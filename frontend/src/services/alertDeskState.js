// UOW-13 Task 13.2: Alert Desk state machine. All ledger mutations route
// through this reducer — no raw useState splicing in the component — so every
// incident-update frame lands as one structured, testable transition.

// Mirrors the backend's SEVERITY_RANK: consolidation escalates, never demotes.
const SEVERITY_RANK = { CRITICAL: 3, WARNING: 2, INFO: 1 }

export function lastActivity(alert) {
  return alert.lastSeenAt ?? alert.openedAt
}

// Canonical desk order — the exact contract idx_alerts_open_ledger serves on
// hydration: CRITICAL first, then newest activity, id as the deterministic
// tiebreak. ISO-8601 stamps compare lexicographically, so string compare is
// chronological compare.
export function canonicalSort(alerts) {
  return [...alerts].sort((a, b) => {
    const rank = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    if (rank !== 0) return rank
    const seenA = lastActivity(a)
    const seenB = lastActivity(b)
    if (seenA !== seenB) return seenB > seenA ? 1 : -1
    return b.id - a.id
  })
}

export const initialDeskState = { phase: 'loading', alerts: [] }

/**
 * Transitions:
 *   HYDRATE / HYDRATE_FAILED — the Task 13.1 mount fetch settling.
 *   STREAM_FRAME — one parsed incident-update SSE frame:
 *     INCIDENT_OPENED       → row joins the ledger. Inserted at the front,
 *       then canonically re-sorted, so it lands at the top of its severity
 *       cohort rather than above a CRITICAL it doesn't outrank. Upsert by id:
 *       a frame that raced the hydration read replaces, never duplicates.
 *     INCIDENT_CONSOLIDATED → the target row absorbs the packet (event count,
 *       escalated severity, refreshed message, last-seen stamp) and the array
 *       re-sorts to the canonical order. Unknown id upserts — a consolidation
 *       for a pre-hydration incident is still authoritative state.
 *     INCIDENT_RESOLVED     → the row is flagged `resolving` in place (opacity
 *       fade); it keeps its slot and stays in the array until eviction.
 *   EVICT_BATCH — Task 13.3 deferred cleanup: one coalesced dispatch per flush
 *     window carrying every id whose fade has completed. A single filter pass
 *     removes them all — one render, one layout recalculation, no matter how
 *     many rows a storm clears at once. Only rows still flagged `resolving`
 *     are eligible (an id that came back to life via upsert between the fade
 *     and the flush is live state and must survive); when nothing matches,
 *     the same state reference returns so React skips the render entirely.
 *
 * Frames arriving before hydration settles are dropped: the ledger response
 * that follows is a full authoritative snapshot of anything they described.
 */
export function deskReducer(state, event) {
  switch (event.type) {
    case 'HYDRATE':
      return { phase: 'ready', alerts: canonicalSort(event.alerts) }
    case 'HYDRATE_FAILED':
      return { phase: 'error', alerts: [] }
    case 'STREAM_FRAME': {
      if (state.phase !== 'ready') return state
      const { action, alert } = event
      switch (action) {
        case 'INCIDENT_OPENED': {
          const rest = state.alerts.filter((row) => row.id !== alert.id)
          return { ...state, alerts: canonicalSort([{ ...alert }, ...rest]) }
        }
        case 'INCIDENT_CONSOLIDATED': {
          let found = false
          const merged = state.alerts.map((row) => {
            if (row.id !== alert.id) return row
            found = true
            return { ...row, ...alert, resolving: false }
          })
          return { ...state, alerts: canonicalSort(found ? merged : [{ ...alert }, ...merged]) }
        }
        case 'INCIDENT_RESOLVED':
          // No re-sort: the row fades where the operator is looking at it.
          return {
            ...state,
            alerts: state.alerts.map((row) =>
              row.id === alert.id ? { ...row, ...alert, resolving: true } : row
            ),
          }
        default:
          return state
      }
    }
    case 'EVICT_BATCH': {
      const ids = new Set(event.ids)
      const kept = state.alerts.filter((row) => !(ids.has(row.id) && row.resolving))
      return kept.length === state.alerts.length ? state : { ...state, alerts: kept }
    }
    default:
      return state
  }
}
