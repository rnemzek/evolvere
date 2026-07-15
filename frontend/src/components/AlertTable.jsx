const SEVERITY_BADGES = {
  CRITICAL: 'bg-red-950 text-red-300 border border-red-700',
  WARNING: 'bg-amber-500/15 text-amber-400 border border-amber-500/50',
  INFO: 'bg-blue-500/15 text-blue-400 border border-blue-500/50',
}

function formatTime(timestamp) {
  if (!timestamp) return 'Ongoing'
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function AlertTable({ alerts, selectedAlertId, onSelectAlert }) {
  return (
    <section
      aria-label="NOC alert desk"
      className="rounded-xl border border-slate-800 bg-slate-900/70 backdrop-blur overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300">
          Alert Desk
        </h2>
        <span className="text-xs text-slate-500">{alerts.length} active</span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <th className="px-4 py-2 font-medium">Severity</th>
              <th className="px-4 py-2 font-medium">Timestamp</th>
              <th className="px-4 py-2 font-medium">Station</th>
              <th className="px-4 py-2 font-medium hidden md:table-cell">Site</th>
              <th className="px-4 py-2 font-medium">Fault Category</th>
              <th className="px-4 py-2 font-medium sr-only md:not-sr-only">Action</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr
                key={alert.id}
                className={`border-b border-slate-800/60 last:border-b-0 ${
                  selectedAlertId === alert.id ? 'bg-cyan-500/10' : 'hover:bg-slate-800/40'
                }`}
              >
                <td className="px-4 py-3">
                  <span
                    className={`inline-block px-2 py-1 rounded text-xs font-bold ${SEVERITY_BADGES[alert.severity]}`}
                  >
                    {alert.severity}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-400 tabular-nums">
                  {formatTime(alert.timestamp)}
                </td>
                <td className="px-4 py-3 font-mono text-cyan-400 whitespace-nowrap">
                  {alert.chargerId}
                </td>
                <td className="px-4 py-3 text-slate-300 hidden md:table-cell">
                  {alert.siteName}
                </td>
                <td className="px-4 py-3 text-slate-200">{alert.category}</td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onSelectAlert(alert)}
                    className="min-h-11 min-w-11 px-3 rounded-lg border border-cyan-700/60 text-cyan-300 text-xs font-semibold uppercase tracking-wide hover:bg-cyan-500/10 active:bg-cyan-500/20"
                  >
                    Triage
                  </button>
                </td>
              </tr>
            ))}
            {alerts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
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
