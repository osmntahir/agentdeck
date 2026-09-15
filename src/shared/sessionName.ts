import { agentFor } from './agents'
import { commandLabel, type Session } from './types'

/** Derive a live label without rewriting the saved name or a user's custom title. */
export function sessionDisplayName(
  session: Pick<Session, 'id' | 'name' | 'command'>,
  foregroundAgent: string | null,
): string {
  const suffix = session.id.slice(0, 6)
  const automaticName = `${commandLabel(session.command)} ${suffix}`
  if (session.name !== automaticName) return session.name
  const agent = agentFor(foregroundAgent)
  return agent ? `${agent.label} ${suffix}` : session.name
}
