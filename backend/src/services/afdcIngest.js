import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { getDb } from './chargerDirectory.js';
import { ensureAfdcSchema, queryStationsInBounds, AFDC_SEED_VERSION } from './afdcSchema.js';
import { CORRIDORS } from './dataIngestionService.js';

// UOW-11 Task 11.2: bulk NREL AFDC ingestion pipeline. The registry payload
// (~75,000 US public ELEC stations) never materializes in memory — the source
// byte stream (live HTTPS, or a local raw/gzip snapshot) flows through
// stream-json token-by-token, `pick` isolates the `fuel_stations` array, and
// `streamArray` re-assembles one station object at a time. Records accumulate
// into 2,000-row batches, each committed inside an explicit BEGIN/COMMIT
// transaction so SQLite journals sequentially instead of fsyncing per row; the
// Task 11.1 base-table triggers carry every batch into the afdc_geo R*Tree
// within the same transaction, so this pipeline never touches the index.
//
// Source tiers (first success wins):
//   1. nrel-live        — streamed fetch of the AFDC registry (NREL_API_KEY,
//                         DEMO_KEY default; throttling/4xx fall through)
//   2. local-snapshot   — backend/data/afdc_snapshot.json[.gz]
//   3. synthesized-seed — deterministic AFDC-shaped snapshot written to disk
//                         (metro-weighted + interstate-corridor distribution),
//                         then ingested through the same streaming path

export const AFDC_TARGET = 75000;
export const BATCH_SIZE = 2000;
const WARM_FLOOR = Math.floor(AFDC_TARGET * 0.8); // below this, re-ingest at boot

const AFDC_API_BASE = 'https://developer.nrel.gov/api/alt-fuel-stations/v1.json';
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(SRC_DIR, '..', '..', 'data');
const SNAPSHOT_RAW = path.join(SNAPSHOT_DIR, 'afdc_snapshot.json');
const SNAPSHOT_GZ = `${SNAPSHOT_RAW}.gz`;

// --- Record mapping -----------------------------------------------------------

function toPortCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/**
 * AFDC record → afdc_stations parameter row (minus synced_at), or null when
 * the record lacks a usable id/coordinate pair or falls outside the US
 * envelope (CONUS + AK + HI; positive-longitude Aleutian outliers excluded).
 */
export function mapAfdcRecord(rec) {
  const id = Number(rec?.id);
  const lat = Number(rec?.latitude);
  const lng = Number(rec?.longitude);
  if (!Number.isInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 15 || lat > 72 || lng < -180 || lng > -60) return null;
  return [
    id,
    String(rec.station_name ?? `AFDC Station ${id}`),
    rec.street_address ?? null,
    rec.city ?? null,
    rec.state ?? null,
    rec.zip != null ? String(rec.zip) : null,
    lat,
    lng,
    rec.fuel_type_code ?? 'ELEC',
    rec.access_days_time ?? null,
    rec.ev_network ?? null,
    rec.status_code ?? null,
    toPortCount(rec.ev_dc_fast_num),
    toPortCount(rec.ev_level2_evse_num ?? rec.ev_level2_num),
    rec.updated_at ?? null,
  ];
}

// --- Transactional batching ---------------------------------------------------

const UPSERT_SQL = `
  INSERT INTO afdc_stations (
    afdc_id, station_name, street_address, city, state, zip,
    latitude, longitude, fuel_type_code, access_days_time, ev_network,
    status_code, ev_dc_fast_num, ev_level2_num, updated_at, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(afdc_id) DO UPDATE SET
    station_name = excluded.station_name,
    street_address = excluded.street_address,
    city = excluded.city,
    state = excluded.state,
    zip = excluded.zip,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    fuel_type_code = excluded.fuel_type_code,
    access_days_time = excluded.access_days_time,
    ev_network = excluded.ev_network,
    status_code = excluded.status_code,
    ev_dc_fast_num = excluded.ev_dc_fast_num,
    ev_level2_num = excluded.ev_level2_num,
    updated_at = excluded.updated_at,
    synced_at = excluded.synced_at
`;

/**
 * Accumulates mapped rows and commits them in BATCH_SIZE-row explicit
 * transactions over a single prepared upsert. A failed batch rolls back
 * atomically; upsert semantics keep interrupted runs safely re-runnable.
 */
class BatchTransactionWriter {
  constructor(database, syncedAt) {
    this.database = database;
    this.syncedAt = syncedAt;
    this.stmt = database.prepare(UPSERT_SQL);
    this.pending = [];
    this.rows = 0;
    this.batches = 0;
    this.peakHeap = process.memoryUsage().heapUsed;
  }

  #commitBatch() {
    this.database.exec('BEGIN TRANSACTION');
    try {
      for (const row of this.pending) this.stmt.run(...row, this.syncedAt);
      this.database.exec('COMMIT');
    } catch (err) {
      this.database.exec('ROLLBACK');
      throw err;
    }
    this.rows += this.pending.length;
    this.batches += 1;
    this.pending.length = 0;
    const heap = process.memoryUsage().heapUsed;
    if (heap > this.peakHeap) this.peakHeap = heap;
  }

  add(row) {
    this.pending.push(row);
    if (this.pending.length >= BATCH_SIZE) this.#commitBatch();
  }

  finish() {
    if (this.pending.length > 0) this.#commitBatch();
    return {
      rows: this.rows,
      batches: this.batches,
      peakHeapMB: Math.round((this.peakHeap / 1048576) * 10) / 10,
    };
  }
}

// --- Streaming ingestion core -------------------------------------------------

/**
 * Byte stream → stream-json token pipeline → batched transactional upserts.
 * Constant-memory: only the current token, one assembled station object, and
 * the pending batch (≤ 2,000 rows) are ever resident.
 */
async function ingestByteStream(byteStream, source) {
  const database = getDb();
  const writer = new BatchTransactionWriter(database, new Date().toISOString());
  let parsed = 0;
  let skipped = 0;

  const pipeline = chain([
    byteStream,
    parser(),
    pick({ filter: 'fuel_stations' }),
    streamArray(),
  ]);

  for await (const { value } of pipeline) {
    parsed += 1;
    const row = mapAfdcRecord(value);
    if (!row) {
      skipped += 1;
      continue;
    }
    writer.add(row);
  }

  const { rows, batches, peakHeapMB } = writer.finish();
  return { source, parsed, skipped, ingested: rows, batches, peakHeapMB };
}

// --- Source tier 1: live NREL AFDC API ---------------------------------------

async function openLiveStream(apiKey) {
  const params = new URLSearchParams({
    fuel_type: 'ELEC',
    country: 'US',
    access: 'public',
    limit: 'all',
    api_key: apiKey,
  });
  const res = await fetch(`${AFDC_API_BASE}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(180000),
  });
  if (res.status === 429 || res.status === 403) {
    throw new Error(`NREL throttled the request (${res.status})${apiKey === 'DEMO_KEY' ? ' — DEMO_KEY rate limits exhausted' : ''}`);
  }
  if (!res.ok) throw new Error(`NREL AFDC responded ${res.status}`);
  if (!res.body) throw new Error('NREL AFDC returned no body stream');
  return Readable.fromWeb(res.body);
}

// --- Source tier 2: local snapshot --------------------------------------------

function findSnapshot() {
  if (existsSync(SNAPSHOT_RAW)) return { file: SNAPSHOT_RAW, gzip: false };
  if (existsSync(SNAPSHOT_GZ)) return { file: SNAPSHOT_GZ, gzip: true };
  return null;
}

function openSnapshotStream({ file, gzip }) {
  const raw = createReadStream(file);
  return gzip ? raw.pipe(createGunzip()) : raw;
}

// --- Source tier 3: deterministic snapshot synthesis --------------------------

// Metro anchors weighted by rough EV-infrastructure density; the remainder of
// the registry scatters along the UOW-09 interstate corridor polylines so the
// national plane reads organically at every zoom.
const METROS = [
  ['Los Angeles', 'CA', 34.05, -118.24, 9], ['San Francisco', 'CA', 37.77, -122.42, 6],
  ['San Jose', 'CA', 37.34, -121.89, 4], ['San Diego', 'CA', 32.72, -117.16, 4],
  ['Sacramento', 'CA', 38.58, -121.49, 3], ['Fresno', 'CA', 36.75, -119.77, 1.5],
  ['Seattle', 'WA', 47.61, -122.33, 4], ['Spokane', 'WA', 47.66, -117.43, 1],
  ['Portland', 'OR', 45.52, -122.68, 3], ['Boise', 'ID', 43.62, -116.2, 1],
  ['Phoenix', 'AZ', 33.45, -112.07, 3], ['Tucson', 'AZ', 32.22, -110.97, 1],
  ['Las Vegas', 'NV', 36.17, -115.14, 2], ['Salt Lake City', 'UT', 40.76, -111.89, 1.5],
  ['Denver', 'CO', 39.74, -104.99, 3], ['Albuquerque', 'NM', 35.08, -106.65, 1],
  ['Dallas', 'TX', 32.78, -96.8, 3], ['Houston', 'TX', 29.76, -95.37, 3],
  ['Austin', 'TX', 30.27, -97.74, 2.5], ['San Antonio', 'TX', 29.42, -98.49, 1.5],
  ['Oklahoma City', 'OK', 35.47, -97.52, 1], ['Kansas City', 'MO', 39.1, -94.58, 1.5],
  ['Minneapolis', 'MN', 44.98, -93.27, 2.5], ['St. Louis', 'MO', 38.63, -90.2, 1.5],
  ['Chicago', 'IL', 41.88, -87.63, 4], ['Milwaukee', 'WI', 43.04, -87.91, 1],
  ['Madison', 'WI', 43.07, -89.4, 1], ['Des Moines', 'IA', 41.59, -93.62, 0.8],
  ['Omaha', 'NE', 41.26, -95.93, 0.8], ['Detroit', 'MI', 42.33, -83.05, 2],
  ['Indianapolis', 'IN', 39.77, -86.16, 1.5], ['Columbus', 'OH', 39.96, -83.0, 1.5],
  ['Cleveland', 'OH', 41.5, -81.69, 1.2], ['Cincinnati', 'OH', 39.1, -84.51, 1.2],
  ['Pittsburgh', 'PA', 40.44, -79.99, 1.5], ['Nashville', 'TN', 36.16, -86.78, 1.5],
  ['Memphis', 'TN', 35.15, -90.05, 0.8], ['Louisville', 'KY', 38.25, -85.76, 0.8],
  ['Atlanta', 'GA', 33.75, -84.39, 3], ['Charlotte', 'NC', 35.23, -80.84, 1.5],
  ['Raleigh', 'NC', 35.78, -78.64, 1.5], ['Wilmington', 'NC', 34.22, -77.94, 0.7],
  ['Richmond', 'VA', 37.54, -77.44, 1],
  ['Washington', 'DC', 38.9, -77.04, 3], ['Baltimore', 'MD', 39.29, -76.61, 1.5],
  ['Philadelphia', 'PA', 39.95, -75.17, 2.5], ['Newark', 'NJ', 40.74, -74.17, 1.5],
  ['New York', 'NY', 40.71, -74.01, 5], ['Boston', 'MA', 42.36, -71.06, 3],
  ['Providence', 'RI', 41.82, -71.41, 0.8], ['Hartford', 'CT', 41.77, -72.67, 0.8],
  ['Albany', 'NY', 42.65, -73.75, 0.8], ['Buffalo', 'NY', 42.89, -78.88, 0.8],
  ['Portland', 'ME', 43.66, -70.26, 0.6], ['Burlington', 'VT', 44.48, -73.21, 0.6],
  ['Miami', 'FL', 25.77, -80.19, 2.5], ['Orlando', 'FL', 28.54, -81.38, 2],
  ['Tampa', 'FL', 27.95, -82.46, 1.8], ['Jacksonville', 'FL', 30.33, -81.66, 1.2],
  ['New Orleans', 'LA', 29.95, -90.07, 1], ['Birmingham', 'AL', 33.52, -86.8, 0.7],
  ['Charleston', 'SC', 32.78, -79.93, 0.7],
];
const CORRIDOR_SHARE = 0.15; // slice of the target scattered along interstates

const NETWORKS = [
  ['ChargePoint Network', 30], ['Non-Networked', 20], ['Tesla', 12], ['Blink Network', 9],
  ['EVgo Network', 8], ['Electrify America', 7], ['SHELL_RECHARGE', 5], ['Volta', 4],
  ['EV Connect', 3], ['FLO', 2],
];
const VENUES = [
  'City Hall', 'Public Library', 'Transit Center', 'Whole Foods Market', 'Parking Structure',
  'Community College', 'Medical Center', 'Shopping Plaza', 'Hilton Garden Inn', 'Municipal Lot',
];
const ACCESS_HOURS = ['24 hours daily', 'Dawn to dusk', 'MON-FRI 7am-9pm', '6am-10pm daily'];
const STREETS = ['Main St', 'Oak Ave', 'Center Dr', 'Market St', 'Industrial Pkwy', 'Harbor Blvd'];

// UOW-14 Task 14.4: generalized topological clipping. The 14.3 gate only
// covered two metro anchors; the San Diego anchor and — critically — the I-5
// corridor scatter (whose SD→LA chord interpolates straight across the
// Pacific bight off Oceanside) still bled 881 rows into the sea. There was no
// coordinate sign inversion: gauss() noise is zero-mean and symmetric, so
// "flipping" its sign is a statistical no-op — the bug was scatter sources
// with no land predicate at all. This zone engine now gates EVERY generated
// point (metro and corridor alike).
//
// A zone is a bounding box plus either a `test(lat, lng) → on-land` predicate
// or a `shore` polyline with a `side` (+1 = land where the cross product
// against the segment direction is positive). Predicates are conservative:
// over-rejection is safe (the draw simply regenerates on land), so gates hug
// the waterline from the landward side.
const COASTAL_ZONES = [
  { name: 'socal-pacific', box: [31.9, 34.45, -121.5, -117.0], side: 1,
    shore: [ // Ventura → Point Mugu → Point Dume → Newport → Dana Point → La Jolla → border
      [34.42, -119.70], [34.27, -119.28], [34.08, -119.04], [34.00, -118.80],
      [33.60, -117.93], [33.35, -117.55], [32.85, -117.28], [32.53, -117.12],
    ] },
  { name: 'sf-pacific', box: [36.8, 38.6, -125.0, -122.35], test: (lat, lng) => lng >= -122.52 },
  { name: 'puget-sound', box: [46.9, 48.6, -126.0, -122.32], test: (lat, lng) => lng >= -122.45 },
  { name: 'carolina-atlantic', box: [33.6, 34.6, -78.6, -76.5], test: (lat, lng) => lng <= -77.82 && lat >= 34.02 },
  { name: 'florida-atlantic', box: [25.0, 30.8, -81.75, -78.6],
    test: (lat, lng) => lng <= (lat < 27 ? -80.13 : lat < 29 ? -80.55 : -81.35) },
  { name: 'tampa-gulf', box: [26.2, 28.6, -84.5, -82.5], test: (lat, lng) => lng >= -82.85 },
  { name: 'charleston-atlantic', box: [32.2, 33.2, -80.4, -78.8], test: (lat, lng) => lng <= -79.82 && lat >= 32.6 },
  { name: 'ny-bight', box: [40.0, 40.78, -74.3, -72.5], test: (lat) => lat >= 40.52 },
  { name: 'boston-harbor', box: [41.9, 42.7, -71.2, -69.8], test: (lat, lng) => lng <= -70.99 },
  { name: 'narragansett-bay', box: [41.2, 41.85, -71.6, -71.0], test: (lat) => lat >= 41.6 },
  { name: 'casco-bay', box: [43.2, 44.0, -70.6, -69.0], test: (lat, lng) => lng <= -70.22 },
  // Shore polyline (not a gate): the I-80 Chicago→Toledo chord interpolates
  // straight across the lake's southern basin, and those water base points
  // need a shoreline to snap to. Traced N→S down the west shore, around the
  // southern tip, back up the east shore; land is outside the basin (side -1).
  { name: 'lake-michigan', box: [41.3, 44.2, -88.1, -86.6], side: -1,
    shore: [
      [44.00, -87.65], [43.00, -87.87], [42.60, -87.80], [41.85, -87.60],
      [41.62, -87.20], [41.75, -86.75], [42.40, -86.35],
    ] },
  { name: 'lake-erie', box: [41.55, 42.9, -83.2, -78.9], side: -1,
    shore: [[41.70, -83.25], [41.50, -81.72], [42.10, -80.10], [42.86, -78.90]] },
  { name: 'lake-stclair', box: [42.05, 42.75, -82.95, -82.3], test: () => false },
  { name: 'pontchartrain', box: [30.03, 30.28, -90.5, -89.8], test: () => false },
  { name: 'galveston-bay', box: [29.3, 29.62, -95.0, -94.4], test: () => false },
  { name: 'great-salt-lake', box: [40.7, 41.7, -112.9, -112.05], test: () => false },
];

function nearestShoreSegment(shore, lat, lng) {
  let best = null;
  for (let i = 0; i < shore.length - 1; i += 1) {
    const [aLat, aLng] = shore[i];
    const [bLat, bLng] = shore[i + 1];
    const dLat = bLat - aLat;
    const dLng = bLng - aLng;
    const t = Math.max(0, Math.min(1,
      ((lat - aLat) * dLat + (lng - aLng) * dLng) / (dLat * dLat + dLng * dLng)));
    const pLat = aLat + t * dLat;
    const pLng = aLng + t * dLng;
    const d2 = (lat - pLat) ** 2 + (lng - pLng) ** 2;
    if (!best || d2 < best.d2) best = { d2, pLat, pLng, aLat, aLng, dLat, dLng };
  }
  return best;
}

function zoneViolation(lat, lng) {
  for (const zone of COASTAL_ZONES) {
    const [s, n, w, e] = zone.box;
    if (lat < s || lat > n || lng < w || lng > e) continue;
    if (zone.test) {
      if (!zone.test(lat, lng)) return zone;
    } else {
      const seg = nearestShoreSegment(zone.shore, lat, lng);
      const cross = seg.dLng * (lat - seg.aLat) - seg.dLat * (lng - seg.aLng);
      if (zone.side * cross < 0) return zone;
    }
  }
  return null;
}

export function onLand(lat, lng) {
  return zoneViolation(lat, lng) === null;
}

// Deterministic landfall for a base point that is itself in the water (the
// I-5 SD→LA and I-80 lake-crossing chord cases): project onto the violated
// zone's shoreline and nudge landward, doubling the nudge depth until the
// candidate clears every zone — a fixed depth can strand inside concave
// corner wedges of the polyline. Gate zones fall back to the base point
// (every corridor chord base inside a gate zone is verified on land).
function snapLandward(lat, lng) {
  const zone = zoneViolation(lat, lng);
  if (!zone?.shore) return { lat, lng };
  const seg = nearestShoreSegment(zone.shore, lat, lng);
  const len = Math.hypot(seg.dLat, seg.dLng);
  for (let depth = 0.03; depth <= 0.5; depth *= 2) {
    const scale = (depth * zone.side) / len;
    const cLat = seg.pLat + seg.dLng * scale;
    const cLng = seg.pLng - seg.dLat * scale;
    if (onLand(cLat, cLng)) return { lat: cLat, lng: cLng };
  }
  return { lat: seg.pLat, lng: seg.pLng };
}

// Rejection-sample the scatter: redraw until the candidate clears every
// coastal zone AND stays out of the dictionary-owned ground-truth sector
// (same deterministic stream, so the seed stays reproducible); after 40
// rejected draws, snap deterministically to the nearest landward point.
// UOW-15 Task 15.3: the sector exclusion is what "completely disables" the
// procedural generator for the Wilmington/Leland coordinates — a Wilmington
// metro draw that lands in the sector regenerates outside it instead.
function jitter(rand, lat, lng, sigmaLat, sigmaLng) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const cLat = lat + gauss(rand) * sigmaLat;
    const cLng = lng + gauss(rand) * sigmaLng;
    if (onLand(cLat, cLng) && !inGroundTruthSector(cLat, cLng)) return { lat: cLat, lng: cLng };
  }
  return snapLandward(lat, lng);
}

// Same deterministic PRNG family as the corridor/tariff seeders.
function seededRng(seed) {
  let h = (seed >>> 0) || 1;
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9))) * Math.cos(2 * Math.PI * rand());
}

function weightedPick(rand, table) {
  const total = table.reduce((a, [, w]) => a + w, 0);
  let roll = rand() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return table[table.length - 1][0];
}

function buildSeedRecord(afdcId, anchor, rand) {
  const isDcFast = rand() < 0.2;
  const statusRoll = rand();
  const updated = new Date(Date.UTC(2023, 0, 1) + Math.floor(rand() * 3.4 * 365 * 86400000));
  return {
    id: afdcId,
    station_name: `${VENUES[Math.floor(rand() * VENUES.length)]} - ${anchor.city ?? anchor.state} #${1 + Math.floor(rand() * 40)}`,
    street_address: `${100 + Math.floor(rand() * 9800)} ${STREETS[Math.floor(rand() * STREETS.length)]}`,
    city: anchor.city,
    state: anchor.state,
    zip: String(10000 + Math.floor(rand() * 89999)),
    latitude: Math.round(anchor.lat * 1e6) / 1e6,
    longitude: Math.round(anchor.lng * 1e6) / 1e6,
    fuel_type_code: 'ELEC',
    access_days_time: ACCESS_HOURS[Math.floor(rand() * ACCESS_HOURS.length)],
    ev_network: weightedPick(rand, NETWORKS),
    status_code: statusRoll < 0.92 ? 'E' : statusRoll < 0.97 ? 'P' : 'T',
    ev_dc_fast_num: isDcFast ? 2 + Math.floor(rand() * 14) : null,
    ev_level2_evse_num: isDcFast ? (rand() < 0.4 ? 1 + Math.floor(rand() * 3) : null) : 1 + Math.floor(rand() * 11),
    ev_connector_types: isDcFast ? ['CHADEMO', 'J1772COMBO'] : ['J1772'],
    updated_at: updated.toISOString().slice(0, 10),
  };
}

// UOW-15 Task 15.3/15.5: static ground-truth data dictionary — the sole
// authority for the Wilmington/Leland UAT sector. 15.3 dismantled the v6
// label↔coordinate cross-wire; 15.5 corrects the PO-caught sequential
// mapping slip (real-world AFDC-199997 belongs exclusively to the Piggly
// Wiggly on 112 Village Rd NE, so Smithfield's moves to the discrete 199996).
// The dictionary binds label → coordinate → network → status explicitly, one
// record per line of the PO's surveyed sheet:
//   AFDC-199996  Leland Supercharger Hub (Smithfield's)  34.2185, -78.0145
//   AFDC-199997  Piggly Wiggly Infrastructure Node       34.2421, -77.9984
//   AFDC-199999  The Villages at Brunswick Forest        34.1954, -78.0231
// 15.6 (UAT final offset): the Smithfield's beacon sat on the "Leland" map
// label at the US-74 junction; the true Olde Regent Way shopping plaza is
// ~1.2 mi southwest — 34.2185/-78.0145 is the land-verified parking lot.
// These records are yielded verbatim ahead of the scatter loops: they never
// enter jitter(), gauss(), or any other randomized noise path, and the
// GROUND_TRUTH_SECTOR exclusion below bars procedural records from the sector
// entirely, so no generated metadata can ever cross-wire onto real Leland
// coordinates again. Ids sit below the generated range (200001+) so scatter
// allocation can never collide with them.
const GROUND_TRUTH_DICTIONARY = [
  {
    id: 199996,
    station_name: "Leland Supercharger Hub (Smithfield's BBQ Plaza)",
    street_address: 'Olde Regent Way',
    city: 'Leland',
    state: 'NC',
    zip: '28451',
    latitude: 34.2185,
    longitude: -78.0145,
    fuel_type_code: 'ELEC',
    access_days_time: '24 hours daily',
    ev_network: 'Tesla',
    status_code: 'E', // OPEN
    ev_dc_fast_num: 12,
    ev_level2_evse_num: null,
    ev_connector_types: ['TESLA'],
    updated_at: '2026-07-19',
  },
  {
    id: 199997,
    station_name: 'Piggly Wiggly Infrastructure Node',
    street_address: '112 Village Rd NE',
    city: 'Leland',
    state: 'NC',
    zip: '28451',
    latitude: 34.2421,
    longitude: -77.9984,
    fuel_type_code: 'ELEC',
    access_days_time: '24 hours daily',
    ev_network: 'ChargePoint Network',
    status_code: 'E', // OPEN
    ev_dc_fast_num: null,
    ev_level2_evse_num: 4,
    ev_connector_types: ['J1772'],
    updated_at: '2026-07-19',
  },
  {
    id: 199999,
    station_name: 'The Villages at Brunswick Forest (ChargePoint)',
    street_address: 'The Villages Town Center, Brunswick Forest Pkwy',
    city: 'Leland',
    state: 'NC',
    zip: '28451',
    latitude: 34.1954,
    longitude: -78.0231,
    fuel_type_code: 'ELEC',
    access_days_time: '24 hours daily',
    ev_network: 'ChargePoint Network',
    status_code: 'E', // OPEN
    ev_dc_fast_num: null,
    ev_level2_evse_num: 2,
    ev_connector_types: ['J1772'],
    updated_at: '2026-07-19',
  },
];

// UOW-15 Task 15.5: dictionary id set for wire-level flagging — the spatial
// cluster engine marks these rows isGroundTruth so the frontend can render
// them with unmistakable neon accents. (dataIngestionService imports this,
// completing a benign ESM cycle with the CORRIDORS import above: both
// bindings are only dereferenced at call time, never during module load.)
export const GROUND_TRUTH_IDS = new Set(GROUND_TRUTH_DICTIONARY.map((r) => r.id));

// Dictionary-owned sector: a bounding box around the Leland UAT neighborhood.
// The procedural metadata generator is fully disabled inside it — jitter()
// rejects any candidate landing here exactly as it rejects water, so the only
// rows that can exist in the sector are the dictionary bindings above.
const GROUND_TRUTH_SECTOR = [34.17, 34.27, -78.06, -77.97]; // [S, N, W, E]

function inGroundTruthSector(lat, lng) {
  const [s, n, w, e] = GROUND_TRUTH_SECTOR;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

/** Deterministic generator yielding `target` AFDC-shaped records one at a time. */
function* generateSeedRecords(target) {
  yield* GROUND_TRUTH_DICTIONARY;
  const scattered = target - GROUND_TRUTH_DICTIONARY.length;
  const corridorCount = Math.round(scattered * CORRIDOR_SHARE);
  const metroCount = scattered - corridorCount;
  const metroWeightTotal = METROS.reduce((a, m) => a + m[4], 0);
  let afdcId = 200001;

  let emitted = 0;
  for (const [mi, [city, state, lat, lng, weight]] of METROS.entries()) {
    const allocation = mi === METROS.length - 1
      ? metroCount - emitted // last metro absorbs rounding remainder
      : Math.round((weight / metroWeightTotal) * metroCount);
    const sigma = 0.06 + Math.sqrt(weight) * 0.05;
    for (let i = 0; i < allocation; i += 1) {
      const rand = seededRng(afdcId);
      yield buildSeedRecord(afdcId, {
        city, state,
        ...jitter(rand, lat, lng, sigma, sigma * 1.2),
      }, rand);
      afdcId += 1;
      emitted += 1;
    }
  }

  const corridorLens = CORRIDORS.map((c) => c.waypoints.length - 1);
  const lenTotal = corridorLens.reduce((a, b) => a + b, 0);
  let corridorEmitted = 0;
  for (const [ci, corridor] of CORRIDORS.entries()) {
    const allocation = ci === CORRIDORS.length - 1
      ? corridorCount - corridorEmitted
      : Math.round((corridorLens[ci] / lenTotal) * corridorCount);
    const segments = corridor.waypoints.length - 1;
    for (let i = 0; i < allocation; i += 1) {
      const rand = seededRng(afdcId);
      const t = segments * (i / allocation);
      const seg = Math.min(Math.floor(t), segments - 1);
      const frac = t - seg;
      const a = corridor.waypoints[seg];
      const b = corridor.waypoints[seg + 1];
      // Corridor chords can cross open water outright (I-5's SD→LA leg cuts
      // across the Pacific bight), so the base interpolation itself rides
      // through the same land gate as the jitter.
      yield buildSeedRecord(afdcId, {
        city: null,
        state: (frac < 0.5 ? a : b).state,
        ...jitter(rand, a.lat + (b.lat - a.lat) * frac, a.lng + (b.lng - a.lng) * frac, 0.08, 0.08),
      }, rand);
      afdcId += 1;
      corridorEmitted += 1;
    }
  }
}

async function writeWithBackpressure(stream, text) {
  if (!stream.write(text)) await once(stream, 'drain');
}

/**
 * Streams a deterministic AFDC-shaped registry snapshot to
 * backend/data/afdc_snapshot.json.gz — record-at-a-time through gzip with
 * drain backpressure, so synthesis is as constant-memory as ingestion.
 */
export async function synthesizeSnapshot(target = AFDC_TARGET) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = createWriteStream(SNAPSHOT_GZ);
  const gzip = createGzip({ level: 6 });
  gzip.pipe(file);

  await writeWithBackpressure(
    gzip,
    `{"station_locator_url":"https://afdc.energy.gov/stations/","total_results":${target},` +
    '"station_counts":{"fuels":{"ELEC":{"total":' + target + '}}},"fuel_stations":['
  );
  let first = true;
  for (const record of generateSeedRecords(target)) {
    await writeWithBackpressure(gzip, (first ? '' : ',') + JSON.stringify(record));
    first = false;
  }
  await writeWithBackpressure(gzip, ']}');
  gzip.end();
  await finished(file);
  return SNAPSHOT_GZ;
}

// --- Orchestration ------------------------------------------------------------

export function countAfdcStations() {
  ensureAfdcSchema();
  return getDb().prepare('SELECT COUNT(*) AS n FROM afdc_stations').get().n;
}

/** Post-ingest verification: base/R*Tree parity plus spatial spot-checks. */
function verifyRegistry(rtreeActive) {
  const database = getDb();
  const stations = countAfdcStations();
  const rtreeRows = rtreeActive
    ? database.prepare('SELECT COUNT(*) AS n FROM afdc_geo').get().n
    : stations;
  const laBox = queryStationsInBounds({ minLat: 33.5, maxLat: 34.5, minLng: -118.8, maxLng: -117.5 });
  // UOW-14 Task 14.1 regression guard: the Leland/Wilmington NC close-up
  // viewport (PO reference ~34.24, -78.01) must never report empty again —
  // real AFDC data has stations there, and the seed now anchors the metro.
  const coastalBox = queryStationsInBounds({ minLat: 34.0, maxLat: 34.5, minLng: -78.3, maxLng: -77.7 });
  // UOW-14 Task 14.4: ocean-leak gate — every ingested row re-runs through
  // the exact onLand() zone geometry the generator used, so verification can
  // never disagree with generation (SQL chord approximations of the shoreline
  // polylines produced false positives on legitimate near-coast land rows).
  let oceanLeaks = 0;
  for (const row of database
    .prepare('SELECT latitude AS lat, longitude AS lng FROM afdc_stations')
    .iterate()) {
    if (!onLand(row.lat, row.lng)) oceanLeaks += 1;
  }
  // Reported but NOT gating `verified`: a live NREL ingest legitimately lacks
  // the synthetic dictionary rows, and must still verify clean.
  // UOW-15 Task 15.3: the check now asserts the FULL binding — id, exact
  // coordinate, label, network, and status together — derived from the same
  // GROUND_TRUTH_DICTIONARY the generator yields, so the exact cross-wire UAT
  // caught (right coordinates under the wrong label) can never verify green.
  const bindingStmt = database
    .prepare(`SELECT COUNT(*) AS n FROM afdc_stations
              WHERE afdc_id = ? AND ABS(latitude - ?) < 1e-6 AND ABS(longitude - ?) < 1e-6
                AND station_name = ? AND ev_network = ? AND status_code = ?`);
  const dictionaryBound = GROUND_TRUTH_DICTIONARY.every(
    (rec) => bindingStmt
      .get(rec.id, rec.latitude, rec.longitude, rec.station_name, rec.ev_network, rec.status_code)
      .n === 1
  );
  // Sector purity: no procedurally generated row may exist inside the
  // dictionary-owned Leland box (live NREL data legitimately has other real
  // stations there, so this is reported, not gating).
  const [secS, secN, secW, secE] = GROUND_TRUTH_SECTOR;
  const { n: sectorStrays } = database
    .prepare(`SELECT COUNT(*) AS n FROM afdc_stations
              WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
                AND afdc_id NOT IN (${GROUND_TRUTH_DICTIONARY.map((r) => r.id).join(',')})`)
    .get(secS, secN, secW, secE);
  return {
    stations,
    rtreeInSync: rtreeRows === stations,
    spatialSpotCheck: laBox.length,
    coastalSpotCheck: coastalBox.length,
    oceanLeaks,
    dictionaryBound,
    sectorStrays,
    verified: stations > 0 && rtreeRows === stations && laBox.length > 0
      && coastalBox.length > 0 && oceanLeaks === 0,
  };
}

/**
 * UOW-14 Task 14.1: live database profile for the SPA header — replaces the
 * hardcoded "Orange County" locality string with what the registry actually
 * holds. Planned ('P') sites are broken out so no consumer folds them into
 * fault/attention math.
 */
export function getRegistryProfile() {
  ensureAfdcSchema();
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS stations,
                     COUNT(DISTINCT state) AS states,
                     SUM(CASE WHEN status_code = 'P' THEN 1 ELSE 0 END) AS planned,
                     SUM(CASE WHEN status_code IS NOT NULL
                              AND status_code NOT IN ('E', 'P') THEN 1 ELSE 0 END) AS offline
              FROM afdc_stations`)
    .get();
  return {
    stations: row.stations,
    states: row.states,
    planned: row.planned ?? 0,
    offline: row.offline ?? 0,
    coverage: row.states > 1 ? 'US National Registry' : 'Regional Registry',
  };
}

// UOW-15 Task 15.2: full-name → USPS code so operators can type either form
// into the Go To Location search.
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

const LOCATE_AGG = `COUNT(*) AS matches,
                    MIN(latitude) AS minLat, MAX(latitude) AS maxLat,
                    MIN(longitude) AS minLng, MAX(longitude) AS maxLng`;

/**
 * UOW-15 Task 15.2: Go To Location resolver. Geocodes entirely against the
 * local registry — the 75k-station table already spans every US city/state/zip
 * we can render, so no external geocoding API is needed. Returns the matched
 * station set's bounding box for a viewport fitBounds, or null.
 *
 * Resolution order: 5-digit zip → state (USPS code or full name) →
 * "City, ST" / "City ST" pair → bare city name. Bare city names group by
 * state and snap to the state holding the most matching stations, so
 * "Wilmington" centers on Wilmington NC's dense cluster instead of a
 * meaningless NC↔DE↔CA-spanning box.
 */
export function locateRegistry(query) {
  ensureAfdcSchema();
  const q = String(query ?? '').trim().replace(/\s+/g, ' ');
  if (!q) return null;
  const database = getDb();
  const hit = (label, row) =>
    row?.matches > 0
      ? {
          label,
          matches: row.matches,
          bounds: { minLat: row.minLat, maxLat: row.maxLat, minLng: row.minLng, maxLng: row.maxLng },
        }
      : null;

  if (/^\d{5}$/.test(q)) {
    // Grouped by densest state for the same reason as bare city names: real
    // AFDC zips live in exactly one state (grouping is then a no-op), but the
    // synthesized seed assigns random zips, and an ungrouped MIN/MAX would
    // span a meaningless coast-to-coast box across those collisions.
    const row = database
      .prepare(`SELECT state, ${LOCATE_AGG} FROM afdc_stations WHERE zip = ?
                GROUP BY state ORDER BY matches DESC, state LIMIT 1`)
      .get(q);
    return row ? hit(`ZIP ${q} (${row.state})`, row) : null;
  }

  const stateCode = /^[a-z]{2}$/i.test(q) ? q.toUpperCase() : STATE_CODES[q.toLowerCase()];
  if (stateCode) {
    const found = hit(stateCode, database
      .prepare(`SELECT ${LOCATE_AGG} FROM afdc_stations WHERE state = ?`)
      .get(stateCode));
    if (found) return found;
  }

  const pair = q.match(/^(.+?)(?:,| ) ?([a-z]{2})$/i);
  if (pair) {
    const found = hit(`${pair[1]}, ${pair[2].toUpperCase()}`, database
      .prepare(`SELECT ${LOCATE_AGG} FROM afdc_stations WHERE city LIKE ? AND state = ?`)
      .get(pair[1], pair[2].toUpperCase()));
    if (found) return found;
  }

  for (const pattern of [q, `${q}%`]) {
    const row = database
      .prepare(`SELECT city, state, ${LOCATE_AGG} FROM afdc_stations
                WHERE city LIKE ? GROUP BY state ORDER BY matches DESC LIMIT 1`)
      .get(pattern);
    const found = row ? hit(`${row.city}, ${row.state}`, row) : null;
    if (found) return found;
  }
  return null;
}

/**
 * Runs the tiered pipeline: live AFDC fetch → local snapshot → synthesized
 * seed. Returns ingest stats merged with post-ingest verification.
 */
export async function ingestAfdcRegistry({ target = AFDC_TARGET } = {}) {
  const { rtree, wiped } = ensureAfdcSchema();
  const apiKey = process.env.NREL_API_KEY ?? 'DEMO_KEY';
  const startedAt = Date.now();
  let stats = null;

  // UOW-15 Task 15.1: the AFDC_SEED_VERSION destructive gate dropped the
  // registry tables, so the cached snapshot on disk holds the SAME stale
  // geometry the wipe exists to shred — purge it too, or the tier-2 fallback
  // would faithfully re-ingest every pre-v6 ocean/lake row and boot without
  // the current ground-truth anchors.
  if (wiped) {
    for (const stale of [SNAPSHOT_RAW, SNAPSHOT_GZ]) {
      if (existsSync(stale)) {
        rmSync(stale);
        console.warn(`AFDC ingestion: purged stale seed snapshot ${path.basename(stale)} (seed geometry v${AFDC_SEED_VERSION} rebuild)`);
      }
    }
  }

  if (apiKey === 'DEMO_KEY') {
    console.warn('AFDC ingestion: no NREL_API_KEY set — using DEMO_KEY (throttling expected, fallback armed)');
  }
  try {
    stats = await ingestByteStream(await openLiveStream(apiKey), 'nrel-live');
  } catch (err) {
    console.warn(`AFDC ingestion: live NREL fetch failed (${err.message}); trying local snapshot`);
  }

  if (!stats || stats.ingested === 0) {
    const snapshot = findSnapshot();
    if (snapshot) {
      try {
        stats = await ingestByteStream(openSnapshotStream(snapshot), 'local-snapshot');
      } catch (err) {
        console.warn(`AFDC ingestion: snapshot ${path.basename(snapshot.file)} failed (${err.message}); synthesizing seed`);
      }
    }
  }

  if (!stats || stats.ingested === 0) {
    console.log(`AFDC ingestion: synthesizing deterministic ${target}-station seed snapshot…`);
    await synthesizeSnapshot(target);
    stats = await ingestByteStream(openSnapshotStream(findSnapshot()), 'synthesized-seed');
  }

  return { ...stats, ...verifyRegistry(rtree), durationMs: Date.now() - startedAt };
}

/** Boot hook: skip the pipeline entirely once the registry is warm. */
export async function initAfdcIngestion() {
  const cached = countAfdcStations();
  if (cached >= WARM_FLOOR) {
    console.log(`AFDC ingestion: registry warm (${cached} stations cached)`);
    return { source: 'cache', stations: cached, ingested: 0, verified: true };
  }
  const result = await ingestAfdcRegistry();
  console.log(
    `AFDC ingestion: ${result.ingested} stations from ${result.source} | ` +
    `${result.batches} × ${BATCH_SIZE}-row transactions | ` +
    `peak heap ${result.peakHeapMB} MB | rtree ${result.rtreeInSync ? 'in sync' : 'OUT OF SYNC'} | ` +
    `${result.durationMs} ms`
  );
  return result;
}

// Standalone runner: `node src/services/afdcIngest.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await ingestAfdcRegistry();
  console.log('AFDC bulk ingestion complete');
  console.log(`  source:            ${result.source}`);
  console.log(`  parsed/skipped:    ${result.parsed} / ${result.skipped}`);
  console.log(`  upserted rows:     ${result.ingested} (${result.batches} × ${BATCH_SIZE}-row transactions)`);
  console.log(`  registry rows:     ${result.stations} | rtree in sync: ${result.rtreeInSync}`);
  console.log(`  LA bbox spot-check: ${result.spatialSpotCheck} stations`);
  console.log(`  coastal spot-check: ${result.coastalSpotCheck} stations | ocean leaks: ${result.oceanLeaks}`);
  console.log(`  Leland dictionary: ${result.dictionaryBound ? `all ${GROUND_TRUTH_DICTIONARY.length} bindings exact (199996 Smithfield's 34.2185,-78.0145 · 199997 Piggly Wiggly 34.2421,-77.9984 · 199999 Brunswick Forest 34.1954,-78.0231)` : 'absent (live registry)'} | sector strays: ${result.sectorStrays}`);
  console.log(`  peak heap:         ${result.peakHeapMB} MB | duration: ${result.durationMs} ms`);
  console.log(`  VERIFIED: ${result.verified}`);
}
