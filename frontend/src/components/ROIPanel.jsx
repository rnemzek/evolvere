import { useEffect, useState } from 'react'
import { fetchRoiAnalytics } from '../services/fleetApi.js'

const usd = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function RoiCard({ label, value, srValue, unit, tone, caption }) {
  // min-h keeps card dimensions static across metric refreshes (CLS = 0).
  // The stylized tabular value is aria-hidden; screen readers get the plain
  // sr-only sentence instead.
  return (
    <article className="min-h-28 rounded-xl border border-slate-800 bg-slate-900/70 backdrop-blur p-4">
      <h3 className="text-xs font-medium uppercase tracking-widest text-slate-400">{label}</h3>
      <p className={`mt-1 text-3xl font-bold tabular-nums ${tone}`}>
        <span className="sr-only">{srValue}</span>
        <span aria-hidden="true">
          {value}
          {unit && <span className="ml-1 text-base font-medium text-slate-400">{unit}</span>}
        </span>
      </p>
      <p className="mt-1 text-xs text-slate-400 min-h-4">{caption}</p>
    </article>
  )
}

/**
 * ROI & Operational Analytics sub-panel. Metrics come pre-aggregated from
 * /api/v1/analytics/roi; the fetch is keyed to the live fleet stream so cards
 * increment in step with simulation events and resolutions.
 */
function ROIPanel({ stations }) {
  const [roi, setRoi] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchRoiAnalytics()
      .then((data) => {
        if (!cancelled) setRoi(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [stations])

  const mttrDisplay =
    roi?.mttr.averageMinutes == null
      ? '—'
      : roi.mttr.averageMinutes < 90
        ? roi.mttr.averageMinutes.toFixed(0)
        : roi.mttr.averageHours.toFixed(1)
  const mttrUnit = roi?.mttr.averageMinutes == null ? '' : roi.mttr.averageMinutes < 90 ? 'min' : 'hrs'

  return (
    <section aria-label="ROI Savings Metrics" className="space-y-2">
      <h2 className="text-xs font-bold uppercase tracking-widest text-slate-300">
        ROI &amp; Operational Analytics
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <RoiCard
          label="Recovered Revenue"
          value={roi ? usd(roi.recoveredRevenue.usd) : '—'}
          srValue={roi ? `${Math.round(roi.recoveredRevenue.usd)} dollars recovered` : 'aggregating'}
          tone="text-green-400"
          caption={
            roi
              ? `${roi.recoveredRevenue.incidents} incidents beat the ${roi.recoveredRevenue.baselineHours}h baseline`
              : 'aggregating…'
          }
        />
        <RoiCard
          label="Avoided Truck Rolls"
          value={roi ? usd(roi.avoidedTruckRolls.usd) : '—'}
          srValue={roi ? `${Math.round(roi.avoidedTruckRolls.usd)} dollars saved` : 'aggregating'}
          tone="text-amber-300"
          caption={
            roi
              ? `${roi.avoidedTruckRolls.count} external dispatches intercepted @ $${roi.avoidedTruckRolls.baseRate}`
              : 'aggregating…'
          }
        />
        <RoiCard
          label="Triage Labor Saved"
          value={roi ? roi.triageLabor.hoursSaved.toFixed(1) : '—'}
          srValue={roi ? `${roi.triageLabor.hoursSaved} hours saved` : 'aggregating'}
          unit="hrs"
          tone="text-cyan-400"
          caption={
            roi ? `${roi.triageLabor.briefCount} automated briefs vs manual portal checks` : 'aggregating…'
          }
        />
        <RoiCard
          label="Mean Time to Resolution"
          value={mttrDisplay}
          srValue={
            roi?.mttr.averageMinutes == null
              ? 'no resolved incidents yet'
              : `${mttrDisplay} ${mttrUnit === 'min' ? 'minutes' : 'hours'} average`
          }
          unit={mttrUnit}
          tone="text-violet-300"
          caption={
            roi?.mttr.reductionPercent != null ? (
              <>
                <span aria-hidden="true">↓ </span>
                <span className="sr-only">down </span>
                {roi.mttr.reductionPercent}% vs {roi.mttr.baselineHours}h unmonitored baseline
              </>
            ) : (
              'no resolved incidents yet'
            )
          }
        />
      </div>
    </section>
  )
}

export default ROIPanel
