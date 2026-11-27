/**
 * Tool-pairing balance over a session surface. Compaction changes surface
 * positions, so safe cuts are derived from tool-call/result content in current
 * surface order rather than step markers.
 * Port of `packages/compaction/compaction/src/tool-pairing.ts`.
 * @module @astra/compaction/tool-pairing
 */

import type { Session, SessionEvent, SessionSeq } from '../../../core/session/src/index.ts'

/** Incremental balance state for one session surface generation. */
interface BalanceCache {
  generation: number
  /** Balance of every surface cut: entry `i` is the cut before sequence `i`. */
  cutBalanced: boolean[]
  indexBySeq: Map<SessionSeq, number>
  inProgressToolCalls: number
}

const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

/** Return how one surface event changes the in-progress tool-call count. */
function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.tool_calls?.length ?? 0
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/** Fold surface sequences not yet in the cache into its balance state. */
function extendCache(session: Session, cache: BalanceCache, seqs: readonly SessionSeq[]): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  // Validate the unseen tail before mutating the live cache, so a corrupt
  // append cannot leave a partially advanced state behind.
  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    const event = session.eventAt(seq)
    if (event === undefined) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    inProgressToolCalls += eventDelta(event)
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }
  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

/** Return balance state synchronized with the current session surface. */
function balanceCache(session: Session): BalanceCache {
  const seqs = session.surface.nodes
  const generation = session.surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)
  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    const rebuilt = extendCache(session, { generation, cutBalanced: [true], indexBySeq: new Map(), inProgressToolCalls: 0 }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

function cutBalance(session: Session, seq: SessionSeq, offset: 0 | 1): boolean {
  const cache = balanceCache(session)
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return balanced
}

/** Whether the cut immediately before a current surface sequence splits no tool-call/result pair. */
export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean {
  return cutBalance(session, seq, 0)
}

/** Whether the cut immediately after a current surface sequence splits no tool-call/result pair. */
export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean {
  return cutBalance(session, seq, 1)
}
