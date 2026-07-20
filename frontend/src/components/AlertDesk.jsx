import { useEffect, useReducer, useState } from 'react'
import { fetchAlertLedger } from '../services/fleetApi.js'
import { subscribeStream } from '../services/streamHub.js'
import { deskReducer, initialDeskState, lastActivity } from '../services/alertDeskState.js'

// UOW-13 Alert Desk: hydrates from the unified alerts ledger on mount
// (Task 13.1), then stays live off the shared SSE socket by intercepting
// named incident-update frames — INCIDENT_OPENED / INCIDENT_CONSOLIDATED /
// INCIDENT_RESOLVED — routed through the deskReducer state machine
// (Task 13.2). CLS isolation contract: the <section> owns an explicit fixed
// structural height (h-96) across every phase, and the list scrolls in its
// own overflow-y container, so rows arriving, consolidating, or fading out
// can never push the Leaflet map or any sibling panel by a pixel. All row
// animation is compositor-side opacity — never height/top.

// Must match .alert-desk-row-resolving's animation duration: an id is only
// eligible for eviction once its fade has fully played out.
const RESOLVE_FADE_MS = 600
// One flush per window — a storm of simultaneous clears coalesces into a
// single EVICT_BATCH dispatch (one render, one layout pass).
const EVICT_FLUSH_MS = 800

const SEVERITY_BADGES = {
  CRITICAL: 'border-red-700/80 bg-red-500/15 text-red-300',
  WARNING: 'border-amber-600/80 bg-amber-500/15 text-amber-300',
  INFO: 'border-slate-600 bg-slate-500/15 text-slate-300',
}

// Task 13.4 quick-toggle filters, rendered in canonical severity order.
const SEVERITY_ORDER = ['CRITICAL', 'WARNING', 'INFO']

const SEVERITY_TOGGLES = {
  CRITICAL: {
    on: 'border-red-700/80 bg-red-500/15 text-red-300',
    off: 'border-slate-700 bg-transparent text-slate-500 hover:text-slate-300',
  },
  WARNING: {
    on: 'border-amber-600/80 bg-amber-500/15 text-amber-300',
    off: 'border-slate-700 bg-transparent text-slate-500 hover:text-slate-300',
  },
  INFO: {
    on: 'border-slate-500 bg-slate-500/15 text-slate-300',
    off: 'border-slate-700 bg-transparent text-slate-500 hover:text-slate-300',
  },
}

const HEADER_CELL =
  'sticky top-0 z-10 bg-slate-900 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800'

function formatSeen(alert) {
  return new Date(lastActivity(alert)).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function DeskNotice({ children }) {
  return (
    <div className="h-full grid place-items-center px-4">
      <p className="text-sm text-slate-400">{children}</p>
    </div>
  )
}

// Same fixed geometry as hydrated rows so the skeleton→data swap is paint-only.
function LoadingSkeleton() {
  return (
    <div className="h-full px-4 py-3 space-y-3" role="status" aria-label="Loading incident ledger">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 rounded-lg bg-slate-800/60 animate-pulse" aria-hidden="true" />
      ))}
    </div>
  )
}

function AlertDesk({ selectedAlertId, onSelectAlert }) {
  const [{ phase, alerts }, dispatch] = useReducer(deskReducer, initialDeskState)
  // Task 13.4 operator filters. Pure view concerns: they never enter the
  // reducer — the raw ledger stays the single source of truth, and the visible
  // slice derives fresh each render.
  const [activeSeverities, setActiveSeverities] = useState({
    CRITICAL: true,
    WARNING: true,
    INFO: true,
  })
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false

    // Task 13.3 deferred eviction: resolved ids accumulate here (id → enqueue
    // stamp) behind ONE shared timer. The flush evicts every id whose fade has
    // completed as a single EVICT_BATCH dispatch; ids that arrived late in the
    // window keep fading and the timer re-arms for them — no row ever pops out
    // mid-animation, and no storm ever schedules more than one live timer.
    const pendingEvictions = new Map()
    let flushTimer = null

    const armFlush = (delay) => {
      if (flushTimer !== null) return
      flushTimer = setTimeout(flushEvictions, delay)
    }

    const flushEvictions = () => {
      flushTimer = null
      if (cancelled) return
      const now = performance.now()
      const ready = []
      for (const [id, enqueuedAt] of pendingEvictions) {
        if (now - enqueuedAt >= RESOLVE_FADE_MS) {
          ready.push(id)
          pendingEvictions.delete(id)
        }
      }
      if (ready.length > 0) dispatch({ type: 'EVICT_BATCH', ids: ready })
      if (pendingEvictions.size > 0) armFlush(RESOLVE_FADE_MS)
    }

    const scheduleEviction = (id) => {
      pendingEvictions.set(id, performance.now())
      armFlush(EVICT_FLUSH_MS)
    }

    // Task 13.1 hydration: the authoritative ledger snapshot paints first.
    fetchAlertLedger()
      .then((data) => {
        if (!cancelled) dispatch({ type: 'HYDRATE', alerts: data.alerts })
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'HYDRATE_FAILED' })
      })

    // Task 13.2 live wire: named incident-update frames off the shared SSE
    // socket. The frame carries { action, alert, … } — extract both and hand
    // them to the reducer; no array surgery happens here. A RESOLVED frame
    // additionally books the row's post-fade eviction.
    const unsubscribe = subscribeStream('incident-update', ({ action, alert }) => {
      if (!action || !alert) return
      dispatch({ type: 'STREAM_FRAME', action, alert })
      if (action === 'INCIDENT_RESOLVED') scheduleEviction(alert.id)
    })

    return () => {
      cancelled = true
      if (flushTimer !== null) clearTimeout(flushTimer)
      unsubscribe()
    }
  }, [])

  // Both totals derive from the same reducer state, so an EVICT_BATCH updates
  // the list, this counter, and the footer in one atomic render.
  const openCount = alerts.filter((alert) => !alert.resolving).length
  const fadingCount = alerts.length - openCount

  // Zero-mutation filter chain: severity gate first (object lookup), then the
  // lowercased substring probe across station name, wire id, and operating
  // network. Short-circuits on the empty query so the unfiltered path costs
  // one boolean check per row.
  const normalizedQuery = query.trim().toLowerCase()
  const filteredAlerts = alerts.filter((alert) => {
    if (!activeSeverities[alert.severity]) return false
    if (normalizedQuery === '') return true
    return [alert.stationName, alert.stationId, alert.network].some((field) =>
      field?.toLowerCase().includes(normalizedQuery)
    )
  })
  const filterActive = normalizedQuery !== '' || SEVERITY_ORDER.some((s) => !activeSeverities[s])

  const toggleSeverity = (severity) =>
    setActiveSeverities((prev) => ({ ...prev, [severity]: !prev[severity] }))

  return (
    <section
      aria-labelledby="alert-desk-heading"
      className="h-96 flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70"
    >
      <header className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
        <h2 id="alert-desk-heading" className="text-xs font-bold uppercase tracking-widest text-slate-300">
          Alert Desk · Active Incident Ledger
        </h2>
        <span
          aria-live="polite"
          className="rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-300"
        >
          {phase === 'ready' ? `${openCount} open` : '—'}
        </span>
      </header>

      {/* Task 13.4 operator filter bar: a search landmark inside the fixed
          desk shell (shrink-0, so toggling filters never resizes the section). */}
      <form
        role="search"
        aria-label="Filter the incident ledger"
        onSubmit={(event) => event.preventDefault()}
        className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-800 bg-slate-950/40"
      >
        <fieldset className="m-0 flex items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">Show or hide severities</legend>
          {SEVERITY_ORDER.map((severity) => (
            <button
              key={severity}
              type="button"
              aria-pressed={activeSeverities[severity]}
              aria-label={`${activeSeverities[severity] ? 'Hide' : 'Show'} ${severity.toLowerCase()} incidents`}
              onClick={() => toggleSeverity(severity)}
              className={`min-h-9 rounded-lg border px-2.5 text-[11px] font-bold tracking-wider focus-visible:outline-2 focus-visible:outline-cyan-400 ${
                activeSeverities[severity]
                  ? SEVERITY_TOGGLES[severity].on
                  : SEVERITY_TOGGLES[severity].off
              }`}
            >
              {severity}
            </button>
          ))}
        </fieldset>
        <label className="relative flex-1 min-w-44">
          <span className="sr-only">Search by station name, station id, or operator network</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search station / network…"
            className="w-full min-h-9 rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-base text-slate-200 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-cyan-400"
          />
        </label>
        {filterActive && phase === 'ready' && (
          <span aria-live="polite" className="text-xs tabular-nums text-slate-400 whitespace-nowrap">
            {filteredAlerts.length} of {alerts.length} shown
          </span>
        )}
      </form>

      {/* Task 19.4.1: flex-1/min-h-0 fully removed per this UOW's explicit
          "Flex Unbind" directive — a hard pixel height replaces the flex-
          computed one so this wrapper's clientHeight is a fixed, known
          quantity independent of the desk's h-96 shell math. Trade-off this
          time deliberately accepted rather than overridden (unlike 19.3): a
          short incident list now leaves visible space above the footer
          instead of the wrapper stretching to fill it — the desk's h-96
          section is still fixed, so no layout-shift/CLS risk, just a look
          change on sparse ledgers. Inline styles (not Tailwind classes) per
          the PO's literal spec — WebkitOverflowScrolling has no Tailwind
          utility equivalent anyway. */}
      <div
        style={{
          height: '240px',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          touchAction: 'pan-y',
        }}
        className="w-full"
      >
        <div
          style={{
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            touchAction: 'pan-x',
          }}
          className="w-full"
        >
        {phase === 'loading' ? (
          <LoadingSkeleton />
        ) : phase === 'error' ? (
          <DeskNotice>Incident ledger unavailable — backend unreachable.</DeskNotice>
        ) : alerts.length === 0 ? (
          <DeskNotice>All clear — no open incidents on the grid.</DeskNotice>
        ) : filteredAlerts.length === 0 ? (
          <DeskNotice>No incidents match the active filters.</DeskNotice>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Active incident desk: showing {filteredAlerts.length} of {alerts.length} incidents
              under the current severity and search filters, sorted by severity, critical first,
              then by most recent activity. Columns list severity, station identity and network,
              fault type, latest message, grouped event count, and last seen time. Select a row to
              generate its Nemzilla AI Diagnostic Brief. Resolved incidents dim in place until
              cleared.
            </caption>
            <thead>
              <tr>
                <th scope="col" className={HEADER_CELL}>Severity</th>
                <th scope="col" className={HEADER_CELL}>Station</th>
                <th scope="col" className={HEADER_CELL}>Fault</th>
                <th scope="col" className={HEADER_CELL}>Message</th>
                <th scope="col" className={`${HEADER_CELL} text-right`}>Events</th>
                <th scope="col" className={`${HEADER_CELL} text-right`}>Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredAlerts.map((alert) => {
                const rowSelected = selectedAlertId === alert.id
                const selectRow = () => onSelectAlert?.(alert)
                return (
                  <tr
                    key={alert.id}
                    tabIndex={onSelectAlert ? 0 : undefined}
                    aria-selected={onSelectAlert ? rowSelected : undefined}
                    onClick={onSelectAlert ? selectRow : undefined}
                    onKeyDown={
                      onSelectAlert
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              selectRow()
                            }
                          }
                        : undefined
                    }
                    className={`${
                      alert.resolving ? 'alert-desk-row-resolving' : 'alert-desk-row-enter'
                    } ${rowSelected ? 'bg-cyan-500/10' : 'hover:bg-slate-800/40'} ${
                      onSelectAlert ? 'cursor-pointer focus-visible:outline-2 focus-visible:outline-cyan-400 focus-visible:-outline-offset-2' : ''
                    }`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-[11px] font-bold tracking-wider ${
                          SEVERITY_BADGES[alert.severity] ?? SEVERITY_BADGES.INFO
                        }`}
                      >
                        {alert.severity}
                      </span>
                      {alert.resolving && (
                        <span className="ml-2 inline-block rounded border border-emerald-700/60 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold tracking-wider text-emerald-300">
                          RESOLVED
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="block text-xs text-slate-200">
                        {alert.stationName ?? alert.stationId}
                      </span>
                      <span className="block font-mono text-[11px] text-cyan-300/90">
                        {alert.stationId}
                        {alert.network && <span className="text-slate-500"> · {alert.network}</span>}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap">{alert.type}</td>
                    <td className="px-4 py-2.5 max-w-xs truncate text-slate-200" title={alert.message}>
                      {alert.message}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                      ×{alert.eventCount}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-xs text-slate-400 whitespace-nowrap">
                      <time dateTime={lastActivity(alert)}>{formatSeen(alert)}</time>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        </div>
      </div>

      <footer className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-t border-slate-800 text-xs text-slate-400 tabular-nums">
        <span>
          Unresolved incidents: <span className="font-semibold text-slate-200">{phase === 'ready' ? openCount : '—'}</span>
        </span>
        <span aria-live="polite">
          {fadingCount > 0 ? `${fadingCount} resolving…` : 'ledger stable'}
        </span>
      </footer>
    </section>
  )
}

export default AlertDesk
