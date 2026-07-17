import { getDb } from './chargerDirectory.js';
import { getGridNode, getIspCarrier, haversineKm } from './infrastructureTopology.js';
import { resolveFleetTopology, listEvents } from './environmentalSimulator.js';

// AI Diagnostic Brief triage (UOW-06 Task 6.5). When a connector faults, the
// interceptor looks up the station's topology bindings, cross-references active
// environmental events, and synthesizes a deterministic SOP brief that is
// persisted immediately — the frontend reads the pre-cached payload with zero
// generation latency.

let tableReady = false;

function db() {
  const database = getDb();
  if (!tableReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS alert_briefs (
        charger_id   TEXT NOT NULL,
        connector_id INTEGER NOT NULL,
        code         TEXT NOT NULL,
        cause_class  TEXT NOT NULL,
        event_id     TEXT,
        brief        TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (charger_id, connector_id)
      );
      CREATE TABLE IF NOT EXISTS alert_incident_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        charger_id   TEXT NOT NULL,
        connector_id INTEGER NOT NULL,
        code         TEXT NOT NULL,
        cause_class  TEXT NOT NULL,
        event_id     TEXT,
        created_at   TEXT NOT NULL,
        resolved_at  TEXT
      );
    `);
    tableReady = true;
  }
  return database;
}

/**
 * Infrastructure context interceptor: the station's topology bindings plus any
 * active environmental incident that overlaps them (matching grid sub-node,
 * matching ISP carrier, or weather cell covering the coordinates).
 */
function interceptContext(station) {
  const { gridNodeId, ispCarrierId } = resolveFleetTopology(station);
  const active = listEvents();

  const gridEvent = active.find(
    (e) => e.type === 'GRID_FAILURE' && e.targetId === gridNodeId
  );
  const networkEvent = active.find(
    (e) => e.type === 'NETWORK_DROP' && e.targetId === ispCarrierId
  );
  const weatherEvent = active.find(
    (e) =>
      e.type === 'WEATHER_IMPACT' &&
      e.center &&
      haversineKm(e.center, station.location) <= e.radiusKm
  );

  return { gridNodeId, ispCarrierId, gridEvent, networkEvent, weatherEvent };
}

/**
 * Pick the incident that explains this fault: the code planted by the simulator
 * has first claim, then any overlapping incident by blast-radius severity.
 */
function matchIncident(code, ctx) {
  const byCode = {
    Power_Loss: ctx.gridEvent,
    Comms_Loss: ctx.networkEvent,
    Weather_Impact: ctx.weatherEvent,
  }[code];
  return byCode ?? ctx.gridEvent ?? ctx.networkEvent ?? ctx.weatherEvent ?? null;
}

function synthesizeBrief({ station, connectorId, code, ctx }) {
  const incident = matchIncident(code, ctx);
  const node = getGridNode(ctx.gridNodeId);
  const carrier = getIspCarrier(ctx.ispCarrierId);
  const port = `Station ${station.chargerId} port ${connectorId}`;

  if (incident?.type === 'GRID_FAILURE') {
    const fleetHit = incident.affected.fleetStations.length;
    const publicHit = incident.affected.directoryChargers.length;
    return {
      causeClass: 'EXTERNAL_GRID_FAILURE',
      eventId: incident.id,
      brief:
        `[Nemzilla AI Analysis — Infrastructure Correlated]: ${port} reports total input power loss, ` +
        `cross-referenced with ACTIVE grid incident ${incident.id} at ${node.name} (${node.utility}, ${node.capacityMVA} MVA). ` +
        `Localized power drop confirmed across the sub-node: ${fleetHit} fleet stations and ${publicHit} public sites went dark on the same timestamp. ` +
        `Probable Cause: Regional substation outage upstream of all site equipment. ` +
        `SOP Action: External grid issue. Do not dispatch field technicians. Escalating to utility grid manager with incident reference ${incident.id}; ` +
        `stations auto-recover on grid restoration. Truck roll suppressed (est. $250 saved per avoided dispatch).`,
    };
  }

  if (incident?.type === 'NETWORK_DROP') {
    const silentNeighbors =
      incident.affected.fleetStations.filter((s) => s.chargerId !== station.chargerId).length +
      incident.affected.directoryChargers.length;
    return {
      causeClass: 'EXTERNAL_NETWORK_DROP',
      eventId: incident.id,
      brief:
        `[Nemzilla AI Analysis — Infrastructure Correlated]: ${port} heartbeat lost, ` +
        `cross-referenced with ACTIVE ${carrier.name} outage ${incident.id} (${carrier.technology}). ` +
        `${silentNeighbors} neighboring nodes on the same carrier are silent simultaneously — charging hardware is likely healthy and unreachable, not failed. ` +
        `Probable Cause: Carrier cellular outage detected. ` +
        `SOP Action: Verify local site host Wi-Fi fallback connectivity before scheduling hardware service. ` +
        `Offline sessions continue locally; billing data backfills on reconnection. Suppress dispatch pending carrier restoration.`,
    };
  }

  if (incident?.type === 'WEATHER_IMPACT') {
    return {
      causeClass: 'ENVIRONMENTAL_WEATHER',
      eventId: incident.id,
      brief:
        `[Nemzilla AI Analysis — Infrastructure Correlated]: ${port} fault falls inside active severe-weather cell ${incident.id} ` +
        `(${incident.radiusKm} km radius, severity ${incident.severity}) covering this site's coordinates. ` +
        `Environmental factors: regional precipitation/wind exposure elevates ground-fault and connector-moisture risk; nearby sites in the cell are alarming concurrently. ` +
        `Probable Cause: Weather-induced protective trip, not component failure. ` +
        `SOP Action: Hold dispatch until the cell clears the ${incident.radiusKm} km zone, then run remote isolation self-test; ` +
        `schedule connector-seal inspection only if the fault persists post-clearance.`,
    };
  }

  // No external anomaly: baseline localized-hardware triage.
  const baseline =
    code === 'GroundFailure'
      ? `Isolation resistance fault on the safety loop (threshold below 50 ohms/V). ` +
        `Probable Cause: Water intrusion inside the cable connector assembly. ` +
        `SOP Action: Dispatch field service technician to test cable isolation; suppress unnecessary truck roll to the utility transformer.`
      : code === 'Power_Loss'
        ? `No matching grid incident at ${node?.name ?? 'the local sub-node'} — co-located sites remain nominal, so the outage is inside the site boundary. ` +
          `Probable Cause: Tripped site distribution breaker or rectifier failure. ` +
          `SOP Action: Verify the site breaker panel remotely via site host; if confirmed closed, dispatch service for rectifier diagnostics.`
        : `Fault code "${code}" with no correlated infrastructure incident. ` +
          `Probable Cause: Localized hardware/connector failure. ` +
          `SOP Action: Pull the raw OCPP StatusNotification log for this port and escalate to Tier 2 hardware triage.`;

  return {
    causeClass: 'LOCAL_HARDWARE',
    eventId: null,
    brief:
      `[Nemzilla AI Analysis]: ${port} — no active grid, carrier, or weather incidents overlap this site ` +
      `(sub-node ${node?.name ?? 'unknown'}, carrier ${carrier?.name ?? 'unknown'} both nominal). ${baseline}`,
  };
}

function upsertBrief({ station, connectorId, code }) {
  const ctx = interceptContext(station);
  const synthesis = synthesizeBrief({ station, connectorId, code, ctx });
  const now = new Date().toISOString();
  db()
    .prepare(`
      INSERT INTO alert_briefs
        (charger_id, connector_id, code, cause_class, event_id, brief, context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(charger_id, connector_id) DO UPDATE SET
        code = excluded.code,
        cause_class = excluded.cause_class,
        event_id = excluded.event_id,
        brief = excluded.brief,
        context_json = excluded.context_json,
        updated_at = excluded.updated_at
    `)
    .run(
      station.chargerId,
      Number(connectorId),
      code,
      synthesis.causeClass,
      synthesis.eventId,
      synthesis.brief,
      JSON.stringify({ gridNodeId: ctx.gridNodeId, ispCarrierId: ctx.ispCarrierId }),
      now,
      now
    );

  // Incident log (ROI analytics source): one open row per live alert. Re-faults
  // of an already-open incident update it in place rather than double-logging.
  const database = db();
  const open = database
    .prepare(
      'SELECT id FROM alert_incident_log WHERE charger_id = ? AND connector_id = ? AND resolved_at IS NULL'
    )
    .get(station.chargerId, Number(connectorId));
  if (open) {
    database
      .prepare('UPDATE alert_incident_log SET code = ?, cause_class = ?, event_id = ? WHERE id = ?')
      .run(code, synthesis.causeClass, synthesis.eventId, open.id);
  } else {
    database
      .prepare(`INSERT INTO alert_incident_log (charger_id, connector_id, code, cause_class, event_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(station.chargerId, Number(connectorId), code, synthesis.causeClass, synthesis.eventId, now);
  }
}

function deleteBrief(chargerId, connectorId) {
  const database = db();
  database
    .prepare('DELETE FROM alert_briefs WHERE charger_id = ? AND connector_id = ?')
    .run(chargerId, Number(connectorId));
  database
    .prepare(
      'UPDATE alert_incident_log SET resolved_at = ? WHERE charger_id = ? AND connector_id = ? AND resolved_at IS NULL'
    )
    .run(new Date().toISOString(), chargerId, Number(connectorId));
}

/**
 * Stateful alert enrichment hook, called synchronously from the fleet change
 * dispatcher BEFORE the SSE broadcast — by the time the frontend reacts to a
 * snapshot, the enriched brief is already persisted and queryable.
 */
export function enrichAlertOnChange({ snapshot, event }) {
  const station = snapshot.stations.find((s) => s.chargerId === event.chargerId);
  if (!station) return;
  if (event.targetStatus === 'Faulted') {
    upsertBrief({
      station,
      connectorId: event.connectorId,
      code: event.lastErrorCode ?? 'Power_Loss',
    });
  } else {
    deleteBrief(event.chargerId, event.connectorId);
  }
}

/** All pre-computed briefs for the alert desk (read path — zero synthesis cost). */
export function getAlertBriefs() {
  return db()
    .prepare('SELECT * FROM alert_briefs ORDER BY updated_at DESC')
    .all()
    .map((row) => ({
      chargerId: row.charger_id,
      connectorId: row.connector_id,
      code: row.code,
      causeClass: row.cause_class,
      eventId: row.event_id,
      brief: row.brief,
      context: JSON.parse(row.context_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

/**
 * Boot sweep: reconcile the brief cache against current fleet state — enrich
 * every faulted connector (organic seed faults included) and drop stale rows.
 */
export function initTriage(snapshot) {
  const database = db();
  const live = new Set();
  for (const station of snapshot.stations) {
    for (const connector of station.connectors) {
      if (connector.status === 'Faulted') {
        live.add(`${station.chargerId}:${connector.connectorId}`);
        upsertBrief({
          station,
          connectorId: connector.connectorId,
          code: connector.lastErrorCode ?? 'Power_Loss',
        });
      }
    }
  }
  for (const row of database.prepare('SELECT charger_id, connector_id FROM alert_briefs').all()) {
    if (!live.has(`${row.charger_id}:${row.connector_id}`)) {
      deleteBrief(row.charger_id, row.connector_id);
    }
  }
  console.log(`Triage cache ready: ${live.size} enriched alert brief(s)`);
}
