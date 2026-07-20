import { useCallback, useEffect, useState } from 'react'
import { fetchWorkQueueTasks, fetchWorkQueueSummary, postDispatchTask } from '../services/fleetApi.js'

// UOW-17 Task 17.4: NOC Dispatch Board — the operator-facing surface over the
// RCA Work Queue (Task 17.3). Every row here was raised by the triage RCA
// correlator: TRUCK_ROLL for an isolated hardware fault that needs a
// technician in the parking lot, UTILITY_TICKET/ISP_TICKET for a confirmed
// regional outage where rolling a truck would be wasted — the Cost Impact
// column makes that spent-vs-avoided distinction visible at a glance.

const PRIORITY_BADGES = {
  CRITICAL: 'border-red-700/80 bg-red-500/15 text-red-300',
  WARNING: 'border-amber-600/80 bg-amber-500/15 text-amber-300',
  INFO: 'border-slate-600 bg-slate-500/15 text-slate-300',
}

const TASK_TYPE_LABELS = {
  TRUCK_ROLL: 'Truck Roll',
  UTILITY_TICKET: 'Utility Ticket',
  ISP_TICKET: 'ISP Ticket',
}

const TASK_TYPE_BADGES = {
  TRUCK_ROLL: 'border-orange-600/80 bg-orange-500/15 text-orange-300',
  UTILITY_TICKET: 'border-cyan-600/80 bg-cyan-500/15 text-cyan-300',
  ISP_TICKET: 'border-violet-600/80 bg-violet-500/15 text-violet-300',
}

const STATUS_LABELS = { OPEN: 'Open', DISPATCHED: 'Dispatched', CLOSED: 'Closed' }

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`

const POLL_MS = 8000

function DispatchBoard() {
  const [tasks, setTasks] = useState([])
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const [dispatchingId, setDispatchingId] = useState(null)

  const refresh = useCallback(() => {
    Promise.all([fetchWorkQueueTasks(), fetchWorkQueueSummary()])
      .then(([taskData, summaryData]) => {
        setTasks(taskData.tasks.filter((t) => t.status !== 'CLOSED'))
        setSummary(summaryData)
        setError(null)
      })
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const dispatch = async (taskId) => {
    setDispatchingId(taskId)
    try {
      await postDispatchTask(taskId)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setDispatchingId(null)
    }
  }

  return (
    <section
      aria-label="NOC Dispatch Board"
      className="max-w-full overflow-x-hidden rounded-xl border border-slate-800 bg-slate-900/70 backdrop-blur"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-800">
        <div className="min-w-0">
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-300">NOC Dispatch Board</h2>
          <p className="text-xs text-slate-400 truncate">
            RCA-driven work queue: truck rolls vs. utility/ISP tickets.
          </p>
        </div>
        {summary && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-md border border-slate-700 text-slate-300 tabular-nums">
              {summary.open} open
            </span>
            <span className="px-2 py-1 rounded-md border border-orange-700 bg-orange-950/40 text-orange-400 tabular-nums">
              {summary.byType.TRUCK_ROLL ?? 0} truck rolls
            </span>
            <span className="px-2 py-1 rounded-md border border-emerald-700 bg-emerald-950/40 text-emerald-400 tabular-nums">
              {summary.avoidedTruckRollCount} avoided
            </span>
          </div>
        )}
      </header>

      <div className="max-w-full overflow-x-auto">
        {error ? (
          <p className="p-4 text-sm text-red-400">Dispatch board unavailable: {error}</p>
        ) : tasks.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">No active work queue tasks.</p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">
              NOC dispatch board: {tasks.length} active task(s) raised by the RCA correlator, worst priority first.
            </caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-widest text-slate-400 border-b border-slate-800">
                <th scope="col" className="px-4 py-2.5 font-medium">Priority</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Station</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Task</th>
                <th scope="col" className="px-4 py-2.5 font-medium text-right">Cost Impact</th>
                <th scope="col" className="px-4 py-2.5 font-medium text-right">Status</th>
                <th scope="col" className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold ${
                        PRIORITY_BADGES[task.priority] ?? PRIORITY_BADGES.INFO
                      }`}
                    >
                      {task.priority}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 truncate max-w-[160px] sm:max-w-none text-slate-200">
                    {task.stationId}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold ${
                        TASK_TYPE_BADGES[task.taskType] ?? TASK_TYPE_BADGES.TRUCK_ROLL
                      }`}
                    >
                      {TASK_TYPE_LABELS[task.taskType] ?? task.taskType}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap tabular-nums text-right">
                    <span className={task.taskType === 'TRUCK_ROLL' ? 'text-rose-400' : 'text-emerald-400'}>
                      {usd(task.costImpact)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap tabular-nums text-right text-slate-400">
                    {STATUS_LABELS[task.status] ?? task.status}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={task.status !== 'OPEN' || dispatchingId === task.id}
                      onClick={() => dispatch(task.id)}
                      className="min-h-9 px-3 rounded-lg border border-cyan-600 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      {task.status === 'OPEN'
                        ? dispatchingId === task.id
                          ? 'Dispatching…'
                          : 'Dispatch'
                        : STATUS_LABELS[task.status]}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

export default DispatchBoard
