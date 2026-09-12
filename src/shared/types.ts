export type AgentKind = 'claude' | 'codex' | 'gemini' | 'shell'
export type Isolation = 'worktree' | 'shared'
export type SessionStatus = 'running' | 'exited'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
}

export interface Session {
  id: string
  projectId: string
  name: string
  agent: AgentKind
  isolation: Isolation
  cwd: string
  branch: string | null
  status: SessionStatus
  exitCode: number | null
  createdAt: number
}

export interface AppState {
  projects: Project[]
  sessions: Session[]
}

export interface DiffResult {
  diff: string
  status: string
  branch: string
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  shell: 'Kabuk',
}
