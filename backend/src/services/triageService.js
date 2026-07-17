import { getDb } from './chargerDirectory.js';
import { getGridNode, getIspCarrier, haversineKm } from './infrastructureTopology.js';
import { resolveFleetTopology, listEvents } from './environmentalSimulator.js';
import { correlateStation, correlationSummary, COHESION_THRESHOLD } from './spatialCorrelator.js';

// AI Diagnostic Brief triage (UOW-06 Task 6.5). When a connector faults, the
// interceptor looks up the station's topology bindings, cross-references active
// environmental events, and synthesizes a deterministic SOP brief that is
// persisted immediately — the frontend reads the pre-cached payload with zero
// generation latency.

let tableReady = false;

// In-memory active-alert cache (UOW-08 Task 8.2): mirrors alert_briefs so
// consolidation checks and SSE payload builds never wait on a disk read.
const briefCache = new Map();
const briefKey = (chargerId, connectorId) => `${chargerId}:${Number(connectorId)}`;

/**
 * Task 8.2 migration: alert tables gain a loop counter and a freshness stamp.
 * CREATE TABLE IF NOT EXISTS cannot add columns to a live database, so existing
 * deployments are patched via PRAGMA-guarded ALTERs with a backfill.
 */
function migrateThrottleColumns(database, table, backfillExpr) {
  const cols = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes('occurrence_count')) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.includes('last_seen_at')) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN last_seen_at TEXT`);
    database.exec(`UPDATE ${table} SET last_seen_at = ${backfillExpr} WHERE last_seen_at IS NULL`);
  }
}

function db() {
  const database = getDb();
  if (!tableReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS alert_briefs (
        charger_id       TEXT NOT NULL,
        connector_id     INTEGER NOT NULL,
        code             TEXT NOT NULL,
        cause_class      TEXT NOT NULL,
        event_id         TEXT,
        brief            TEXT NOT NULL,
        context_json     TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at     TEXT,
        PRIMARY KEY (charger_id, connector_id)
      );
      CREATE TABLE IF NOT EXISTS alert_incident_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        charger_id       TEXT NOT NULL,
        connector_id     INTEGER NOT NULL,
        code             TEXT NOT NULL,
        cause_class      TEXT NOT NULL,
        event_id         TEXT,
        created_at       TEXT NOT NULL,
        resolved_at      TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at     TEXT
      );
    `);
    migrateThrottleColumns(database, 'alert_briefs', 'updated_at');
    migrateThrottleColumns(database, 'alert_incident_log', 'created_at');

    // Hydrate the active-alert cache from disk once per process.
    briefCache.clear();
    for (const row of database.prepare('SELECT * FROM alert_briefs').all()) {
      briefCache.set(briefKey(row.charger_id, row.connector_id), mapBriefRow(row));
    }
    tableReady = true;
  }
  return database;
}

function mapBriefRow(row) {
  return {
    chargerId: row.charger_id,
    connectorId: row.connector_id,
    code: row.code,
    causeClass: row.cause_class,
    eventId: row.event_id,
    brief: row.brief,
    context: JSON.parse(row.context_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    occurrenceCount: row.occurrence_count,
    lastSeenAt: row.last_seen_at,
  };
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

/**
 * Correlator-driven brief synthesis (UOW-08 Task 8.3): a localized fault whose
 * infrastructure cohort crossed the 75% cohesion threshold is rewritten as a
 * definitive regional outage, stating the co-located failure counts.
 */
function synthesizeCorrelatedBrief({ station, connectorId, correlation }) {
  const port = `Station ${station.chargerId} port ${connectorId}`;
  const pct = Math.round(correlation.cohesionScore * 100);
  const thresholdPct = Math.round(COHESION_THRESHOLD * 100);
  const nearby = `${correlation.proximity.downCount} impacted site(s) within ${correlation.proximity.radiusKm} km`;

  if (correlation.verdict === 'EXTERNAL_NETWORK_DROP') {
    const { silentCount, peerCount, silentSites } = correlation.carrier;
    return {
      causeClass: 'EXTERNAL_NETWORK_DROP',
      eventId: null,
      brief:
        `[Nemzilla AI Analysis — Cross-Layer Spatial Correlator]: ${port} — Upgraded to Carrier Outage: ` +
        `${silentCount} of ${peerCount} neighboring ${correlation.carrierName} nodes are silent (${silentSites.join(', ')}), ` +
        `infrastructure cohesion ${pct}% ≥ ${thresholdPct}% threshold; ${nearby}. ` +
        `Synchronized heartbeat loss across distinct sites on one carrier isolates the failure upstream of the charging hardware. ` +
        `Probable Cause: Regional ${correlation.carrierName} cellular outage. ` +
        `SOP Action: Suppress per-station hardware dispatch; verify site-host Wi-Fi fallback and monitor carrier restoration — ` +
        `offline sessions continue locally and billing backfills on reconnection.`,
    };
  }

  const { downCount, peerCount, downSites } = correlation.grid;
  return {
    causeClass: 'EXTERNAL_GRID_FAILURE',
    eventId: null,
    brief:
      `[Nemzilla AI Analysis — Cross-Layer Spatial Correlator]: ${port} — Upgraded to Grid Substation Outage: ` +
      `${downCount} of ${peerCount} co-located fleet sites on sub-node ${correlation.gridNodeName} are dark (${downSites.join(', ')}), ` +
      `infrastructure cohesion ${pct}% ≥ ${thresholdPct}% threshold; ${nearby}. ` +
      `Synchronized faulting across the sub-node isolates the failure upstream of all site equipment. ` +
      `Probable Cause: Substation/feeder outage at ${correlation.gridNodeName}. ` +
      `SOP Action: External grid issue — do not dispatch field technicians; escalate to the utility grid manager. ` +
      `Truck roll suppressed (est. $250 saved per avoided dispatch).`,
  };
}

/**
 * Alert ingestion with throttling & consolidation (UOW-08 Task 8.2).
 * An open, unresolved alert matching the same charger, connector, and fault
 * code is a repeat of the same incident — no new alert row is generated;
 * the existing row's occurrence_count increments and last_seen_at refreshes.
 * A different code on the same connector reclassifies the alert (fresh
 * synthesis, counter reset to 1) while its open parent incident keeps looping.
 * Returns a broadcastable result describing what happened.
 */
function upsertBrief({ station, connectorId, code, snapshot = null, countOccurrence = true }) {
  const database = db();
  const now = new Date().toISOString();
  const key = briefKey(station.chargerId, connectorId);
  const existing = briefCache.get(key);

  if (existing && existing.code === code) {
    const occurrenceCount = countOccurrence
      ? existing.occurrenceCount + 1
      : existing.occurrenceCount;
    database
      .prepare(`UPDATE alert_briefs
        SET occurrence_count = ?, last_seen_at = ?, updated_at = ?
        WHERE charger_id = ? AND connector_id = ?`)
      .run(occurrenceCount, now, now, station.chargerId, Number(connectorId));
    database
      .prepare(`UPDATE alert_incident_log
        SET occurrence_count = occurrence_count + ?, last_seen_at = ?
        WHERE charger_id = ? AND connector_id = ? AND resolved_at IS NULL`)
      .run(countOccurrence ? 1 : 0, now, station.chargerId, Number(connectorId));

    const consolidated = {
      ...existing,
      occurrenceCount,
      lastSeenAt: now,
      updatedAt: now,
    };
    briefCache.set(key, consolidated);
    return {
      action: countOccurrence ? 'ALERT_CONSOLIDATED' : 'ALERT_REFRESHED',
      alert: consolidated,
    };
  }

  const ctx = interceptContext(station);
  let synthesis = synthesizeBrief({ station, connectorId, code, ctx });

  // Analytical trigger hook (Task 8.3): every Faulted/Offline ingestion runs
  // the multi-site spatial lookup. A cohesion verdict overrides a localized
  // triage — the correlator's cross-layer evidence is definitive.
  let correlation = null;
  if (snapshot) {
    correlation = correlateStation(station, snapshot);
    if (correlation.verdict && synthesis.causeClass === 'LOCAL_HARDWARE') {
      synthesis = synthesizeCorrelatedBrief({ station, connectorId, correlation });
    }
  }

  database
    .prepare(`
      INSERT INTO alert_briefs
        (charger_id, connector_id, code, cause_class, event_id, brief, context_json,
         created_at, updated_at, occurrence_count, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(charger_id, connector_id) DO UPDATE SET
        code = excluded.code,
        cause_class = excluded.cause_class,
        event_id = excluded.event_id,
        brief = excluded.brief,
        context_json = excluded.context_json,
        updated_at = excluded.updated_at,
        occurrence_count = 1,
        last_seen_at = excluded.last_seen_at
    `)
    .run(
      station.chargerId,
      Number(connectorId),
      code,
      synthesis.causeClass,
      synthesis.eventId,
      synthesis.brief,
      JSON.stringify({
        gridNodeId: ctx.gridNodeId,
        ispCarrierId: ctx.ispCarrierId,
        correlation: correlationSummary(correlation),
      }),
      now,
      now,
      now
    );

  // Incident log (ROI analytics source): one open parent incident per live
  // alert. A reclassifying re-fault updates it in place and bumps the loop
  // counter rather than double-logging a second incident.
  const open = database
    .prepare(
      'SELECT id FROM alert_incident_log WHERE charger_id = ? AND connector_id = ? AND resolved_at IS NULL'
    )
    .get(station.chargerId, Number(connectorId));
  if (open) {
    database
      .prepare(`UPDATE alert_incident_log
        SET code = ?, cause_class = ?, event_id = ?, occurrence_count = occurrence_count + 1, last_seen_at = ?
        WHERE id = ?`)
      .run(code, synthesis.causeClass, synthesis.eventId, now, open.id);
  } else {
    database
      .prepare(`INSERT INTO alert_incident_log
        (charger_id, connector_id, code, cause_class, event_id, created_at, occurrence_count, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(station.chargerId, Number(connectorId), code, synthesis.causeClass, synthesis.eventId, now, now);
  }

  const raised = mapBriefRow(
    database
      .prepare('SELECT * FROM alert_briefs WHERE charger_id = ? AND connector_id = ?')
      .get(station.chargerId, Number(connectorId))
  );
  briefCache.set(key, raised);
  return { action: existing ? 'ALERT_RECLASSIFIED' : 'ALERT_RAISED', alert: raised };
}

function deleteBrief(chargerId, connectorId) {
  const database = db();
  const key = briefKey(chargerId, connectorId);
  const cleared = briefCache.get(key) ?? null;
  database
    .prepare('DELETE FROM alert_briefs WHERE charger_id = ? AND connector_id = ?')
    .run(chargerId, Number(connectorId));
  database
    .prepare(
      'UPDATE alert_incident_log SET resolved_at = ? WHERE charger_id = ? AND connector_id = ? AND resolved_at IS NULL'
    )
    .run(new Date().toISOString(), chargerId, Number(connectorId));
  briefCache.delete(key);
  return cleared ? { action: 'ALERT_CLEARED', alert: cleared } : null;
}

/**
 * Stateful alert enrichment hook, called synchronously from the fleet change
 * dispatcher BEFORE the SSE broadcast — by the time the frontend reacts to a
 * snapshot, the enriched brief is already persisted and queryable.
 */
/**
 * Dynamic brief rewriting (UOW-08 Task 8.3): after any ingestion, re-correlate
 * every active brief still classified LOCAL_HARDWARE. Faults that triaged as
 * localized before their neighbors failed get upgraded in place to the regional
 * verdict once the cohort crosses the cohesion threshold — occurrence counters
 * and created_at survive; only the classification and narrative are rewritten.
 */
function sweepSpatialUpgrades(snapshot) {
  const database = db();
  const upgraded = [];
  for (const [key, brief] of briefCache) {
    if (brief.causeClass !== 'LOCAL_HARDWARE') continue;
    const station = snapshot.stations.find((s) => s.chargerId === brief.chargerId);
    if (!station) continue;

    const correlation = correlateStation(station, snapshot);
    if (!correlation.verdict) continue;

    const synthesis = synthesizeCorrelatedBrief({
      station,
      connectorId: brief.connectorId,
      correlation,
    });
    const now = new Date().toISOString();
    const context = { ...brief.context, correlation: correlationSummary(correlation) };
    database
      .prepare(`UPDATE alert_briefs
        SET cause_class = ?, brief = ?, context_json = ?, updated_at = ?
        WHERE charger_id = ? AND connector_id = ?`)
      .run(synthesis.causeClass, synthesis.brief, JSON.stringify(context), now, brief.chargerId, brief.connectorId);
    database
      .prepare(`UPDATE alert_incident_log SET cause_class = ?
        WHERE charger_id = ? AND connector_id = ? AND resolved_at IS NULL`)
      .run(synthesis.causeClass, brief.chargerId, brief.connectorId);

    const next = {
      ...brief,
      causeClass: synthesis.causeClass,
      brief: synthesis.brief,
      context,
      updatedAt: now,
    };
    briefCache.set(key, next);
    upgraded.push({ action: 'ALERT_UPGRADED', alert: next });
  }
  return upgraded;
}

export function enrichAlertOnChange({ snapshot, event }) {
  const station = snapshot.stations.find((s) => s.chargerId === event.chargerId);
  if (!station) return null;

  const alerting = event.targetStatus === 'Faulted' || event.targetStatus === 'Offline';
  if (!alerting) {
    return deleteBrief(event.chargerId, event.connectorId);
  }

  const result = upsertBrief({
    station,
    connectorId: event.connectorId,
    code:
      event.lastErrorCode ?? (event.targetStatus === 'Offline' ? 'Comms_Loss' : 'Power_Loss'),
    snapshot,
  });
  const upgraded = sweepSpatialUpgrades(snapshot);
  return upgraded.length > 0 ? { ...result, upgraded } : result;
}

/** All active alerts from the in-memory cache (read path — zero disk cost). */
export function getAlertBriefs() {
  db();
  return [...briefCache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Boot sweep: reconcile the brief cache against current fleet state — enrich
 * every faulted connector (organic seed faults included) and drop stale rows.
 */
export function initTriage(snapshot) {
  db();
  const live = new Set();
  for (const station of snapshot.stations) {
    for (const connector of station.connectors) {
      if (connector.status === 'Faulted' || connector.status === 'Offline') {
        live.add(briefKey(station.chargerId, connector.connectorId));
        // Boot reconciliation re-observes known faults — refresh the brief but
        // do not inflate the loop counter (countOccurrence: false).
        upsertBrief({
          station,
          connectorId: connector.connectorId,
          code:
            connector.lastErrorCode ??
            (connector.status === 'Offline' ? 'Comms_Loss' : 'Power_Loss'),
          snapshot,
          countOccurrence: false,
        });
      }
    }
  }
  for (const key of [...briefCache.keys()]) {
    if (!live.has(key)) {
      const cached = briefCache.get(key);
      deleteBrief(cached.chargerId, cached.connectorId);
    }
  }
  console.log(`Triage cache ready: ${live.size} enriched alert brief(s)`);
}
