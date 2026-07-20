import { getDb } from './chargerDirectory.js';
import { ensureFinancialSchema } from './tariffEngine.js';
import { boundsQueryParts } from './afdcSchema.js';
// Benign ESM cycle (afdcIngest imports CORRIDORS from here): both bindings
// are dereferenced only at call time, never during module evaluation.
import { GROUND_TRUTH_IDS } from './afdcIngest.js';
import { ensureSpatialCorrectionsSchema } from './spatialCorrections.js';

// National ingestion pipe (UOW-09 Task 9.1): pages and caches up to
// NATIONAL_TARGET real US public charger positions along the key shipping
// corridors into the national_chargers ledger (SQLite via node:sqlite). With
// no OpenChargeMap key present, a synthetic corridor seeder interpolates
// positions linearly between corridor waypoints with localized distribution
// noise — deterministic, so every boot reproduces the same national fleet.

export const NATIONAL_TARGET = 5000;

// UOW-11 Task 11.2: national map source-of-truth toggle. false = the AFDC
// real-world registry (afdc_stations, ~75k stations) supersedes the synthetic
// corridor waypoints — fresh boots no longer seed NAT-% rows. Legacy cached
// rows are retained read-only (they still feed the tariff/financial ledger)
// until Task 11.3 re-points the spatial cluster engine at afdc_stations.
export const USE_MOCK_DATA = false;

const OCM_API_BASE = 'https://api.openchargemap.io/v3/poi/';
const OCM_PAGE_SIZE = 250;
const OCM_WAYPOINT_RADIUS_KM = 60;

// Key transit lanes as waypoint polylines. Each waypoint carries the state it
// anchors so interpolated positions inherit a real tariff jurisdiction.
export const CORRIDORS = [
  {
    id: 'I95',
    name: 'I-95 Atlantic Seaboard',
    waypoints: [
      { lat: 25.77, lng: -80.19, state: 'FL' }, // Miami
      { lat: 30.33, lng: -81.66, state: 'FL' }, // Jacksonville
      { lat: 32.08, lng: -81.09, state: 'GA' }, // Savannah
      { lat: 34.19, lng: -79.83, state: 'SC' }, // Florence
      { lat: 37.54, lng: -77.44, state: 'VA' }, // Richmond
      { lat: 39.95, lng: -75.17, state: 'PA' }, // Philadelphia
      { lat: 40.71, lng: -74.01, state: 'NY' }, // New York
      { lat: 42.36, lng: -71.06, state: 'MA' }, // Boston
    ],
  },
  {
    id: 'I80',
    name: 'I-80 Transcontinental',
    waypoints: [
      { lat: 37.77, lng: -122.42, state: 'CA' }, // San Francisco
      { lat: 39.53, lng: -119.81, state: 'NV' }, // Reno
      { lat: 40.76, lng: -111.89, state: 'UT' }, // Salt Lake City
      { lat: 41.14, lng: -104.82, state: 'WY' }, // Cheyenne
      { lat: 41.26, lng: -95.93, state: 'NE' }, // Omaha
      { lat: 41.88, lng: -87.63, state: 'IL' }, // Chicago
      { lat: 41.65, lng: -83.54, state: 'OH' }, // Toledo
      { lat: 40.89, lng: -74.01, state: 'NJ' }, // Teaneck
    ],
  },
  {
    id: 'I10',
    name: 'I-10 Southern Sunbelt',
    waypoints: [
      { lat: 34.05, lng: -118.24, state: 'CA' }, // Los Angeles
      { lat: 33.45, lng: -112.07, state: 'AZ' }, // Phoenix
      { lat: 31.76, lng: -106.49, state: 'TX' }, // El Paso
      { lat: 29.42, lng: -98.49, state: 'TX' }, // San Antonio
      { lat: 29.76, lng: -95.37, state: 'TX' }, // Houston
      { lat: 29.95, lng: -90.07, state: 'LA' }, // New Orleans
      { lat: 30.33, lng: -81.66, state: 'FL' }, // Jacksonville
    ],
  },
  {
    id: 'I5',
    name: 'I-5 Pacific Corridor',
    waypoints: [
      { lat: 32.72, lng: -117.16, state: 'CA' }, // San Diego
      { lat: 34.05, lng: -118.24, state: 'CA' }, // Los Angeles
      { lat: 38.58, lng: -121.49, state: 'CA' }, // Sacramento
      { lat: 45.52, lng: -122.68, state: 'OR' }, // Portland
      { lat: 47.61, lng: -122.33, state: 'WA' }, // Seattle
    ],
  },
];

// Same deterministic PRNG family as the tariff ledger seeder.
function seededRng(seed) {
  let h = (seed >>> 0) || 1;
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function corridorLength(corridor) {
  let total = 0;
  for (let i = 1; i < corridor.waypoints.length; i += 1) {
    const a = corridor.waypoints[i - 1];
    const b = corridor.waypoints[i];
    total += Math.hypot(b.lat - a.lat, b.lng - a.lng);
  }
  return total;
}

/**
 * Synthetic fallback seeder: distributes each corridor's allocation linearly
 * along its waypoint segments, then jitters every position with minor
 * localized noise (±0.06° ≈ 6 km) so lanes read as organic clusters instead
 * of ruler lines. Deterministic per station id.
 */
export function generateSyntheticCorridorStations(target = NATIONAL_TARGET) {
  const lengths = CORRIDORS.map(corridorLength);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  const stations = [];

  CORRIDORS.forEach((corridor, ci) => {
    const allocation =
      ci === CORRIDORS.length - 1
        ? target - stations.length // last corridor absorbs rounding remainder
        : Math.round((lengths[ci] / totalLength) * target);
    const segments = corridor.waypoints.length - 1;

    for (let i = 0; i < allocation; i += 1) {
      const t = segments * (i / allocation);
      const seg = Math.min(Math.floor(t), segments - 1);
      const frac = t - seg;
      const a = corridor.waypoints[seg];
      const b = corridor.waypoints[seg + 1];

      const stationId = `NAT-${corridor.id}-${String(i + 1).padStart(4, '0')}`;
      const rand = seededRng(hashString(stationId));
      const lat = a.lat + (b.lat - a.lat) * frac + (rand() - 0.5) * 0.12;
      const lng = a.lng + (b.lng - a.lng) * frac + (rand() - 0.5) * 0.12;
      const anchor = frac < 0.5 ? a : b;

      stations.push({
        stationId,
        name: `${corridor.name} Plaza ${i + 1}`,
        state: anchor.state,
        town: null,
        latitude: Math.round(lat * 1e5) / 1e5,
        longitude: Math.round(lng * 1e5) / 1e5,
        cumulativeKwh: Math.round((40 + rand() * 2360) * 100) / 100,
        idleMinutes: Math.round(rand() * 70 * 100) / 100,
        activeGridSag: rand() < 0.18 ? 1 : 0,
      });
    }
  });

  return stations.slice(0, target);
}

async function fetchOcmPage(apiKey, waypoint, offset) {
  const params = new URLSearchParams({
    output: 'json',
    countrycode: 'US',
    latitude: String(waypoint.lat),
    longitude: String(waypoint.lng),
    distance: String(OCM_WAYPOINT_RADIUS_KM),
    distanceunit: 'km',
    maxresults: String(OCM_PAGE_SIZE),
    offset: String(offset),
    compact: 'true',
    verbose: 'false',
    key: apiKey,
  });
  const res = await fetch(`${OCM_API_BASE}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenChargeMap responded ${res.status}`);
  return res.json();
}

/**
 * Live discovery: page OpenChargeMap POIs around every corridor waypoint
 * (OCM_PAGE_SIZE per page, offset paging) until the national target is hit,
 * de-duplicating by OCM id across overlapping waypoint radii.
 */
async function fetchCorridorStationsLive(apiKey, target) {
  const seen = new Set();
  const stations = [];

  for (const corridor of CORRIDORS) {
    for (const waypoint of corridor.waypoints) {
      let offset = 0;
      for (;;) {
        if (stations.length >= target) return stations;
        const page = await fetchOcmPage(apiKey, waypoint, offset);
        if (!Array.isArray(page) || page.length === 0) break;
        for (const poi of page) {
          const addr = poi.AddressInfo ?? {};
          if (seen.has(poi.ID) || !Number.isFinite(addr.Latitude)) continue;
          seen.add(poi.ID);
          const stationId = `NAT-OCM-${poi.ID}`;
          const rand = seededRng(hashString(stationId));
          stations.push({
            stationId,
            name: addr.Title ?? stationId,
            state: addr.StateOrProvince ?? waypoint.state,
            town: addr.Town ?? null,
            latitude: addr.Latitude,
            longitude: addr.Longitude,
            // Financial telemetry is always simulated — OCM carries no meters.
            cumulativeKwh: Math.round((40 + rand() * 2360) * 100) / 100,
            idleMinutes: Math.round(rand() * 70 * 100) / 100,
            activeGridSag: rand() < 0.18 ? 1 : 0,
          });
          if (stations.length >= target) return stations;
        }
        if (page.length < OCM_PAGE_SIZE) break;
        offset += OCM_PAGE_SIZE;
      }
    }
  }
  return stations;
}

/**
 * Run the national ingestion: live OCM corridor paging when an API key is
 * present (OPENCHARGEMAP_API_KEY, with the legacy OCM_API_KEY honored),
 * synthetic corridor seeding otherwise or on live failure. Upserts into
 * national_chargers inside one transaction.
 */
export async function ingestNationalChargers(target = NATIONAL_TARGET) {
  const database = ensureFinancialSchema();
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_national_geo ON national_chargers (latitude, longitude)'
  );

  const apiKey = process.env.OPENCHARGEMAP_API_KEY ?? process.env.OCM_API_KEY;
  let stations = null;
  let source;

  if (apiKey) {
    try {
      stations = await fetchCorridorStationsLive(apiKey, target);
      source = 'openchargemap-live';
    } catch (err) {
      console.error(`National OCM paging failed (${err.message}); falling back to synthetic corridors`);
    }
  }
  if (!stations || stations.length === 0) {
    stations = generateSyntheticCorridorStations(target);
    source = 'synthetic-corridors';
  }

  const upsert = database.prepare(`
    INSERT INTO national_chargers (
      station_id, name, state, town, latitude, longitude,
      cumulative_kwh, idle_minutes, active_grid_sag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id) DO UPDATE SET
      name = excluded.name,
      state = excluded.state,
      town = excluded.town,
      latitude = excluded.latitude,
      longitude = excluded.longitude
  `);

  database.exec('BEGIN');
  try {
    for (const s of stations) {
      upsert.run(
        s.stationId, s.name, s.state, s.town, s.latitude, s.longitude,
        s.cumulativeKwh, s.idleMinutes, s.activeGridSag
      );
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  return { source, ingested: stations.length };
}

// --- Spatial boundary filtering & clustering (Task 9.2) ------------------------

export const CLUSTER_ZOOM_THRESHOLD = 10; // below this, pins bucket into clusters
export const STATION_MODE_CAP = 1500; // per-response pin ceiling at street zooms
const CELLS_PER_TILE_AXIS = 4;

/**
 * Server-side viewport query (UOW-11 Task 11.3): bounding-box selection rides
 * the afdc_geo R*Tree (via the canonical boundsQueryParts predicate) and joins
 * back to afdc_stations for metadata — the 5,000-row national_chargers ledger
 * is no longer consulted.
 *
 * 15×-density safeguard: at wide zooms the grid-bucket aggregation happens
 * INSIDE SQLite (integer cell ids + GROUP BY), so a full-CONUS viewport
 * reduces ~75k stations to a few hundred cluster rows entirely in C before a
 * single JS object materializes. Compared to the old pattern (materialize
 * every row, hash string keys into a Map), this removes ~75k object
 * allocations + string builds from the event loop per pan. CAST(x AS INTEGER)
 * truncates toward zero, which equals floor here because lat+90 and lng+180
 * are non-negative. In stations mode the ≤ STATION_MODE_CAP page is capped by
 * SQL LIMIT, with the true total from an rtree-only COUNT.
 *
 * `sagCount`/`activeGridSag` keep their wire names for the frontend and flag
 * genuinely unavailable stations only (status_code 'T' or unknown non-open).
 * Planned build-outs ('P') ride separately as `isPlanned`/`plannedCount` so
 * the UI can render neutral blueprint indicators instead of faults.
 *
 * UOW-17 Task 17.2: every coordinate read below LEFT JOINs
 * station_spatial_corrections and wraps latitude/longitude in
 * COALESCE(corrected, original) — a manual or geocoder-reconciled override
 * wins with zero extra round-trip, so precision fixes land on the live map
 * the instant they're written, not on the next AFDC bulk re-ingest.
 */
export function getSpatialClusters({ minLat, maxLat, minLng, maxLng, zoom }) {
  ensureSpatialCorrectionsSchema();
  const database = getDb();
  const { join, where, params } = boundsQueryParts({ minLat, maxLat, minLng, maxLng });
  const CORRECTIONS_JOIN = 'LEFT JOIN station_spatial_corrections c ON c.afdc_id = s.afdc_id';
  // UOW-14 Task 14.1: AFDC 'P' (planned build-out) is a blueprint, not a
  // fault — only genuinely unavailable stations (T, or unknown non-open
  // codes) feed attention counters. Planned sites travel as their own count.
  const ATTENTION = "CASE WHEN s.status_code IS NOT NULL AND s.status_code NOT IN ('E', 'P') THEN 1 ELSE 0 END";
  const PLANNED = "CASE WHEN s.status_code = 'P' THEN 1 ELSE 0 END";

  if (zoom >= CLUSTER_ZOOM_THRESHOLD) {
    const { total } = database
      .prepare(`SELECT COUNT(*) AS total FROM afdc_stations s ${join} WHERE ${where}`)
      .get(...params);
    // UOW-14 Task 14.1: when the in-bounds population exceeds the cap, an
    // unordered LIMIT returns an arbitrary (insert-order) page that can leave
    // whole corners of the viewport empty. Ranking by squared distance to the
    // viewport center keeps the page anchored on what the operator is looking
    // at — the close-up regional slice always survives the national cap.
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    const rows = database
      .prepare(`SELECT s.afdc_id, s.station_name, s.state, s.ev_network, s.status_code,
                       COALESCE(c.corrected_lat, s.latitude) AS latitude,
                       COALESCE(c.corrected_lng, s.longitude) AS longitude
                FROM afdc_stations s ${join} ${CORRECTIONS_JOIN} WHERE ${where}
                ORDER BY (latitude - ?) * (latitude - ?) + (longitude - ?) * (longitude - ?)
                LIMIT ${STATION_MODE_CAP}`)
      .all(...params, centerLat, centerLat, centerLng, centerLng);
    return {
      mode: 'stations',
      zoom,
      total,
      truncated: total > STATION_MODE_CAP,
      stations: rows.map((r) => ({
        stationId: `AFDC-${r.afdc_id}`,
        name: r.station_name,
        state: r.state,
        network: r.ev_network,
        statusCode: r.status_code,
        latitude: r.latitude,
        longitude: r.longitude,
        isPlanned: r.status_code === 'P',
        activeGridSag: r.status_code != null && r.status_code !== 'E' && r.status_code !== 'P',
        // UOW-15 Task 15.5: dictionary anchors render as neon validation pins.
        isGroundTruth: GROUND_TRUTH_IDS.has(r.afdc_id),
      })),
    };
  }

  // Grid buckets sized off the slippy-tile pyramid: each tile axis splits into
  // CELLS_PER_TILE_AXIS cells, so cluster granularity tracks the zoom level.
  const cellDeg = 360 / (2 ** zoom * CELLS_PER_TILE_AXIS);
  // UOW-15 Task 15.5: dictionary ids are a tiny static set, so inlining them
  // keeps the aggregate one pass; clusters holding a ground-truth anchor get
  // a neon treatment so the anchors stay locatable even when panned out.
  const GROUND_TRUTH = `CASE WHEN s.afdc_id IN (${[...GROUND_TRUTH_IDS].join(',')}) THEN 1 ELSE 0 END`;
  const CORRECTED_LAT = 'COALESCE(c.corrected_lat, s.latitude)';
  const CORRECTED_LNG = 'COALESCE(c.corrected_lng, s.longitude)';
  const rows = database
    .prepare(`SELECT CAST((${CORRECTED_LAT} + 90.0) / ? AS INTEGER) AS ci,
                     CAST((${CORRECTED_LNG} + 180.0) / ? AS INTEGER) AS cj,
                     COUNT(*) AS n,
                     AVG(${CORRECTED_LAT}) AS lat,
                     AVG(${CORRECTED_LNG}) AS lng,
                     SUM(${ATTENTION}) AS attention,
                     SUM(${PLANNED}) AS planned,
                     SUM(${GROUND_TRUTH}) AS groundTruth
              FROM afdc_stations s ${join} ${CORRECTIONS_JOIN} WHERE ${where}
              GROUP BY ci, cj`)
    .all(cellDeg, cellDeg, ...params);

  let total = 0;
  for (const r of rows) total += r.n;
  return {
    mode: 'clusters',
    zoom,
    total,
    cellDeg,
    clusters: rows.map((r) => ({
      key: `${r.ci}:${r.cj}`,
      count: r.n,
      sagCount: r.attention,
      plannedCount: r.planned,
      groundTruthCount: r.groundTruth,
      latitude: Math.round(r.lat * 1e5) / 1e5,
      longitude: Math.round(r.lng * 1e5) / 1e5,
    })),
  };
}

/** Boot hook: ingest once while the national ledger holds only the interim seed. */
export async function initNationalIngestion() {
  const database = ensureFinancialSchema();
  const { n } = database
    .prepare("SELECT COUNT(*) AS n FROM national_chargers WHERE station_id LIKE 'NAT-%'")
    .get();
  if (n > 0) {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_national_geo ON national_chargers (latitude, longitude)'
    );
    console.log(
      USE_MOCK_DATA
        ? `National ingestion: ledger warm (${n} corridor stations cached)`
        : `National ingestion: synthetic corridors DEPRECATED (USE_MOCK_DATA=false) — ${n} legacy rows retained for the tariff ledger until Task 11.3 re-points clustering to afdc_stations`
    );
    return { source: USE_MOCK_DATA ? 'cache' : 'deprecated-cache', ingested: 0, cached: n };
  }
  if (!USE_MOCK_DATA) {
    console.log('National ingestion: skipped — USE_MOCK_DATA=false, AFDC registry is the national source of truth');
    return { source: 'afdc-registry', ingested: 0, cached: 0 };
  }
  const result = await ingestNationalChargers();
  console.log(`National ingestion: ${result.ingested} corridor stations cached from ${result.source}`);
  return result;
}
