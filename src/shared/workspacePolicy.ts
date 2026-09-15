import { agentFor } from './agents'
import { explicitResumeOf, repeatLaunchCommand, CLI_COMMANDS } from './launchPolicy'
import { sessionWorkCli } from './sessionActions'
import type { SessionView } from './types'

export function inProjectNavigation(session: SessionView): boolean {
  return session.archivedAt === null && (session.lifecycle === 'live' || session.remainingProcessGroup)
}

/** Kesilmiş işler veya doğrulanmış açık konuşma kimliği olan eski Run'lar; genel komutlar tekrar edilmez. */
export function recoveryLaunch(session: SessionView): { command: string | null; mode: 'command' | 'picker' } | null {
  const exactResume = session.lastLaunch?.mode === 'resume' && session.autoResumeAttempted !== true
  if ((session.lifecycle !== 'orphaned' && !exactResume) || session.archivedAt !== null || session.degraded) return null
  const command = repeatLaunchCommand(session)
  if (command === null) return { command: null, mode: 'command' }
  if (command !== undefined && explicitResumeOf(command)) return { command, mode: 'command' }
  const cli = sessionWorkCli(session)
  if (cli) return { command: CLI_COMMANDS[cli].picker, mode: 'picker' }
  // Ek presetlerin devam bayrakları doğrulanmış değil; yalnız literal yeni başlangıç.
  const agent = agentFor(command)
  return agent ? { command: agent.command, mode: 'command' } : null
}
