import { Fragment, useEffect, useState } from 'react'
import { fetchTelemetrySeries } from '../services/fleetApi.js'
import TelemetrySparkline from './TelemetrySparkline.jsx'
import { generateDiagnosticBrief } from '../services/alertEngine.js'

const SEVERITY_BADGES = {
  CRITICAL: 'bg-red-950 text-red-300 border border-red-700',
  WARNING: 'bg-amber-500/15 text-amber-400 border border-amber-500/50',
  INFO: 'bg-blue-500/15 text-blue-400 border border-blue-500/50',
}

// Parent-row column count — keep in sync with <thead>; the drawer row spans it.
const COLSPAN = 6

function formatTime(timestamp) {
  if (!timestamp) return 'Ongoing'
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function relativeTime(timestamp) {
  if (!timestamp) return null
  const secs = Math.round((Date.now() - new Date(timestamp).getTime()) / 1000)
  if (!Number.isFinite(secs)) return null
  if (secs < 60) return `${Math.max(secs, 0)}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const briefFor = (alert, briefs) =>
  briefs.find(
    (b) =>
      b.chargerId === alert.chargerId &&
      b.connectorId === alert.connectorId &&
      b.code === alert.code
  ) ?? null

// Weather/thermal incidents chart temperature; everything else (grid sag, power
// loss, carrier drop) charts the voltage trajectory.
function metricFor(alert, brief) {
  if (alert.code === 'Weather_Impact' || brief?.causeClass === 'ENVIRONMENTAL_WEATHER') {
    return 'temperature'
  }
  return 'voltage'
}

// Correlator evidence for the "Upgraded Root Cause" panel — the neighbor-drop
// figures depend on whether the verdict isolated the grid or the carrier layer.
function upgradeEvidence(correlation) {
  if (!correlation?.verdict) return null
  const pct = Math.round((correlation.cohesionScore ?? 0) * 100)
  if (correlation.verdict === 'EXTERNAL_NETWORK_DROP') {
    const { silentCount = 0, peerCount = 0, silentSites = [] } = correlation.carrier ?? {}
    return {
      label: 'Regional Carrier Drop',
      layer: 'Carrier',
      cohesionPct: pct,
      dropText: `${silentCount}/${peerCount} neighbor nodes silent`,
      sites: silentSites,
      proximity: correlation.proximity,
    }
  }
  const { downCount = 0, peerCount = 0, downSites = [] } = correlation.grid ?? {}
  return {
    label: 'Substation / Grid Outage',
    layer: 'Grid',
    cohesionPct: pct,
    dropText: `${downCount}/${peerCount} co-located sites dark`,
    sites: downSites,
    proximity: correlation.proximity,
  }
}

// Inline drawer: mounted only while its parent row is expanded, so telemetry is
// fetched on expand and torn down on collapse. Fixed-height chart frame -> no CLS.
function AlertDrawer({ alert, brief, drawerId }) {
  const [ticks, setTicks] = useState(null)
  const [failed, setFailed] = useState(false)
  const metric = metricFor(alert, brief)
  const evidence = upgradeEvidence(brief?.context?.correlation)

  useEffect(() => {
    let cancelled = false
    setTicks(null)
    setFailed(false)
    fetchTelemetrySeries(alert.chargerId, alert.connectorId, 60)
      .then((data) => {
        if (!cancelled) setTicks(data.ticks ?? [])
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [alert.chargerId, alert.connectorId])

  return (
    <div id={drawerId} className="grid gap-4 p-4 bg-slate-950/50 md:grid-cols-2">
      {/* Left: live degradation micro-chart */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Live Degradation Series
        </p>
        {failed ? (
          <div className="grid h-[84px] place-items-center rounded-lg border border-slate-800 bg-slate-950/60 text-xs text-slate-500">
            Telemetry series unavailable.
          </div>
        ) : (
          <TelemetrySparkline ticks={ticks ?? []} metric={metric} />
        )}
      </div>

      {/* Right: correlator upgrade evidence + brief text */}
      <div className="space-y-3">
        {evidence ? (
          <div className="rounded-lg border border-fuchsia-800/60 bg-fuchsia-950/30 p-3">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-fuchsia-500 bg-fuchsia-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fuchsia-300">
                ⤴ Upgraded Root Cause
              </span>
              <span className="text-xs font-semibold text-fuchsia-200">{evidence.label}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-slate-400">Infra cohesion</dt>
              <dd className="text-right font-mono tabular-nums text-fuchsia-200">
                {evidence.cohesionPct}%
              </dd>
              <dt className="text-slate-400">Neighbor drop</dt>
              <dd className="text-right font-mono tabular-nums text-fuchsia-200">
                {evidence.dropText}
              </dd>
              {evidence.proximity ? (
                <>
                  <dt className="text-slate-400">Within {evidence.proximity.radiusKm}km</dt>
                  <dd className="text-right font-mono tabular-nums text-fuchsia-200">
                    {evidence.proximity.downCount} impacted
                  </dd>
                </>
              ) : null}
            </dl>
            {evidence.sites.length > 0 ? (
              <p className="mt-2 text-[11px] text-slate-400">
                Cross-station:{' '}
                <span className="font-mono text-slate-300">{evidence.sites.join(', ')}</span>
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Diagnostic Brief
        </p>
        <p className="text-xs leading-relaxed text-slate-300 whitespace-pre-line">
          {brief ? brief.brief : generateDiagnosticBrief(alert)}
        </p>
      </div>
    </div>
  )
}

function AlertTable({ alerts, briefs = [], selectedAlertId, onSelectAlert }) {
  const [expanded, setExpanded] = useState(() => new Set())

  const toggle = (alert) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(alert.id)) next.delete(alert.id)
      else next.add(alert.id)
      return next
    })
    onSelectAlert(alert)
  }

  return (
    <section
      aria-label="NOC alert desk"
      className="rounded-xl border border-slate-800 bg-slate-900/70 backdrop-blur overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300">
          Alert Desk
        </h2>
        <span className="text-xs text-slate-400">{alerts.length} active</span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-800">
              <th className="px-2 py-2 font-medium w-8" aria-label="Expand" />
              <th className="px-4 py-2 font-medium">Severity</th>
              <th className="px-4 py-2 font-medium">Incident</th>
              <th className="px-4 py-2 font-medium">Station</th>
              <th className="px-4 py-2 font-medium hidden md:table-cell">Site</th>
              <th className="px-4 py-2 font-medium">Fault Category</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => {
              const brief = briefFor(alert, briefs)
              const isOpen = expanded.has(alert.id)
              const drawerId = `alert-drawer-${alert.id}`
              const occurrences = brief?.occurrenceCount ?? 1
              const lastSeen = relativeTime(brief?.lastSeenAt)
              const upgraded = Boolean(brief?.context?.correlation?.verdict)
              const rowActive = selectedAlertId === alert.id
              return (
                <Fragment key={alert.id}>
                  <tr
                    className={`border-b border-slate-800/60 ${
                      isOpen
                        ? 'bg-cyan-500/[0.07]'
                        : rowActive
                        ? 'bg-cyan-500/10'
                        : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <td className="px-2 py-3 align-top">
                      <button
                        type="button"
                        onClick={() => toggle(alert)}
                        aria-expanded={isOpen}
                        aria-controls={drawerId}
                        aria-label={`${isOpen ? 'Collapse' : 'Expand'} incident ${alert.category} at ${alert.chargerId} port ${alert.connectorId ?? ''}`}
                        className="grid min-h-11 min-w-11 place-items-center rounded-lg text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-300"
                      >
                        <span
                          aria-hidden="true"
                          className={`transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                        >
                          ▶
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-bold ${SEVERITY_BADGES[alert.severity]}`}
                      >
                        {alert.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-400 tabular-nums">
                        <span className="whitespace-nowrap">{formatTime(alert.timestamp)}</span>
                        {occurrences > 1 ? (
                          <span
                            title={`${occurrences} consolidated occurrences`}
                            className="rounded-full border border-amber-600/70 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300"
                          >
                            ×{occurrences}
                          </span>
                        ) : null}
                        {upgraded ? (
                          <span className="rounded-full border border-fuchsia-600/70 bg-fuchsia-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fuchsia-300">
                            ⤴ Upgraded
                          </span>
                        ) : null}
                        {lastSeen ? (
                          <span className="text-[10px] text-slate-500">seen {lastSeen}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-cyan-400 whitespace-nowrap">
                      {alert.chargerId}
                    </td>
                    <td className="px-4 py-3 align-top text-slate-300 hidden md:table-cell">
                      {alert.siteName}
                    </td>
                    <td className="px-4 py-3 align-top text-slate-200">{alert.category}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-slate-800/60 bg-slate-950/40">
                      <td colSpan={COLSPAN} className="p-0">
                        <AlertDrawer alert={alert} brief={brief} drawerId={drawerId} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
            {alerts.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="px-4 py-8 text-center text-slate-400">
                  No active alerts — fleet nominal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default AlertTable
