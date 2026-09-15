export const AGENTS = [
  { command: 'claude', label: 'Claude Code' },
  { command: 'codex', label: 'Codex' },
  { command: 'gemini', label: 'Gemini CLI' },
  { command: 'grok', label: 'Grok' },
  { command: 'opencode', label: 'OpenCode' },
  { command: 'agy', label: 'Antigravity' },
] as const
export type AgentCommand = typeof AGENTS[number]['command']
export function agentFor(command: string | null | undefined) {
  const name = command?.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd)$/i, '').toLowerCase()
  return AGENTS.find(agent => agent.command === (name === 'antigravity' ? 'agy' : name)) ?? null
}
