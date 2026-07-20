import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react'
import StationDrawer from './components/StationDrawer.jsx'
import KPIStats from './components/KPIStats.jsx'
import ROIPanel from './components/ROIPanel.jsx'
import AlertTable from './components/AlertTable.jsx'
import AlertDesk from './components/AlertDesk.jsx'
import DispatchBoard from './components/DispatchBoard.jsx'
import DiagnosticBrief from './components/DiagnosticBrief.jsx'
import ControlPanel from './components/ControlPanel.jsx'
import { fetchSessionHistory, fetchAlertBriefs, fetchRegistryProfile } from './services/fleetApi.js'
import { deriveAlerts } from './services/alertEngine.js'
import { useFleetStream } from './hooks/useFleetStream.js'

// The Leaflet map (leaflet + react-leaflet + overlay planes + national cluster
// markers) is the heaviest dependency tree in the app; splitting it keeps the
// landing bundle lean so telemetry tiles and the Alert Desk render without
// waiting on map code. The Financial Matrix ledger splits for the same reason
// (Task 10.1): neither view is on the landing path, so neither taxes TTI.
const CommandCenterMap = lazy(() => import('./components/CommandCenterMap.jsx'))
const FinancialMatrix = lazy(() => import('./components/FinancialMatrix.jsx'))

const VIEWS = ['Map', 'Dashboard', 'Financials']

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

// Zero-CLS placeholder for the lazy ledger chunk: reserves table-scale height
// so the Financials view doesn't jump when the chunk resolves.
function LedgerLoadingFallback() {
  return (
    <div
      className="min-h-64 rounded-xl border border-slate-800 bg-slate-900/70 grid place-items-center"
      aria-label="Loading financial matrix"
    >
      <div className="flex items-center gap-3 text-slate-400">
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
        <p className="text-sm font-semibold tracking-widest uppercase">Loading financial matrix…</p>
      </div>
    </div>
  )
}

// A failed chunk fetch (offline, deploy mid-session) must degrade to a retry
// placeholder — without this boundary the rejection unmounts the whole app,
// Dashboard included. Shared by every lazy chunk (map, financial ledger).
class ChunkErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="h-full w-full grid place-items-center bg-slate-950">
        <div className="text-center space-y-3">
          <p className="text-sm font-semibold text-slate-300">{this.props.label} failed to load.</p>
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
  // UOW-19.1 Task 19.1.1: Alert Desk row selection (unified ledger incidents)
  // feeds the same Diagnostic Brief panel as the fault-level Alert Table.
  // Whichever the operator clicked most recently wins — selecting in one
  // list clears the other so the brief never shows a stale combination.
  const [selectedLedgerAlert, setSelectedLedgerAlert] = useState(null)
  const [controlPanelOpen, setControlPanelOpen] = useState(false)
  const [registryProfile, setRegistryProfile] = useState(null)

  // UOW-14 Task 14.1: the header locality line reads the live database
  // profile instead of a hardcoded "Orange County" asset.
  useEffect(() => {
    fetchRegistryProfile()
      .then(setRegistryProfile)
      .catch(() => {})
  }, [])

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
    // UOW-16 Task 16.2: fixed inset-0 pins the shell to the visual viewport —
    // h-screen tracked the layout viewport, so mobile URL-bar collapse plus
    // body overscroll let the masthead drift ("ghost scrolling"). touch-none
    // kills native panning on the shell itself; it is NOT consulted for
    // descendants that sit inside their own scroll container (the Dashboard/
    // Financials mains, the map tray) or for Leaflet's pointer-event pipeline,
    // so a thumb-drag pans exactly one thing: the map canvas.
    <div className="fixed inset-0 overflow-hidden overscroll-none touch-none bg-slate-950 text-slate-100 flex flex-col">
      <header className="z-[1000] w-full max-w-full left-0 right-0 box-border shrink-0 overflow-x-hidden flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/85 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-sm font-bold tracking-widest text-cyan-400 truncate">
            Nemzilla evolvère GRID
          </h1>
          <p className="text-xs text-slate-400 truncate">
            {registryProfile
              ? `${registryProfile.stations.toLocaleString()} stations · ${registryProfile.coverage} · ${registryProfile.states} states · live`
              : `${stations.length} fleet chargers · live`}
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
          <ChunkErrorBoundary label="Command map">
            <Suspense fallback={<MapLoadingFallback />}>
              <CommandCenterMap stations={stations} onSelectStation={(s) => setSelectedStationId(s.chargerId)} />
            </Suspense>
          </ChunkErrorBoundary>
          <StationDrawer station={selectedStation} onClose={() => setSelectedStationId(null)} />
        </main>
      ) : view === 'Financials' ? (
        <main className="flex-1 max-w-full overflow-y-auto overflow-x-hidden overscroll-contain p-4">
          <ChunkErrorBoundary label="Financial matrix">
            <Suspense fallback={<LedgerLoadingFallback />}>
              <FinancialMatrix />
            </Suspense>
          </ChunkErrorBoundary>
        </main>
      ) : (
        <main className="flex-1 max-w-full overflow-y-auto overflow-x-hidden overscroll-contain p-4 space-y-4">
          <KPIStats stations={stations} transactions={transactions} />
          <ROIPanel stations={stations} />
          <AlertDesk
            selectedAlertId={selectedLedgerAlert?.id}
            onSelectAlert={(alert) => {
              setSelectedLedgerAlert(alert)
              setSelectedAlert(null)
            }}
          />
          <DispatchBoard />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <AlertTable
                alerts={alerts}
                briefs={briefs}
                selectedAlertId={selectedAlert?.id}
                onSelectAlert={(alert) => {
                  setSelectedAlert(alert)
                  setSelectedLedgerAlert(null)
                }}
              />
            </div>
            <DiagnosticBrief alert={selectedAlert} ledgerAlert={selectedLedgerAlert} briefs={briefs} />
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
