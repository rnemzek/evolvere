import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react'
import StationDrawer from './components/StationDrawer.jsx'
import KPIStats from './components/KPIStats.jsx'
import ROIPanel from './components/ROIPanel.jsx'
import AlertTable from './components/AlertTable.jsx'
import DiagnosticBrief from './components/DiagnosticBrief.jsx'
import ControlPanel from './components/ControlPanel.jsx'
import { fetchSessionHistory, fetchAlertBriefs } from './services/fleetApi.js'
import { deriveAlerts } from './services/alertEngine.js'
import { useFleetStream } from './hooks/useFleetStream.js'

// The Leaflet map (leaflet + react-leaflet + overlay planes) is the heaviest
// dependency tree in the app; splitting it keeps the landing bundle lean so
// telemetry tiles and the Alert Desk render without waiting on map code.
const CommandCenterMap = lazy(() => import('./components/CommandCenterMap.jsx'))

const VIEWS = ['Map', 'Dashboard']

// Fills the same flex-1 container the map mounts into — identical fixed
// dimensions while the chunk resolves, so CLS stays at zero.
function MapLoadingFallback() {
  return (
    <div className="h-full w-full grid place-items-center bg-slate-950" aria-label="Loading map">
      <div className="flex items-center gap-3 text-slate-400">
        <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 animate-pulse" aria-hidden="true" />
        <p className="text-sm font-semibold tracking-widest uppercase">Loading command map…</p>
      </div>
    </div>
  )
}

// A failed chunk fetch (offline, deploy mid-session) must degrade to a retry
// placeholder — without this boundary the rejection unmounts the whole app,
// Dashboard included.
class MapErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="h-full w-full grid place-items-center bg-slate-950">
        <div className="text-center space-y-3">
          <p className="text-sm font-semibold text-slate-300">Command map failed to load.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 px-4 rounded-lg border border-cyan-600 text-sm font-semibold text-cyan-300 hover:bg-cyan-500/10"
          >
            Reload NOC
          </button>
        </div>
      </div>
    )
  }
}

function App() {
  const [view, setView] = useState('Map')
  const { stations, error } = useFleetStream()
  const [transactions, setTransactions] = useState([])
  const [briefs, setBriefs] = useState([])
  const [selectedStationId, setSelectedStationId] = useState(null)
  const [selectedAlert, setSelectedAlert] = useState(null)
  const [controlPanelOpen, setControlPanelOpen] = useState(false)

  useEffect(() => {
    fetchSessionHistory()
      .then((history) => setTransactions(history.transactions))
      .catch(() => {})
  }, [])

  // Pre-computed triage briefs: refreshed on every SSE snapshot so a selected
  // alert row reads its enriched payload instantly, with no generation delay.
  useEffect(() => {
    let cancelled = false
    fetchAlertBriefs()
      .then((data) => {
        if (!cancelled) setBriefs(data.briefs)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [stations])

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
          <MapErrorBoundary>
            <Suspense fallback={<MapLoadingFallback />}>
              <CommandCenterMap stations={stations} onSelectStation={(s) => setSelectedStationId(s.chargerId)} />
            </Suspense>
          </MapErrorBoundary>
          <StationDrawer station={selectedStation} onClose={() => setSelectedStationId(null)} />
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto p-4 space-y-4">
          <KPIStats stations={stations} transactions={transactions} />
          <ROIPanel stations={stations} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <AlertTable
                alerts={alerts}
                selectedAlertId={selectedAlert?.id}
                onSelectAlert={setSelectedAlert}
              />
            </div>
            <DiagnosticBrief alert={selectedAlert} briefs={briefs} />
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
