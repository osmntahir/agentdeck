import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ConversationRecord, ConversationSource, Isolation, LastLaunch, Lifecycle, PersistedState, Project, Session, SessionPullRequest, SessionWorktree, Work } from '../shared/types'

export const SCHEMA_VERSION = 2

/**
 * Kalıcı kaydın güvenle kullanılamadığı durumlar. Sözleşme gereği bunların
 * hiçbirinde boş state yazılmaz ve hiçbir dosya süpürülmez: daemon durur.
 */
export class StateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StateError'
    this.code = code
  }
}

const LIFECYCLES: Lifecycle[] = ['live', 'exited', 'orphaned']
const ISOLATIONS: Isolation[] = ['worktree', 'shared']

/** Eski şemadaki ajan kimliği yalnız başlangıç Command'ına çevrilir. */
const LEGACY_AGENT_COMMAND: Record<string, string | null> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  shell: null,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corrupt(what: string): never {
  throw new StateError('state_corrupt', `Kalıcı kayıt tanınmıyor: ${what}`)
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') corrupt(what)
  return value
}

function nullableStr(value: unknown, what: string): string | null {
  if (value === null) return null
  return str(value, what)
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) corrupt(what)
  return value
}

function nullableNum(value: unknown, what: string): number | null {
  if (value === null) return null
  return num(value, what)
}

function optionalBool(value: unknown, what: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') corrupt(what)
  return value
}

function project(raw: unknown): Project {
  if (!isObject(raw)) corrupt('project kaydı')
  const kind = raw.kind === undefined ? 'git' : raw.kind
  if (kind !== 'git' && kind !== 'folder') corrupt('project.kind')
  return {
    kind,
    id: str(raw.id, 'project.id'),
    name: str(raw.name, 'project.name'),
    path: str(raw.path, 'project.path'),
    createdAt: num(raw.createdAt, 'project.createdAt'),
    ...(raw.general === true ? { general: true as const } : {}),
  }
}

function lastLaunch(raw: unknown): LastLaunch | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) corrupt('lastLaunch')
  switch (raw.mode) {
    case 'command':
      return { mode: 'command', command: nullableStr(raw.command, 'lastLaunch.command') }
    case 'fresh':
      return {
        mode: 'fresh',
        cli: str(raw.cli, 'lastLaunch.cli'),
        conversationId: nullableStr(raw.conversationId, 'lastLaunch.conversationId'),
      }
    case 'resume':
      return {
        mode: 'resume',
        cli: str(raw.cli, 'lastLaunch.cli'),
        conversationId: str(raw.conversationId, 'lastLaunch.conversationId'),
      }
    case 'picker':
      return { mode: 'picker', cli: str(raw.cli, 'lastLaunch.cli') }
    default:
      return corrupt(`lastLaunch.mode=${String(raw.mode)}`)
  }
}

function worktrees(raw: unknown): SessionWorktree[] {
  // Alan eklenmeden önceki kayıtlarda alt depo worktree'si yoktur.
  if (raw === undefined) return []
  if (!Array.isArray(raw)) corrupt('session.worktrees')
  return raw.map((entry) => {
    if (!isObject(entry)) corrupt('session.worktrees kaydı')
    const rel = str(entry.path, 'session.worktrees.path')
    // Yol silme sırasında cwd ve proje köküne eklenir; dışarı taşamaz.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) corrupt(`session.worktrees.path=${rel}`)
    return { path: rel, baseCommit: str(entry.baseCommit, 'session.worktrees.baseCommit') }
  })
}

const CONVERSATION_SOURCES: ConversationSource[] = ['startup', 'resume', 'clear', 'compact', 'other']

function work(raw: unknown): Work {
  if (!isObject(raw)) corrupt('work kaydı')
  return {
    id: str(raw.id, 'work.id'),
    projectId: str(raw.projectId, 'work.projectId'),
    name: str(raw.name, 'work.name'),
    createdAt: num(raw.createdAt, 'work.createdAt'),
    ...(raw.claudeSessions !== undefined ? { claudeSessions: claudeSessionIds(raw.claudeSessions) } : {}),
    ...(raw.conversationRefs !== undefined ? { conversationRefs: conversationRefIds(raw.conversationRefs) } : {}),
  }
}

function conversationRefIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) corrupt('work.conversationRefs')
  return raw.map((id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) corrupt('work.conversationRefs kaydı')
    return id
  })
}

function claudeSessionIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) corrupt('work.claudeSessions')
  return raw.map((id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) corrupt('work.claudeSessions kaydı')
    return id
  })
}

function conversations(raw: unknown): ConversationRecord[] {
  if (!Array.isArray(raw)) corrupt('session.conversations')
  return raw.map((entry) => {
    if (!isObject(entry)) corrupt('session.conversations kaydı')
    if (entry.cli !== 'claude') corrupt(`conversation.cli=${String(entry.cli)}`)
    const source = str(entry.source, 'conversation.source')
    if (!CONVERSATION_SOURCES.includes(source as ConversationSource)) corrupt(`conversation.source=${source}`)
    return {
      cli: 'claude',
      id: str(entry.id, 'conversation.id'),
      runId: str(entry.runId, 'conversation.runId'),
      source: source as ConversationSource,
      startedAt: num(entry.startedAt, 'conversation.startedAt'),
      lastSeenAt: num(entry.lastSeenAt, 'conversation.lastSeenAt'),
      transcriptPath: nullableStr(entry.transcriptPath, 'conversation.transcriptPath'),
    }
  })
}

function session(raw: unknown): Session {
  if (!isObject(raw)) corrupt('session kaydı')
  const lifecycle = str(raw.lifecycle, 'session.lifecycle')
  if (!LIFECYCLES.includes(lifecycle as Lifecycle)) corrupt(`lifecycle=${lifecycle}`)
  const isolation = str(raw.isolation, 'session.isolation')
  if (!ISOLATIONS.includes(isolation as Isolation)) corrupt(`isolation=${isolation}`)

  return {
    id: str(raw.id, 'session.id'),
    projectId: str(raw.projectId, 'session.projectId'),
    name: str(raw.name, 'session.name'),
    command: nullableStr(raw.command, 'session.command'),
    isolation: isolation as Isolation,
    cwd: str(raw.cwd, 'session.cwd'),
    branch: nullableStr(raw.branch, 'session.branch'),
    baseCommit: nullableStr(raw.baseCommit, 'session.baseCommit'),
    worktrees: worktrees(raw.worktrees),
    lifecycle: lifecycle as Lifecycle,
    exitCode: nullableNum(raw.exitCode, 'session.exitCode'),
    exitSignal: nullableNum(raw.exitSignal, 'session.exitSignal'),
    createdAt: num(raw.createdAt, 'session.createdAt'),
    endedAt: nullableNum(raw.endedAt, 'session.endedAt'),
    runId: nullableStr(raw.runId, 'session.runId'),
    archivedAt: nullableNum(raw.archivedAt, 'session.archivedAt'),
    lastLaunch: lastLaunch(raw.lastLaunch),
    autoResumeAttempted: optionalBool(raw.autoResumeAttempted, 'session.autoResumeAttempted'),
    // Alanlar eklenmeden önceki kayıtlarda yoktur; yoksa anahtar da yazılmaz.
    ...(raw.workId !== undefined ? { workId: str(raw.workId, 'session.workId') } : {}),
    ...(raw.conversations !== undefined ? { conversations: conversations(raw.conversations) } : {}),
    ...(raw.pullRequest !== undefined ? { pullRequest: pullRequestRef(raw.pullRequest) } : {}),
  }
}

function pullRequestRef(raw: unknown): SessionPullRequest {
  if (!isObject(raw)) corrupt('session.pullRequest')
  const number = num(raw.number, 'session.pullRequest.number')
  if (!Number.isSafeInteger(number) || number <= 0) corrupt('session.pullRequest.number')
  const tracking = optionalBool(raw.tracking, 'session.pullRequest.tracking')
  if (tracking === undefined) corrupt('session.pullRequest.tracking')
  return { number, headRefName: str(raw.headRefName, 'session.pullRequest.headRefName'), tracking }
}

/**
 * Eski agent/status kaydını şema 2'ye çevirir. Bilinmeyen bir alan değeri
 * görüldüğünde kayıt kısmen kurtarılmaz; migrate durur.
 */
function migrateLegacySession(raw: unknown): Session {
  if (!isObject(raw)) corrupt('legacy session kaydı')

  const agent = str(raw.agent, 'legacy session.agent')
  if (!(agent in LEGACY_AGENT_COMMAND)) corrupt(`legacy agent=${agent}`)
  const command = LEGACY_AGENT_COMMAND[agent]

  const status = str(raw.status, 'legacy session.status')
  if (status !== 'running' && status !== 'exited') corrupt(`legacy status=${status}`)

  const isolation = str(raw.isolation, 'legacy session.isolation')
  if (!ISOLATIONS.includes(isolation as Isolation)) corrupt(`legacy isolation=${isolation}`)

  return {
    id: str(raw.id, 'legacy session.id'),
    projectId: str(raw.projectId, 'legacy session.projectId'),
    name: str(raw.name, 'legacy session.name'),
    command,
    isolation: isolation as Isolation,
    cwd: str(raw.cwd, 'legacy session.cwd'),
    branch: nullableStr(raw.branch ?? null, 'legacy session.branch'),
    // Eski şema başlangıç commit'ini tutmuyordu; hareketli HEAD ikame edilmez.
    baseCommit: null,
    worktrees: [],
    // Eski "running" kaydı yönetilebilir bir PTY bırakmaz.
    lifecycle: status === 'running' ? 'orphaned' : 'exited',
    exitCode: nullableNum(raw.exitCode ?? null, 'legacy session.exitCode'),
    exitSignal: null,
    createdAt: num(raw.createdAt, 'legacy session.createdAt'),
    // Eski kayıt çıkış anını tutmuyordu; kurtarma saati ölüm saati gibi yazılmaz.
    endedAt: null,
    // Eski şemada Run kimliği yoktu; sahte runId üretilmez.
    runId: null,
    archivedAt: null,
    lastLaunch: { mode: 'command', command },
    autoResumeAttempted: undefined,
  }
}

function parseKnownSchema(raw: unknown): { state: PersistedState; migrated: boolean } {
  if (!isObject(raw)) corrupt('kök nesne')
  if (!Array.isArray(raw.projects) || !Array.isArray(raw.sessions)) corrupt('projects/sessions dizisi')

  const projects = raw.projects.map(project)
  const version = raw.schemaVersion

  if (version === undefined || version === 1) {
    return {
      state: { schemaVersion: SCHEMA_VERSION, projects, sessions: raw.sessions.map(migrateLegacySession) },
      migrated: true,
    }
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) corrupt(`schemaVersion=${String(version)}`)
  if (version > SCHEMA_VERSION) {
    throw new StateError(
      'state_newer_schema',
      `Kayıt şeması ${version}, bu daemon ${SCHEMA_VERSION} biliyor. Daha yeni sürümle açılmış bir kayda dokunulmaz.`,
    )
  }
  if (raw.works !== undefined && !Array.isArray(raw.works)) corrupt('works dizisi')
  const works = raw.works === undefined ? undefined : raw.works.map(work)
  return {
    state: {
      schemaVersion: SCHEMA_VERSION,
      projects,
      sessions: raw.sessions.map(session),
      ...(works !== undefined ? { works } : {}),
    },
    migrated: false,
  }
}

/**
 * Önceki daemon'dan yönetilebilir PTY kalmaz; canlı kayıt orphaned olur.
 * Dönen kimlikler, yalnız bu açılışta daemon'un otomatik geri açmayı deneyebileceği
 * Run'lardır. Dönüşüm diske de yazılır; başarısız deneme sonraki açılışta sonsuz
 * kez tekrarlanmaz.
 */
function recoverLifecycles(state: PersistedState): string[] {
  const interrupted: string[] = []
  for (const s of state.sessions) {
    if (s.lifecycle === 'live') {
      interrupted.push(s.id)
      s.lifecycle = 'orphaned'
    }
  }
  return interrupted
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

export interface Store {
  readonly worktreeRoot: string
  /** Yayımlanmış kayıt. Salt okunurdur (dondurulmuştur); commit ile değiştirilir. */
  get(): PersistedState
  revision(): number
  serviceError(): string | null
  /** Bu daemon açılırken yarım kaldığı görülen, bir kez otomatik denenebilecek Run'lar. */
  interruptedSessionIds(): readonly string[]
  /**
   * Copy-on-write mutation: taslak klonlanır, temp+rename ile yazılır ve ancak
   * rename başarılıysa yayımlanır. Çağrılar sıraya girer.
   */
  commit(mutate: (draft: PersistedState) => void): Promise<void>
  token(): string
}

export function openStore(dataDir: string): Store {
  const worktreeRoot = path.join(dataDir, 'worktrees')
  const stateFile = path.join(dataDir, 'state.json')
  const tokenFile = path.join(dataDir, 'token')

  let raw: string | null = null
  try {
    raw = fs.readFileSync(stateFile, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new StateError('state_unreadable', `Kalıcı kayıt okunamadı (${code}): ${stateFile}`)
    }
  }

  let published: PersistedState
  let migratedFrom: string | null = null
  let interruptedSessionIds: string[] = []

  if (raw === null) {
    // Kayıt yok ama yönetilen alanda çalışma kopyası duruyorsa, bu kopya
    // kullanıcı işi içerebilir. Boş state yazmak onları kayıtsız bırakır.
    const managed = readManagedEntries(worktreeRoot)
    if (managed.length > 0) {
      throw new StateError(
        'state_missing_with_resources',
        `Kalıcı kayıt yok ama yönetilen alanda ${managed.length} çalışma kopyası var (${worktreeRoot}). ` +
          'Boş kayıt yazılmadı; dosyalar olduğu gibi duruyor.',
      )
    }
    published = { schemaVersion: SCHEMA_VERSION, projects: [], sessions: [] }
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new StateError('state_corrupt', `Kalıcı kayıt ayrıştırılamadı: ${(err as Error).message}`)
    }
    const result = parseKnownSchema(parsed)
    published = result.state
    interruptedSessionIds = recoverLifecycles(published)

    if (result.migrated) {
      migratedFrom = raw
    }
  }

  fs.mkdirSync(worktreeRoot, { recursive: true })

  let revision = 0
  let serviceError: string | null = null
  let queue: Promise<void> = Promise.resolve()

  function writeAtomic(next: PersistedState): void {
    const tmp = `${stateFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, stateFile)
  }

  function commit(mutate: (draft: PersistedState) => void): Promise<void> {
    const task = queue.then(() => {
      // Taslak sıraya girdiği anda değil, çalıştığı anda klonlanır; böylece
      // bekleyen mutation en güncel yayımlanmış kaydı görür.
      const draft = structuredClone(published) as PersistedState
      mutate(draft)
      try {
        writeAtomic(draft)
      } catch (err) {
        serviceError = `Kalıcı kayıt yazılamadı: ${(err as Error).message}`
        throw err
      }
      published = deepFreeze(draft)
      revision += 1
      serviceError = null
    })
    // Sıra bir hatada kırılmaz; sonraki mutation denenebilir olmalı.
    queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  if (migratedFrom !== null || interruptedSessionIds.length > 0) {
    // Yedek atomik yayımdan önce yazılır: yedeklenemiyorsa migrate edilmez.
    if (migratedFrom !== null) {
      const backup = `${stateFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try {
        fs.writeFileSync(backup, migratedFrom, { mode: 0o600, flag: 'wx' })
      } catch (err) {
        throw new StateError('state_unreadable', `Migrate yedeği yazılamadı: ${(err as Error).message}`)
      }
    }
    try {
      writeAtomic(published)
    } catch (err) {
      throw new StateError(
        'state_unreadable',
        `${migratedFrom !== null ? 'Migrate' : 'Oturum kurtarma durumu'} yayımlanamadı: ${(err as Error).message}`,
      )
    }
    revision += 1
  }

  published = deepFreeze(published)

  return {
    worktreeRoot,
    get: () => published,
    revision: () => revision,
    serviceError: () => serviceError,
    interruptedSessionIds: () => [...interruptedSessionIds],
    commit,
    token(): string {
      try {
        const existing = fs.readFileSync(tokenFile, 'utf8').trim()
        if (existing) return existing
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw new StateError('state_unreadable', `Token okunamadı (${code})`)
      }
      const value = crypto.randomBytes(24).toString('hex')
      fs.writeFileSync(tokenFile, value, { mode: 0o600 })
      return value
    },
  }
}

/** Yönetilen kökteki çalışma kopyası adayları; salt okunur, symlink izlemez. */
function readManagedEntries(worktreeRoot: string): string[] {
  const found: string[] = []
  let projects: fs.Dirent[]
  try {
    projects = fs.readdirSync(worktreeRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(worktreeRoot, entry.name)
    try {
      for (const child of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (child.isDirectory()) found.push(path.join(projectDir, child.name))
      }
    } catch {
      // okunamayan dizin keşifte eksik kalır; silme yetkisi doğurmaz
    }
  }
  return found
}
