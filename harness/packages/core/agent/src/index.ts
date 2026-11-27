/**
 * Agent: one session plus the request options used against it.
 * Port of `packages/core/agent/src/index.ts` without the cordis registry.
 * @module @astra/agent
 */

import type { Session } from '../../session/src/index.ts'
import type { Agent, AgentOptions } from './types.ts'

export type { Agent, AgentOptions, AgentStatus, ModelSelection, RequestErrorAction } from './types.ts'

let counter = 0

/** Create the agent that owns `session`; ids are unique within this process. */
export function createAgent(session: Session, options: AgentOptions = {}): Agent {
  return { id: `agent-${++counter}`, session, options, status: 'idle' }
}

/** Run `work` with the agent marked running; an agent that is not idle refuses. */
export async function runExclusive<T>(agent: Agent, work: () => Promise<T>): Promise<T> {
  if (agent.status !== 'idle') throw new Error(`agent ${agent.id} is ${agent.status}`)
  agent.status = 'running'
  try {
    return await work()
  } finally {
    agent.status = 'idle'
  }
}
