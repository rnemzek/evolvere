export const SEVERITY = {
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  INFO: 'INFO',
}

const FAULT_CATEGORIES = {
  GroundFailure: { severity: SEVERITY.CRITICAL, label: 'Ground Failure' },
  Power_Loss: { severity: SEVERITY.CRITICAL, label: 'Total Power Loss' },
  Comms_Loss: { severity: SEVERITY.WARNING, label: 'Carrier Comms Loss' },
  Weather_Impact: { severity: SEVERITY.WARNING, label: 'Weather Impact' },
  ZeroOutput: { severity: SEVERITY.WARNING, label: 'Zero Output Trend' },
  SuspendedEVSE: { severity: SEVERITY.WARNING, label: 'Connector Suspended' },
  EmergencyStop: { severity: SEVERITY.INFO, label: 'Emergency Stop Termination' },
  IrregularStop: { severity: SEVERITY.INFO, label: 'Irregular Session Termination' },
}

/**
 * Derive NOC alerts from fleet status (faulted / degraded ports) and
 * session history (termination irregularities).
 */
export function deriveAlerts(stations, transactions) {
  const alerts = []

  for (const station of stations) {
    for (const connector of station.connectors) {
      if (connector.status === 'Faulted') {
        const code = connector.lastErrorCode ?? 'Power_Loss'
        alerts.push(makeAlert(code, station, connector, connector.lastErrorTimestamp))
      } else if (connector.status === 'SuspendedEVSE') {
        alerts.push(makeAlert('SuspendedEVSE', station, connector, null))
      } else if (connector.status === 'Charging' && connector.currentPowerKW === 0) {
        alerts.push(makeAlert('ZeroOutput', station, connector, null))
      }
    }
  }

  for (const txn of transactions) {
    if (txn.terminationReason === 'EmergencyStop' || txn.terminationReason === 'Other') {
      const category = txn.terminationReason === 'EmergencyStop' ? 'EmergencyStop' : 'IrregularStop'
      const station = stations.find((s) => s.chargerId === txn.chargerId)
      alerts.push({
        id: `${category}-${txn.transactionId}`,
        severity: FAULT_CATEGORIES[category].severity,
        category: FAULT_CATEGORIES[category].label,
        code: category,
        timestamp: txn.endTime,
        chargerId: txn.chargerId,
        siteName: station?.siteName ?? 'Unknown site',
        connectorId: txn.connectorId,
        transactionId: txn.transactionId,
      })
    }
  }

  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 }
  return alerts.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (a.timestamp < b.timestamp ? 1 : -1)
  )
}

function makeAlert(code, station, connector, timestamp) {
  const category = FAULT_CATEGORIES[code] ?? { severity: SEVERITY.WARNING, label: code }
  return {
    id: `${code}-${station.chargerId}-${connector.connectorId}`,
    severity: category.severity,
    category: category.label,
    code,
    timestamp,
    chargerId: station.chargerId,
    siteName: station.siteName,
    connectorId: connector.connectorId,
    connectorType: connector.type,
  }
}

// UOW-19.1 Task 19.1.1: client-side brief synthesis for the unified alerts
// ledger (AlertDesk incidents) — a sibling to generateDiagnosticBrief below,
// same "no persisted record yet, fabricate from what the wire gave us"
// pattern, but keyed on the ledger's stationId/type/message shape instead of
// the fault-level chargerId/connectorId/code shape.
const LEDGER_CAUSE_TEXT = {
  EXTERNAL_GRID_FAILURE:
    'Probable Cause: Regional utility grid outage, confirmed via live county-outage correlation against the AFDC registry. ' +
    'Recommended Action: Do not dispatch field technicians — escalate to the utility grid manager and monitor for automatic recovery on grid restoration.',
  EXTERNAL_NETWORK_DROP:
    'Probable Cause: Regional carrier network outage upstream of the charging hardware. ' +
    'Recommended Action: Verify site-host Wi-Fi fallback connectivity before considering dispatch; offline sessions continue locally and billing data backfills on reconnection.',
}

export function generateLedgerBrief(alert) {
  const cause =
    LEDGER_CAUSE_TEXT[alert.type] ??
    `Probable Cause: ${alert.type.replace(/_/g, ' ').toLowerCase()} condition reported at ${
      alert.stationName ?? alert.stationId
    }${alert.eventCount > 1 ? ` (recurred ${alert.eventCount}×)` : ''}. ` +
      'Recommended Action: Review the incident detail below and dispatch per standard severity SOP if the condition persists.'
  return `[Nemzilla AI Analysis]: ${alert.message} ${cause}`
}

/**
 * Mock generative triage briefs — canned per fault category, parameterized per
 * alert, standing in for a live LLM diagnostic call.
 */
export function generateDiagnosticBrief(alert) {
  switch (alert.code) {
    case 'GroundFailure':
      return (
        `[Nemzilla AI Analysis]: Port ${alert.connectorId} has generated an isolation resistance fault. ` +
        `Current safety loop threshold fell below 50 ohms/V. ` +
        `Probable Cause: Water intrusion inside cable connector assembly. ` +
        `Recommended Action: Dispatch field service technician to test cable isolation. ` +
        `Suppress unnecessary truck roll to utility transformer.`
      )
    case 'Power_Loss':
      return (
        `[Nemzilla AI Analysis]: Station ${alert.chargerId} port ${alert.connectorId} reports total input power loss. ` +
        `Heartbeat maintained over cellular backup, so the comms path is intact and the outage is upstream of the rectifier. ` +
        `Probable Cause: Tripped site distribution breaker or utility-side interruption; co-located ports lost output at the same timestamp. ` +
        `Recommended Action: Verify site breaker panel remotely via site host before dispatch. If breaker confirmed closed, escalate to utility with outage reference. Estimated revenue exposure $22.50/hr per port.`
      )
    case 'SuspendedEVSE':
      return (
        `[Nemzilla AI Analysis]: Port ${alert.connectorId} at ${alert.chargerId} entered SuspendedEVSE — the vehicle requested energy but the EVSE is withholding output. ` +
        `Probable Cause: Local load-management ceiling reached, or pending firmware-side thermal derate. ` +
        `Recommended Action: Review site load-management policy and cabinet temperature trend. No truck roll indicated; clear remotely if thermals are nominal.`
      )
    case 'ZeroOutput':
      return (
        `[Nemzilla AI Analysis]: Port ${alert.connectorId} at ${alert.chargerId} reports an active session with 0 kW delivered over the trailing interval. ` +
        `Probable Cause: Vehicle BMS pause at high state-of-charge, or a stuck contactor failing to close. ` +
        `Recommended Action: Poll live meter values for 5 minutes; if output remains flat with SoC < 85%, issue a remote connector reset before considering dispatch.`
      )
    case 'EmergencyStop':
      return (
        `[Nemzilla AI Analysis]: Transaction ${alert.transactionId} at ${alert.chargerId} was terminated via the physical emergency stop circuit and delivered minimal energy. ` +
        `Probable Cause: Patron-initiated E-stop press; correlates with the ground-fault event window at this site. ` +
        `Recommended Action: Confirm E-stop latch has been physically reset. Station remains lockout-tagged until the CRITICAL fault at this site clears.`
      )
    case 'IrregularStop':
      return (
        `[Nemzilla AI Analysis]: Transaction ${alert.transactionId} at ${alert.chargerId} ended with a non-standard stop reason ("Other") outside normal EV/driver flows. ` +
        `Probable Cause: Charger-side session teardown during the fault window — consistent with a controller brown-out rather than driver behavior. ` +
        `Recommended Action: No dispatch. Flag session for billing reconciliation and attach to the parent site incident.`
      )
    default:
      return (
        `[Nemzilla AI Analysis]: Unclassified fault "${alert.code}" at ${alert.chargerId}. ` +
        `Recommended Action: Pull raw OCPP StatusNotification log for port ${alert.connectorId} and escalate to Tier 2.`
      )
  }
}
