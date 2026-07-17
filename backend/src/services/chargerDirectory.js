import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRID_NODES,
  ISP_CARRIERS,
  getGridNode,
  getIspCarrier,
  resolveGridNode,
  resolveIspCarrier,
} from './infrastructureTopology.js';

// Shadow-ingestion directory: discovers real public charger locations around the
// fleet via OpenChargeMap and caches them in a local SQLite database so the
// topology/simulator layers (Tasks 6.2/6.3) can work fully offline.

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(SRC_DIR, '..', 'data');
export const DB_FILE = path.join(DATA_DIR, 'directory.db');
const SEED_FILE = path.join(SRC_DIR, '..', 'mockData', 'openChargeMapSeed.json');

const OCM_API_BASE = 'https://api.openchargemap.io/v3/poi/';

// Discovery region defaults to the fleet's home turf (Tustin HQ).
export const DEFAULT_DISCOVERY = {
  latitude: 33.7458,
  longitude: -117.8265,
  distanceKm: 20,
  maxResults: 50,
};

let db = null;

// Shared handle: the directory service owns the SQLite file; sibling services
// (simulator) attach their own tables through this accessor.
export function getDb() {
  if (!db) {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS directory_chargers (
        ocm_id           INTEGER PRIMARY KEY,
        name             TEXT NOT NULL,
        operator         TEXT,
        latitude         REAL NOT NULL,
        longitude        REAL NOT NULL,
        address          TEXT,
        town             TEXT,
        state            TEXT,
        postcode         TEXT,
        usage_cost       TEXT,
        num_points       INTEGER,
        connections_json TEXT NOT NULL,
        is_operational   INTEGER NOT NULL,
        data_source      TEXT NOT NULL,
        synced_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS directory_sync_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT NOT NULL,
        poi_count   INTEGER NOT NULL,
        latitude    REAL NOT NULL,
        longitude   REAL NOT NULL,
        distance_km REAL NOT NULL,
        synced_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grid_nodes (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        utility      TEXT NOT NULL,
        capacity_mva REAL NOT NULL,
        latitude     REAL NOT NULL,
        longitude    REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS isp_carriers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        network_type TEXT NOT NULL,
        technology   TEXT NOT NULL
      );
    `);
    migrateTopologyColumns(db);
    seedInfrastructureRegistries(db);
  }
  return db;
}

// Pre-6.2 databases lack the topology columns; add them idempotently.
function migrateTopologyColumns(database) {
  const columns = database
    .prepare("SELECT name FROM pragma_table_info('directory_chargers')")
    .all()
    .map((c) => c.name);
  if (!columns.includes('grid_node_id')) {
    database.exec('ALTER TABLE directory_chargers ADD COLUMN grid_node_id TEXT');
  }
  if (!columns.includes('isp_carrier_id')) {
    database.exec('ALTER TABLE directory_chargers ADD COLUMN isp_carrier_id TEXT');
  }
}

// Registries are code-authoritative; re-seed on every boot so DB mirrors the module.
function seedInfrastructureRegistries(database) {
  const putNode = database.prepare(`
    INSERT OR REPLACE INTO grid_nodes (id, name, utility, capacity_mva, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const n of GRID_NODES) {
    putNode.run(n.id, n.name, n.utility, n.capacityMVA, n.centroid.latitude, n.centroid.longitude);
  }
  const putCarrier = database.prepare(`
    INSERT OR REPLACE INTO isp_carriers (id, name, network_type, technology)
    VALUES (?, ?, ?, ?)
  `);
  for (const c of ISP_CARRIERS) {
    putCarrier.run(c.id, c.name, c.networkType, c.technology);
  }
}

/**
 * Deterministically bind every cached charger to its grid sub-node (nearest
 * centroid) and ISP carrier (zip district). Safe to re-run: same inputs always
 * produce the same bindings.
 */
export function assignTopology() {
  const database = getDb();
  const chargers = database
    .prepare('SELECT ocm_id, latitude, longitude, postcode, town FROM directory_chargers')
    .all();
  const bind = database.prepare(
    'UPDATE directory_chargers SET grid_node_id = ?, isp_carrier_id = ? WHERE ocm_id = ?'
  );
  for (const c of chargers) {
    const node = resolveGridNode(c.latitude, c.longitude);
    const carrier = resolveIspCarrier(c.postcode, c.town);
    bind.run(node?.id ?? null, carrier?.id ?? null, c.ocm_id);
  }
  return chargers.length;
}

/** Normalize an OpenChargeMap POI (live or seed — same shape) into a flat row. */
function normalizePoi(poi) {
  const addr = poi.AddressInfo ?? {};
  return {
    ocmId: poi.ID,
    name: addr.Title ?? `OCM-${poi.ID}`,
    operator: poi.OperatorInfo?.Title ?? 'Unknown',
    latitude: addr.Latitude,
    longitude: addr.Longitude,
    address: addr.AddressLine1 ?? null,
    town: addr.Town ?? null,
    state: addr.StateOrProvince ?? null,
    postcode: addr.Postcode ?? null,
    usageCost: poi.UsageCost ?? null,
    numPoints: poi.NumberOfPoints ?? null,
    connections: (poi.Connections ?? []).map((c) => ({
      type: c.ConnectionType?.Title ?? 'Unknown',
      powerKW: c.PowerKW ?? null,
      quantity: c.Quantity ?? 1,
    })),
    isOperational: poi.StatusType?.IsOperational !== false,
    dataSource: poi.DataProvider?.Title ?? 'Open Charge Map',
  };
}

async function fetchFromOpenChargeMap({ latitude, longitude, distanceKm, maxResults }) {
  const params = new URLSearchParams({
    output: 'json',
    latitude: String(latitude),
    longitude: String(longitude),
    distance: String(distanceKm),
    distanceunit: 'km',
    maxresults: String(maxResults),
    compact: 'true',
    verbose: 'false',
    key: process.env.OCM_API_KEY,
  });
  const res = await fetch(`${OCM_API_BASE}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenChargeMap responded ${res.status}`);
  return res.json();
}

async function loadSeedPois() {
  return JSON.parse(await readFile(SEED_FILE, 'utf8'));
}

/**
 * Discover chargers around the given point and upsert them into the local DB.
 * Uses the live OpenChargeMap API when OCM_API_KEY is set; otherwise (or on
 * network failure) falls back to the bundled seed fixture so the demo stays
 * deterministic and offline-capable.
 */
export async function syncDirectory(options = {}) {
  const query = { ...DEFAULT_DISCOVERY, ...options };
  let pois;
  let source;

  if (process.env.OCM_API_KEY) {
    try {
      pois = await fetchFromOpenChargeMap(query);
      source = 'openchargemap-live';
    } catch (err) {
      console.error(`OCM live fetch failed (${err.message}); falling back to seed fixture`);
    }
  }
  if (!pois) {
    pois = await loadSeedPois();
    source = 'seed-fixture';
  }

  const rows = pois
    .map(normalizePoi)
    .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));

  const database = getDb();
  const syncedAt = new Date().toISOString();
  const upsert = database.prepare(`
    INSERT INTO directory_chargers (
      ocm_id, name, operator, latitude, longitude, address, town, state,
      postcode, usage_cost, num_points, connections_json, is_operational,
      data_source, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ocm_id) DO UPDATE SET
      name = excluded.name,
      operator = excluded.operator,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      address = excluded.address,
      town = excluded.town,
      state = excluded.state,
      postcode = excluded.postcode,
      usage_cost = excluded.usage_cost,
      num_points = excluded.num_points,
      connections_json = excluded.connections_json,
      is_operational = excluded.is_operational,
      data_source = excluded.data_source,
      synced_at = excluded.synced_at
  `);

  database.exec('BEGIN');
  try {
    for (const r of rows) {
      upsert.run(
        r.ocmId, r.name, r.operator, r.latitude, r.longitude, r.address,
        r.town, r.state, r.postcode, r.usageCost, r.numPoints,
        JSON.stringify(r.connections), r.isOperational ? 1 : 0,
        r.dataSource, syncedAt
      );
    }
    database
      .prepare(`INSERT INTO directory_sync_log (source, poi_count, latitude, longitude, distance_km, synced_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(source, rows.length, query.latitude, query.longitude, query.distanceKm, syncedAt);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  assignTopology();

  return { source, synced: rows.length, syncedAt, query };
}

function rowToCharger(row) {
  return {
    ocmId: row.ocm_id,
    name: row.name,
    operator: row.operator,
    location: { latitude: row.latitude, longitude: row.longitude },
    address: {
      line1: row.address,
      town: row.town,
      state: row.state,
      postcode: row.postcode,
    },
    usageCost: row.usage_cost,
    numPoints: row.num_points,
    connections: JSON.parse(row.connections_json),
    isOperational: Boolean(row.is_operational),
    dataSource: row.data_source,
    syncedAt: row.synced_at,
    gridNode: getGridNode(row.grid_node_id),
    ispCarrier: getIspCarrier(row.isp_carrier_id),
  };
}

/** All cached directory chargers, plus sync provenance. */
export function getDirectory() {
  const database = getDb();
  const chargers = database
    .prepare('SELECT * FROM directory_chargers ORDER BY name')
    .all()
    .map(rowToCharger);
  const lastSync = database
    .prepare('SELECT source, poi_count, synced_at FROM directory_sync_log ORDER BY id DESC LIMIT 1')
    .get() ?? null;
  return {
    count: chargers.length,
    lastSync: lastSync
      ? { source: lastSync.source, poiCount: lastSync.poi_count, syncedAt: lastSync.synced_at }
      : null,
    chargers,
  };
}

/**
 * Infrastructure topology rollup: every grid sub-node and ISP carrier with its
 * member chargers, for the correlator (6.3/6.5) and map overlays (6.4).
 */
export function getTopology() {
  const database = getDb();
  const memberships = database
    .prepare('SELECT ocm_id, name, grid_node_id, isp_carrier_id FROM directory_chargers')
    .all();

  const membersOf = (key, id) =>
    memberships
      .filter((m) => m[key] === id)
      .map((m) => ({ ocmId: m.ocm_id, name: m.name }));

  return {
    gridNodes: GRID_NODES.map((n) => {
      const members = membersOf('grid_node_id', n.id);
      return { ...n, chargerCount: members.length, chargers: members };
    }),
    ispCarriers: ISP_CARRIERS.map((c) => {
      const members = membersOf('isp_carrier_id', c.id);
      return { ...c, chargerCount: members.length, chargers: members };
    }),
  };
}

/**
 * Boot hydration: sync once if the cache is empty, then (re)bind topology so
 * pre-existing databases pick up the 6.2 columns without a re-sync.
 */
export async function initDirectory() {
  const database = getDb();
  const { n } = database.prepare('SELECT COUNT(*) AS n FROM directory_chargers').get();
  if (n === 0) {
    const result = await syncDirectory();
    console.log(`Directory hydrated: ${result.synced} chargers from ${result.source}`);
  } else {
    const bound = assignTopology();
    console.log(`Directory cache ready: ${n} chargers (topology bound for ${bound})`);
  }
}
