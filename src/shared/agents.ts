export const AGENTS = [
  { command: 'claude', label: 'Claude Code', mark: '✳' },
  { command: 'codex', label: 'Codex', mark: '⌘' },
  { command: 'gemini', label: 'Gemini CLI', mark: '✦' },
  { command: 'grok', label: 'Grok', mark: '𝕏' },
  { command: 'opencode', label: 'OpenCode', mark: '◧' },
  { command: 'agy', label: 'Antigravity', mark: '△' },
] as const
export type AgentCommand = typeof AGENTS[number]['command']
export function agentFor(command: string | null | undefined) {
  return AGENTS.find(agent => agent.command === command?.trim()) ?? null
}
