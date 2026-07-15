async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return res.json();
}

export function fetchFleetStatus() {
  return getJson('/api/v1/fleet/status');
}

export function fetchSessionHistory() {
  return getJson('/api/v1/fleet/history');
}

export function fetchLiveTelemetry(transactionId) {
  return getJson(`/api/v1/fleet/telemetry/${encodeURIComponent(transactionId)}`);
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `${url} responded ${res.status}`);
  }
  return res.json();
}

export function postToggleStatus({ chargerId, connectorId, targetStatus, lastErrorCode }) {
  return postJson('/api/v1/internal/toggle-status', {
    chargerId,
    connectorId,
    targetStatus,
    lastErrorCode,
  });
}

export function subscribeToAlerts(phoneNumber) {
  return postJson('/api/v1/fleet/subscribe', { phoneNumber });
}

export function fetchAlertSubscriptions() {
  return getJson('/api/v1/fleet/subscriptions');
}
