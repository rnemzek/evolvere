import { generateDiagnosticBrief } from '../services/alertEngine.js'

function DiagnosticBrief({ alert }) {
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

      <div className="p-4">
        {alert ? (
          <>
            <p className="text-xs font-mono text-slate-500 mb-3">
              {alert.chargerId} · port {alert.connectorId} · {alert.category}
            </p>
            <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-line">
              {generateDiagnosticBrief(alert)}
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-500">
            Select an alert from the desk to generate a triage brief with probable
            cause and SOP action steps.
          </p>
        )}
      </div>
    </section>
  )
}

export default DiagnosticBrief
