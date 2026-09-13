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
 * Command'ını değiştirmez. V0 fresh/picker UUID üretmez; resume (AgentDeck
 * kimliği) G2 geçmeden yazılmaz.
 */
export type LastLaunch =
  | { mode: 'command'; command: string | null }
  | { mode: 'fresh'; cli: string; conversationId: string | null }
  | { mode: 'resume'; cli: string; conversationId: string }
  | { mode: 'picker'; cli: string }

/** İzole oturumda bir worktree hedefi; path proje köküne ve cwd'ye göredir. Kayıtta yalnız klasör oturumu tutar. */
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
  /** Kalan süreç grubu: Run'ın lideri çıktı ama grubunda hâlâ süreç var. */
  remainingProcessGroup: boolean
  /** Çalışma dizini kullanılamıyorsa nedeni; lifecycle'dan ayrı, türetilmiş overlay (ADR 0005). */
  degraded: string | null
}

/** Proje kökü kullanılamıyorsa nedeni; kayıt ve oturumlar olduğu gibi kalır. */
export interface ProjectView extends Project {
  degraded: string | null
}

/** Canlı Run veya kalan süreç grubu: arşiv ve yeni Run önce doğrulanmış durdurma ister. */
export function hasRunningProcesses(session: SessionView): boolean {
  return session.lifecycle === 'live' || session.remainingProcessGroup
}

/** Saklanmış terminal görüntüsü olan Run; updatedAt kaydın son yazım anıdır. */
export interface StoredRun {
  runId: string
  updatedAt: number
}

export interface StateResponse {
  protocolVersion: 2
  daemonId: string
  revision: number
  serverNow: number
  projects: ProjectView[]
  sessions: SessionView[]
  serviceError: string | null
  terminals?: Record<string, {
    failure: { code: string; message: string } | null
    checkpoint: { lastSuccessAt: number | null; lastError: string | null }
    outputPressure: boolean
  }>
  previews?: Record<string, {
    state: 'ready' | 'preparing' | 'unavailable'
    preview?: { text: string; truncated: boolean; capturedAt: number }
    reason?: string
  }>
}

/**
 * work: base commit'ten mevcut çalışma ağacına toplam fark + takip edilmeyenler.
 * uncommitted: HEAD'e göre net fark + takip edilmeyenler.
 */
export type DiffScope = 'work' | 'uncommitted'

/** Tek bir Git deposunun farkı; path çalışma dizinine göredir. */
export interface RepoDiff {
  path: string
  branch: string
  /** Toplam görünümün sabit referansı; bilinmiyorsa null ve toplam görünüm kapalıdır. */
  baseCommit: string | null
  diff: string
  /** Porcelain satırları: index ve çalışma ağacı durumu ayrı sütunlardadır. */
  status: string
  /** Patch 1 MiB sınırında kesildi. */
  patchTruncated: boolean
  /** Status listesi 10.000 giriş veya 1 MiB sınırında kesildi. */
  statusTruncated: boolean
  /** Okuma sırasında HEAD değişti; sonuç eski olabilir. */
  stale: boolean
  /** Git hatası veya kapalı görünüm; boş diff temiz çalışma kopyası sayılmaz. */
  error: string | null
}

export interface DiffResult {
  scope: DiffScope
  capturedAt: number
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

/** Kartta gösterilen yaş: kısa, aşağı yuvarlanmış süre. 10 sn altı "az önce"dir. */
export function formatAge(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 10) return 'az önce'
  if (seconds < 60) return `${seconds} sn`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} dk`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} sa`
  return `${Math.floor(hours / 24)} gün`
}

/** Canlı oturumda son hareket, diğerlerinde çıkış (yoksa oluşum) anına göre yaş. */
export function sessionAgeMs(
  session: Pick<SessionView, 'lifecycle' | 'lastActivityAt' | 'createdAt' | 'endedAt'>,
  now: number,
): number {
  const origin =
    session.lifecycle === 'live' ? (session.lastActivityAt ?? session.createdAt) : (session.endedAt ?? session.createdAt)
  return Math.max(0, now - origin)
}

/** Bir Session'ın canlı olmadığı bir durumda gösterilecek program etiketi. */
export function commandLabel(command: string | null): string {
  if (command === null) return 'Kabuk'
  return PRESETS.find((p) => p.command === command)?.label ?? command
}
