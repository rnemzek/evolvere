import { createReadStream, existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { getDb } from './chargerDirectory.js';
import { ensureAfdcSchema, queryStationsInBounds, AFDC_SEED_VERSION } from './afdcSchema.js';
import { geocodeStationAddress } from './geocodeEngine.js';

// UOW-11 Task 11.2: bulk NREL AFDC ingestion pipeline. The registry payload
// never materializes in memory — the source byte stream (live HTTPS, or a
// local raw/gzip snapshot) flows through stream-json token-by-token, `pick`
// isolates the `fuel_stations` array, and `streamArray` re-assembles one
// station object at a time. Records accumulate into 2,000-row batches, each
// committed inside an explicit BEGIN/COMMIT transaction so SQLite journals
// sequentially instead of fsyncing per row; the Task 11.1 base-table triggers
// carry every batch into the afdc_geo R*Tree within the same transaction, so
// this pipeline never touches the index.
//
// UOW-22 Task 22.1: the deterministic synthesized-seed tier is retired
// outright — the registry now only ever holds authentic AFDC records, either
// fetched live or replayed from a local authentic snapshot. There is no
// synthetic fallback; if both tiers fail, ingestion simply yields zero rows.
//
// Source tiers (first success wins):
//   1. afdc-live        — streamed fetch of the AFDC registry (NREL_API_KEY,
//                         DEMO_KEY default; throttling/4xx fall through)
//   2. local-snapshot   — backend/data/afdc_snapshot.json[.gz], an authentic
//                         (non-synthetic) point-in-time capture of tier 1

export const AFDC_TARGET = 75000;
export const BATCH_SIZE = 2000;
const WARM_FLOOR = Math.floor(AFDC_TARGET * 0.8); // below this, re-ingest at boot

// UOW-22 Task 22.1 (PO directive, confirmed after independent verification):
// the upstream host moves from developer.nrel.gov to developer.nlr.gov. This
// is NOT the same domain NREL publishes — verified live before wiring it in:
// it resolves on real .gov/api.data.gov infrastructure (National Laboratory
// of the Rockies) and its /api/alt-fuel-stations/v1.json path independently
// mirrors the identical AFDC schema and station_locator_url with real data.
// developer.nrel.gov itself does not resolve at all from this environment.
const AFDC_API_BASE = 'https://developer.nlr.gov/api/alt-fuel-stations/v1.json';
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(SRC_DIR, '..', '..', 'data');
const SNAPSHOT_RAW = path.join(SNAPSHOT_DIR, 'afdc_snapshot.json');
const SNAPSHOT_GZ = `${SNAPSHOT_RAW}.gz`;

// --- Record mapping -----------------------------------------------------------

function toPortCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

const US_ENVELOPE = { latMin: 15, latMax: 72, lngMin: -180, lngMax: -60 };

function usableNativePoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= US_ENVELOPE.latMin && lat <= US_ENVELOPE.latMax
    && lng >= US_ENVELOPE.lngMin && lng <= US_ENVELOPE.lngMax;
}

/**
 * AFDC record → afdc_stations parameter row (minus synced_at), or null when
 * the record lacks a usable id AND has neither a usable native coordinate nor
 * enough address to ever be geocoded. UOW-22 Task 22.2: dual-coordinate
 * persistence — the raw AFDC point (afdc_latitude/afdc_longitude, verbatim)
 * and the active render point (latitude/longitude) start out identical when
 * the source record carries a valid point ('NATIVE_GPS' — the field-surveyed
 * AFDC coordinate is the highest-precision source available). A record with
 * no usable native point is still admitted when it has enough address to
 * resolve later — it ingests with a NULL active pin ('MISSING') until
 * backfillGeocodePrecision or the standalone script derives one.
 */
export function mapAfdcRecord(rec) {
  const id = Number(rec?.id);
  if (!Number.isInteger(id)) return null;

  const rawLat = Number(rec?.latitude);
  const rawLng = Number(rec?.longitude);
  const hasNative = usableNativePoint(rawLat, rawLng);
  const hasAddress = Boolean(rec?.city || rec?.state || rec?.zip);
  if (!hasNative && !hasAddress) return null;

  const afdcLat = hasNative ? rawLat : null;
  const afdcLng = hasNative ? rawLng : null;
  const afdcGeocodeStatus = hasNative ? 'PRESENT' : 'MISSING';

  return [
    id,
    String(rec.station_name ?? `AFDC Station ${id}`),
    rec.street_address ?? null,
    rec.city ?? null,
    rec.state ?? null,
    rec.zip != null ? String(rec.zip) : null,
    hasNative ? rawLat : null, // active render latitude
    hasNative ? rawLng : null, // active render longitude
    afdcLat,
    afdcLng,
    afdcGeocodeStatus,
    rec.fuel_type_code ?? 'ELEC',
    rec.access_days_time ?? null,
    rec.ev_network ?? null,
    rec.status_code ?? null,
    toPortCount(rec.ev_dc_fast_num),
    toPortCount(rec.ev_level2_evse_num ?? rec.ev_level2_num),
    rec.updated_at ?? null,
    hasNative ? 'NATIVE_GPS' : null,
  ];
}

// --- Transactional batching ---------------------------------------------------

const UPSERT_SQL = `
  INSERT INTO afdc_stations (
    afdc_id, station_name, street_address, city, state, zip,
    latitude, longitude, afdc_latitude, afdc_longitude, afdc_geocode_status,
    fuel_type_code, access_days_time, ev_network,
    status_code, ev_dc_fast_num, ev_level2_num, updated_at, precision_score, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(afdc_id) DO UPDATE SET
    station_name = excluded.station_name,
    street_address = excluded.street_address,
    city = excluded.city,
    state = excluded.state,
    zip = excluded.zip,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    afdc_latitude = excluded.afdc_latitude,
    afdc_longitude = excluded.afdc_longitude,
    afdc_geocode_status = excluded.afdc_geocode_status,
    fuel_type_code = excluded.fuel_type_code,
    access_days_time = excluded.access_days_time,
    ev_network = excluded.ev_network,
    status_code = excluded.status_code,
    ev_dc_fast_num = excluded.ev_dc_fast_num,
    ev_level2_num = excluded.ev_level2_num,
    updated_at = excluded.updated_at,
    synced_at = excluded.synced_at,
    precision_score = excluded.precision_score,
    geocoded_latitude = NULL,
    geocoded_longitude = NULL
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

// --- Coastal geometry validation (UOW-14 regression guard) --------------------
//
// Retained independent of the synthetic seed generator it originally gated:
// verifyRegistry() below still re-runs every ingested row (live or authentic
// snapshot) through onLand() as a sanity check that no source data lands in
// open water — a legitimate guard regardless of where the row came from.
//
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
  // UOW-14 Task 14.4 (re-scoped UOW-22): this hand-drawn shoreline geometry
  // was built to gate a deterministic synthetic generator's own jitter draws.
  // Now that the registry only ever holds authentic AFDC records, a nonzero
  // count here is expected and NOT a defect — real stations legitimately sit
  // on piers, harbors, barrier islands, and other coastline features these
  // simplified polylines don't model precisely. Reported as a diagnostic
  // only; no longer gates `verified` below.
  let oceanLeaks = 0;
  for (const row of database
    .prepare('SELECT latitude AS lat, longitude AS lng FROM afdc_stations WHERE latitude IS NOT NULL AND longitude IS NOT NULL')
    .iterate()) {
    if (!onLand(row.lat, row.lng)) oceanLeaks += 1;
  }
  // UOW-22: precision coverage — how many rows carry a resolved active pin at
  // all (NATIVE_GPS from the AFDC source, or a geocode-cleanse hit) versus
  // still sitting unpinned pending backfillGeocodePrecision(). Reported, not
  // gating: coverage climbs progressively rather than completing in one pass.
  const { n: precisionCoverage } = database
    .prepare("SELECT COUNT(*) AS n FROM afdc_stations WHERE precision_score IS NOT NULL")
    .get();
  const { n: nativeGpsCoverage } = database
    .prepare("SELECT COUNT(*) AS n FROM afdc_stations WHERE precision_score = 'NATIVE_GPS'")
    .get();
  return {
    stations,
    rtreeInSync: rtreeRows === stations,
    spatialSpotCheck: laBox.length,
    coastalSpotCheck: coastalBox.length,
    oceanLeaks,
    precisionCoverage,
    nativeGpsCoverage,
    verified: stations > 0 && rtreeRows === stations && laBox.length > 0
      && coastalBox.length > 0,
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
 * UOW-22 Task 22.1: runs the (now two-tier) pipeline: live AFDC fetch → local
 * authentic snapshot. No synthetic fallback — if both tiers fail, this
 * returns a zero-station result rather than fabricating data. Returns ingest
 * stats merged with post-ingest verification.
 */
export async function ingestAfdcRegistry() {
  const { rtree, wiped } = ensureAfdcSchema();
  const apiKey = process.env.NREL_API_KEY ?? 'DEMO_KEY';
  const startedAt = Date.now();
  let stats = null;

  // UOW-15 Task 15.1: the AFDC_SEED_VERSION destructive gate dropped the
  // registry tables, so the cached snapshot on disk holds the SAME stale
  // geometry the wipe exists to shred — purge it too, or the tier-2 fallback
  // would faithfully re-ingest every pre-v14 row and boot without the
  // current schema (dual-coordinate columns included).
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
    stats = await ingestByteStream(await openLiveStream(apiKey), 'afdc-live');
  } catch (err) {
    console.warn(`AFDC ingestion: live AFDC fetch failed (${err.message}); trying local authentic snapshot`);
  }

  if (!stats || stats.ingested === 0) {
    const snapshot = findSnapshot();
    if (snapshot) {
      try {
        stats = await ingestByteStream(openSnapshotStream(snapshot), 'local-snapshot');
      } catch (err) {
        console.warn(`AFDC ingestion: snapshot ${path.basename(snapshot.file)} failed (${err.message})`);
      }
    }
  }

  if (!stats || stats.ingested === 0) {
    console.warn('AFDC ingestion: no live source and no authentic local snapshot available — registry stays empty (no synthetic fallback)');
    stats = { source: 'none', parsed: 0, skipped: 0, ingested: 0, batches: 0, peakHeapMB: 0 };
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

const GEOCODE_BOOT_BATCH = Number(process.env.GEOCODE_BOOT_BATCH) || 25;

/**
 * UOW-21/22: bounded, resumable geocoding-cleanse pass — the ingest
 * pipeline's inline integration of the high-precision geocoding engine.
 * Shares geocodeEngine.js with the standalone backfill script
 * (backend/scripts/geocodeStations.js), so a station's coordinate always
 * resolves through the exact same tiered Census -> Nominatim lookup no
 * matter which caller triggered it — one uniform code path, no per-station
 * special-casing.
 *
 * UOW-22 Task 22.2 (dual-coordinate persistence): targets any row that has
 * never been geocode-attempted (geocoded_latitude IS NULL), including rows
 * that already have a NATIVE_GPS active pin — the geocode result is stored
 * independently (geocoded_latitude/geocoded_longitude) as a cross-check
 * rather than overwriting a source coordinate that outranks it. Only rows
 * with no native point (afdc_geocode_status = 'MISSING') get the geocode
 * result promoted into the active latitude/longitude/precision_score.
 *
 * Bounded to `limit` rows per call rather than run fleet-wide inline: the
 * shared 1 req/sec throttle would take hours across the full registry, which
 * cannot block server startup. This picks up the oldest un-geocoded rows
 * (afdc_id order) a small slice at a time on every boot, so coverage climbs
 * progressively without ever stalling the app. For a larger or specifically-
 * scoped batch (e.g. one ZIP code, or an overnight full-fleet run), invoke
 * backend/scripts/geocodeStations.js directly.
 */
export async function backfillGeocodePrecision({ limit = GEOCODE_BOOT_BATCH } = {}) {
  ensureAfdcSchema();
  const database = getDb();
  const targets = database
    .prepare('SELECT * FROM afdc_stations WHERE geocoded_latitude IS NULL ORDER BY afdc_id LIMIT ?')
    .all(limit);
  if (targets.length === 0) return { attempted: 0, geocoded: 0 };

  const storeGeocodedOnly = database.prepare(
    'UPDATE afdc_stations SET geocoded_latitude = ?, geocoded_longitude = ? WHERE afdc_id = ?'
  );
  const promoteToActive = database.prepare(
    `UPDATE afdc_stations
     SET geocoded_latitude = ?, geocoded_longitude = ?, latitude = ?, longitude = ?, precision_score = ?
     WHERE afdc_id = ?`
  );
  let geocoded = 0;
  for (const station of targets) {
    const result = await geocodeStationAddress(station);
    if (!result) continue;
    if (station.afdc_geocode_status === 'PRESENT') {
      storeGeocodedOnly.run(result.lat, result.lng, station.afdc_id);
    } else {
      promoteToActive.run(result.lat, result.lng, result.lat, result.lng, result.precisionScore, station.afdc_id);
    }
    geocoded += 1;
  }
  return { attempted: targets.length, geocoded };
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
  console.log(`  precision coverage: ${result.precisionCoverage} / ${result.stations} stations pinned (${result.nativeGpsCoverage} NATIVE_GPS)`);
  console.log(`  peak heap:         ${result.peakHeapMB} MB | duration: ${result.durationMs} ms`);
  console.log(`  VERIFIED: ${result.verified}`);
}
