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
  if (targetStatus === 'Faulted') {
    connector.currentPowerKW = 0.0;
    connector.lastErrorCode = lastErrorCode ?? 'Power_Loss';
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
      chargerId,
      connectorId: connector.connectorId,
      targetStatus,
      lastErrorCode: connector.lastErrorCode ?? null,
    },
  });

  return fleetState;
}

export function onFleetChange(listener) {
  fleetEvents.on('change', listener);
  return () => fleetEvents.off('change', listener);
}
