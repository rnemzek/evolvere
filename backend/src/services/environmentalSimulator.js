import { randomUUID } from 'node:crypto';
import { getDb } from './chargerDirectory.js';
import {
  getGridNode,
  getIspCarrier,
  resolveGridNode,
  haversineKm,
} from './infrastructureTopology.js';
import {
  getFleetStatus,
  toggleConnectorStatus,
  applyTelemetryBatch,
} from './chargerService.js';

// Environmental Event Simulator (UOW-06 Task 6.3, upgraded UOW-08 Task 8.1):
// triggers regional outages across the 6.2 topology. Since 8.1, affected fleet
// connectors no longer snap instantly to Faulted — they enter a continuous
// degradation trajectory (voltage sag, thermal climb, current decay) driven by
// the background tick loop, and fault organically once telemetry crosses
// critical thresholds. Every tick persists to SQLite and rides the SSE stream.

const EVENT_TYPES = {
  GRID_FAILURE: {
    targetType: 'GRID_NODE',
    faultCode: 'Power_Loss',
    defaultSeverity: 'CRITICAL',
    label: 'Regional Grid Failure',
    // Voltage collapse dominates; current decays as the bus browns out.
    degradation: { weights: { sag: 1.0, heat: 0.25, decay: 0.8 }, trip: 'VOLTAGE' },
  },
  NETWORK_DROP: {
    targetType: 'ISP_CARRIER',
    faultCode: 'Comms_Loss',
    defaultSeverity: 'WARNING',
    label: 'Carrier Network Drop',
    // Comms loss: electricals stay near nominal, session current bleeds out.
    degradation: { weights: { sag: 0.1, heat: 0.1, decay: 1.0 }, trip: 'PROGRESS' },
  },
  WEATHER_IMPACT: {
    targetType: 'GEO_CLUSTER',
    faultCode: 'Weather_Impact',
    defaultSeverity: 'WARNING',
    label: 'Severe Weather Impact',
    // Thermal runaway dominates with moderate electrical instability.
    degradation: { weights: { sag: 0.3, heat: 1.0, decay: 0.5 }, trip: 'TEMPERATURE' },
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
      CREATE TABLE IF NOT EXISTS telemetry_ticks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        charger_id    TEXT NOT NULL,
        connector_id  INTEGER NOT NULL,
        tick_at       TEXT NOT NULL,
        voltage_v     REAL NOT NULL,
        current_a     REAL NOT NULL,
        temperature_c REAL NOT NULL,
        power_kw      REAL NOT NULL,
        status        TEXT NOT NULL,
        phase         TEXT NOT NULL,
        event_id      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_ticks_connector
        ON telemetry_ticks (charger_id, connector_id, id);
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

  // UOW-08 Task 8.1: no instant working→broken snap. Affected connectors enter
  // a degradation trajectory; the tick loop faults each one only when its
  // telemetry crosses critical thresholds (< 200 V sag, > 85 °C, dead current).
  for (const station of affected.fleetStations) {
    for (const connectorId of station.connectorIds) {
      beginDegradation({
        chargerId: station.chargerId,
        connectorId,
        eventType: type,
        eventId: event.id,
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
      // Telemetry climbs back toward nominal over the next ticks rather than
      // snapping — the trajectory unwinds until it reaches baseline.
      beginRecovery(station.chargerId, connectorId);
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
        holdDegradation({
          chargerId: station.chargerId,
          connectorId,
          eventType: other.type,
          eventId: other.id,
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
        // State restore, not a fresh outage: pin telemetry at full degradation.
        holdDegradation({
          chargerId: station.chargerId,
          connectorId,
          eventType: event.type,
          eventId: event.id,
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

// --- Continuous Degradation Pipeline (UOW-08 Task 8.1) -------------------------
// Background tick loop that replaces instant working→broken snaps with
// fluctuating time-series telemetry: voltage sags decaying below 200 V,
// temperatures spiking past 85 °C, and exponentially decaying current draw.
// Every tick persists per-connector samples to SQLite (telemetry_ticks) and
// broadcasts the mutated fleet snapshot over /api/v1/fleet/stream via
// applyTelemetryBatch → the standard onFleetChange SSE fan-out.

const TICK_INTERVAL_MS = 5000;
const RETENTION_TICKS = 720; // per connector ≈ 1 h of history at 5 s cadence
const TRIM_EVERY_TICKS = 30;
const RECOVERY_RATE = 0.12;
const VOLTAGE_CRITICAL_V = 200;
const TEMP_CRITICAL_C = 85;
const NOMINAL_VOLTAGE_BY_TYPE = { CCS1: 480, CHAdeMO: 450, J1772: 240 };

// lastErrorCode → degradation profile for faults raised outside the simulator
// (control-panel toggles, seed-profile faults) so they too emit sick telemetry.
const CODE_PROFILE = {
  Power_Loss: 'GRID_FAILURE',
  GroundFailure: 'GRID_FAILURE',
  Comms_Loss: 'NETWORK_DROP',
  Weather_Impact: 'WEATHER_IMPACT',
  OverTemperature: 'WEATHER_IMPACT',
};

const degradationStates = new Map(); // "chargerId:connectorId" → trajectory
const baselines = new Map(); // "chargerId:connectorId" → nominal operating point
let tickTimer = null;
let tickCount = 0;

const stateKey = (chargerId, connectorId) => `${chargerId}:${Number(connectorId)}`;
const jitter = (amplitude) => (Math.random() * 2 - 1) * amplitude;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round1 = (n) => Math.round(n * 10) / 10;

function newState({ chargerId, connectorId, eventType, eventId, progress = 0 }) {
  return {
    chargerId,
    connectorId: Number(connectorId),
    eventType,
    eventId: eventId ?? null,
    direction: 'DEGRADING',
    progress,
    ratePerTick: 0.04 + Math.random() * 0.06, // threshold breach in ~1–2 min
    sagFloorV: 150 + Math.random() * 35, // well below the 200 V critical line
    tempPeakC: 92 + Math.random() * 12, // well above the 85 °C critical line
    faulted: progress >= 1,
  };
}

function beginDegradation({ chargerId, connectorId, eventType, eventId }) {
  degradationStates.set(
    stateKey(chargerId, connectorId),
    newState({ chargerId, connectorId, eventType, eventId })
  );
}

/** Pin a connector at full degradation (boot re-hydration, overlap re-faulting). */
function holdDegradation({ chargerId, connectorId, eventType, eventId }) {
  degradationStates.set(
    stateKey(chargerId, connectorId),
    newState({ chargerId, connectorId, eventType, eventId, progress: 1 })
  );
}

function beginRecovery(chargerId, connectorId) {
  const state = degradationStates.get(stateKey(chargerId, connectorId));
  if (state) {
    state.direction = 'RECOVERING';
    state.faulted = false;
  }
}

/**
 * Nominal operating point, captured on first sight and re-captured when the
 * connector's status changes — degraded samples never contaminate the baseline.
 */
function baselineFor(chargerId, connector) {
  const key = stateKey(chargerId, connector.connectorId);
  const cached = baselines.get(key);
  if (cached && cached.lastStatus === connector.status) return cached;

  const voltageV = NOMINAL_VOLTAGE_BY_TYPE[connector.type] ?? 480;
  const powerKW = connector.status === 'Charging' ? Math.max(connector.currentPowerKW, 3) : 0;
  const baseline = {
    lastStatus: connector.status,
    voltageV,
    temperatureC: (connector.status === 'Charging' ? 46 : 36) + jitter(3),
    currentA: (powerKW * 1000) / voltageV,
  };
  baselines.set(key, baseline);
  return baseline;
}

function sampleConnector(state, baseline) {
  if (!state) {
    const voltageV = baseline.voltageV + jitter(baseline.voltageV * 0.008);
    const currentA = Math.max(0, baseline.currentA + jitter(baseline.currentA * 0.04));
    return {
      voltageV,
      currentA,
      temperatureC: baseline.temperatureC + jitter(1.1),
      powerKW: (voltageV * currentA) / 1000,
    };
  }

  const { weights } = EVENT_TYPES[state.eventType].degradation;
  const p = state.progress;
  const voltageV =
    baseline.voltageV -
    (baseline.voltageV - state.sagFloorV) * p * weights.sag +
    jitter(baseline.voltageV * 0.012);
  const temperatureC =
    baseline.temperatureC +
    (state.tempPeakC - baseline.temperatureC) * p * weights.heat +
    jitter(1.4);
  const currentA = Math.max(
    0,
    baseline.currentA * (1 - weights.decay + weights.decay * Math.exp(-3 * p)) +
      jitter(baseline.currentA * 0.05)
  );
  return { voltageV, currentA, temperatureC, powerKW: (voltageV * currentA) / 1000 };
}

async function runDegradationTick() {
  const fleet = await getFleetStatus();
  const database = db();
  const tickAt = new Date().toISOString();
  const updates = [];
  const pendingFaults = [];
  const insertTick = database.prepare(`INSERT INTO telemetry_ticks
    (charger_id, connector_id, tick_at, voltage_v, current_a, temperature_c, power_kw, status, phase, event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const station of fleet.stations) {
    for (const connector of station.connectors) {
      const key = stateKey(station.chargerId, connector.connectorId);
      let state = degradationStates.get(key);

      // Faults raised outside the pipeline still emit degraded telemetry.
      if (!state && connector.status === 'Faulted') {
        state = newState({
          chargerId: station.chargerId,
          connectorId: connector.connectorId,
          eventType: CODE_PROFILE[connector.lastErrorCode] ?? 'GRID_FAILURE',
          progress: 1,
        });
        degradationStates.set(key, state);
      }

      if (state) {
        state.progress = clamp01(
          state.progress +
            (state.direction === 'DEGRADING' ? state.ratePerTick : -RECOVERY_RATE)
        );
        if (state.direction === 'RECOVERING' && state.progress <= 0) {
          degradationStates.delete(key);
          state = null;
        }
      }

      const baseline = baselineFor(station.chargerId, connector);
      const sample = sampleConnector(state, baseline);
      let phase = 'HEALTHY';

      if (state) {
        phase =
          state.direction === 'RECOVERING'
            ? 'RECOVERING'
            : state.faulted
              ? 'CRITICAL'
              : 'DEGRADING';

        const { trip } = EVENT_TYPES[state.eventType].degradation;
        const tripped =
          trip === 'VOLTAGE'
            ? sample.voltageV < VOLTAGE_CRITICAL_V
            : trip === 'TEMPERATURE'
              ? sample.temperatureC > TEMP_CRITICAL_C
              : state.progress >= 1;
        if (
          state.direction === 'DEGRADING' &&
          !state.faulted &&
          tripped &&
          connector.status !== 'Faulted'
        ) {
          state.faulted = true;
          phase = 'CRITICAL';
          pendingFaults.push({
            chargerId: station.chargerId,
            connectorId: connector.connectorId,
            faultCode: EVENT_TYPES[state.eventType].faultCode,
          });
        }
      }

      const voltageV = round1(sample.voltageV);
      const currentA = round1(sample.currentA);
      const temperatureC = round1(sample.temperatureC);
      const powerKW = Math.round(sample.powerKW * 100) / 100;

      insertTick.run(
        station.chargerId, connector.connectorId, tickAt,
        voltageV, currentA, temperatureC, powerKW,
        connector.status, phase, state?.eventId ?? null
      );
      updates.push({
        chargerId: station.chargerId,
        connectorId: connector.connectorId,
        voltageV, currentA, temperatureC, powerKW, tickAt,
      });
    }
  }

  tickCount += 1;
  if (tickCount % TRIM_EVERY_TICKS === 0) {
    database
      .prepare(`DELETE FROM telemetry_ticks WHERE id NOT IN (
        SELECT id FROM telemetry_ticks AS keep
        WHERE keep.charger_id = telemetry_ticks.charger_id
          AND keep.connector_id = telemetry_ticks.connector_id
        ORDER BY keep.id DESC LIMIT ?)`)
      .run(RETENTION_TICKS);
  }

  // One SSE snapshot per tick; threshold-crossing faults then flow through the
  // standard toggle path so briefs, SMS fan-out, and the ROI log all fire.
  await applyTelemetryBatch(updates);
  for (const fault of pendingFaults) {
    await toggleConnectorStatus({
      chargerId: fault.chargerId,
      connectorId: fault.connectorId,
      targetStatus: 'Faulted',
      lastErrorCode: fault.faultCode,
    });
    nocLog('DEGRADATION_THRESHOLD_FAULT', fault);
  }
}

export function startDegradationLoop() {
  if (tickTimer) return;
  db(); // ensure telemetry_ticks exists before the first tick races a reader
  tickTimer = setInterval(() => {
    runDegradationTick().catch((err) =>
      console.error(`Degradation tick failed: ${err.message}`)
    );
  }, TICK_INTERVAL_MS);
  tickTimer.unref?.();
  nocLog('DEGRADATION_PIPELINE_STARTED', {
    tickIntervalMs: TICK_INTERVAL_MS,
    retentionTicks: RETENTION_TICKS,
    thresholds: { voltageSagV: VOLTAGE_CRITICAL_V, temperatureC: TEMP_CRITICAL_C },
  });
}

export function stopDegradationLoop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Persisted time-series read path (feeds the UOW-08 Task 8.4 brief charts). */
export function getTelemetrySeries({ chargerId, connectorId, limit = 120 }) {
  const rows = db()
    .prepare(`SELECT tick_at, voltage_v, current_a, temperature_c, power_kw, status, phase, event_id
      FROM telemetry_ticks WHERE charger_id = ? AND connector_id = ?
      ORDER BY id DESC LIMIT ?`)
    .all(chargerId, Number(connectorId), Math.min(Math.max(1, limit), RETENTION_TICKS));
  return rows.reverse().map((row) => ({
    tickAt: row.tick_at,
    voltageV: row.voltage_v,
    currentA: row.current_a,
    temperatureC: row.temperature_c,
    powerKW: row.power_kw,
    status: row.status,
    phase: row.phase,
    eventId: row.event_id,
  }));
}
