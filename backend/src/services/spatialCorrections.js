import { getDb } from './chargerDirectory.js';
import { haversineKm } from './infrastructureTopology.js';

// UOW-17 Task 17.2: Geospatial MDM spatial-corrections pipeline. The AFDC
// bulk import (UOW-11) is authoritative for coverage but not always for
// precision — a station's published lat/lng can land it on the wrong side of
// a parking lot or across a highway from its true plug. This service layers a
// small, independently-sourced override table on top of the 75k-row registry
// rather than mutating afdc_stations directly, so every correction carries its
// own provenance (manual UAT survey vs. automated geocoder) and can be
// audited or rolled back without touching the bulk-ingested source of truth.

let migrated = false;

export function ensureSpatialCorrectionsSchema() {
  if (migrated) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS station_spatial_corrections (
      afdc_id       INTEGER PRIMARY KEY,  -- afdc_stations.afdc_id
      corrected_lat REAL NOT NULL,
      corrected_lng REAL NOT NULL,
      source        TEXT NOT NULL,        -- 'manual' | 'nominatim' | 'pelias'
      delta_m       REAL,                 -- haversine delta vs. registry coordinate at write time
      created_at    TEXT NOT NULL
    );
  `);
  migrated = true;
}

function rowToCorrection(row) {
  return row && {
    afdcId: row.afdc_id,
    correctedLat: row.corrected_lat,
    correctedLng: row.corrected_lng,
    source: row.source,
    deltaM: row.delta_m,
    createdAt: row.created_at,
  };
}

/** Manual or automated override write — upserts on the station's afdc_id. */
export function applyCorrection({ afdcId, correctedLat, correctedLng, source, deltaM = null }) {
  if (!Number.isInteger(afdcId)) throw new TypeError('afdcId must be an integer');
  if (!Number.isFinite(correctedLat) || !Number.isFinite(correctedLng)) {
    throw new TypeError('correctedLat/correctedLng must be finite numbers');
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new TypeError('source must be a non-empty string');
  }

  ensureSpatialCorrectionsSchema();
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      INSERT INTO station_spatial_corrections (afdc_id, corrected_lat, corrected_lng, source, delta_m, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(afdc_id) DO UPDATE SET
        corrected_lat = excluded.corrected_lat,
        corrected_lng = excluded.corrected_lng,
        source = excluded.source,
        delta_m = excluded.delta_m,
        created_at = excluded.created_at
    `)
    .run(afdcId, correctedLat, correctedLng, source.trim(), deltaM, now);
  return rowToCorrection(
    database.prepare('SELECT * FROM station_spatial_corrections WHERE afdc_id = ?').get(afdcId)
  );
}

export function listCorrections() {
  ensureSpatialCorrectionsSchema();
  return getDb()
    .prepare('SELECT * FROM station_spatial_corrections ORDER BY created_at DESC')
    .all()
    .map(rowToCorrection);
}

// --- Background Nominatim/Pelias reconciliation ---------------------------------
// A small, rate-limited sweep that walks the registry in afdc_id order,
// forward-geocodes each station's postal address, and writes a correction row
// only when the geocoder's answer disagrees with the stored coordinate by
// more than RECONCILE_DELTA_THRESHOLD_M — most stations never earn a row.

const GEOCODER_URL =
  process.env.PELIAS_URL || process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const GEOCODER_SOURCE = process.env.PELIAS_URL ? 'pelias' : 'nominatim';
const RECONCILE_DELTA_THRESHOLD_M = 100;
// Nominatim's usage policy caps anonymous callers at 1 request/second; the
// sweep serializes its own calls well under that ceiling regardless of tick
// cadence, so it stays a good citizen even if SPATIAL_RECONCILE_BATCH is
// raised for a larger deploy.
const RECONCILE_MIN_INTERVAL_MS = 1100;
const RECONCILE_BATCH_SIZE = Number(process.env.SPATIAL_RECONCILE_BATCH) || 3;
const RECONCILE_TICK_MS = Number(process.env.SPATIAL_RECONCILE_INTERVAL_MS) || 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function geocodeStation(station) {
  const addressParts = [station.street_address, station.city, station.state, station.zip].filter(Boolean);
  if (addressParts.length === 0) return null;
  const params = new URLSearchParams({
    q: addressParts.join(', '),
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'us',
  });
  const res = await fetch(`${GEOCODER_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      // Nominatim's usage policy requires an identifying User-Agent.
      'User-Agent': 'nemzilla-evolvere-grid/1.0 (NOC prototype geospatial MDM reconciliation)',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`geocoder responded ${res.status}`);
  const hits = await res.json();
  const hit = Array.isArray(hits) ? hits[0] : null;
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon ?? hit.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Reconcile one station's coordinate against the geocoder's answer. */
export async function reconcileStation(afdcId) {
  const database = getDb();
  const station = database.prepare('SELECT * FROM afdc_stations WHERE afdc_id = ?').get(afdcId);
  if (!station) return { afdcId, status: 'not-found' };

  const geocoded = await geocodeStation(station);
  if (!geocoded) return { afdcId, status: 'no-match' };

  const deltaM =
    haversineKm(
      { latitude: station.latitude, longitude: station.longitude },
      { latitude: geocoded.lat, longitude: geocoded.lng }
    ) * 1000;

  if (deltaM < RECONCILE_DELTA_THRESHOLD_M) {
    return { afdcId, status: 'within-tolerance', deltaM: Math.round(deltaM) };
  }

  const correction = applyCorrection({
    afdcId,
    correctedLat: geocoded.lat,
    correctedLng: geocoded.lng,
    source: GEOCODER_SOURCE,
    deltaM: Math.round(deltaM),
  });
  return { afdcId, status: 'corrected', deltaM: Math.round(deltaM), correction };
}

function ensureCursorTable(database) {
  database.exec('CREATE TABLE IF NOT EXISTS spatial_reconcile_state (key TEXT PRIMARY KEY, value TEXT)');
}

function getCursor(database) {
  ensureCursorTable(database);
  const row = database.prepare("SELECT value FROM spatial_reconcile_state WHERE key = 'cursor'").get();
  return row ? Number(row.value) : 0;
}

function setCursor(database, afdcId) {
  database
    .prepare(`INSERT INTO spatial_reconcile_state (key, value) VALUES ('cursor', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(afdcId));
}

/**
 * Process one small batch, resuming from wherever the last batch left off
 * (a cursor row, not an in-memory offset, so a restart resumes cleanly). Wraps
 * back to the start once every station has been walked once.
 */
export async function runReconciliationBatch(batchSize = RECONCILE_BATCH_SIZE) {
  ensureSpatialCorrectionsSchema();
  const database = getDb();
  let cursor = getCursor(database);
  let page = database
    .prepare('SELECT afdc_id FROM afdc_stations WHERE afdc_id > ? ORDER BY afdc_id LIMIT ?')
    .all(cursor, batchSize);
  if (page.length === 0) {
    page = database.prepare('SELECT afdc_id FROM afdc_stations ORDER BY afdc_id LIMIT ?').all(batchSize);
  }

  const results = [];
  for (let i = 0; i < page.length; i += 1) {
    const afdcId = page[i].afdc_id;
    try {
      results.push(await reconcileStation(afdcId));
    } catch (err) {
      results.push({ afdcId, status: 'error', error: err.message });
    }
    setCursor(database, afdcId);
    if (i < page.length - 1) await sleep(RECONCILE_MIN_INTERVAL_MS);
  }
  return { processed: results.length, results };
}

let reconcileTimer = null;

/** Boot hook: arms the background sweep on an unref'd interval. Never blocks boot. */
export function startSpatialReconciliation() {
  ensureSpatialCorrectionsSchema();
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    runReconciliationBatch().catch((err) =>
      console.warn(`Spatial MDM reconciliation batch failed (non-fatal): ${err.message}`)
    );
  }, RECONCILE_TICK_MS);
  reconcileTimer.unref();
  console.log(
    `[boot] spatial MDM reconciliation armed: batch=${RECONCILE_BATCH_SIZE} every ${RECONCILE_TICK_MS}ms | ` +
    `source=${GEOCODER_SOURCE} (${GEOCODER_URL}) | correction threshold=${RECONCILE_DELTA_THRESHOLD_M}m`
  );
}

// Standalone runner: `node src/services/spatialCorrections.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runReconciliationBatch();
  console.log('Spatial MDM reconciliation batch complete');
  for (const r of result.results) console.log(`  AFDC-${r.afdcId}: ${r.status}${r.deltaM ? ` (${r.deltaM}m)` : ''}`);
}
