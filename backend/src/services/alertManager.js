import { getDb, DB_FILE } from './chargerDirectory.js';

// UOW-12 Task 12.1: centralized Alert Management service — the unified
// incident data store every fault vector (environmental simulator, telemetry
// degradation, future real OCPP feeds) will raise into. Alerts link to the
// AFDC registry through the wire-format station identity (`AFDC-<afdc_id>`;
// legacy fleet ids like `OC-…` pass through untouched, so both planes share
// one incident ledger).
//
// Transaction discipline (UOW-12 constraint): every state mutation runs inside
// an explicit BEGIN IMMEDIATE transaction. IMMEDIATE takes SQLite's write lock
// at BEGIN — not at first write — so the read-decide-write sequence inside
// raiseAlert/resolveAlert can never interleave with another writer's, which is
// what makes the 12.2 de-duplication sweep safe from lost updates. Status
// transitions are guarded in SQL (`WHERE status = 'OPEN'`) so a double-resolve
// is a detected no-op rather than a silent overwrite of resolved_at.

export const SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'];
export const ALERT_STATUS = { OPEN: 'OPEN', RESOLVED: 'RESOLVED' };

// Higher rank wins: a consolidated incident escalates to the worst severity
// seen across its grouped fault packets, never downgrades.
const SEVERITY_RANK = { INFO: 1, WARNING: 2, CRITICAL: 3 };

let migrated = false;

// UOW-13 Task 13.4: every alert read joins the AFDC registry so rows (and the
// SSE frames built from them) carry station_name/ev_network for the desk's
// operator search. The join key is computed per alert row — substr strips the
// 'AFDC-' prefix, and the equality probe rides afdc_stations' INTEGER PRIMARY
// KEY — so legacy ids (OC-…) simply null out via the LEFT JOIN. Resolved at
// migration time: a ledger opened standalone before the AFDC migration has no
// afdc_stations table to join, so we fall back to the bare select.
let alertSelect = 'SELECT a.* FROM alerts a';

function resolveAlertSelect(database) {
  const registryPresent = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'afdc_stations'")
    .get();
  if (registryPresent) {
    alertSelect = `SELECT a.*, s.station_name, s.ev_network
      FROM alerts a
      LEFT JOIN afdc_stations s
        ON a.station_id LIKE 'AFDC-%'
       AND s.afdc_id = CAST(substr(a.station_id, 6) AS INTEGER)`;
  }
}

/** Migration: unified alerts ledger + the (station_id, status) lookup index. */
export function ensureAlertSchema() {
  const database = getDb();
  if (migrated) return database;
  database.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id  TEXT NOT NULL,   -- AFDC-<id> registry link, or legacy fleet id
      alert_type  TEXT NOT NULL,
      severity    TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'WARNING', 'INFO')),
      status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
      message     TEXT NOT NULL,
      opened_at   TEXT NOT NULL,
      resolved_at TEXT,
      event_count  INTEGER NOT NULL DEFAULT 1,  -- fault packets grouped into this row (12.2)
      last_seen_at TEXT                         -- most recent grouped recurrence
    );
    -- Compound index: dedupe sweeps and open-incident lookups always filter by
    -- station identity first, then status — one index descent serves both.
    CREATE INDEX IF NOT EXISTS idx_alerts_station_status ON alerts (station_id, status);
  `);
  // In-place upgrade for ledgers created by the 12.1 migration.
  const columns = new Set(
    database.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name)
  );
  if (!columns.has('event_count')) {
    database.exec('ALTER TABLE alerts ADD COLUMN event_count INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.has('last_seen_at')) {
    database.exec('ALTER TABLE alerts ADD COLUMN last_seen_at TEXT');
  }
  // UOW-13 Task 13.1: the (station_id, status) index cannot serve the Alert
  // Desk's station-agnostic ledger read — station_id is its leftmost column,
  // so `WHERE status = 'OPEN'` alone would degrade to a full scan. OPEN rows
  // instead carry a dedicated partial expression index whose columns mirror
  // the ledger query's ORDER BY verbatim: the planner descends it already in
  // output order (CRITICAL first, newest activity first), no scan and no temp
  // B-tree sort pass. Partial (`WHERE status = 'OPEN'`) keeps it tiny — it
  // only ever holds live incidents, and resolved rows drop out on transition.
  // Created after the column upgrade above: the COALESCE expression references
  // last_seen_at, which pre-12.2 ledgers don't have yet.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_open_ledger ON alerts (
      (CASE severity WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END) DESC,
      (COALESCE(last_seen_at, opened_at)) DESC
    ) WHERE status = 'OPEN'
  `);
  resolveAlertSelect(database);
  migrated = true;
  return database;
}

// --- Incident event fan-out (SSE bridge) --------------------------------------

// Listeners fire AFTER COMMIT only — a stream frame must never describe state
// that could still roll back. Actions: INCIDENT_OPENED, INCIDENT_CONSOLIDATED,
// INCIDENT_RESOLVED.
const incidentListeners = new Set();

export function onIncidentEvent(listener) {
  incidentListeners.add(listener);
  return () => incidentListeners.delete(listener);
}

function emitIncident(action, alert) {
  for (const listener of incidentListeners) {
    try {
      listener({ action, alert });
    } catch (err) {
      console.error(`Incident listener failed: ${err.message}`);
    }
  }
}

/** Numeric AFDC ids normalize to the wire identity; string ids pass through. */
export function normalizeStationId(stationId) {
  if (Number.isInteger(stationId)) return `AFDC-${stationId}`;
  if (typeof stationId === 'string' && stationId.trim() !== '') return stationId.trim();
  throw new TypeError('stationId must be a non-empty string or an AFDC integer id');
}

function rowToAlert(row) {
  return row && {
    id: row.id,
    stationId: row.station_id,
    type: row.alert_type,
    severity: row.severity,
    status: row.status,
    message: row.message,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    eventCount: row.event_count,
    lastSeenAt: row.last_seen_at,
    stationName: row.station_name ?? null,
    network: row.ev_network ?? null,
  };
}

/**
 * Core entry point: raise a fault vector into the unified ledger, with the
 * 12.2 de-duplication loop riding the priorOpenCount anchor.
 *
 * Routing (all under one IMMEDIATE transaction, so the read-decide-write
 * sequence can never interleave with a concurrent raiser's):
 *   priorOpenCount === 0 → INSERT a fresh OPEN incident   → INCIDENT_OPENED
 *   priorOpenCount  >  0 → intercept: no new row. The station's newest OPEN
 *     incident absorbs the packet — event_count += 1, last_seen_at stamped,
 *     message refreshed to the latest telemetry recurrence, severity escalated
 *     if the incoming packet ranks worse   → INCIDENT_CONSOLIDATED
 *
 * The matching post-commit incident event fans out to the SSE bridge.
 */
export function raiseAlert({ stationId, type, severity, message }) {
  const station = normalizeStationId(stationId);
  if (typeof type !== 'string' || type.trim() === '') {
    throw new TypeError('type must be a non-empty string');
  }
  if (!SEVERITIES.includes(severity)) {
    throw new TypeError(`severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TypeError('message must be a non-empty string');
  }

  const database = ensureAlertSchema();
  const now = new Date().toISOString();
  let alert;
  let action;
  let priorOpenCount;

  database.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Group by station identity: the newest OPEN incident is the consolidation
    // target (older stragglers, if any, are left for the auto-closure sweep).
    const open = database
      .prepare(`SELECT * FROM alerts WHERE station_id = ? AND status = 'OPEN'
                ORDER BY opened_at DESC, id DESC`)
      .all(station);
    priorOpenCount = open.length;

    if (priorOpenCount > 0) {
      const target = open[0];
      const escalated =
        SEVERITY_RANK[severity] > SEVERITY_RANK[target.severity] ? severity : target.severity;
      database
        .prepare(`UPDATE alerts
                  SET event_count = event_count + 1, last_seen_at = ?, message = ?, severity = ?
                  WHERE id = ?`)
        .run(now, message.trim(), escalated, target.id);
      alert = rowToAlert(database.prepare(`${alertSelect} WHERE a.id = ?`).get(target.id));
      action = 'INCIDENT_CONSOLIDATED';
    } else {
      const { lastInsertRowid } = database
        .prepare(`INSERT INTO alerts (station_id, alert_type, severity, status, message,
                                      opened_at, event_count, last_seen_at)
                  VALUES (?, ?, ?, 'OPEN', ?, ?, 1, ?)`)
        .run(station, type.trim(), severity, message.trim(), now, now);
      alert = rowToAlert(database.prepare(`${alertSelect} WHERE a.id = ?`).get(lastInsertRowid));
      action = 'INCIDENT_OPENED';
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  emitIncident(action, alert);
  return { ...alert, action, deduplicated: action === 'INCIDENT_CONSOLIDATED', priorOpenCount };
}

/**
 * Guarded OPEN → RESOLVED transition. Returns the resolved alert, or null when
 * the alert was already resolved (or unknown) — the WHERE guard makes the
 * transition atomic, so concurrent resolvers cannot clobber resolved_at.
 */
export function resolveAlert(alertId) {
  const database = ensureAlertSchema();
  database.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const { changes } = database
      .prepare("UPDATE alerts SET status = 'RESOLVED', resolved_at = ? WHERE id = ? AND status = 'OPEN'")
      .run(new Date().toISOString(), alertId);
    const alert = changes === 1
      ? rowToAlert(database.prepare(`${alertSelect} WHERE a.id = ?`).get(alertId))
      : null;
    database.exec('COMMIT');
    if (alert) emitIncident('INCIDENT_RESOLVED', alert);
    return alert;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/**
 * UOW-12 Task 12.3: condition-driven auto-closure. Called when an asset
 * reports a healthy signal again (AFDC status back to 'E', simulator outage
 * flag dropped): every OPEN incident for the station — optionally narrowed to
 * one alert_type when only a specific fault condition cleared — transitions
 * RESOLVED with a stamped resolved_at.
 *
 * Same transaction discipline as the raise path: the find (which rows are
 * OPEN) and the guarded mutation (`… WHERE status = 'OPEN'`) commit atomically
 * under BEGIN IMMEDIATE, so a concurrent raiser either lands its packet before
 * the sweep (and gets closed with it) or after COMMIT (and opens a fresh
 * incident) — never a half-closed interleave. One INCIDENT_RESOLVED event fans
 * out per closed row, post-commit only.
 *
 * Returns the resolved alerts (empty array when the station was already
 * clean — a nominal heartbeat with nothing open is a no-op, not an error).
 */
export function clearAlerts({ stationId, type = null }) {
  const station = normalizeStationId(stationId);
  if (type !== null && (typeof type !== 'string' || type.trim() === '')) {
    throw new TypeError('type, when provided, must be a non-empty string');
  }

  const database = ensureAlertSchema();
  const now = new Date().toISOString();
  let resolved = [];

  database.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Find phase: index descent on (station_id, status), then the optional
    // fault-condition narrowing.
    const openIds = database
      .prepare(`SELECT id FROM alerts WHERE station_id = ? AND status = 'OPEN'
                ${type ? 'AND alert_type = ?' : ''} ORDER BY id`)
      .all(...(type ? [station, type.trim()] : [station]))
      .map((r) => r.id);

    if (openIds.length > 0) {
      const marks = openIds.map(() => '?').join(', ');
      // Guarded mutation: the status predicate rides into the UPDATE too, so
      // rows resolved by any other path since the read are skipped, never
      // re-stamped.
      database
        .prepare(`UPDATE alerts SET status = 'RESOLVED', resolved_at = ?
                  WHERE id IN (${marks}) AND status = 'OPEN'`)
        .run(now, ...openIds);
      resolved = database
        .prepare(`${alertSelect} WHERE a.id IN (${marks}) AND a.resolved_at = ?`)
        .all(...openIds, now)
        .map(rowToAlert);
    }
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  for (const alert of resolved) emitIncident('INCIDENT_RESOLVED', alert);
  return resolved;
}

/** Open incidents for one station — rides idx_alerts_station_status. */
export function getOpenAlerts(stationId) {
  const database = ensureAlertSchema();
  return database
    .prepare(`${alertSelect} WHERE a.station_id = ? AND a.status = 'OPEN' ORDER BY a.opened_at DESC`)
    .all(normalizeStationId(stationId))
    .map(rowToAlert);
}

/**
 * UOW-13 Task 13.1: the Alert Desk hydration read — every OPEN incident,
 * CRITICAL first, then most recent activity (last_seen_at, falling back to
 * opened_at for never-consolidated rows). WHERE and ORDER BY match
 * idx_alerts_open_ledger's definition expression-for-expression, which is what
 * lets SQLite satisfy both the filter and the sort with one partial-index
 * descent (verified in the migration runner's EXPLAIN QUERY PLAN).
 */
export function listOpenLedger({ limit = 200 } = {}) {
  const database = ensureAlertSchema();
  const capped = Math.min(Math.max(1, limit), 500);
  return database
    .prepare(`${alertSelect} WHERE a.status = 'OPEN'
              ORDER BY (CASE a.severity WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END) DESC,
                       (COALESCE(a.last_seen_at, a.opened_at)) DESC
              LIMIT ?`)
    .all(capped)
    .map(rowToAlert);
}

/** Ledger listing, newest first, optionally filtered by status. */
export function listAlerts({ status = null, limit = 100 } = {}) {
  const database = ensureAlertSchema();
  const capped = Math.min(Math.max(1, limit), 500);
  const rows = status
    ? database
        .prepare(`${alertSelect} WHERE a.status = ? ORDER BY a.opened_at DESC LIMIT ?`)
        .all(status, capped)
    : database.prepare(`${alertSelect} ORDER BY a.opened_at DESC LIMIT ?`).all(capped);
  return rows.map(rowToAlert);
}

// Standalone migration runner: `node src/services/alertManager.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const database = ensureAlertSchema();
  const objects = database
    .prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'idx_alerts%' OR name = 'alerts' ORDER BY name")
    .all();
  const plan = database
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM alerts WHERE station_id = ? AND status = 'OPEN'")
    .all('AFDC-200001');
  const ledgerPlan = database
    .prepare(`EXPLAIN QUERY PLAN ${alertSelect} WHERE a.status = 'OPEN'
              ORDER BY (CASE a.severity WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END) DESC,
                       (COALESCE(a.last_seen_at, a.opened_at)) DESC
              LIMIT 200`)
    .all();
  console.log(`Alert schema migration applied to ${DB_FILE}`);
  console.log(`  objects: ${objects.map((o) => `${o.name} (${o.type})`).join(', ')}`);
  console.log(`  lookup plan: ${plan.map((p) => p.detail).join(' | ')}`);
  console.log(`  ledger plan: ${ledgerPlan.map((p) => p.detail).join(' | ')}`);
}
