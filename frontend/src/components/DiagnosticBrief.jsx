import { generateDiagnosticBrief, generateLedgerBrief } from '../services/alertEngine.js'

const CAUSE_LABELS = {
  EXTERNAL_GRID_FAILURE: 'External · Grid',
  EXTERNAL_NETWORK_DROP: 'External · Carrier',
  ENVIRONMENTAL_WEATHER: 'Environmental · Weather',
  LOCAL_HARDWARE: 'Local Hardware',
}

// UOW-19.1 Task 19.1.1: the panel now also renders for a selected Alert Desk
// ledger incident (`ledgerAlert`) — a distinct shape from the fault-level
// `alert` prop (chargerId/connectorId/code) it already served. Whichever the
// operator selected most recently wins; App.jsx enforces that mutual
// exclusivity, this component just renders whichever prop is non-null.
function DiagnosticBrief({ alert, ledgerAlert, briefs = [] }) {
  // Server-enriched briefs are pre-computed at fault time; the client
  // generator only backfills alert types without a persisted record
  // (suspensions, zero-output trends, session terminations).
  const cached = alert
    ? briefs.find(
        (b) => b.chargerId === alert.chargerId && b.connectorId === alert.connectorId && b.code === alert.code
      )
    : null
  return (
    <section
      aria-label="Nemzilla AI Diagnostic Brief"
      className="rounded-xl border border-cyan-900/70 bg-gradient-to-b from-slate-900/90 to-cyan-950/40 backdrop-blur overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-cyan-900/50 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" aria-hidden="true" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-cyan-300">
          Nemzilla AI Diagnostic Brief
        </h2>
      </header>

      {/* Task 19.3.2: touch-pan-y (single axis, this panel only ever scrolls
          vertically) + overscroll-contain stops the swipe from chaining into
          the fixed-shell page once the text hits its top/bottom edge —
          same WebKit-safe axis-locked approach as the Alert Desk split in
          19.3.1, just single-axis here since there's no horizontal content. */}
      <div className="p-4 w-full max-h-[250px] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]">
        {ledgerAlert ? (
          <>
            <p className="text-xs font-mono text-slate-400 mb-3 flex items-center gap-2 flex-wrap">
              <span>
                {ledgerAlert.stationName ?? ledgerAlert.stationId} · {ledgerAlert.stationId}
                {ledgerAlert.network && ` · ${ledgerAlert.network}`}
              </span>
              <span className="rounded-full border border-cyan-700 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-cyan-300">
                {CAUSE_LABELS[ledgerAlert.type] ?? ledgerAlert.type}
              </span>
            </p>
            <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-line">
              {generateLedgerBrief(ledgerAlert)}
            </p>
          </>
        ) : alert ? (
          <>
            <p className="text-xs font-mono text-slate-400 mb-3 flex items-center gap-2 flex-wrap">
              <span>
                {alert.chargerId} · port {alert.connectorId} · {alert.category}
              </span>
              {cached ? (
                <span className="rounded-full border border-cyan-700 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-cyan-300">
                  {CAUSE_LABELS[cached.causeClass] ?? cached.causeClass}
                </span>
              ) : null}
            </p>
            <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-line">
              {cached ? cached.brief : generateDiagnosticBrief(alert)}
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-400">
            Select an alert from the desk to generate a triage brief with probable
            cause and SOP action steps.
          </p>
        )}
      </div>
    </section>
  )
}

export default DiagnosticBrief
