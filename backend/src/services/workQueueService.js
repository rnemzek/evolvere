import { getDb } from './chargerDirectory.js';

// UOW-17 Task 17.3: RCA Operational Work Queue. The fleet-station Root Cause
// Analysis correlator (triageService's causeClass classification, backed by
// the Cross-Layer Spatial Correlator) already tells us WHY a connector is
// down; this service turns that verdict into WHAT happens next: an isolated
// hardware fault needs a technician in the parking lot (TRUCK_ROLL), while a
// confirmed regional grid or carrier outage needs a phone call instead
// (UTILITY_TICKET / ISP_TICKET) — dispatching a truck against those would be
// exactly the wasted roll the ROI panel already credits itself for avoiding.
//
// One task row per incident lifecycle: incident_id (the triage brief's
// chargerId:connectorId key) is UNIQUE, so a reclassification (LOCAL_HARDWARE
// upgraded to EXTERNAL_GRID_FAILURE once the correlator crosses cohesion)
// rewrites the existing row in place instead of leaving a stale duplicate
// behind, and a resolved-then-reopened incident cleanly reopens the same row.

export const TASK_TYPES = ['TRUCK_ROLL', 'UTILITY_TICKET', 'ISP_TICKET'];
const PRIORITIES = ['CRITICAL', 'WARNING', 'INFO'];

// causeClass → dispatch classification. ENVIRONMENTAL_WEATHER intentionally
// raises no task: triageService's own SOP text is "hold dispatch until the
// cell clears" — not a truck roll, and not a ticket against a utility/carrier
// that isn't actually at fault.
const CLASSIFICATION = {
  LOCAL_HARDWARE: { taskType: 'TRUCK_ROLL', costImpact: 250 },
  EXTERNAL_GRID_FAILURE: { taskType: 'UTILITY_TICKET', costImpact: 0 },
  EXTERNAL_NETWORK_DROP: { taskType: 'ISP_TICKET', costImpact: 0 },
};

let migrated = false;

export function ensureWorkQueueSchema() {
  if (migrated) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS work_queue_tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id   TEXT NOT NULL UNIQUE,  -- triage brief key: chargerId:connectorId
      station_id    TEXT NOT NULL,
      task_type     TEXT NOT NULL CHECK (task_type IN ('TRUCK_ROLL', 'UTILITY_TICKET', 'ISP_TICKET')),
      priority      TEXT NOT NULL CHECK (priority IN ('CRITICAL', 'WARNING', 'INFO')),
      cost_impact   REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DISPATCHED', 'CLOSED')),
      created_at    TEXT NOT NULL,
      dispatched_at TEXT,
      closed_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_queue_status ON work_queue_tasks (status);
  `);
  migrated = true;
}

function rowToTask(row) {
  return row && {
    id: row.id,
    incidentId: row.incident_id,
    stationId: row.station_id,
    taskType: row.task_type,
    priority: row.priority,
    costImpact: row.cost_impact,
    status: row.status,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    closedAt: row.closed_at,
  };
}

/**
 * Raise or update the dispatch task for one incident — called by the RCA
 * correlator (triageService) whenever a brief is raised, reclassified, or
 * spatially upgraded. Returns null for cause classes that carry no dispatch
 * action.
 */
export function raiseTask({ incidentId, stationId, causeClass, severity }) {
  const classification = CLASSIFICATION[causeClass];
  if (!classification) return null;
  const priority = PRIORITIES.includes(severity) ? severity : 'WARNING';

  ensureWorkQueueSchema();
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      INSERT INTO work_queue_tasks (incident_id, station_id, task_type, priority, cost_impact, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
      ON CONFLICT(incident_id) DO UPDATE SET
        station_id = excluded.station_id,
        task_type = excluded.task_type,
        priority = excluded.priority,
        cost_impact = excluded.cost_impact,
        status = 'OPEN',
        dispatched_at = NULL,
        closed_at = NULL
    `)
    .run(incidentId, stationId, classification.taskType, priority, classification.costImpact, now);
  return rowToTask(database.prepare('SELECT * FROM work_queue_tasks WHERE incident_id = ?').get(incidentId));
}

/** Close the task tied to an incident once the underlying alert clears. */
export function closeTask(incidentId) {
  ensureWorkQueueSchema();
  const database = getDb();
  const { changes } = database
    .prepare(`UPDATE work_queue_tasks SET status = 'CLOSED', closed_at = ?
              WHERE incident_id = ? AND status != 'CLOSED'`)
    .run(new Date().toISOString(), incidentId);
  return changes === 1
    ? rowToTask(database.prepare('SELECT * FROM work_queue_tasks WHERE incident_id = ?').get(incidentId))
    : null;
}

/** Operator dispatch action (Dispatch Board button): OPEN → DISPATCHED. */
export function markDispatched(taskId) {
  ensureWorkQueueSchema();
  const database = getDb();
  const { changes } = database
    .prepare(`UPDATE work_queue_tasks SET status = 'DISPATCHED', dispatched_at = ?
              WHERE id = ? AND status = 'OPEN'`)
    .run(new Date().toISOString(), taskId);
  return changes === 1
    ? rowToTask(database.prepare('SELECT * FROM work_queue_tasks WHERE id = ?').get(taskId))
    : null;
}

export function listTasks({ status = null, limit = 200 } = {}) {
  ensureWorkQueueSchema();
  const database = getDb();
  const capped = Math.min(Math.max(1, limit), 500);
  const rank = "CASE priority WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END";
  const rows = status
    ? database
        .prepare(`SELECT * FROM work_queue_tasks WHERE status = ? ORDER BY ${rank} DESC, created_at DESC LIMIT ?`)
        .all(status, capped)
    : database
        .prepare(`SELECT * FROM work_queue_tasks ORDER BY ${rank} DESC, created_at DESC LIMIT ?`)
        .all(capped);
  return rows.map(rowToTask);
}

/** Dispatch Board summary strip: open/dispatched/closed counts + per-type mix. */
export function getQueueSummary() {
  ensureWorkQueueSchema();
  const database = getDb();
  const rows = database
    .prepare(`SELECT status, task_type, COUNT(*) AS n
              FROM work_queue_tasks GROUP BY status, task_type`)
    .all();

  const summary = {
    open: 0,
    dispatched: 0,
    closed: 0,
    byType: { TRUCK_ROLL: 0, UTILITY_TICKET: 0, ISP_TICKET: 0 },
    avoidedTruckRollCount: 0,
  };
  for (const row of rows) {
    const statusKey = row.status.toLowerCase();
    if (statusKey in summary) summary[statusKey] += row.n;
    summary.byType[row.task_type] = (summary.byType[row.task_type] ?? 0) + row.n;
    if (row.task_type !== 'TRUCK_ROLL') summary.avoidedTruckRollCount += row.n;
  }
  return summary;
}

// Standalone migration runner: `node src/services/workQueueService.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureWorkQueueSchema();
  console.log('Work queue schema migration applied');
  console.log(`  summary: ${JSON.stringify(getQueueSummary())}`);
}
