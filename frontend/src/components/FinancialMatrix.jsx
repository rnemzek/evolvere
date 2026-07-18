import { useEffect, useState } from 'react'
import { fetchFinancialMatrix } from '../services/fleetApi.js'

const usd = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })

/**
 * 'Earning vs. Burning' Financial Matrix (UOW-09 Task 9.4). Rows arrive from
 * /api/v1/financials/matrix already ranked netMargin ascending, so chronic
 * Cash Burner stations (idle lines, grid sags) lead the ledger.
 */
function FinancialMatrix() {
  const [matrix, setMatrix] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchFinancialMatrix()
      .then((data) => {
        if (!cancelled) setMatrix(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section aria-label="Earning versus Burning financial matrix" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-300">
            Earning vs. Burning — Net Operational Margin
          </h2>
          <p className="text-xs text-slate-400">
            Ranked worst-first: cash burners with idle lines or grid sags lead the ledger.
          </p>
        </div>
        {matrix && (
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-md border border-slate-700 text-slate-300 tabular-nums">
              {matrix.returned < matrix.count
                ? `worst ${matrix.returned} of ${matrix.count.toLocaleString('en-US')}`
                : `${matrix.count} stations`}
            </span>
            <span className="px-2 py-1 rounded-md border border-rose-800 bg-rose-950/40 text-rose-400 tabular-nums">
              {matrix.burnerCount} burning cash
            </span>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/70 backdrop-blur overflow-x-auto">
        {error ? (
          <p className="p-4 text-sm text-red-400">Financial matrix unavailable: {error}</p>
        ) : !matrix ? (
          <p className="p-4 text-sm text-slate-400">Computing tariff ledger…</p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">
              Earning versus Burning financial ledger: {matrix.returned} stations ranked by net
              operational margin, worst first. {matrix.burnerCount} stations fleet-wide are
              operating at a loss.
            </caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-widest text-slate-400 border-b border-slate-800">
                <th scope="col" className="px-4 py-3 font-medium">Station / Location</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Gross Revenue</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Operating Costs</th>
                <th scope="col" aria-sort="ascending" className="px-4 py-3 font-medium text-right">Net Margin</th>
              </tr>
            </thead>
            <tbody>
              {matrix.stations.map((s) => {
                const burning = s.netMargin < 0
                return (
                  <tr
                    key={s.stationId}
                    data-station-id={s.stationId}
                    data-margin-state={burning ? 'burning' : 'earning'}
                    className={`border-b border-slate-800/60 last:border-b-0 ${
                      burning ? 'bg-rose-950/20' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-200">{s.name}</p>
                      <p className="text-xs text-slate-400">
                        {s.stationId} · {[s.town, s.state].filter(Boolean).join(', ')}
                        {s.activeGridSag && (
                          <span className="ml-2 px-1.5 py-0.5 rounded border border-amber-700 text-amber-400">
                            GRID SAG
                          </span>
                        )}
                        {s.idlePenalty > 0 && (
                          <span className="ml-2 px-1.5 py-0.5 rounded border border-slate-600 text-slate-300">
                            IDLE {Math.round(s.idleMinutes)}m
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-300">
                      {usd(s.grossRevenue)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-300">
                      {usd(s.operatingCost)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums font-bold ${
                        burning ? 'text-rose-500' : 'text-emerald-400'
                      }`}
                    >
                      {usd(s.netMargin)}
                      <span className="sr-only">{burning ? ' net loss' : ' net profit'}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

export default FinancialMatrix
