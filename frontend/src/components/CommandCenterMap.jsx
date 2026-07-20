import { useCallback, useEffect, useRef, useState } from 'react'
import { AttributionControl, MapContainer, TileLayer, Marker, Tooltip, Circle, CircleMarker, Rectangle, ZoomControl, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
// Leaflet CSS ships with this lazy chunk, not the landing bundle (Task 7.1).
import 'leaflet/dist/leaflet.css'
import { isStationFaulted } from '../services/stationHealth.js'
import { STATUS_STYLES } from './StationDrawer'
import MapLayerControls from './MapLayerControls.jsx'
import { useEnvironment } from '../hooks/useEnvironment.js'
import { fetchSpatialClusters, fetchRegistryLocate, fetchGridOutages } from '../services/fleetApi.js'
import { subscribeStream } from '../services/streamHub.js'

const OC_CENTER = [33.74, -117.82]

// UOW-15 Task 15.4: canonical national overview — the Home control resets the
// viewport to this CONUS frame.
const NATIONAL_OVERVIEW_BOUNDS = [[24.4, -124.8], [49.4, -66.7]]

// UOW-15 Task 15.2: macro US sector presets — [[south, west], [north, east]]
// viewport bounds the operator can teleport to instantly (no network hop).
const REGION_PRESETS = [
  { id: 'ne', label: 'NE', name: 'Northeast', bounds: [[40.4, -80.6], [47.6, -66.7]] },
  { id: 'midatl', label: 'MID-ATL', name: 'Mid-Atlantic', bounds: [[36.5, -83.7], [41.5, -73.8]] },
  { id: 'se', label: 'SE', name: 'Southeast', bounds: [[24.4, -92.6], [36.7, -75.3]] },
  { id: 'mw', label: 'MW', name: 'Midwest', bounds: [[36.0, -104.1], [49.4, -80.4]] },
  { id: 'west', label: 'WEST', name: 'West Coast', bounds: [[32.3, -124.8], [49.1, -114.0]] },
]

const CARRIER_COLORS = {
  'ISP-VERIZON-CELLULAR': '#fb7185',
  'ISP-ATT-BUSINESS': '#38bdf8',
  'ISP-TMOBILE-IOT': '#e879f9',
  'ISP-SPECTRUM-FIBER': '#fbbf24',
}
// UOW-16 Task 16.2: touch-tap hardening for vector pins. Leaflet 1.9 dropped
// the legacy `tap` handler in favor of native pointer events, so tap fidelity
// is configured in two places: (1) this shared Canvas renderer, whose
// `tolerance` option extends every path's hit-test by 14px in all directions —
// a 5px CircleMarker becomes a ~38px effective thumb target — and (2) an
// explicit `click → openTooltip()` handler, because tooltips otherwise open
// only on mouseover, an event a touch screen never fires. openTooltip() reads
// data already resident in the layer, so the popup is instant — zero network
// hop. (Canvas also rasterizes the 1,500-pin street-zoom payload into a
// single element, cheaper than 1,500 SVG nodes.)
const touchPinRenderer = L.canvas({ padding: 0.5, tolerance: 14 })

// Desktop is unaffected: hover already opened the tooltip, so the click is a
// no-op there; bubbling stays off so a pin tap can't fall through to the map.
const tapOpenTooltip = { click: (e) => e.target.openTooltip() }

// UOW-16 Task 16.3 (Diagnostic Reference Pin): neon-cyan crosshair target for
// screenshot-based UAT coordinate verification. One icon instance — the pin is
// a singleton, so the divIcon never varies.
const diagnosticPinIcon = L.divIcon({
  className: '',
  html:
    '<div class="diagnostic-pin" role="img" aria-label="UAT diagnostic reference pin">' +
    '<span class="ring"></span><span class="cross-v"></span><span class="cross-h"></span><span class="dot"></span></div>',
  iconSize: [44, 44],
  iconAnchor: [22, 22],
})

/**
 * Map-level interaction listener for the diagnostic pin. Leaflet fires
 * `contextmenu` for desktop right-clicks natively; on touch screens the
 * MapContainer's `tapHold` gate synthesizes the same `contextmenu` event from
 * a long-press (Leaflet 1.9's pointer-event replacement for the removed Tap
 * handler), so one listener covers both input worlds. preventDefault stops
 * the OS/browser context menu from opening over the map.
 */
function DiagnosticPinController({ onDrop }) {
  useMapEvents({
    contextmenu: (e) => {
      e.originalEvent?.preventDefault()
      onDrop({ lat: e.latlng.lat, lng: e.latlng.lng })
    },
  })
  return null
}

const DARK_MATTER_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const DARK_MATTER_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

function markerIcon(station) {
  const state = isStationFaulted(station) ? 'faulted' : 'healthy'
  return L.divIcon({
    className: '',
    html: `<div class="charger-marker ${state}" role="button" aria-label="${station.siteName}"><span class="ring"></span><span class="dot"></span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

function StationTooltip({ station }) {
  const { latitude, longitude } = station.location
  return (
    // fleet-station-tooltip: hover-only — on touch devices the tap opens the
    // full StationDrawer instead, so index.css suppresses just this tooltip.
    <Tooltip
      direction="top"
      offset={[0, -16]}
      opacity={1}
      className="charger-tooltip fleet-station-tooltip"
    >
      <div className="min-w-52 space-y-2">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-zinc-400">
            Station
          </p>
          <p className="text-sm font-semibold leading-tight text-slate-100">
            {station.siteName}
          </p>
          <p className="font-mono text-xs text-cyan-400">{station.chargerId}</p>
        </div>
        <p className="font-mono text-[11px] text-zinc-300">
          {latitude.toFixed(4)}, {longitude.toFixed(4)} · FW{' '}
          {station.firmwareVersion} · OCPP {station.ocppVersion}
        </p>
        <ul className="space-y-1">
          {station.connectors.map((connector) => (
            <li
              key={connector.connectorId}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="text-slate-300">
                #{connector.connectorId} · {connector.type}
              </span>
              <span
                className={`font-semibold px-1.5 py-0.5 rounded-full border text-[10px] ${
                  STATUS_STYLES[connector.status] ??
                  'bg-slate-700 text-slate-300 border-slate-600'
                }`}
              >
                {connector.status}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[10px] uppercase tracking-wider text-zinc-400">
          Tap for full telemetry
        </p>
      </div>
    </Tooltip>
  )
}

/** Grid Power plane: coverage circles around the six substation centroids. */
function GridPowerLayer({ topology, environment }) {
  const statusById = new Map((environment?.gridNodes ?? []).map((n) => [n.id, n]))
  return (topology?.gridNodes ?? []).map((node) => {
    const outage = statusById.get(node.id)?.powerStatus === 'OUTAGE'
    return (
      // pathOptions.className never reaches the SVG (react-leaflet applies
      // updates via setStyle, which ignores it), so the pulse class is added
      // on the layer's `add` event; the key remounts the layer on state flips.
      <Circle
        key={`${node.id}-${outage ? 'outage' : 'nominal'}`}
        center={[node.centroid.latitude, node.centroid.longitude]}
        radius={1600}
        pathOptions={{
          color: outage ? '#f59e0b' : '#34d399',
          weight: outage ? 2.5 : 1.2,
          fillColor: outage ? '#ef4444' : '#34d399',
          fillOpacity: outage ? 0.22 : 0.06,
        }}
        eventHandlers={
          outage
            ? { ...tapOpenTooltip, add: (e) => e.target.getElement()?.classList.add('grid-zone-outage') }
            : tapOpenTooltip
        }
        bubblingMouseEvents={false}
      >
        <Tooltip direction="top" opacity={1} className="charger-tooltip">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">{node.name}</p>
            <p className="font-mono text-xs text-zinc-300">
              {node.utility} · {node.capacityMVA} MVA · {node.chargerCount} sites
            </p>
            <p className={`text-xs font-bold ${outage ? 'text-red-400' : 'text-emerald-400'}`}>
              {outage ? 'GRID OUTAGE' : 'NOMINAL'}
            </p>
          </div>
        </Tooltip>
      </Circle>
    )
  })
}

/** Network plane: public sites ringed in carrier colors; downed carriers wash out. */
function NetworkLayer({ directory, environment }) {
  const carrierStatus = new Map((environment?.ispCarriers ?? []).map((c) => [c.id, c]))
  const impacted = new Set(environment?.affectedDirectoryChargers ?? [])
  return directory.map((charger) => {
    const carrierId = charger.ispCarrier?.id
    const carrierDown = carrierStatus.get(carrierId)?.networkStatus === 'DOWN'
    const washed = carrierDown || impacted.has(charger.ocmId)
    return (
      <CircleMarker
        key={charger.ocmId}
        center={[charger.location.latitude, charger.location.longitude]}
        radius={9}
        renderer={touchPinRenderer}
        eventHandlers={tapOpenTooltip}
        bubblingMouseEvents={false}
        pathOptions={{
          color: washed ? '#64748b' : (CARRIER_COLORS[carrierId] ?? '#94a3b8'),
          weight: 2,
          opacity: washed ? 0.55 : 0.9,
          dashArray: washed ? '4 4' : null,
          fillColor: washed ? '#64748b' : (CARRIER_COLORS[carrierId] ?? '#94a3b8'),
          fillOpacity: washed ? 0.08 : 0.25,
        }}
      >
        <Tooltip direction="top" opacity={1} className="charger-tooltip">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">{charger.name}</p>
            <p className="font-mono text-xs text-zinc-300">
              {charger.operator} · {charger.ispCarrier?.name ?? 'Unknown carrier'}
            </p>
            <p className={`text-xs font-bold ${washed ? 'text-amber-400' : 'text-emerald-400'}`}>
              {carrierDown ? 'CARRIER DOWN' : impacted.has(charger.ocmId) ? 'IMPACTED' : 'ONLINE'}
            </p>
          </div>
        </Tooltip>
      </CircleMarker>
    )
  })
}

// UOW-16 Task 16.4: severity → wash styling for the Grid Outage plane.
// Low-profile translucent fills so tiles, pins, and clusters stay legible
// through the territory shading: dark crimson for CRITICAL, soft amber for
// WARNING, and a barely-there dashed slate for INFO-grade flickers.
const OUTAGE_WASHES = {
  CRITICAL: { color: '#b91c1c', weight: 1.5, fillColor: '#7f1d1d', fillOpacity: 0.28 },
  WARNING: { color: '#d97706', weight: 1.2, fillColor: '#f59e0b', fillOpacity: 0.14 },
  INFO: { color: '#64748b', weight: 1, dashArray: '4 4', fillColor: '#64748b', fillOpacity: 0.07 },
}

// County impact footprint → Leaflet bounds. Mirrors the backend correlator's
// impactBounds() math exactly, so the wash the operator sees is the same
// region the EXTERNAL_GRID_FAILURE station counts were computed from.
const KM_PER_DEG_LAT = 111.32
function outageBounds(outage) {
  const dLat = outage.radiusKm / KM_PER_DEG_LAT
  const dLng =
    outage.radiusKm /
    (KM_PER_DEG_LAT * Math.max(0.2, Math.cos((outage.latitude * Math.PI) / 180)))
  return [
    [outage.latitude - dLat, outage.longitude - dLng],
    [outage.latitude + dLat, outage.longitude + dLng],
  ]
}

/**
 * UOW-16 Task 16.4: Grid Outage overlay plane. Mounts with the Grid Power
 * layer toggle, hydrates from /api/v1/grid/outages, and renders each affected
 * county's impact footprint as a severity-washed rectangle. Live refresh rides
 * the existing SSE multiplexer: county incidents reach the ledger as
 * GRID-<fips> rows, so every incident-update frame (opened / consolidated /
 * resolved) re-syncs the plane — storm-coalesced through a single trailing
 * timer so a burst of frames costs one fetch, and the periodic backend sync
 * cadence needs no additional client polling.
 */
function GridOutageLayer() {
  const [outages, setOutages] = useState([])

  useEffect(() => {
    let cancelled = false
    let timer = null
    const refresh = () => {
      fetchGridOutages()
        .then((data) => {
          if (!cancelled) setOutages(data.outages)
        })
        .catch(() => {})
    }
    refresh()
    const unsubscribe = subscribeStream('incident-update', () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        refresh()
      }, 400)
    })
    return () => {
      cancelled = true
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return outages.map((outage) => (
    <Rectangle
      key={outage.fips}
      bounds={outageBounds(outage)}
      pathOptions={OUTAGE_WASHES[outage.severity] ?? OUTAGE_WASHES.INFO}
      eventHandlers={tapOpenTooltip}
      bubblingMouseEvents={false}
    >
      <Tooltip direction="top" opacity={1} className="charger-tooltip">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-slate-100">
            {outage.countyName} County, {outage.state}
          </p>
          <p className="font-mono text-xs text-zinc-300">
            FIPS {outage.fips} · {outage.customersOut.toLocaleString()} of{' '}
            {outage.customersTracked.toLocaleString()} customers dark (
            {(outage.pctOut * 100).toFixed(1)}%)
          </p>
          <p
            className={`text-xs font-bold ${
              outage.severity === 'CRITICAL'
                ? 'text-red-400'
                : outage.severity === 'WARNING'
                  ? 'text-amber-400'
                  : 'text-slate-400'
            }`}
          >
            GRID OUTAGE · {outage.severity}
          </p>
        </div>
      </Tooltip>
    </Rectangle>
  ))
}

/** Weather plane: bounding circles matching each active zone's broadcast radius. */
function WeatherLayer({ environment }) {
  return (environment?.weatherZones ?? []).map((zone) => (
    <Circle
      key={zone.eventId}
      center={[zone.center.latitude, zone.center.longitude]}
      radius={zone.radiusKm * 1000}
      eventHandlers={tapOpenTooltip}
      bubblingMouseEvents={false}
      pathOptions={{
        color: '#a5b4fc',
        weight: 2,
        dashArray: '8 6',
        fillColor: '#818cf8',
        fillOpacity: 0.12,
      }}
    >
      <Tooltip direction="top" opacity={1} className="charger-tooltip">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-slate-100">Severe Weather Zone</p>
          <p className="font-mono text-xs text-zinc-300">
            {zone.radiusKm} km radius · {zone.severity}
          </p>
        </div>
      </Tooltip>
    </Circle>
  ))
}

const formatCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// UOW-14 Task 14.1: planned build-outs ('P', `isPlanned` on the wire) are
// blueprints, not faults — they never carry activeGridSag. Only genuinely
// unavailable stations read as operational problems.
const stationStateLabel = (station) => {
  if (station.isPlanned) return ' · PLANNED SITE'
  if (!station.activeGridSag) return ''
  if (station.statusCode === 'T') return ' · STATION OFFLINE'
  return ' · STATION DOWN'
}

function clusterIcon(cluster) {
  const sagging = cluster.sagCount > 0
  // UOW-15 Task 15.5: clusters containing a ground-truth validation anchor
  // take the neon fuchsia treatment so the anchors read from any zoom.
  const anchored = cluster.groundTruthCount > 0
  // Screen readers get the full telemetry sentence; the visual bubble shows
  // only the compact count. Enter/Space activate via Leaflet marker keyboard
  // support on the focusable wrapper.
  // UOW-14: `sagCount` counts only genuinely offline stations; planned
  // build-outs ride separately as `plannedCount` and never trip the sagging
  // (amber warning) treatment.
  const detail = [
    cluster.sagCount > 0 ? `${cluster.sagCount} offline` : null,
    cluster.plannedCount > 0 ? `${cluster.plannedCount} planned` : null,
    anchored ? `${cluster.groundTruthCount} ground-truth anchors` : null,
  ].filter(Boolean).join(', ')
  const srLabel = detail
    ? `Cluster of ${cluster.count} national stations, ${detail} — activate to zoom in`
    : `Cluster of ${cluster.count} national stations, all open — activate to zoom in`
  return L.divIcon({
    className: '',
    html: `<div class="national-cluster${sagging ? ' sagging' : ''}${anchored ? ' has-ground-truth' : ''}" role="img" aria-label="${srLabel}">${formatCount(cluster.count)}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

// UOW-15 Task 15.5: neon fuchsia beacon for dictionary-anchored ground-truth
// stations — pulsing halo + rimmed core, unmistakable against the dark tiles.
function groundTruthIcon(station) {
  return L.divIcon({
    className: '',
    html: `<div class="ground-truth-marker" role="img" aria-label="Ground-truth validation anchor: ${station.name}"><span class="halo"></span><span class="core"></span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

/**
 * National fleet plane (UOW-09 Task 9.2). The Leaflet viewport drives
 * /api/v1/fleet/spatial-cluster on every moveend/zoomend: wide zooms render
 * server-aggregated count bubbles, street zooms render individual pins — the
 * DOM never holds thousands of markers, keeping pans at 60 FPS. A sequence
 * guard drops stale responses that resolve after a newer pan.
 */
function NationalFleetLayer({ onViewportTotal }) {
  const [payload, setPayload] = useState(null)
  const seqRef = useRef(0)

  const refresh = useCallback(
    (mapInstance) => {
      const bounds = mapInstance.getBounds()
      const seq = ++seqRef.current
      fetchSpatialClusters({
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
        zoom: mapInstance.getZoom(),
      })
        .then((data) => {
          if (seq !== seqRef.current) return
          setPayload(data)
          onViewportTotal?.(data.total)
        })
        .catch(() => {})
    },
    [onViewportTotal]
  )

  const map = useMapEvents({
    moveend: () => refresh(map),
    zoomend: () => refresh(map),
  })

  useEffect(() => {
    refresh(map)
  }, [map, refresh])

  if (!payload) return null

  if (payload.mode === 'clusters') {
    return payload.clusters.map((cluster) => (
      <Marker
        key={cluster.key}
        position={[cluster.latitude, cluster.longitude]}
        icon={clusterIcon(cluster)}
        keyboard={true}
        alt={`${cluster.count} station cluster`}
        eventHandlers={{
          click: () =>
            map.setView([cluster.latitude, cluster.longitude], Math.min(map.getZoom() + 2, 18)),
        }}
      >
        <Tooltip direction="top" offset={[0, -14]} opacity={1} className="charger-tooltip">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">{cluster.count} national stations</p>
            <p className="font-mono text-xs text-zinc-300">
              {cluster.sagCount > 0 ? `${cluster.sagCount} offline · ` : ''}
              {cluster.plannedCount > 0 ? `${cluster.plannedCount} planned · ` : ''}tap to zoom
            </p>
          </div>
        </Tooltip>
      </Marker>
    ))
  }

  // Pin palette: teal = open, amber = genuinely offline, planned sites render
  // as neutral slate-blue blueprint outlines (dashed, low fill) so a future
  // build-out never reads as an active system failure, and ground-truth
  // dictionary anchors render as neon fuchsia beacons (Task 15.5).
  return payload.stations.map((station) => station.isGroundTruth ? (
    <Marker
      key={station.stationId}
      position={[station.latitude, station.longitude]}
      icon={groundTruthIcon(station)}
      keyboard={true}
      alt={`Ground-truth validation anchor: ${station.name}`}
      eventHandlers={tapOpenTooltip}
    >
      <Tooltip direction="top" offset={[0, -14]} opacity={1} className="charger-tooltip">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-100">{station.name}</p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-fuchsia-300">
            ◆ Ground-Truth Anchor
          </p>
          <p className="font-mono text-xs text-zinc-300">
            {station.stationId} · {station.state ?? '—'} ·{' '}
            {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}
          </p>
        </div>
      </Tooltip>
    </Marker>
  ) : (
    <CircleMarker
      key={station.stationId}
      center={[station.latitude, station.longitude]}
      radius={5}
      renderer={touchPinRenderer}
      eventHandlers={tapOpenTooltip}
      bubblingMouseEvents={false}
      pathOptions={{
        color: station.isPlanned ? '#94a3b8' : station.activeGridSag ? '#f59e0b' : '#2dd4bf',
        weight: 1.5,
        dashArray: station.isPlanned ? '2 3' : null,
        fillColor: station.isPlanned ? '#94a3b8' : station.activeGridSag ? '#f59e0b' : '#2dd4bf',
        fillOpacity: station.isPlanned ? 0.2 : 0.5,
      }}
    >
      <Tooltip direction="top" opacity={1} className="charger-tooltip">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-slate-100">{station.name}</p>
          <p className="font-mono text-xs text-zinc-300">
            {station.stationId} · {station.state ?? '—'}
            {stationStateLabel(station)}
          </p>
        </div>
      </Tooltip>
    </CircleMarker>
  ))
}

/**
 * UOW-15 Task 15.2: Map Navigation Suite. Absolutely positioned over the map
 * canvas (top-left, mirroring MapLayerControls top-right), zero layout shift.
 * - Go To Location: free-text city / state / zip resolved by
 *   /api/v1/registry/locate against the AFDC registry itself — the result's
 *   bounding box flies the viewport straight onto the matched station set.
 * - Regional Presets: one-tap teleport to the five macro US sectors.
 * - Box Zoom signal: Leaflet's native Shift+drag box zoom is enabled on the
 *   MapContainer; the hint chip advertises it to operators.
 */
function MapNavigator({ map }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const flyTo = useCallback(
    (bounds) => {
      map?.flyToBounds(bounds, { padding: [48, 48], maxZoom: 13, duration: 0.9 })
    },
    [map]
  )

  const goToLocation = async (event) => {
    event.preventDefault()
    // UOW-17 Task 17.1: blur the search input immediately on submit — mobile
    // Safari/Chrome keep the virtual keyboard's viewport offset applied until
    // the focused element loses focus, so without this the map (and the
    // fixed-inset shell around it) stays shifted upward after the flyTo.
    document.activeElement?.blur?.()
    const q = query.trim()
    if (!q || !map || busy) return
    setBusy(true)
    try {
      const hit = await fetchRegistryLocate(q)
      flyTo([
        [hit.bounds.minLat, hit.bounds.minLng],
        [hit.bounds.maxLat, hit.bounds.maxLng],
      ])
      setStatus({ kind: 'ok', text: `${hit.label} · ${formatCount(hit.matches)} stations` })
    } catch {
      setStatus({ kind: 'err', text: `No registry match for “${q}”` })
    } finally {
      setBusy(false)
    }
  }

  return (
    // UOW-15 Task 15.4: floats top-left on md+ viewports; below md it docks
    // full-width inside the slide-in control tray.
    <section
      aria-label="Map Navigation"
      className="md:absolute md:top-3 md:left-3 md:z-[1000] md:w-60 max-md:w-full rounded-xl border border-slate-700 bg-slate-900/90 backdrop-blur p-2 space-y-2 shadow-lg shadow-black/40"
    >
      <h2 className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-200">
        Navigation
      </h2>
      <form role="search" aria-label="Go To Location" onSubmit={goToLocation} className="flex gap-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="City, state, or ZIP…"
          aria-label="Go to city, state, or ZIP code"
          className="min-w-0 flex-1 min-h-11 rounded-lg border border-slate-700 bg-slate-950/80 px-2.5 text-base text-slate-100 placeholder:text-slate-500 focus:border-cyan-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 shrink-0 rounded-lg border border-cyan-600 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
        >
          Go
        </button>
      </form>
      <p
        aria-live="polite"
        className={`min-h-4 px-1 text-[11px] font-mono leading-tight ${
          status ? (status.kind === 'ok' ? 'text-emerald-400' : 'text-amber-400') : 'text-transparent'
        }`}
      >
        {status?.text ?? '·'}
      </p>
      <div role="group" aria-label="Regional Presets" className="flex flex-wrap gap-1">
        {REGION_PRESETS.map((region) => (
          <button
            key={region.id}
            type="button"
            title={`Jump to ${region.name}`}
            onClick={() => {
              flyTo(region.bounds)
              setStatus({ kind: 'ok', text: `Sector · ${region.name}` })
            }}
            className="min-h-11 flex-1 basis-16 rounded-lg border border-slate-700 bg-transparent px-1.5 text-[11px] font-bold tracking-wider text-slate-200 transition-colors hover:border-cyan-600 hover:bg-cyan-500/10 hover:text-cyan-300"
          >
            {region.label}
          </button>
        ))}
      </div>
      <p
        title="Hold Shift, then click and drag a rectangle on the map to zoom the viewport directly to it"
        className="flex items-center gap-1.5 px-1 pb-0.5 text-[10px] uppercase tracking-wider text-slate-500"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current">
          <rect x="2.5" y="4.5" width="11" height="8" rx="1" strokeWidth="1.5" strokeDasharray="2.5 2" />
        </svg>
        <kbd className="rounded border border-slate-700 bg-slate-950/80 px-1 font-mono text-[9px] text-slate-400">
          Shift
        </kbd>
        + drag · box zoom
      </p>
    </section>
  )
}

function CommandCenterMap({ stations, onSelectStation, active = true }) {
  const { topology, directory, environment } = useEnvironment(stations)
  const [layers, setLayers] = useState({
    fleet: true,
    grid: true,
    network: true,
    weather: true,
    national: true,
  })
  const [nationalTotal, setNationalTotal] = useState(null)
  // Leaflet Map instance for the navigation suite — react-leaflet v5 exposes
  // it via MapContainer ref once the map mounts.
  const [mapInstance, setMapInstance] = useState(null)

  // UOW-19.8 Task 19.8.2: the map now stays mounted across tab switches (see
  // App.jsx) so Leaflet's own camera state (center/zoom/pan) survives a
  // Dashboard/Financials round-trip instead of resetting on remount. The
  // trade-off: Leaflet measures its container on mount but never again on
  // its own, so a container that was `display:none` while another tab was
  // active comes back with a stale (often zero) internal size — tiles render
  // misaligned or blank until something tells it to re-measure.
  // invalidateSize() on the active:false→true transition is that signal.
  useEffect(() => {
    if (active && mapInstance) {
      mapInstance.invalidateSize()
    }
  }, [active, mapInstance])
  // UOW-15 Task 15.4: mobile (<768px) collapses both overlay panels into a
  // slide-in side tray so the touch surface stays clear; md+ ignores this.
  const [trayOpen, setTrayOpen] = useState(false)
  // UOW-16 Task 16.3: Diagnostic Reference Pin — right-click / long-press
  // drops (or moves) the singleton UAT crosshair; null = no pin on the map.
  const [diagnosticPin, setDiagnosticPin] = useState(null)

  const gridDown = (environment?.gridNodes ?? []).filter((n) => n.powerStatus === 'OUTAGE').length
  const ispDown = (environment?.ispCarriers ?? []).filter((c) => c.networkStatus === 'DOWN').length
  const weatherActive = environment?.weatherZones?.length ?? 0
  const fleetFaulted = stations.filter(isStationFaulted).length
  const badges = {
    fleet: fleetFaulted ? `${fleetFaulted} down` : null,
    grid: gridDown ? `${gridDown} outage` : null,
    network: ispDown ? `${ispDown} down` : null,
    weather: weatherActive ? `${weatherActive} active` : null,
    national: layers.national && nationalTotal != null ? `${formatCount(nationalTotal)} in view` : null,
  }

  return (
    <>
      <MapContainer
        ref={setMapInstance}
        center={OC_CENTER}
        zoom={11}
        // Default top-left zoom control stays off — the navigator panel owns
        // that corner; the themed <ZoomControl> below re-homes it bottom-right.
        zoomControl={false}
        // UOW-15 Task 15.2: box zoom (Shift + click-drag) explicitly enabled —
        // it is Leaflet's default, but the navigator's hint chip advertises it,
        // so pin the behavior rather than rely on the default staying true.
        boxZoom={true}
        // UOW-16 Task 16.3: long-press → synthesized contextmenu on touch
        // screens, so the diagnostic pin drops from a thumb hold exactly as
        // from a desktop right-click. (Leaflet enables this by default only on
        // mobile Safari; pinning it true covers Android Chrome too.)
        tapHold={true}
        // UOW-16 Task 16.2: attribution moves out of the default bottom-right
        // corner — it was stacking into the same Leaflet corner container as
        // the zoom bar, crowding the +/- strip on compact viewports.
        attributionControl={false}
        className="h-full w-full"
      >
        <AttributionControl position="bottomleft" />
        {/* UOW-15 Task 15.4: native +/- restored, zinc-themed via index.css.
            UOW-16 Task 16.2: sole occupant of bottom-right, ⌂ stacked above. */}
        <ZoomControl position="bottomright" />
        <TileLayer url={DARK_MATTER_URL} attribution={DARK_MATTER_ATTRIBUTION} />
        {layers.national && <NationalFleetLayer onViewportTotal={setNationalTotal} />}
        {layers.grid && <GridPowerLayer topology={topology} environment={environment} />}
        {/* Task 16.4: the Grid Power toggle now also drives the national
            county-outage wash plane alongside the local substation circles. */}
        {layers.grid && <GridOutageLayer />}
        {layers.weather && <WeatherLayer environment={environment} />}
        {layers.network && <NetworkLayer directory={directory} environment={environment} />}
        {layers.fleet &&
          stations.map((station) => (
            <Marker
              key={station.chargerId}
              position={[station.location.latitude, station.location.longitude]}
              icon={markerIcon(station)}
              eventHandlers={{ click: () => onSelectStation(station) }}
            >
              <StationTooltip station={station} />
            </Marker>
          ))}
        {/* UOW-16 Task 16.3: Diagnostic Reference Pin — singleton crosshair
            with a permanent (never-fading) coordinate readout for
            screenshot-safe UAT verification. Tapping the pin itself clears it. */}
        <DiagnosticPinController onDrop={setDiagnosticPin} />
        {diagnosticPin && (
          <Marker
            position={[diagnosticPin.lat, diagnosticPin.lng]}
            icon={diagnosticPinIcon}
            keyboard={true}
            alt="UAT diagnostic reference pin"
            eventHandlers={{ click: () => setDiagnosticPin(null) }}
          >
            <Tooltip
              permanent
              direction="top"
              offset={[0, -20]}
              opacity={1}
              className="charger-tooltip diagnostic-tooltip"
            >
              <p className="font-mono text-xs font-bold tracking-tight text-cyan-300">
                UAT TARGET REFERENCE // LAT: {diagnosticPin.lat.toFixed(6)}, LNG:{' '}
                {diagnosticPin.lng.toFixed(6)}
              </p>
            </Tooltip>
          </Marker>
        )}
      </MapContainer>
      {/* UOW-15 Task 15.4 / UOW-16 Task 16.2: floating Home — resets the
          viewport to the canonical national overview. Re-aligned to the zoom
          bar's exact outer box: the bar is 44px links + 2px frame = 46px wide
          and 91px tall, anchored 10px from the corner — so ⌂ takes w-[46px]
          and bottom-[111px] for a matching 10px gap above the [+]. */}
      <button
        type="button"
        title="Reset to national overview"
        aria-label="Reset viewport to national overview"
        onClick={() =>
          mapInstance?.flyToBounds(NATIONAL_OVERVIEW_BOUNDS, { padding: [24, 24], duration: 1.1 })
        }
        className="absolute bottom-[111px] right-[10px] z-[1000] flex h-11 w-[46px] items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900/90 text-xl leading-none text-zinc-200 shadow-lg shadow-black/40 backdrop-blur transition-colors hover:border-cyan-600 hover:text-cyan-300"
      >
        <span aria-hidden="true">⌂</span>
      </button>
      {/* UOW-16 Task 16.2: the open-tray toggle renders only while the tray is
          closed. Its old floating [X] lived in the map container's coordinate
          space (absolute, below the masthead) while the tray is viewport-fixed
          — two different origins, so the X landed on the Navigator's search
          row and blocked the [Go] button. Closing now happens exclusively
          inside the tray's own layout flow, where overlap is impossible. */}
      {!trayOpen && (
        <button
          type="button"
          aria-expanded={false}
          aria-controls="map-control-tray"
          aria-label="Open map controls"
          onClick={() => setTrayOpen(true)}
          className="md:hidden absolute top-3 right-3 z-[1110] flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900/90 text-zinc-200 shadow-lg shadow-black/40 backdrop-blur transition-colors hover:border-cyan-600 hover:text-cyan-300"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 stroke-current fill-none" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          </svg>
        </button>
      )}
      {trayOpen && (
        <button
          type="button"
          aria-label="Close map controls"
          onClick={() => setTrayOpen(false)}
          className="md:hidden fixed inset-0 z-[1090] bg-slate-950/60"
        />
      )}
      {/* md+: display:contents — panels float in their own corners exactly as
          before. Below md: this wrapper becomes the sliding side tray holding
          both panels, translated off-canvas until the toggle opens it.
          Discrete z ladder (Task 16.2): backdrop 1090 < tray 1100 < open
          toggle 1110 — every control on its own layer, no collisions.
          overscroll-contain stops a tray scroll from chaining into a ghost
          page scroll behind the backdrop. */}
      <div
        id="map-control-tray"
        className={`md:contents max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-[1100] max-md:w-72 max-md:max-w-[85vw] max-md:space-y-3 max-md:overflow-y-auto max-md:overscroll-contain max-md:border-l max-md:border-slate-700 max-md:bg-slate-950/95 max-md:p-3 max-md:backdrop-blur max-md:motion-safe:transition-transform max-md:motion-safe:duration-200 ${
          trayOpen ? 'max-md:translate-x-0' : 'max-md:translate-x-full'
        }`}
      >
        {/* In-flow close row (mobile only): the [X] participates in the tray's
            own layout above the Navigation card, so it can never overlap the
            search input or [Go] regardless of masthead height or wrapping. */}
        <div className="md:hidden flex items-center justify-between gap-3 pb-1">
          <p className="px-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
            Map Controls
          </p>
          <button
            type="button"
            aria-controls="map-control-tray"
            aria-label="Close map controls"
            onClick={() => setTrayOpen(false)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900/90 text-zinc-200 transition-colors hover:border-cyan-600 hover:text-cyan-300"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 stroke-current fill-none" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>
        <MapNavigator map={mapInstance} />
        <MapLayerControls
          layers={layers}
          badges={badges}
          onToggle={(id) => setLayers((prev) => ({ ...prev, [id]: !prev[id] }))}
        />
      </div>
    </>
  )
}

export default CommandCenterMap
