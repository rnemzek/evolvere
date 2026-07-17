import { randomUUID } from 'node:crypto';
import { getDb } from './chargerDirectory.js';
import {
  getGridNode,
  getIspCarrier,
  resolveGridNode,
  haversineKm,
} from './infrastructureTopology.js';
import { getFleetStatus, toggleConnectorStatus } from './chargerService.js';

// Environmental Event Simulator (UOW-06 Task 6.3): triggers regional outages
// across the 6.2 topology. Affected fleet connectors are faulted through
// toggleConnectorStatus so the existing SSE stream, NOC event log, and frontend
// alert desk light up exactly as they would for organic hardware faults.

const EVENT_TYPES = {
  GRID_FAILURE: {
    targetType: 'GRID_NODE',
    faultCode: 'Power_Loss',
    defaultSeverity: 'CRITICAL',
    label: 'Regional Grid Failure',
  },
  NETWORK_DROP: {
    targetType: 'ISP_CARRIER',
    faultCode: 'Comms_Loss',
    defaultSeverity: 'WARNING',
    label: 'Carrier Network Drop',
  },
  WEATHER_IMPACT: {
    targetType: 'GEO_CLUSTER',
    faultCode: 'Weather_Impact',
    defaultSeverity: 'WARNING',
    label: 'Severe Weather Impact',
  },
};

let tableReady = false;

function db() {
  const database = getDb();
  if (!tableReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS environmental_events (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        severity      TEXT NOT NULL,
        target_type   TEXT NOT NULL,
        target_id     TEXT,
        center_lat    REAL,
        center_lon    REAL,
        radius_km     REAL,
        description   TEXT NOT NULL,
        status        TEXT NOT NULL,
        affected_json TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        resolved_at   TEXT
      );
    `);
    tableReady = true;
  }
  return database;
}

function nocLog(kind, data) {
  console.log(
    `[ēvolvere-NOC-EVENT] ${kind} | Timestamp: ${new Date().toISOString()} | Data: ${JSON.stringify(data)}`
  );
}

/**
 * Fleet stations carry no zip code, so their topology binds deterministically
 * by geography: nearest sub-node centroid for power, and the ISP carrier of
 * the nearest directory charger for comms (same physical coverage area).
 */
export function resolveFleetTopology(station) {
  const { latitude, longitude } = station.location;
  const gridNode = resolveGridNode(latitude, longitude);

  const neighbors = db()
    .prepare('SELECT latitude, longitude, isp_carrier_id FROM directory_chargers WHERE isp_carrier_id IS NOT NULL')
    .all();
  let carrierId = null;
  let bestDist = Infinity;
  for (const n of neighbors) {
    const dist = haversineKm({ latitude, longitude }, n);
    if (dist < bestDist) {
      bestDist = dist;
      carrierId = n.isp_carrier_id;
    }
  }
  return { gridNodeId: gridNode?.id ?? null, ispCarrierId: carrierId };
}

/** Compute the blast radius: directory chargers + fleet stations hit by an event. */
async function computeAffected({ type, targetId, center, radiusKm }) {
  const database = db();
  const fleet = await getFleetStatus();
  let directoryRows;
  let fleetStations;

  if (type === 'GRID_FAILURE') {
    directoryRows = database
      .prepare('SELECT ocm_id, name FROM directory_chargers WHERE grid_node_id = ?')
      .all(targetId);
    fleetStations = fleet.stations.filter(
      (s) => resolveFleetTopology(s).gridNodeId === targetId
    );
  } else if (type === 'NETWORK_DROP') {
    directoryRows = database
      .prepare('SELECT ocm_id, name FROM directory_chargers WHERE isp_carrier_id = ?')
      .all(targetId);
    fleetStations = fleet.stations.filter(
      (s) => resolveFleetTopology(s).ispCarrierId === targetId
    );
  } else {
    directoryRows = database
      .prepare('SELECT ocm_id, name, latitude, longitude FROM directory_chargers')
      .all()
      .filter((r) => haversineKm(center, r) <= radiusKm);
    fleetStations = fleet.stations.filter(
      (s) => haversineKm(center, s.location) <= radiusKm
    );
  }

  return {
    directoryChargers: directoryRows.map((r) => ({ ocmId: r.ocm_id, name: r.name })),
    fleetStations: fleetStations.map((s) => ({
      chargerId: s.chargerId,
      siteName: s.siteName,
      connectorIds: s.connectors.map((c) => c.connectorId),
    })),
  };
}

/**
 * Trigger a regional outage. Persists the event, then cascades synthetic
 * faults onto every affected fleet connector.
 */
export async function triggerEvent({ type, targetId, center, radiusKm, severity, description }) {
  const spec = EVENT_TYPES[type];
  if (!spec) {
    throw Object.assign(
      new Error(`type must be one of: ${Object.keys(EVENT_TYPES).join(', ')}`),
      { statusCode: 400 }
    );
  }

  let targetLabel;
  if (spec.targetType === 'GRID_NODE') {
    const node = getGridNode(targetId);
    if (!node) throw Object.assign(new Error(`Unknown grid node: ${targetId}`), { statusCode: 400 });
    targetLabel = node.name;
  } else if (spec.targetType === 'ISP_CARRIER') {
    const carrier = getIspCarrier(targetId);
    if (!carrier) throw Object.assign(new Error(`Unknown ISP carrier: ${targetId}`), { statusCode: 400 });
    targetLabel = carrier.name;
  } else {
    if (
      !Number.isFinite(center?.latitude) ||
      !Number.isFinite(center?.longitude) ||
      !Number.isFinite(radiusKm) ||
      radiusKm <= 0
    ) {
      throw Object.assign(
        new Error('WEATHER_IMPACT requires center {latitude, longitude} and a positive radiusKm'),
        { statusCode: 400 }
      );
    }
    targetLabel = `${radiusKm} km cluster @ ${center.latitude.toFixed(4)}, ${center.longitude.toFixed(4)}`;
  }

  const affected = await computeAffected({ type, targetId, center, radiusKm });
  const event = {
    id: `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
    type,
    severity: severity ?? spec.defaultSeverity,
    targetType: spec.targetType,
    targetId: targetId ?? null,
    center: center ?? null,
    radiusKm: radiusKm ?? null,
    description:
      description ??
      `${spec.label} — ${targetLabel}; ${affected.directoryChargers.length} public sites, ${affected.fleetStations.length} fleet stations affected`,
    status: 'ACTIVE',
    affected,
    startedAt: new Date().toISOString(),
    resolvedAt: null,
  };

  db()
    .prepare(`INSERT INTO environmental_events
      (id, type, severity, target_type, target_id, center_lat, center_lon, radius_km,
       description, status, affected_json, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      event.id, event.type, event.severity, event.targetType, event.targetId,
      center?.latitude ?? null, center?.longitude ?? null, event.radiusKm,
      event.description, event.status, JSON.stringify(affected), event.startedAt, null
    );

  for (const station of affected.fleetStations) {
    for (const connectorId of station.connectorIds) {
      await toggleConnectorStatus({
        chargerId: station.chargerId,
        connectorId,
        targetStatus: 'Faulted',
        lastErrorCode: spec.faultCode,
      });
    }
  }

  nocLog('ENVIRONMENTAL_EVENT_TRIGGERED', {
    eventId: event.id,
    type,
    severity: event.severity,
    target: targetLabel,
    affectedFleetStations: affected.fleetStations.length,
    affectedPublicSites: affected.directoryChargers.length,
  });

  return event;
}

/** Resolve an active event and restore its fleet connectors to Available. */
export async function resolveEvent(eventId) {
  const row = db()
    .prepare('SELECT * FROM environmental_events WHERE id = ?')
    .get(eventId);
  if (!row) throw Object.assign(new Error(`Unknown event: ${eventId}`), { statusCode: 404 });
  if (row.status === 'RESOLVED') {
    throw Object.assign(new Error(`Event ${eventId} is already resolved`), { statusCode: 400 });
  }

  const affected = JSON.parse(row.affected_json);
  for (const station of affected.fleetStations) {
    for (const connectorId of station.connectorIds) {
      await toggleConnectorStatus({
        chargerId: station.chargerId,
        connectorId,
        targetStatus: 'Available',
      });
    }
  }

  // Overlapping events: stations covered by another still-active event must
  // stay faulted under that event's code, not pop back to Available.
  const stillActive = listEvents().filter((e) => e.id !== eventId);
  for (const other of stillActive) {
    const code = EVENT_TYPES[other.type].faultCode;
    for (const station of other.affected.fleetStations) {
      if (!affected.fleetStations.some((s) => s.chargerId === station.chargerId)) continue;
      for (const connectorId of station.connectorIds) {
        await toggleConnectorStatus({
          chargerId: station.chargerId,
          connectorId,
          targetStatus: 'Faulted',
          lastErrorCode: code,
        });
      }
    }
  }

  const resolvedAt = new Date().toISOString();
  db()
    .prepare("UPDATE environmental_events SET status = 'RESOLVED', resolved_at = ? WHERE id = ?")
    .run(resolvedAt, eventId);

  nocLog('ENVIRONMENTAL_EVENT_RESOLVED', { eventId, type: row.type, resolvedAt });
  return { ...rowToEvent(row), status: 'RESOLVED', resolvedAt };
}

function rowToEvent(row) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    targetType: row.target_type,
    targetId: row.target_id,
    center:
      row.center_lat !== null ? { latitude: row.center_lat, longitude: row.center_lon } : null,
    radiusKm: row.radius_km,
    description: row.description,
    status: row.status,
    affected: JSON.parse(row.affected_json),
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
  };
}

export function listEvents({ includeResolved = false } = {}) {
  const rows = includeResolved
    ? db().prepare('SELECT * FROM environmental_events ORDER BY started_at DESC').all()
    : db()
        .prepare("SELECT * FROM environmental_events WHERE status = 'ACTIVE' ORDER BY started_at DESC")
        .all();
  return rows.map(rowToEvent);
}

/**
 * Boot re-hydration: fleet connector state is in-memory and resets to the seed
 * profile on restart, while events persist in SQLite — so re-apply the faults
 * of every still-active event (oldest first, matching trigger-time layering).
 */
export async function initSimulator() {
  const active = listEvents().reverse();
  for (const event of active) {
    const code = EVENT_TYPES[event.type].faultCode;
    for (const station of event.affected.fleetStations) {
      for (const connectorId of station.connectorIds) {
        await toggleConnectorStatus({
          chargerId: station.chargerId,
          connectorId,
          targetStatus: 'Faulted',
          lastErrorCode: code,
        });
      }
    }
  }
  if (active.length > 0) {
    console.log(`Environmental simulator: re-applied ${active.length} active event(s) to fleet state`);
  }
}

/**
 * Live overlay contract for the 6.4 map layers: per-sub-node power status,
 * per-carrier network status, active weather zones, and impacted charger ids.
 */
export function getEnvironmentStatus() {
  const active = listEvents();
  const byTarget = (type) =>
    new Map(active.filter((e) => e.type === type).map((e) => [e.targetId, e]));
  const gridOutages = byTarget('GRID_FAILURE');
  const networkDrops = byTarget('NETWORK_DROP');

  const affectedOcmIds = new Set();
  for (const e of active) {
    for (const c of e.affected.directoryChargers) affectedOcmIds.add(c.ocmId);
  }

  const database = db();
  const gridNodes = database
    .prepare('SELECT id FROM grid_nodes')
    .all()
    .map(({ id }) => ({
      id,
      powerStatus: gridOutages.has(id) ? 'OUTAGE' : 'NOMINAL',
      activeEventId: gridOutages.get(id)?.id ?? null,
    }));
  const ispCarriers = database
    .prepare('SELECT id FROM isp_carriers')
    .all()
    .map(({ id }) => ({
      id,
      networkStatus: networkDrops.has(id) ? 'DOWN' : 'NOMINAL',
      activeEventId: networkDrops.get(id)?.id ?? null,
    }));

  return {
    generatedAt: new Date().toISOString(),
    activeEventCount: active.length,
    gridNodes,
    ispCarriers,
    weatherZones: active
      .filter((e) => e.type === 'WEATHER_IMPACT')
      .map((e) => ({
        eventId: e.id,
        center: e.center,
        radiusKm: e.radiusKm,
        severity: e.severity,
        description: e.description,
      })),
    affectedDirectoryChargers: [...affectedOcmIds],
  };
}
