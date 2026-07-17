import { useEffect, useRef, useState } from 'react'
import { postToggleStatus, subscribeToAlerts, fetchAlertSubscriptions } from '../services/fleetApi.js'
import { isStationFaulted } from '../services/stationHealth.js'

const FAULT_CODES = ['GroundFailure', 'Power_Loss']

function FaultSwitch({ station, index }) {
  const faulted = isStationFaulted(station)
  const [busy, setBusy] = useState(false)

  const flip = async () => {
    setBusy(true)
    try {
      await postToggleStatus({
        chargerId: station.chargerId,
        connectorId: station.connectors[0].connectorId,
        targetStatus: faulted ? 'Available' : 'Faulted',
        lastErrorCode: faulted ? undefined : FAULT_CODES[index % FAULT_CODES.length],
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={faulted}
      aria-label={`Inject fault on ${station.chargerId}`}
      disabled={busy}
      onClick={flip}
      className={`relative min-w-16 min-h-11 h-11 w-16 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
        faulted ? 'bg-red-500/30 border-red-500' : 'bg-slate-800 border-slate-600'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-1 h-8 w-8 rounded-full transition-all ${
          faulted ? 'left-7 bg-red-400' : 'left-1 bg-slate-400'
        }`}
      />
    </button>
  )
}

function SubscribeForm() {
  const [phoneNumber, setPhoneNumber] = useState('')
  const [status, setStatus] = useState(null)
  const [subscribers, setSubscribers] = useState([])

  useEffect(() => {
    let cancelled = false
    fetchAlertSubscriptions()
      .then(({ subscribers }) => {
        if (!cancelled) setSubscribers(subscribers)
      })
      .catch((err) => {
        if (!cancelled) setStatus({ ok: false, text: `Could not load subscriptions: ${err.message}` })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    try {
      const result = await subscribeToAlerts(phoneNumber)
      setSubscribers(result.subscribers)
      setStatus({ ok: true, text: `Subscribed ${result.subscribed} to critical SMS alerts` })
      setPhoneNumber('')
    } catch (err) {
      setStatus({ ok: false, text: err.message })
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="alert-phone" className="text-xs uppercase tracking-widest text-slate-500 block">
          SMS Alert Subscription
        </label>
        <div className="flex gap-2">
          <input
            id="alert-phone"
            type="tel"
            required
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+1 555 010 0199"
            className="min-h-11 flex-1 min-w-0 rounded-lg border border-slate-700 bg-slate-800/70 px-3 text-sm placeholder:text-slate-600 focus:outline-none focus:border-cyan-600"
          />
          <button
            type="submit"
            className="min-h-11 min-w-11 px-4 rounded-lg border border-cyan-700/60 text-cyan-300 text-sm font-semibold hover:bg-cyan-500/10 active:bg-cyan-500/20"
          >
            Subscribe
          </button>
        </div>
        {status && (
          <p className={`text-xs ${status.ok ? 'text-green-400' : 'text-red-400'}`}>{status.text}</p>
        )}
      </form>

      {subscribers.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500 mb-2">
            Active Alerts Feed
          </p>
          <ul className="space-y-1.5">
            {subscribers.map((number) => (
              <li
                key={number}
                className="min-h-11 rounded-lg border border-slate-800 bg-slate-800/40 px-3 flex items-center justify-between gap-3"
              >
                <span className="font-mono text-sm text-slate-200">{number}</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-emerald-500/15 text-emerald-400 border-emerald-500/40">
                  ✓ SUBSCRIBED
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ControlPanel({ open, stations, onClose }) {
  const panelRef = useRef(null)

  // Modal focus management: trap Tab inside the drawer while open, close on
  // Escape, and hand focus back to the triggering button on close.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const previouslyFocused = document.activeElement

    const focusables = () =>
      [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled)

    focusables()[0]?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = focusables()
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      className="absolute z-[1100] bg-slate-900/95 backdrop-blur border-slate-700 text-slate-100 shadow-2xl
                 inset-x-0 bottom-0 max-h-[75vh] rounded-t-2xl border-t
                 md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:w-96 md:max-h-none md:rounded-none md:border-t-0 md:border-l
                 flex flex-col"
      aria-label="Demo control panel"
    >
      {/* div, not <header>: inside role="dialog" a header element would compute
          as a second banner landmark and break landmark uniqueness. */}
      <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-800">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-amber-400">
            Control Panel
          </h2>
          <p className="text-xs text-slate-500">Demo state driver — operator only</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close control panel"
          className="min-w-11 min-h-11 grid place-items-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xl leading-none"
        >
          &times;
        </button>
      </div>

      <div className="overflow-y-auto p-4 space-y-4">
        <ul className="space-y-2">
          {stations.map((station, index) => (
            <li
              key={station.chargerId}
              className="rounded-lg border border-slate-800 bg-slate-800/40 p-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="font-mono text-sm text-cyan-400 truncate">{station.chargerId}</p>
                <p className="text-xs text-slate-500 truncate">{station.siteName}</p>
                <p className={`text-xs font-semibold ${isStationFaulted(station) ? 'text-red-400' : 'text-green-400'}`}>
                  {isStationFaulted(station) ? 'FAULTED' : 'HEALTHY'}
                </p>
              </div>
              <FaultSwitch station={station} index={index} />
            </li>
          ))}
        </ul>

        <div className="border-t border-slate-800 pt-4">
          <SubscribeForm />
        </div>
      </div>
    </div>
  )
}

export default ControlPanel
