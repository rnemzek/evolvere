import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './chargerDirectory.js';

// UOW-16 Task 16.1: real-world power-grid outage ingestion. The service keeps
// a county-scoped "current outage picture" (EIA-861 / ORNL EAGLE-I shape:
// county FIPS + customers tracked/out) in SQLite alongside the AFDC registry,
// refreshed through the same tiered sourcing discipline as afdcIngest:
//
//   1. live-feed        — OUTAGE_FEED_URL (JSON; optional OUTAGE_FEED_API_KEY
//                         bearer header). EAGLE-I has no anonymous public API,
//                         so the live tier is a configurable endpoint rather
//                         than a hardcoded vendor URL; successful fetches are
//                         cached to disk for tier 2.
//   2. cached-snapshot  — backend/data/outage_snapshot.json[.gz], accepted
//                         only while younger than SNAPSHOT_MAX_AGE_MS (a stale
//                         outage picture is worse than a simulated fresh one).
//   3. deterministic-simulation — hour-bucket-seeded synthetic outages over
//                         the COUNTY_ANCHORS table, so the picture is stable
//                         within an hour, evolves hour-to-hour, and always
//                         reproduces identically for a given clock hour.
//
// Every sync is a full atomic replace (BEGIN IMMEDIATE → DELETE → INSERT →
// COMMIT): the table always holds exactly one coherent snapshot, never a
// blend of two sources. Task 16.2 correlates these rows against the AFDC
// R*Tree; Task 16.3 renders them as the map's Grid Outage overlay plane.

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(SRC_DIR, '..', '..', 'data');
const SNAPSHOT_RAW = path.join(SNAPSHOT_DIR, 'outage_snapshot.json');
const SNAPSHOT_GZ = `${SNAPSHOT_RAW}.gz`;
const SNAPSHOT_MAX_AGE_MS = 6 * 3600000;
const REFRESH_MS = Number(process.env.OUTAGE_REFRESH_MS) || 15 * 60000;

// Severity ladder over the share of tracked customers dark. Thresholds follow
// the alert ledger's three-tier vocabulary so 16.2 can map rows straight into
// EXTERNAL_GRID_FAILURE incidents without a translation layer.
export function outageSeverity(pctOut) {
  if (pctOut >= 0.15) return 'CRITICAL';
  if (pctOut >= 0.04) return 'WARNING';
  return 'INFO';
}

// --- Schema -------------------------------------------------------------------

let migrated = false;

export function ensureOutageSchema() {
  if (migrated) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS grid_outages (
      fips              TEXT PRIMARY KEY,   -- 5-digit county FIPS
      county_name       TEXT NOT NULL,
      state             TEXT NOT NULL,
      latitude          REAL NOT NULL,      -- county centroid
      longitude         REAL NOT NULL,
      radius_km         REAL NOT NULL,      -- approximate county footprint for overlay shading
      customers_tracked INTEGER NOT NULL,
      customers_out     INTEGER NOT NULL,
      pct_out           REAL NOT NULL,
      severity          TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'WARNING', 'INFO')),
      started_at        TEXT,
      observed_at       TEXT NOT NULL,
      source            TEXT NOT NULL,
      synced_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_grid_outages_state ON grid_outages (state);
    CREATE INDEX IF NOT EXISTS idx_grid_outages_severity ON grid_outages (severity);
  `);
  migrated = true;
}

// --- County anchor table --------------------------------------------------------
// Approximate centroids, footprint radii, and tracked-meter counts for the
// county seats of the AFDC metro anchors (afdcIngest METROS), so simulated
// outages always land where the registry has station density. Brunswick and
// New Hanover NC cover the Leland/Wilmington ground-truth UAT sector.
// [fips, county, state, lat, lng, radiusKm, customersTracked]
const COUNTY_ANCHORS = [
  ['06037', 'Los Angeles', 'CA', 34.05, -118.25, 60, 3450000],
  ['06073', 'San Diego', 'CA', 33.03, -116.77, 55, 1150000],
  ['06075', 'San Francisco', 'CA', 37.76, -122.44, 12, 380000],
  ['06085', 'Santa Clara', 'CA', 37.23, -121.7, 40, 650000],
  ['06067', 'Sacramento', 'CA', 38.45, -121.34, 35, 570000],
  ['53033', 'King', 'WA', 47.49, -121.84, 50, 890000],
  ['41051', 'Multnomah', 'OR', 45.55, -122.42, 25, 330000],
  ['16001', 'Ada', 'ID', 43.45, -116.24, 30, 190000],
  ['04013', 'Maricopa', 'AZ', 33.35, -112.49, 80, 1650000],
  ['04019', 'Pima', 'AZ', 32.1, -111.79, 60, 420000],
  ['32003', 'Clark', 'NV', 36.21, -115.01, 70, 830000],
  ['49035', 'Salt Lake', 'UT', 40.67, -111.92, 30, 400000],
  ['08031', 'Denver', 'CO', 39.76, -104.88, 20, 320000],
  ['35001', 'Bernalillo', 'NM', 35.05, -106.67, 35, 280000],
  ['48113', 'Dallas', 'TX', 32.77, -96.78, 35, 950000],
  ['48201', 'Harris', 'TX', 29.86, -95.39, 55, 1750000],
  ['48453', 'Travis', 'TX', 30.33, -97.78, 35, 480000],
  ['48029', 'Bexar', 'TX', 29.45, -98.52, 40, 720000],
  ['40109', 'Oklahoma', 'OK', 35.55, -97.4, 35, 300000],
  ['29095', 'Jackson', 'MO', 39.01, -94.35, 30, 310000],
  ['27053', 'Hennepin', 'MN', 45.0, -93.49, 30, 520000],
  ['29510', 'St. Louis City', 'MO', 38.64, -90.24, 12, 150000],
  ['17031', 'Cook', 'IL', 41.84, -87.82, 40, 2150000],
  ['55079', 'Milwaukee', 'WI', 43.02, -87.93, 20, 420000],
  ['55025', 'Dane', 'WI', 43.07, -89.42, 30, 240000],
  ['19153', 'Polk', 'IA', 41.69, -93.57, 25, 200000],
  ['31055', 'Douglas', 'NE', 41.3, -96.15, 20, 240000],
  ['26163', 'Wayne', 'MI', 42.28, -83.28, 30, 780000],
  ['18097', 'Marion', 'IN', 39.78, -86.14, 25, 410000],
  ['39049', 'Franklin', 'OH', 39.97, -83.01, 25, 560000],
  ['39035', 'Cuyahoga', 'OH', 41.43, -81.66, 25, 580000],
  ['39061', 'Hamilton', 'OH', 39.19, -84.54, 25, 380000],
  ['42003', 'Allegheny', 'PA', 40.47, -79.98, 30, 590000],
  ['47037', 'Davidson', 'TN', 36.17, -86.78, 25, 320000],
  ['47157', 'Shelby', 'TN', 35.18, -89.9, 30, 420000],
  ['21111', 'Jefferson', 'KY', 38.19, -85.65, 25, 350000],
  ['13121', 'Fulton', 'GA', 33.79, -84.47, 30, 480000],
  ['37119', 'Mecklenburg', 'NC', 35.25, -80.83, 25, 480000],
  ['37183', 'Wake', 'NC', 35.79, -78.65, 30, 470000],
  ['37129', 'New Hanover', 'NC', 34.18, -77.87, 18, 110000],
  ['37019', 'Brunswick', 'NC', 34.04, -78.23, 30, 80000],
  ['51760', 'Richmond City', 'VA', 37.53, -77.47, 12, 110000],
  ['11001', 'District of Columbia', 'DC', 38.9, -77.02, 12, 300000],
  ['24510', 'Baltimore City', 'MD', 39.3, -76.61, 12, 280000],
  ['42101', 'Philadelphia', 'PA', 40.01, -75.13, 18, 700000],
  ['34013', 'Essex', 'NJ', 40.79, -74.25, 15, 310000],
  ['36061', 'New York', 'NY', 40.78, -73.97, 10, 950000],
  ['25025', 'Suffolk', 'MA', 42.33, -71.07, 12, 340000],
  ['44007', 'Providence', 'RI', 41.87, -71.58, 20, 270000],
  ['09003', 'Hartford', 'CT', 41.81, -72.73, 25, 380000],
  ['36001', 'Albany', 'NY', 42.6, -73.97, 25, 140000],
  ['36029', 'Erie', 'NY', 42.75, -78.78, 30, 400000],
  ['23005', 'Cumberland', 'ME', 43.8, -70.33, 30, 160000],
  ['50007', 'Chittenden', 'VT', 44.46, -73.08, 25, 80000],
  ['12086', 'Miami-Dade', 'FL', 25.61, -80.5, 40, 1150000],
  ['12095', 'Orange', 'FL', 28.51, -81.32, 30, 560000],
  ['12057', 'Hillsborough', 'FL', 27.91, -82.35, 30, 620000],
  ['12031', 'Duval', 'FL', 30.34, -81.65, 30, 440000],
  ['22071', 'Orleans', 'LA', 30.07, -89.93, 20, 180000],
  ['01073', 'Jefferson', 'AL', 33.55, -86.9, 30, 300000],
  ['45019', 'Charleston', 'SC', 32.84, -79.98, 30, 200000],
];

const ANCHOR_BY_FIPS = new Map(COUNTY_ANCHORS.map((c) => [c[0], c]));

// --- Record normalization -------------------------------------------------------

/**
 * Feed record → grid_outages row object, or null when unusable. Field names
 * are matched leniently across the EAGLE-I / PowerOutage.us / EIA vocabulary
 * variants (fips_code vs fips, sum vs customers_out, …); missing coordinates
 * resolve through the county anchor table by FIPS.
 */
export function mapOutageRecord(rec) {
  const pickField = (...names) => names.map((n) => rec?.[n]).find((v) => v !== undefined && v !== null);
  const fips = String(pickField('fips', 'fips_code', 'fipsCode', 'county_fips') ?? '').padStart(5, '0');
  if (!/^\d{5}$/.test(fips)) return null;
  const anchor = ANCHOR_BY_FIPS.get(fips);
  const customersOut = Number(pickField('customers_out', 'customersOut', 'sum', 'outages'));
  if (!Number.isFinite(customersOut) || customersOut <= 0) return null;
  const customersTracked = Number(pickField('customers_tracked', 'customersTracked', 'total_customers')) || anchor?.[6] || null;
  if (!customersTracked) return null;
  const lat = Number(pickField('latitude', 'lat', 'centroid_lat') ?? anchor?.[3]);
  const lng = Number(pickField('longitude', 'lng', 'centroid_lng') ?? anchor?.[4]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 15 || lat > 72 || lng < -180 || lng > -60) return null; // same US envelope as AFDC ingest
  const pctOut = Math.min(1, customersOut / customersTracked);
  return {
    fips,
    countyName: String(pickField('county_name', 'county', 'countyName') ?? anchor?.[1] ?? `County ${fips}`),
    state: String(pickField('state', 'state_abbr', 'stateAbbr') ?? anchor?.[2] ?? 'US').slice(0, 2).toUpperCase(),
    latitude: lat,
    longitude: lng,
    radiusKm: Number(pickField('radius_km', 'radiusKm')) || anchor?.[5] || 25,
    customersTracked: Math.trunc(customersTracked),
    customersOut: Math.trunc(customersOut),
    pctOut,
    severity: outageSeverity(pctOut),
    startedAt: pickField('started_at', 'startedAt', 'run_start_time') ?? null,
    observedAt: pickField('observed_at', 'observedAt', 'run_end_time') ?? new Date().toISOString(),
  };
}

// --- Atomic persistence ---------------------------------------------------------

const INSERT_SQL = `
  INSERT INTO grid_outages (
    fips, county_name, state, latitude, longitude, radius_km,
    customers_tracked, customers_out, pct_out, severity,
    started_at, observed_at, source, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Full atomic replace of the outage picture. BEGIN IMMEDIATE serializes
 * against the alert ledger's writers on the shared connection; the table
 * transitions old-snapshot → new-snapshot with no observable blend state.
 */
function replaceOutages(rows, source) {
  ensureOutageSchema();
  const database = getDb();
  const stmt = database.prepare(INSERT_SQL);
  const syncedAt = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM grid_outages');
    for (const r of rows) {
      stmt.run(
        r.fips, r.countyName, r.state, r.latitude, r.longitude, r.radiusKm,
        r.customersTracked, r.customersOut, r.pctOut, r.severity,
        r.startedAt, r.observedAt, source, syncedAt
      );
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return { counties: rows.length, source, syncedAt };
}

// --- Source tier 1: configurable live feed --------------------------------------

async function fetchLiveFeed() {
  const url = process.env.OUTAGE_FEED_URL;
  if (!url) throw new Error('no OUTAGE_FEED_URL configured');
  const headers = { Accept: 'application/json' };
  if (process.env.OUTAGE_FEED_API_KEY) headers.Authorization = `Bearer ${process.env.OUTAGE_FEED_API_KEY}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`outage feed responded ${res.status}`);
  const body = await res.json();
  const records = Array.isArray(body) ? body : body?.outages ?? body?.data;
  if (!Array.isArray(records)) throw new Error('outage feed payload is not a record array');
  return records;
}

/** Cache a successful live fetch so tier 2 can serve it while it stays fresh. */
function writeSnapshot(records) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const payload = JSON.stringify({ retrieved_at: new Date().toISOString(), outages: records });
  writeFileSync(SNAPSHOT_GZ, gzipSync(payload, { level: 6 }));
}

// --- Source tier 2: cached snapshot ---------------------------------------------

function readSnapshot() {
  const file = existsSync(SNAPSHOT_RAW) ? SNAPSHOT_RAW : existsSync(SNAPSHOT_GZ) ? SNAPSHOT_GZ : null;
  if (!file) return null;
  const raw = file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file);
  const body = JSON.parse(raw.toString('utf8'));
  const retrievedAt = Date.parse(body?.retrieved_at ?? '');
  if (!Number.isFinite(retrievedAt) || Date.now() - retrievedAt > SNAPSHOT_MAX_AGE_MS) {
    return null; // a stale outage picture must not masquerade as current
  }
  const records = Array.isArray(body) ? body : body?.outages;
  return Array.isArray(records) ? records : null;
}

// --- Source tier 3: deterministic simulation ------------------------------------

// Same deterministic PRNG family as the AFDC/corridor seeders.
function seededRng(seed) {
  let h = (seed >>> 0) || 1;
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN_SIMULATED_OUTAGES = 5;

/**
 * Hour-bucket-seeded synthetic outage picture: every county draws against a
 * PRNG keyed on (FIPS, UTC hour), so two boots in the same hour agree exactly
 * and the national picture rotates every hour. Brunswick County NC carries an
 * elevated draw probability so the Leland ground-truth UAT sector regularly
 * exercises the 16.2 correlation path. Heavy-tailed pct_out (rand^2.4) keeps
 * most outages INFO-grade with occasional regional CRITICALs, echoing real
 * EAGLE-I distributions.
 */
export function simulateOutages(epochHour = Math.floor(Date.now() / 3600000)) {
  const nowIso = new Date().toISOString();
  const scored = COUNTY_ANCHORS.map(([fips, county, state, lat, lng, radiusKm, tracked]) => {
    const rand = seededRng(Number(fips) * 2654435761 + epochHour);
    const draw = rand();
    const probability = fips === '37019' ? 0.55 : 0.18;
    const pctOut = Math.max(0.002, rand() ** 2.4 * 0.45);
    const startedAt = new Date(Date.now() - Math.floor(rand() * 6 * 3600000)).toISOString();
    return { fips, county, state, lat, lng, radiusKm, tracked, draw, probability, pctOut, startedAt };
  });

  // Natural draws first; if the hour rolled quiet, force the closest misses in
  // as INFO-grade flickers so the overlay and correlator never render empty.
  const active = scored.filter((c) => c.draw < c.probability);
  if (active.length < MIN_SIMULATED_OUTAGES) {
    const misses = scored
      .filter((c) => c.draw >= c.probability)
      .sort((a, b) => a.draw - b.draw);
    for (const c of misses.slice(0, MIN_SIMULATED_OUTAGES - active.length)) {
      active.push({ ...c, pctOut: Math.min(c.pctOut, 0.02) });
    }
  }

  return active.map((c) => ({
    fips: c.fips,
    county_name: c.county,
    state: c.state,
    latitude: c.lat,
    longitude: c.lng,
    radius_km: c.radiusKm,
    customers_tracked: c.tracked,
    customers_out: Math.max(1, Math.round(c.tracked * c.pctOut)),
    started_at: c.startedAt,
    observed_at: nowIso,
  }));
}

// --- Orchestration --------------------------------------------------------------

/** Post-sync verification mirroring the AFDC ingest gate. */
function verifyOutages() {
  const database = getDb();
  const summary = database
    .prepare(`SELECT COUNT(*) AS counties,
                     SUM(customers_out) AS customersOut,
                     SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
                     SUM(CASE WHEN severity = 'WARNING' THEN 1 ELSE 0 END) AS warning,
                     SUM(CASE WHEN severity = 'INFO' THEN 1 ELSE 0 END) AS info,
                     SUM(CASE WHEN latitude NOT BETWEEN 15 AND 72
                              OR longitude NOT BETWEEN -180 AND -60 THEN 1 ELSE 0 END) AS envelopeLeaks,
                     SUM(CASE WHEN pct_out < 0 OR pct_out > 1 THEN 1 ELSE 0 END) AS pctViolations
              FROM grid_outages`)
    .get();
  return {
    ...summary,
    customersOut: summary.customersOut ?? 0,
    verified: summary.counties > 0 && summary.envelopeLeaks === 0 && summary.pctViolations === 0,
  };
}

/**
 * Runs the tiered pipeline (live feed → fresh cached snapshot → deterministic
 * simulation) and atomically replaces the outage table with the winner.
 */
export async function syncGridOutages() {
  ensureOutageSchema();
  const startedAt = Date.now();
  let records = null;
  let source = null;

  try {
    records = await fetchLiveFeed();
    source = 'live-feed';
    try {
      writeSnapshot(records);
    } catch (err) {
      console.warn(`Grid outages: snapshot cache write failed (${err.message})`);
    }
  } catch (err) {
    if (process.env.OUTAGE_FEED_URL) {
      console.warn(`Grid outages: live feed failed (${err.message}); trying cached snapshot`);
    }
  }

  if (!records) {
    try {
      records = readSnapshot();
      if (records) source = 'cached-snapshot';
    } catch (err) {
      console.warn(`Grid outages: cached snapshot unreadable (${err.message}); simulating`);
    }
  }

  if (!records) {
    records = simulateOutages();
    source = 'deterministic-simulation';
  }

  const rows = [];
  let skipped = 0;
  for (const rec of records) {
    const row = mapOutageRecord(rec);
    if (row) rows.push(row);
    else skipped += 1;
  }
  const { counties, syncedAt } = replaceOutages(rows, source);
  return { source, counties, skipped, syncedAt, ...verifyOutages(), durationMs: Date.now() - startedAt };
}

/** Read API: current picture, CRITICAL first then darkest share of customers. */
export function listGridOutages() {
  ensureOutageSchema();
  const outages = getDb()
    .prepare(`SELECT fips, county_name AS countyName, state,
                     latitude, longitude, radius_km AS radiusKm,
                     customers_tracked AS customersTracked, customers_out AS customersOut,
                     pct_out AS pctOut, severity,
                     started_at AS startedAt, observed_at AS observedAt,
                     source, synced_at AS syncedAt
              FROM grid_outages
              ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                       pct_out DESC`)
    .all();
  const summary = verifyOutages();
  return {
    count: outages.length,
    customersOut: summary.customersOut,
    severityCounts: { critical: summary.critical ?? 0, warning: summary.warning ?? 0, info: summary.info ?? 0 },
    source: outages[0]?.source ?? null,
    syncedAt: outages[0]?.syncedAt ?? null,
    outages,
  };
}

// --- Boot hook ------------------------------------------------------------------

let refreshTimer = null;

/**
 * Boot: run one sync immediately, then keep the picture current on a
 * REFRESH_MS cadence (default 15 min — EAGLE-I publishes 15-minute runs).
 * The timer is unref'd so it never pins the process open.
 */
export async function initGridOutages() {
  const result = await syncGridOutages();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      syncGridOutages().catch((err) => console.error(`Grid outages: scheduled sync failed: ${err.message}`));
    }, REFRESH_MS);
    refreshTimer.unref();
  }
  return result;
}

// Standalone runner: `node src/services/gridOutageService.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await syncGridOutages();
  console.log('Grid outage sync complete');
  console.log(`  source:        ${result.source}`);
  console.log(`  counties:      ${result.counties} (${result.skipped} skipped)`);
  console.log(`  severity:      ${result.critical} CRITICAL / ${result.warning} WARNING / ${result.info} INFO`);
  console.log(`  customers out: ${result.customersOut}`);
  console.log(`  envelope leaks: ${result.envelopeLeaks} | pct violations: ${result.pctViolations}`);
  console.log(`  duration:      ${result.durationMs} ms`);
  console.log(`  VERIFIED: ${result.verified}`);
}
