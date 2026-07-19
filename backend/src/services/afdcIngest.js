import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
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
import { ensureAfdcSchema, queryStationsInBounds } from './afdcSchema.js';
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

// UOW-14 Task 14.3: topological clipping gate. The gaussian anchor scatter is
// direction-blind — a uniform 360° variance around a coastal metro bleeds
// points into open water (81 Wilmington rows reached the Atlantic, 419 LA rows
// the Pacific before this gate). Each predicate returns true only for on-land
// candidates; rejected draws are regenerated from the same deterministic
// stream, so the seed stays reproducible.
//
// - Wilmington, NC: land ends at the intracoastal waterway (lng -77.82) —
//   everything east is Atlantic; below lat 34.02 the Cape Fear mouth opens
//   into open sea.
// - Los Angeles, CA: land lies strictly northeast of the natural Pacific
//   shoreline vector from Point Dume (34.00, -118.80) to Newport Beach
//   (33.60, -117.93); the sign of the 2-D cross product against that vector
//   decides land vs water (and correctly discards Catalina Island draws).
const LA_SHORE = { lat: 34.0, lng: -118.8, dLat: -0.4, dLng: 0.87 };
const COASTAL_CLIPS = {
  'Wilmington,NC': (lat, lng) => lng <= -77.82 && lat >= 34.02,
  'Los Angeles,CA': (lat, lng) =>
    LA_SHORE.dLng * (lat - LA_SHORE.lat) - LA_SHORE.dLat * (lng - LA_SHORE.lng) >= 0,
};

// Rejection-sample the anchor scatter: redraw until the candidate clears the
// clip predicate, pinning to the anchor itself (always on land) in the
// vanishingly unlikely case 40 consecutive draws all land in water.
function jitterAnchor(rand, lat, lng, sigma, clip) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const cLat = lat + gauss(rand) * sigma;
    const cLng = lng + gauss(rand) * sigma * 1.2;
    if (!clip || clip(cLat, cLng)) return { lat: cLat, lng: cLng };
  }
  return { lat, lng };
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

/** Deterministic generator yielding `target` AFDC-shaped records one at a time. */
function* generateSeedRecords(target) {
  const corridorCount = Math.round(target * CORRIDOR_SHARE);
  const metroCount = target - corridorCount;
  const metroWeightTotal = METROS.reduce((a, m) => a + m[4], 0);
  let afdcId = 200001;

  let emitted = 0;
  for (const [mi, [city, state, lat, lng, weight]] of METROS.entries()) {
    const allocation = mi === METROS.length - 1
      ? metroCount - emitted // last metro absorbs rounding remainder
      : Math.round((weight / metroWeightTotal) * metroCount);
    const sigma = 0.06 + Math.sqrt(weight) * 0.05;
    const clip = COASTAL_CLIPS[`${city},${state}`];
    for (let i = 0; i < allocation; i += 1) {
      const rand = seededRng(afdcId);
      yield buildSeedRecord(afdcId, {
        city, state,
        ...jitterAnchor(rand, lat, lng, sigma, clip),
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
      yield buildSeedRecord(afdcId, {
        city: null,
        state: (frac < 0.5 ? a : b).state,
        lat: a.lat + (b.lat - a.lat) * frac + gauss(rand) * 0.08,
        lng: a.lng + (b.lng - a.lng) * frac + gauss(rand) * 0.08,
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
  // UOW-14 Task 14.3: ocean-leak gate — the COASTAL_CLIPS predicates re-run as
  // SQL over the ingested rows, so a regression in the clipping gate fails
  // verification. City-scoped on purpose: real AFDC barrier-island stations
  // (Wrightsville Beach, Carolina Beach) carry their own city names and stay
  // exempt, while anything filed under the clipped anchor cities must be on
  // the landward side of its shoreline predicate.
  const { leaks: ncLeaks } = database
    .prepare(`SELECT COUNT(*) AS leaks FROM afdc_stations
              WHERE city = 'Wilmington' AND state = 'NC'
                AND (longitude > -77.82 OR latitude < 34.02)`)
    .get();
  const { leaks: laLeaks } = database
    .prepare(`SELECT COUNT(*) AS leaks FROM afdc_stations
              WHERE city = 'Los Angeles' AND state = 'CA'
                AND 0.87 * (latitude - 34.0) + 0.4 * (longitude + 118.8) < 0`)
    .get();
  const oceanLeaks = ncLeaks + laLeaks;
  return {
    stations,
    rtreeInSync: rtreeRows === stations,
    spatialSpotCheck: laBox.length,
    coastalSpotCheck: coastalBox.length,
    oceanLeaks,
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

/**
 * Runs the tiered pipeline: live AFDC fetch → local snapshot → synthesized
 * seed. Returns ingest stats merged with post-ingest verification.
 */
export async function ingestAfdcRegistry({ target = AFDC_TARGET } = {}) {
  const { rtree } = ensureAfdcSchema();
  const apiKey = process.env.NREL_API_KEY ?? 'DEMO_KEY';
  const startedAt = Date.now();
  let stats = null;

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
  console.log(`  peak heap:         ${result.peakHeapMB} MB | duration: ${result.durationMs} ms`);
  console.log(`  VERIFIED: ${result.verified}`);
}
