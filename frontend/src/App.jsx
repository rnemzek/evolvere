import { useEffect, useMemo, useState } from 'react'
import CommandCenterMap from './components/CommandCenterMap.jsx'
import StationDrawer from './components/StationDrawer.jsx'
import KPIStats from './components/KPIStats.jsx'
import AlertTable from './components/AlertTable.jsx'
import DiagnosticBrief from './components/DiagnosticBrief.jsx'
import ControlPanel from './components/ControlPanel.jsx'
import { fetchSessionHistory } from './services/fleetApi.js'
import { deriveAlerts } from './services/alertEngine.js'
import { useFleetStream } from './hooks/useFleetStream.js'

const VIEWS = ['Map', 'Dashboard']

function App() {
  const [view, setView] = useState('Map')
  const { stations, error } = useFleetStream()
  const [transactions, setTransactions] = useState([])
  const [selectedStationId, setSelectedStationId] = useState(null)
  const [selectedAlert, setSelectedAlert] = useState(null)
  const [controlPanelOpen, setControlPanelOpen] = useState(false)

  useEffect(() => {
    fetchSessionHistory()
      .then((history) => setTransactions(history.transactions))
      .catch(() => {})
  }, [])

  const alerts = useMemo(
    () => deriveAlerts(stations, transactions),
    [stations, transactions]
  )

  const selectedStation = useMemo(
    () => stations.find((s) => s.chargerId === selectedStationId) ?? null,
    [stations, selectedStationId]
  )

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col">
      <header className="z-[1000] flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/85 backdrop-blur">
        <div>
          <h1 className="text-sm font-bold tracking-widest text-cyan-400">
            Nemzilla NOC — ēvolvere FLEET
          </h1>
          <p className="text-xs text-slate-400">
            {stations.length} stations · Orange County, CA · live
          </p>
        </div>
        <nav aria-label="View switcher" className="flex items-center gap-2">
          {VIEWS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setView(name)}
              aria-pressed={view === name}
              className={`min-h-11 min-w-11 px-4 rounded-lg text-sm font-semibold border ${
                view === name
                  ? 'bg-cyan-500/15 border-cyan-600 text-cyan-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setControlPanelOpen((open) => !open)}
            aria-label="Open demo control panel"
            className="min-h-11 min-w-11 grid place-items-center rounded-lg text-slate-700 hover:text-amber-400"
          >
            ⚙
          </button>
        </nav>
      </header>

      {error ? (
        <div className="flex-1 grid place-items-center">
          <p className="text-red-400">Fleet data unavailable: {error}</p>
        </div>
      ) : view === 'Map' ? (
        <main className="relative flex-1">
          <CommandCenterMap stations={stations} onSelectStation={(s) => setSelectedStationId(s.chargerId)} />
          <StationDrawer station={selectedStation} onClose={() => setSelectedStationId(null)} />
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto p-4 space-y-4">
          <KPIStats stations={stations} transactions={transactions} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <AlertTable
                alerts={alerts}
                selectedAlertId={selectedAlert?.id}
                onSelectAlert={setSelectedAlert}
              />
            </div>
            <DiagnosticBrief alert={selectedAlert} />
          </div>
        </main>
      )}

      <ControlPanel
        open={controlPanelOpen}
        stations={stations}
        onClose={() => setControlPanelOpen(false)}
      />
    </div>
  )
}

export default App
