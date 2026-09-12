export type Lifecycle = 'live' | 'exited' | 'orphaned'
export type Isolation = 'worktree' | 'shared'
export type UiStatus = 'running' | 'idle' | 'exited' | 'orphaned'

export interface Project {
  id: string
  name: string
  path: string
  /** İkincil işaret — asla tek ayırt edici olmamalı. */
  color: string
  rootMissing: boolean
}

export interface Session {
  id: string
  projectId: string
  name: string
  command: string | null
  isolation: Isolation
  branch: string | null
  cwd: string
  cwdMissing: boolean
  lifecycle: Lifecycle
  lastActivity: number | null
  exitCode: number | null
  exitSignal: number | null
  endedAt: number | null
  lines: string[]
}

export interface World {
  now: number
  projects: Project[]
  sessions: Session[]
}

export function activity(session: Session, now: number): 'running' | 'idle' | null {
  if (session.lifecycle !== 'live' || session.lastActivity == null) return null
  return now - session.lastActivity >= 30_000 ? 'idle' : 'running'
}

export function uiStatus(session: Session, now: number): UiStatus {
  if (session.lifecycle === 'live') return activity(session, now) ?? 'running'
  return session.lifecycle
}

export function commandGlyph(command: string | null): string {
  if (command === null) return '$'
  const base = basename(command)
  if (base === 'claude') return 'C'
  if (base === 'codex') return 'X'
  if (base === 'gemini') return 'G'
  return (base[0] ?? '?').toUpperCase()
}

export function commandLabel(command: string | null): string {
  if (command === null) return 'Kabuk'
  const base = basename(command)
  if (base === 'claude') return 'Claude Code'
  if (base === 'codex') return 'Codex'
  if (base === 'gemini') return 'Gemini CLI'
  return base
}

export function exitLabel(session: Session): string | null {
  if (session.lifecycle !== 'exited') return null
  if (session.exitSignal != null) return SIGNALS[session.exitSignal] ?? `sig ${session.exitSignal}`
  if (session.exitCode != null) return `çıkış ${session.exitCode}`
  return 'çıkış'
}

export function overlays(session: Session, project: Project): string[] {
  const out: string[] = []
  if (session.cwdMissing) out.push('cwd yok')
  if (project.rootMissing) out.push('proje kökü yok')
  return out
}

export function relative(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} sn`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} dk`
  return `${Math.floor(m / 60)} sa`
}

/** V0'ın "dikkat" diye bileceği şey — anlamsal waiting_for_user değil. */
export function attentionRank(session: Session, project: Project, now: number): number {
  const over = overlays(session, project).length > 0
  const status = uiStatus(session, now)
  if (over) return 0
  if (status === 'orphaned') return 1
  if (status === 'exited' && (session.exitCode !== 0 || session.exitSignal != null)) return 2
  if (status === 'idle') return 3
  if (status === 'running') return 4
  return 5
}

function basename(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first.split('/').pop() ?? first
}

const SIGNALS: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
}
