import { readFile } from 'fs/promises';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

const USE_MOCK_DATA = true;

const ZERO_IMPACT_API_BASE = 'https://zeroimpactenergy.com/api/v1';
const MOCK_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mockData');

// Mutable in-memory fleet snapshot, seeded from the mock profile at boot.
let fleetState = null;
const fleetEvents = new EventEmitter();

async function readMock(fileName) {
  const raw = await readFile(path.join(MOCK_DATA_DIR, fileName), 'utf8');
  return JSON.parse(raw);
}

async function fetchLive(endpoint) {
  const res = await fetch(`${ZERO_IMPACT_API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${process.env.ZERO_IMPACT_API_TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Upstream fleet API ${endpoint} responded ${res.status}`);
  }
  return res.json();
}

export async function initFleetState() {
  if (USE_MOCK_DATA && !fleetState) {
    fleetState = await readMock('chargerStatus.json');
  }
  return fleetState;
}

export async function getFleetStatus() {
  if (USE_MOCK_DATA) {
    return initFleetState();
  }
  return fetchLive('/fleet/status');
}

export async function getSessionHistory() {
  if (USE_MOCK_DATA) {
    return readMock('sessionHistory.json');
  }
  return fetchLive('/fleet/sessions');
}

export async function getLiveTelemetry(transactionId) {
  if (USE_MOCK_DATA) {
    const stream = await readMock('liveTelemetryStream.json');
    const meterValues = stream.meterValues.filter(
      (entry) => entry.transactionId === transactionId
    );
    return { ...stream, meterValues };
  }
  return fetchLive(`/fleet/telemetry/${encodeURIComponent(transactionId)}`);
}

/**
 * Demo state driver: mutate a connector's status in the in-memory snapshot
 * and notify listeners (SSE broadcaster, SMS dispatcher).
 */
export async function toggleConnectorStatus({ chargerId, connectorId, targetStatus, lastErrorCode }) {
  await initFleetState();

  const station = fleetState.stations.find((s) => s.chargerId === chargerId);
  if (!station) throw new Error(`Unknown chargerId: ${chargerId}`);

  const connector = station.connectors.find((c) => c.connectorId === Number(connectorId));
  if (!connector) throw new Error(`Unknown connectorId ${connectorId} on ${chargerId}`);

  connector.status = targetStatus;
  if (targetStatus === 'Faulted' || targetStatus === 'Offline') {
    // Offline (UOW-08 Task 8.3): heartbeat lost — the carrier-layer alarm
    // state analyzed by the spatial correlator alongside hard faults.
    connector.currentPowerKW = 0.0;
    connector.lastErrorCode =
      lastErrorCode ?? (targetStatus === 'Offline' ? 'Comms_Loss' : 'Power_Loss');
    connector.lastErrorTimestamp = new Date().toISOString();
  } else {
    connector.currentPowerKW = 0.0;
    delete connector.lastErrorCode;
    delete connector.lastErrorTimestamp;
  }
  fleetState.generatedAt = new Date().toISOString();

  fleetEvents.emit('change', {
    snapshot: fleetState,
    event: {
      kind: 'STATUS_CHANGE',
      chargerId,
      connectorId: connector.connectorId,
      targetStatus,
      lastErrorCode: connector.lastErrorCode ?? null,
    },
  });

  return fleetState;
}

/**
 * Continuous degradation pipeline (UOW-08 Task 8.1): apply one tick of
 * time-series telemetry to many connectors at once, then emit a single
 * TELEMETRY_TICK change so the SSE broadcaster pushes one snapshot per tick.
 */
export async function applyTelemetryBatch(updates) {
  await initFleetState();

  const applied = [];
  for (const update of updates) {
    const station = fleetState.stations.find((s) => s.chargerId === update.chargerId);
    const connector = station?.connectors.find(
      (c) => c.connectorId === Number(update.connectorId)
    );
    if (!connector) continue;

    connector.telemetry = {
      voltageV: update.voltageV,
      currentA: update.currentA,
      temperatureC: update.temperatureC,
      updatedAt: update.tickAt,
    };
    if (connector.status === 'Charging') {
      connector.currentPowerKW = update.powerKW;
    }
    applied.push({ chargerId: update.chargerId, connectorId: connector.connectorId });
  }

  if (applied.length > 0) {
    fleetState.generatedAt = new Date().toISOString();
    fleetEvents.emit('change', {
      snapshot: fleetState,
      event: { kind: 'TELEMETRY_TICK', connectors: applied },
    });
  }
  return fleetState;
}

export function onFleetChange(listener) {
  fleetEvents.on('change', listener);
  return () => fleetEvents.off('change', listener);
}
