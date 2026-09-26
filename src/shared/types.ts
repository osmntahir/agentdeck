import { AGENTS } from './agents'
import type { ConversationUsage, TokenUsage } from './usage'
import type { QueuedPrompt, SavedPrompt } from './prompts'
export type Isolation = 'worktree' | 'shared'

/** Yönetilen PTY'nin durumu. Activity ve çalışma kopyası sağlığı ayrı kavramlardır. */
export type Lifecycle = 'live' | 'exited' | 'orphaned'

/** Yalnız canlı Run için anlamlıdır; sessizlik kullanıcı beklediğini kanıtlamaz. */
export type Activity = 'active' | 'idle'

/** Terminal kullanıcının yanıtını veya onayını bekliyorsa daemon'ın türettiği durum. */
export interface TerminalAttention {
  kind: 'approval' | 'question'
  message: string
  detectedAt: number
}

export interface Project {
  kind: 'git' | 'folder'
  id: string
  name: string
  path: string
  createdAt: number
  /** Projesiz oturumların kaydı: ev klasöründe, yalnız ortak klasörle çalışır. */
  general?: true
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
  /** Bu saklı resume hedefi daemon açılışında bir kez otomatik denenmiş mi? */
  autoResumeAttempted?: boolean
  /** Bağlı olduğu İş; yoksa oturum hiçbir işe bağlı değildir. */
  workId?: string
  /** Bu oturumun Run'larında gözlenen ajan konuşmaları; eskiden yeniye. */
  conversations?: ConversationRecord[]
  /** PR üzerinde başlatılan oturumun PR'ı; worktree o PR'ın head commit'inden açılmıştır. */
  pullRequest?: SessionPullRequest
  /**
   * Oturuma ayrılan port; Run'a PORT olarak verilir (ADR 0023). Uymayan
   * program başka porttan dinleyebilir; gerçek adres dinlenen portlardan okunur.
   */
  port?: number
  /** Ajan turunu bitirince sırayla gönderilecek istemler (ADR 0024). */
  promptQueue?: QueuedPrompt[]
  /** Kuyruk duraklatıldı: tur bitse de istem gönderilmez. */
  queuePaused?: true
}

export interface SessionPullRequest {
  number: number
  headRefName: string
  /** Oturum branch'i PR'ın uzak branch'ini izliyor mu; fork PR'ında false, push PR'a gitmez. */
  tracking: boolean
}

/**
 * Kullanıcının adlandırdığı iş: bir projede aynı amaca hizmet eden oturumları
 * ve onların konuşmalarını bir araya toplar. Kaldırılması oturumlara dokunmaz.
 */
export interface Work {
  id: string
  projectId: string
  name: string
  createdAt: number
  /** İşe bağlanmış Claude arka plan oturumlarının kısa kimlikleri (`claude agents`). */
  claudeSessions?: string[]
  /**
   * Başka yerden bu işe taşınmış Claude konuşmaları (UUID). Konuşma Claude'da
   * yerinde kalır; yalnız AgentDeck'te bu işin altında görünür.
   */
  conversationRefs?: string[]
}

/**
 * Claude Code'un arka plan oturumu (`claude agents --json`). Durum CLI'ındır:
 * working, blocked (girdi bekliyor), done, failed; listede yoksa unknown.
 */
export interface ClaudeAgentView {
  /** `claude attach <id>` ile açılan kısa kimlik. */
  id: string
  name: string
  state: string
  cwd: string
  /** Güncel konuşmanın kimliği. */
  sessionId: string | null
  startedAt: number | null
  updatedAt: number | null
  /** CLI'ın son özet satırı; iç dosyadan okunur, yoksa null. */
  detail: string | null
}

/** Konuşmanın o Run'da nasıl başladığı; Claude SessionStart kancasının source alanıdır. */
export type ConversationSource = 'startup' | 'resume' | 'clear' | 'compact' | 'other'

/**
 * Ajan CLI'ının bildirdiği bir konuşma. Kimlik CLI'ındır; AgentDeck üretmez.
 * Kayıt, konuşmanın hâlâ erişilebilir olduğunu kanıtlamaz.
 */
export interface ConversationRecord {
  cli: 'claude'
  id: string
  /** Bu kaydın açıldığı Run. */
  runId: string
  source: ConversationSource
  startedAt: number
  /** Aynı konuşmanın bu oturumda en son (yeniden) başladığı an. */
  lastSeenAt: number
  transcriptPath: string | null
}

/** Transcript'ten türetilen özet; dosya okunamazsa alanlar null kalır. */
export interface ConversationSummary {
  /** CLI'da /rename ile verilen ad. /clear sonrası yeni konuşmaya da kopyalanır. */
  title: string | null
  firstPrompt: string | null
  lastPrompt: string | null
  updatedAt: number | null
}

/**
 * Bir işin konuşması. terminal: bu işin terminalinde kancayla görüldü;
 * claude-session: işe bağlı Claude arka plan oturumunun zincirinde;
 * reference: başka yerden bu işe taşındı.
 */
export interface ConversationView extends ConversationSummary {
  id: string
  origin: 'terminal' | 'claude-session' | 'reference'
  /** Görüldüğü AgentDeck oturumu (yalnız terminal). */
  sessionId: string | null
  /** Ait olduğu Claude arka plan oturumu. */
  claudeSessionId: string | null
  source: ConversationSource | null
  lastSeenAt: number
  transcriptPath: string | null
  /** Konuşmanın açıldığı klasör; sürdürme burada yapılır. */
  cwd: string | null
  /** Şu an bir terminalde veya Claude oturumunda açık olan konuşma. */
  current: boolean
  /** Transcript'ten okunan token kullanımı; henüz okunmadıysa boştur. */
  usage?: ConversationUsage
}

/** Konuşma metninde arama sonucu; snippet.ranges eşleşen parçaların snippet içindeki konumlarıdır. */
export interface ConversationSearchHit {
  conversation: ConversationView
  projectId: string
  snippet: { role: 'user' | 'assistant'; text: string; ranges: Array<[number, number]>; at: number | null }
  /** Terimlerden en az birini içeren mesaj sayısı. */
  matches: number
}

export interface ConversationSearchResponse {
  hits: ConversationSearchHit[]
  /** Henüz dizinlenmemiş konuşma sayısı; sıfır değilse sonuç eksik olabilir. */
  pending: number
}

/** Diske yazılan kayıt. Activity, health ve preview buraya girmez. */
export interface PersistedState {
  schemaVersion: 2
  projects: Project[]
  sessions: Session[]
  /** Alan eklenmeden önceki kayıtlarda yoktur. */
  works?: Work[]
  /** Hazır istemler (ADR 0024). */
  prompts?: SavedPrompt[]
}

/** Kalıcı kayda türetilmiş alanların eklendiği API görünümü. */
export interface SessionView extends Session {
  /** Çalışan alt süreçten gözlenen ajan; yalnız sunum, konuşma kimliği değildir. */
  foregroundAgent?: string | null
  /** Doğrulanabilir bir terminal onayı/sorusu kullanıcı girdisi bekliyor. */
  attention: TerminalAttention | null
  activity: Activity | null
  lastActivityAt: number | null
  /** Kalan süreç grubu: Run'ın lideri çıktı ama grubunda hâlâ süreç var. */
  remainingProcessGroup: boolean
  /** Çalışma dizini kullanılamıyorsa nedeni; lifecycle'dan ayrı, türetilmiş overlay (ADR 0005). */
  degraded: string | null
  /** En son gözlenen konuşmanın özeti; özet henüz okunmadıysa alanları null'dur. */
  conversation?: (ConversationSummary & { id: string; current: boolean }) | null
  /** Oturumun konuşmalarının toplam kullanımı ve son konuşmanın bağlamı; konuşma yoksa null. */
  usage?: ConversationUsage | null
  /** Canlı Run'ın süreç ağacında dinlenen TCP portları; artan sırada. */
  ports?: number[]
  /**
   * Claude kancalarından türetilen tur: working istem işleniyor, waiting
   * ajan kullanıcıyı bekliyor. Kanca olayı gelmemiş veya ön planda Claude
   * yoksa null; kuyruk yalnız waiting'de gönderir.
   */
  agentTurn?: 'working' | 'waiting' | null
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
  works?: Work[]
  /** İş kimliği → bağlı Claude arka plan oturumları; liste henüz okunmadıysa durum unknown'dur. */
  claudeSessions?: Record<string, ClaudeAgentView[]>
  /** İş kimliği → konuşma sayısı (önbellekten; tarama sürerken eksik olabilir). */
  workConversationCounts?: Record<string, number>
  /** İş kimliği → konuşmalarının toplam kullanımı (önbellekten). */
  workUsage?: Record<string, TokenUsage>
  /** Hazır istemler; sık kullanılan önce. */
  prompts?: SavedPrompt[]
  /** Claude konuşma takibinin durumu; kanca kurulamadıysa nedeni. */
  conversationTracking?: { active: boolean; message: string | null }
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

/** GitHub'daki bir pull request'in özeti (`gh pr list/view --json`). */
export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  baseRefName: string
  headRefName: string
  author: string | null
  additions: number
  deletions: number
  changedFiles: number
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED; inceleme kuralı yoksa null. */
  reviewDecision: string | null
  updatedAt: string
  /** CI kontrollerinin özeti; kontrol yoksa null. */
  checks: 'success' | 'failure' | 'pending' | null
  /** Klasör projesinde PR'ın alt deposu (proje köküne göre); git projesinde yoktur. */
  repo?: string
}

/** Proje PR listesi; klasör projesinde depo başına durum da gelir (ADR 0025). */
export interface ProjectPullRequestList {
  pullRequests: PullRequestSummary[]
  repos?: Array<{ path: string; count: number; error: { code: string; message: string } | null }>
  /** Alt depo taraması sınırda kesildi; liste eksik olabilir. */
  truncated?: boolean
}

/**
 * GitHub bağlantısının durumu. Bağlantı kullanıcının `gh` oturumudur;
 * AgentDeck token saklamaz ve okumaz.
 */
export type GithubState = 'ready' | 'gh_missing' | 'unauthenticated' | 'not_github' | 'error'

export interface GithubStatus {
  state: GithubState
  message: string | null
  /** owner/name */
  repo: string | null
  defaultBranch: string | null
  /** Çalışma kopyasının güncel branch'i; ayrık HEAD'de null. */
  branch: string | null
  /** Bu branch'ten açılmış PR; açık olan önceliklidir. */
  pullRequest: PullRequestSummary | null
}

/** PR'daki satır yorumu. line null ise yorumun satırı güncel farkta yoktur (outdated). */
export interface PullRequestComment {
  id: number
  path: string
  line: number | null
  startLine: number | null
  side: 'new' | 'old'
  body: string
  author: string
  createdAt: string
  url: string
  inReplyTo: number | null
}

/** PR'ın satıra bağlı olmayan konuşması: genel yorumlar ve inceleme özetleri. */
export interface PullRequestNote {
  kind: 'comment' | 'review'
  author: string
  body: string
  createdAt: string
  url: string
  /** İnceleme sonucu: APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state: string | null
}

export interface PullRequestDetail {
  pullRequest: PullRequestSummary & { body: string; headRefOid: string }
  /** PR'ın GitHub'daki birleşik farkı; 1 MiB sınırında kesilir. */
  diff: string
  truncated: boolean
  comments: PullRequestComment[]
  notes: PullRequestNote[]
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
  ...AGENTS.map(({ label, command }) => ({ label, command })),
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

/** Anlık Git durumu; Session.branch açılış kaydıyla karıştırılmaz. */
export interface GitWorkspace {
  path: string
  branch: string | null
  head: string | null
  dirty: boolean
  branches: string[]
  truncated: boolean
}
export interface GitWorkspaces { repos: GitWorkspace[]; truncated: boolean }

/** Kayıtlı Claude hesabı; token taşımaz. Etkin: canlı kimlik dosyasındaki hesaptır. */
export interface ClaudeAccountView {
  id: string
  email: string | null
  displayName: string | null
  organization: string | null
  subscription: string | null
  active: boolean
  savedAt: number
}

export interface ClaudeAccountsResponse {
  /** Kimliği dosyada tutmayan platformda (macOS anahtar zinciri) veya yapılandırılmamış daemon'da false. */
  supported: boolean
  accounts: ClaudeAccountView[]
  /** Canlı dosyada oturum var ama kayıtlı değilse kimliği; kayıtlıysa veya oturum yoksa null. */
  unsaved: { email: string | null } | null
  login: ClaudeLoginView | null
}

/** Geçici yapılandırma dizininde yürüyen `claude auth login` işi. */
export interface ClaudeLoginView {
  id: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** Çıktıda görülen ilk giriş adresi; tarayıcı açılmazsa kullanıcı buradan gider. */
  url: string | null
  /** ANSI'den arındırılmış çıktı kuyruğu. */
  output: string
  message: string | null
  account: ClaudeAccountView | null
}
