import { getDb, DB_FILE } from './chargerDirectory.js';

// UOW-11 Task 11.1: schema migration for the real-world NREL AFDC station
// registry (~75,000 US public stations). Spatial lookups are the hot path —
// the /api/v1/fleet/spatial-cluster engine fires a bounding-box query on every
// map pan — so the migration establishes an R*Tree virtual table as the
// primary spatial index, with a compound B-Tree fallback when the deploy
// environment's SQLite build lacks the rtree extension.
//
// Index rationale:
// - R*Tree turns a 2-D box lookup into an O(log n) tree descent regardless of
//   how the box is shaped. A plain B-Tree on (latitude, longitude) can only
//   range-scan the FIRST column: a CONUS-wide latitude band still sweeps every
//   longitude in it, which degrades exactly at the 75k-row density this
//   migration is sized for.
// - Stations are points, stored as degenerate boxes (min == max). The rtree
//   holds only id + 4 coords; all metadata stays in the base table and joins
//   back by primary key.
// - AFTER INSERT/UPDATE/DELETE triggers on the base table keep the rtree in
//   lockstep inside the same transaction as any write — ingestion code (11.2)
//   never has to remember to maintain the index. (SQLite forbids triggers ON
//   virtual tables, but triggers writing INTO one are fine.)
// - Fallback path (no rtree): compound index (latitude, longitude) so the
//   latitude range-scan carries longitude ordering with it, plus a standalone
//   longitude index to give the planner an index-intersection option.

let migrated = null;

// UOW-14 Task 14.4: bump whenever the seed's coordinate geometry changes.
// A mismatch forces the destructive wipe below on next boot, so a deployed
// container (Railway included) shreds every cached stale row and re-ingests
// with the current topology — exactly once, not on every reboot.
// v6 (UOW-15 Task 15.1): dual Leland ground-truth anchors (Supercharger Hub +
// Piggly Wiggly node) land in the seed; any cached pre-v6 registry — including
// lingering ocean/lake rows from pre-14.4 geometry — is dropped on boot.
// v7 (UOW-15 Task 15.3): UAT caught a primary-key ↔ metadata cross-wire
// (AFDC-199999 carried the Smithfield's label on what are really Brunswick
// Forest ChargePoint coordinates). The Leland sector is now owned exclusively
// by the static GROUND_TRUTH_DICTIONARY (procedural generation excluded from
// the sector box), so v7 shreds every cross-wired row and recompiles the
// registry against the corrected dictionary bindings.
// v8 (UOW-15 Task 15.5): sequential mapping slip corrected — real-world
// AFDC-199997 is the Piggly Wiggly (112 Village Rd NE); Smithfield's moves to
// the discrete 199996. v8 scrubs the cross-wired label rows atomically.
// v9 (UOW-15 Task 15.6): Smithfield's beacon shifted ~1.2 mi southwest off
// the "Leland" map label to the land-verified Olde Regent Way plaza parking
// lot (34.2185/-78.0145); v9 purges the v8 rows and re-synthesizes clean.
// v11 (UOW-16 Task 16.4): the Diagnostic Reference Pin crosshair surveyed the
// true Smithfield's retail plaza parking lot at exactly 34.217440/-78.018444 —
// AFDC-199996 snaps to the measured signature. Version jumps straight past
// v10 per the PO's numbering; the gate only tests inequality, so any cached
// pre-v11 registry (and its tier-2 snapshot) is shredded on boot regardless.
// v12 (UOW-18 Task 18.2): two more surveyed Leland-sector sites join the
// ground-truth dictionary — AFDC-199994 Blink Charging (Ocean Hwy E) and
// AFDC-199993 EnviroSpark Charging (Belville). AFDC-199996 keeps its v11
// crosshair coordinate; the PO's 18.2 sheet still lists the earlier Olde
// Regent Way estimate for it, but regressing a verified survey fix would be
// a step backward, not a correction.
// v13 (UOW-21): the static GROUND_TRUTH_DICTIONARY special-case is retired.
// Every station — Leland sector included — now derives its coordinate through
// the same uniform ingest-time geocoding-cleanse pipeline (afdcIngest.js's
// backfillGeocodePrecision, backed by geocodeEngine.js's tiered Census ->
// Nominatim lookup). The new `precision_score` column ('ROOFTOP_INTERPOLATED'
// once a real geocoder hit lands, NULL until then) replaces the dictionary's
// hardcoded-anchor concept: precision is now a property any station in the
// fleet can earn, not a privilege reserved for five hand-picked ids.
export const AFDC_SEED_VERSION = 13;

export function ensureAfdcSchema() {
  if (migrated) return migrated;
  const database = getDb();

  // Destructive refresh gate: stale seed geometry cannot survive a deploy.
  database.exec('CREATE TABLE IF NOT EXISTS afdc_meta (key TEXT PRIMARY KEY, value TEXT)');
  const versionRow = database
    .prepare("SELECT value FROM afdc_meta WHERE key = 'seed_version'")
    .get();
  let wiped = false;
  if (!versionRow || Number(versionRow.value) !== AFDC_SEED_VERSION) {
    wiped = true;
    console.warn(
      `AFDC schema: seed geometry v${versionRow?.value ?? 'none'} → v${AFDC_SEED_VERSION} — dropping stale registry for full re-ingest`
    );
    database.exec(`
      DROP TRIGGER IF EXISTS afdc_geo_after_insert;
      DROP TRIGGER IF EXISTS afdc_geo_after_update;
      DROP TRIGGER IF EXISTS afdc_geo_after_delete;
      DROP TABLE IF EXISTS afdc_geo;
      DROP TABLE IF EXISTS afdc_stations;
    `);
    database
      .prepare(`INSERT INTO afdc_meta (key, value) VALUES ('seed_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(AFDC_SEED_VERSION));
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS afdc_stations (
      afdc_id          INTEGER PRIMARY KEY,  -- AFDC source record id
      station_name     TEXT NOT NULL,
      street_address   TEXT,
      city             TEXT,
      state            TEXT,
      zip              TEXT,
      latitude         REAL NOT NULL,
      longitude        REAL NOT NULL,
      fuel_type_code   TEXT NOT NULL DEFAULT 'ELEC',
      access_days_time TEXT,
      ev_network       TEXT,                 -- operating network (ChargePoint, Tesla, …)
      status_code      TEXT,                 -- AFDC: E=open, P=planned, T=temporarily unavailable
      ev_dc_fast_num   INTEGER,              -- DC fast port count
      ev_level2_num    INTEGER,              -- Level-2 port count
      updated_at       TEXT,                 -- AFDC record freshness stamp
      synced_at        TEXT NOT NULL,
      precision_score  TEXT                  -- NULL | 'ROOFTOP_INTERPOLATED' (UOW-21 geocode-cleanse tag)
    );
    CREATE INDEX IF NOT EXISTS idx_afdc_state ON afdc_stations (state);
  `);

  let rtree = false;
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS afdc_geo USING rtree(
        id,               -- = afdc_stations.afdc_id
        min_lat, max_lat, -- degenerate box: point stations store min == max
        min_lng, max_lng
      );
    `);
    // DELETE + plain INSERT rather than INSERT OR REPLACE: SQLite overrides a
    // trigger body's conflict policy with the outer statement's ON CONFLICT
    // clause, so under the 11.2 bulk upsert (ON CONFLICT DO UPDATE) an OR
    // REPLACE here silently degrades to ABORT and re-ingestion dies on the
    // rtree's id uniqueness. DELETE carries no conflict policy to override.
    // DROP + CREATE (not IF NOT EXISTS) migrates databases holding the old
    // OR REPLACE trigger bodies in place.
    database.exec(`
      DROP TRIGGER IF EXISTS afdc_geo_after_insert;
      DROP TRIGGER IF EXISTS afdc_geo_after_update;
      DROP TRIGGER IF EXISTS afdc_geo_after_delete;
      CREATE TRIGGER afdc_geo_after_insert
      AFTER INSERT ON afdc_stations BEGIN
        DELETE FROM afdc_geo WHERE id = NEW.afdc_id;
        INSERT INTO afdc_geo
        VALUES (NEW.afdc_id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
      END;
      CREATE TRIGGER afdc_geo_after_update
      AFTER UPDATE OF latitude, longitude ON afdc_stations BEGIN
        DELETE FROM afdc_geo WHERE id = NEW.afdc_id;
        INSERT INTO afdc_geo
        VALUES (NEW.afdc_id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
      END;
      CREATE TRIGGER afdc_geo_after_delete
      AFTER DELETE ON afdc_stations BEGIN
        DELETE FROM afdc_geo WHERE id = OLD.afdc_id;
      END;
    `);
    rtree = true;
  } catch (err) {
    // Optimization note: without rtree, the compound (lat, lng) B-Tree makes
    // the latitude range-scan emit rows already ordered by longitude, and the
    // standalone longitude index lets the planner intersect both dimensions.
    // Adequate to ~75k rows; beyond that, upgrade the runtime to an
    // rtree-enabled SQLite rather than tuning further here.
    console.warn(`AFDC schema: rtree unavailable (${err.message}); falling back to B-Tree indices`);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_afdc_lat_lng ON afdc_stations (latitude, longitude);
      CREATE INDEX IF NOT EXISTS idx_afdc_lng ON afdc_stations (longitude);
    `);
  }

  // `wiped` rides the memoized result so the ingest orchestrator (which may
  // run long after another module triggered this migration) can tell that the
  // registry was force-dropped and must also invalidate its snapshot cache.
  migrated = { rtree, wiped };
  return migrated;
}

/**
 * Canonical spatial predicate over afdc_stations (aliased `s`), shared by the
 * row helper below and the 11.3 clustering engine so every consumer rides the
 * same R*Tree/B-Tree strategy. rtree coords are float32 rounded outward, so a
 * point box may poke past a query edge in either direction: overlap semantics
 * (not containment) keep edge stations from dropping out, and the float64 base
 * columns re-check exactness on the survivors, discarding any widened-box
 * false positives.
 */
export function boundsQueryParts({ minLat, maxLat, minLng, maxLng }) {
  const { rtree } = ensureAfdcSchema();
  const [lo, hi] = [Math.min(minLat, maxLat), Math.max(minLat, maxLat)];
  const [west, east] = [Math.min(minLng, maxLng), Math.max(minLng, maxLng)];
  return rtree
    ? {
        join: 'JOIN afdc_geo g ON g.id = s.afdc_id',
        where: `g.max_lat >= ? AND g.min_lat <= ? AND g.max_lng >= ? AND g.min_lng <= ?
                AND s.latitude BETWEEN ? AND ? AND s.longitude BETWEEN ? AND ?`,
        params: [lo, hi, west, east, lo, hi, west, east],
      }
    : {
        join: '',
        where: 's.latitude BETWEEN ? AND ? AND s.longitude BETWEEN ? AND ?',
        params: [lo, hi, west, east],
      };
}

/** Full-row bounding-box lookup routed through the canonical predicate. */
export function queryStationsInBounds(bounds) {
  const { join, where, params } = boundsQueryParts(bounds);
  return getDb()
    .prepare(`SELECT s.* FROM afdc_stations s ${join} WHERE ${where}`)
    .all(...params);
}

// Standalone migration runner: `node src/services/afdcSchema.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { rtree } = ensureAfdcSchema();
  const database = getDb();
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'afdc%' ORDER BY name")
    .all()
    .map((t) => t.name);
  console.log(`AFDC migration applied to ${DB_FILE}`);
  console.log(`  spatial strategy: ${rtree ? 'R*Tree virtual table + sync triggers' : 'compound B-Tree fallback'}`);
  console.log(`  objects: ${tables.join(', ')}`);
}
