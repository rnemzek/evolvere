import { MapContainer, TileLayer, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { STATUS_STYLES } from './StationDrawer'

const OC_CENTER = [33.74, -117.82]
const DARK_MATTER_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const DARK_MATTER_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

export function isStationFaulted(station) {
  return station.connectors.some((c) => c.status === 'Faulted')
}

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
    <Tooltip
      direction="top"
      offset={[0, -16]}
      opacity={1}
      className="charger-tooltip"
    >
      <div className="min-w-52 space-y-2">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500">
            Station
          </p>
          <p className="text-sm font-semibold leading-tight text-slate-100">
            {station.siteName}
          </p>
          <p className="font-mono text-xs text-cyan-400">{station.chargerId}</p>
        </div>
        <p className="font-mono text-[11px] text-slate-400">
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
        <p className="text-[10px] uppercase tracking-wider text-slate-600">
          Tap for full telemetry
        </p>
      </div>
    </Tooltip>
  )
}

function CommandCenterMap({ stations, onSelectStation }) {
  return (
    <MapContainer
      center={OC_CENTER}
      zoom={11}
      zoomControl={false}
      className="h-full w-full"
    >
      <TileLayer url={DARK_MATTER_URL} attribution={DARK_MATTER_ATTRIBUTION} />
      {stations.map((station) => (
        <Marker
          key={station.chargerId}
          position={[station.location.latitude, station.location.longitude]}
          icon={markerIcon(station)}
          eventHandlers={{ click: () => onSelectStation(station) }}
        >
          <StationTooltip station={station} />
        </Marker>
      ))}
    </MapContainer>
  )
}

export default CommandCenterMap
