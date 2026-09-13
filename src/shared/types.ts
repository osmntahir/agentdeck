export type Isolation = 'worktree' | 'shared'

/** Yönetilen PTY'nin durumu. Activity ve çalışma kopyası sağlığı ayrı kavramlardır. */
export type Lifecycle = 'live' | 'exited' | 'orphaned'

/** Yalnız canlı Run için anlamlıdır; sessizlik kullanıcı beklediğini kanıtlamaz. */
export type Activity = 'active' | 'idle'

export interface Project {
  kind: 'git' | 'folder'
  id: string
  name: string
  path: string
  createdAt: number
}

/**
 * Son başarıyla yayımlanmış Run'ın açık launch niyeti. Session'ın başlangıç
 * Command'ını değiştirmez. fresh/resume/picker yönetilen kimlik gerektirir ve
 * G2 insan kabul testi geçmeden hiçbir CLI için üretilmez.
 */
export type LastLaunch =
  | { mode: 'command'; command: string | null }
  | { mode: 'fresh'; cli: string; conversationId: string | null }
  | { mode: 'resume'; cli: string; conversationId: string }
  | { mode: 'picker'; cli: string }

/** İzole klasör oturumunda bir alt deponun worktree'si; path proje köküne ve cwd'ye göredir. */
export interface SessionWorktree {
  path: string
  /** O deponun worktree açılışındaki commit'i. */
  baseCommit: string
}

export interface Session {
  id: string
  projectId: string
  name: string
  /** Kullanıcının seçtiği başlangıç programı; null etkileşimli kabuk demektir. */
  command: string | null
  isolation: Isolation
  cwd: string
  /** Worktree oturumunun branch'i; klasör oturumunda her alt depoda aynı addır. */
  branch: string | null
  /** Çalışmanın başlangıç commit'i. Bilinmiyorsa null; uydurulmaz. */
  baseCommit: string | null
  /** Klasör projesindeki izole oturumun alt depo worktree'leri; diğer oturumlarda boş. */
  worktrees: SessionWorktree[]
  lifecycle: Lifecycle
  exitCode: number | null
  exitSignal: number | null
  createdAt: number
  /** Gözlenen çıkış anı. Orphaned kayıtta bilinmez ve null kalır. */
  endedAt: number | null
  /** Son Run'ın kimliği. Geç gelen callback'in yeni Run'ı değiştirmesini engeller. */
  runId: string | null
  archivedAt: number | null
  lastLaunch: LastLaunch | null
}

/** Diske yazılan kayıt. Activity, health ve preview buraya girmez. */
export interface PersistedState {
  schemaVersion: 2
  projects: Project[]
  sessions: Session[]
}

/** Kalıcı kayda türetilmiş alanların eklendiği API görünümü. */
export interface SessionView extends Session {
  activity: Activity | null
  lastActivityAt: number | null
}

export interface StateResponse {
  protocolVersion: 2
  daemonId: string
  revision: number
  serverNow: number
  projects: Project[]
  sessions: SessionView[]
  serviceError: string | null
  terminals?: Record<string, {
    failure: { code: string; message: string } | null
    checkpoint: { lastSuccessAt: number | null; lastError: string | null }
  }>
  previews?: Record<string, {
    state: 'ready' | 'preparing' | 'unavailable'
    preview?: { text: string; truncated: boolean; capturedAt: number }
    reason?: string
  }>
}

/** Tek bir Git deposunun commit edilmemiş değişikliği; path çalışma dizinine göredir. */
export interface RepoDiff {
  path: string
  branch: string
  diff: string
  status: string
}

export interface DiffResult {
  /** Git projesinde tek değer "."; klasör projesinde alt klasörlerdeki depolar. */
  repos: RepoDiff[]
  /** Alt depo taraması sınırda kesildi; liste eksik. */
  truncated: boolean
}

export interface ApiError {
  code: string
  message: string
  details?: unknown
}

/** Başlangıç Command'ını dolduran gömülü kısayol. Kalıcı ajan kimliği değildir. */
export interface Preset {
  label: string
  command: string | null
}

export const PRESETS: Preset[] = [
  { label: 'Claude Code', command: 'claude' },
  { label: 'Codex', command: 'codex' },
  { label: 'Gemini CLI', command: 'gemini' },
  { label: 'Kabuk', command: null },
]

/** Bir Session'ın canlı olmadığı bir durumda gösterilecek program etiketi. */
export function commandLabel(command: string | null): string {
  if (command === null) return 'Kabuk'
  return PRESETS.find((p) => p.command === command)?.label ?? command
}
