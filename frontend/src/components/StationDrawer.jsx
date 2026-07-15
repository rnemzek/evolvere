export const STATUS_STYLES = {
  Available: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  Preparing: 'bg-sky-500/15 text-sky-400 border-sky-500/40',
  Charging: 'bg-green-500/15 text-green-400 border-green-500/40',
  SuspendedEVSE: 'bg-amber-500/15 text-amber-400 border-amber-500/40',
  Finishing: 'bg-teal-500/15 text-teal-300 border-teal-500/40',
  Faulted: 'bg-red-500/20 text-red-400 border-red-500/60',
}

function StationDrawer({ station, onClose }) {
  if (!station) return null

  const totalKW = station.connectors.reduce((sum, c) => sum + c.currentPowerKW, 0)
  const faulted = station.connectors.some((c) => c.status === 'Faulted')

  return (
    <aside
      className="absolute z-[1000] bg-slate-900/95 backdrop-blur border-slate-700 text-slate-100 shadow-2xl
                 inset-x-0 bottom-0 max-h-[60vh] rounded-t-2xl border-t
                 md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:w-96 md:max-h-none md:rounded-none md:border-t-0 md:border-l
                 flex flex-col"
      aria-label={`Details for ${station.siteName}`}
    >
      <header className="flex items-start justify-between gap-3 p-4 border-b border-slate-800">
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500">Station</p>
          <h2 className="text-lg font-semibold leading-tight">{station.siteName}</h2>
          <p className="font-mono text-sm text-cyan-400">{station.chargerId}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close station details"
          className="min-w-11 min-h-11 shrink-0 grid place-items-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 active:bg-slate-700 text-xl leading-none"
        >
          &times;
        </button>
      </header>

      <div className="overflow-y-auto p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-slate-800/60 p-3">
            <p className="text-slate-500 text-xs uppercase tracking-wider">Firmware</p>
            <p className="font-mono">{station.firmwareVersion}</p>
          </div>
          <div className="rounded-lg bg-slate-800/60 p-3">
            <p className="text-slate-500 text-xs uppercase tracking-wider">OCPP</p>
            <p className="font-mono">{station.ocppVersion}</p>
          </div>
          <div className="rounded-lg bg-slate-800/60 p-3 col-span-2">
            <p className="text-slate-500 text-xs uppercase tracking-wider">Site Power Draw</p>
            <p className={`text-2xl font-bold ${faulted ? 'text-red-400' : 'text-green-400'}`}>
              {totalKW.toFixed(1)} kW
            </p>
          </div>
        </div>

        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">Connectors</p>
          <ul className="space-y-2">
            {station.connectors.map((connector) => (
              <li
                key={connector.connectorId}
                className="min-h-11 rounded-lg border border-slate-800 bg-slate-800/40 p-3 flex items-center justify-between gap-3"
              >
                <div>
                  <p className="font-medium">
                    #{connector.connectorId} · {connector.type}
                  </p>
                  {connector.lastErrorCode && (
                    <p className="text-xs font-mono text-red-400">
                      {connector.lastErrorCode}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-slate-300">
                    {connector.currentPowerKW.toFixed(1)} kW
                  </span>
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded-full border ${
                      STATUS_STYLES[connector.status] ?? 'bg-slate-700 text-slate-300 border-slate-600'
                    }`}
                  >
                    {connector.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  )
}

export default StationDrawer
