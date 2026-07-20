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

/** Look-Near primitive: the local cache check every reconciliation path runs first. */
export function getCorrection(afdcId) {
  ensureSpatialCorrectionsSchema();
  return rowToCorrection(
    getDb().prepare('SELECT * FROM station_spatial_corrections WHERE afdc_id = ?').get(afdcId)
  );
}

export function listCorrections() {
  ensureSpatialCorrectionsSchema();
  return getDb()
    .prepare('SELECT * FROM station_spatial_corrections ORDER BY created_at DESC')
    .all()
    .map(rowToCorrection);
}

// UOW-18 Task 18.2: hardcoded ground-truth baseline for the Leland UAT sector
// spike — surveyed street coordinates, entered with explicit 'UAT_MANUAL'
// provenance rather than the geocoder source tag. applyCorrection() upserts,
// so re-running this at every boot is a no-op once written.
//
// AFDC-199996 (Tesla Supercharger / Smithfield's) is deliberately NOT
// included: UOW-16 Task 16.4 already crosshair-surveyed it to a more precise
// 34.217440/-78.018444 and marked it VERIFIED. The PO's 18.2 survey sheet
// still carries the earlier Olde Regent Way estimate (34.2185/-78.0145) for
// that same station — seeding it here would silently regress a verified fix
// via the COALESCE override, so it's skipped rather than applied literally.
const LELAND_UAT_BASELINE = [
  { afdcId: 199999, correctedLat: 34.1954, correctedLng: -78.0231 }, // ChargePoint, Brunswick Forest
  { afdcId: 199994, correctedLat: 34.2125, correctedLng: -78.011 }, // Blink Charging, Ocean Hwy E
  { afdcId: 199993, correctedLat: 34.231, correctedLng: -77.989 }, // EnviroSpark Charging, Belville
];

export function seedLelandUatBaseline() {
  ensureSpatialCorrectionsSchema();
  for (const entry of LELAND_UAT_BASELINE) {
    applyCorrection({ ...entry, source: 'UAT_MANUAL' });
  }
  return LELAND_UAT_BASELINE.length;
}

// --- Single-station reconciliation (Nominatim, cache-first) --------------------

const GEOCODER_URL =
  process.env.PELIAS_URL || process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const GEOCODER_SOURCE = process.env.PELIAS_URL ? 'pelias' : 'nominatim';
const RECONCILE_DELTA_THRESHOLD_M = 100;

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

/**
 * Reconcile one station's coordinate on demand. UOW-18 Task 18.3 "Look Local
 * First": a station that already carries a correction — manual or a prior
 * geocoder hit — is treated as already reconciled and never re-triggers an
 * external call; only a genuine cache miss reaches the geocoder.
 */
export async function reconcileStation(afdcId) {
  ensureSpatialCorrectionsSchema();
  const database = getDb();
  if (getCorrection(afdcId)) return { afdcId, status: 'cached' };

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

// --- Leland spike: Look-Near / Look-Far Overpass sweep (UOW-18 Task 18.3) ------
// The "1X Incremental" pipeline proves itself on one controlled 15-mile pilot
// area before any future expansion nationally. Look-Near: every candidate
// station inside the radius that already has a station_spatial_corrections
// row is skipped outright — no external call, cache wins. Look-Far: the
// remainder is resolved in ONE Overpass radius query (amenity=charging_station)
// covering the whole pilot area, rather than one geocode call per station —
// far cheaper, and the shape Overpass's usage policy prefers.

const KM_PER_DEG_LAT = 111.32;
const LELAND_ANCHOR = { lat: 34.2174, lng: -78.0184 };
const LELAND_RADIUS_MILES = 15;
const LELAND_RADIUS_M = LELAND_RADIUS_MILES * 1609.34;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
// A returned POI more than this far from a candidate station isn't a match —
// it's some other nearby charger Overpass happens to know about.
const OVERPASS_MATCH_MAX_M = 300;
const RECONCILE_TICK_MS = Number(process.env.SPATIAL_RECONCILE_INTERVAL_MS) || 30000;

function lelandBoundingBox() {
  const radiusKm = LELAND_RADIUS_M / 1000;
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.2, Math.cos((LELAND_ANCHOR.lat * Math.PI) / 180)));
  return {
    minLat: LELAND_ANCHOR.lat - dLat,
    maxLat: LELAND_ANCHOR.lat + dLat,
    minLng: LELAND_ANCHOR.lng - dLng,
    maxLng: LELAND_ANCHOR.lng + dLng,
  };
}

async function fetchOverpassChargingStations() {
  const query =
    `[out:json][timeout:25];` +
    `node["amenity"="charging_station"](around:${Math.round(LELAND_RADIUS_M)},${LELAND_ANCHOR.lat},${LELAND_ANCHOR.lng});` +
    `out body;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      // Overpass's fair-use policy asks for an identifying User-Agent, same
      // as Nominatim.
      'User-Agent': 'nemzilla-evolvere-grid/1.0 (NOC prototype geospatial MDM reconciliation, Leland pilot)',
    },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.elements) ? body.elements : [];
}

/**
 * Look-Near / Look-Far reconciliation pass restricted to the 15-mile Leland
 * pilot radius. Cache hits (Look-Near) never touch the network; only
 * uncached candidates fall through to the single Look-Far Overpass call.
 */
export async function runLelandReconciliationSweep() {
  ensureSpatialCorrectionsSchema();
  const database = getDb();
  const box = lelandBoundingBox();
  const candidates = database
    .prepare(`SELECT afdc_id, latitude, longitude FROM afdc_stations
              WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`)
    .all(box.minLat, box.maxLat, box.minLng, box.maxLng);

  const uncached = candidates.filter((s) => !getCorrection(s.afdc_id));
  if (uncached.length === 0) {
    return { scope: 'leland-15mi', candidates: candidates.length, uncached: 0, poisFound: 0, matched: 0, corrected: 0 };
  }

  const pois = await fetchOverpassChargingStations();

  let matched = 0;
  let corrected = 0;
  for (const station of uncached) {
    let bestPoi = null;
    let bestM = Infinity;
    for (const poi of pois) {
      if (!Number.isFinite(poi.lat) || !Number.isFinite(poi.lon)) continue;
      const m =
        haversineKm(
          { latitude: station.latitude, longitude: station.longitude },
          { latitude: poi.lat, longitude: poi.lon }
        ) * 1000;
      if (m < bestM) {
        bestM = m;
        bestPoi = poi;
      }
    }
    if (!bestPoi || bestM > OVERPASS_MATCH_MAX_M) continue;
    matched += 1;
    if (bestM < RECONCILE_DELTA_THRESHOLD_M) continue;
    applyCorrection({
      afdcId: station.afdc_id,
      correctedLat: bestPoi.lat,
      correctedLng: bestPoi.lon,
      source: 'overpass',
      deltaM: Math.round(bestM),
    });
    corrected += 1;
  }

  return {
    scope: 'leland-15mi',
    candidates: candidates.length,
    uncached: uncached.length,
    poisFound: pois.length,
    matched,
    corrected,
  };
}

let reconcileTimer = null;

/** Boot hook: arms the Leland-scoped background sweep on an unref'd interval. */
export function startSpatialReconciliation() {
  ensureSpatialCorrectionsSchema();
  seedLelandUatBaseline();
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    runLelandReconciliationSweep().catch((err) =>
      console.warn(`Spatial MDM reconciliation sweep failed (non-fatal): ${err.message}`)
    );
  }, RECONCILE_TICK_MS);
  reconcileTimer.unref();
  console.log(
    `[boot] spatial MDM reconciliation armed: Leland 15mi pilot every ${RECONCILE_TICK_MS}ms | ` +
    `source=overpass (${OVERPASS_URL}) | correction threshold=${RECONCILE_DELTA_THRESHOLD_M}m | ` +
    `UAT baseline: ${LELAND_UAT_BASELINE.length} manually-surveyed sites seeded`
  );
}

// Standalone runner: `node src/services/spatialCorrections.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  seedLelandUatBaseline();
  const result = await runLelandReconciliationSweep();
  console.log('Leland spatial MDM reconciliation sweep complete');
  console.log(`  ${JSON.stringify(result)}`);
}
