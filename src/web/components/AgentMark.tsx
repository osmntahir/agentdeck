import { agentFor } from '../../shared/agents'
import type { SessionView } from '../../shared/types'
import { repeatLaunchCommand } from '../../shared/launchPolicy'
export function ProgramIcon({ command }: { command: string | null | undefined }) {
  const agent = agentFor(command?.trim().split(/\s+/)[0])
  return <span className={`agent-mark agent-${agent?.command ?? 'shell'}`} title={agent?.label ?? 'Terminal'}>{agent ? <img src={`/agents/${agent.command}.svg`} alt="" /> : '>_'}</span>
}
export function AgentMark({ session }: { session: SessionView }) {
  const agent = agentFor(session.foregroundAgent) ?? agentFor(repeatLaunchCommand(session)?.split(' ')[0])
  return <span className={`agent-mark agent-${agent?.command ?? 'shell'}`} title={agent ? `${agent.label}${session.foregroundAgent ? ' · çalışan süreç' : ' · başlangıç programı'}` : 'Terminal'} aria-label={agent?.label ?? 'Terminal'}>{agent ? <img src={`/agents/${agent.command}.svg`} alt="" /> : '>_'}</span>
}
