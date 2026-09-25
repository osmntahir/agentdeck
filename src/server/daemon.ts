import { sessionDisplayName } from '../shared/sessionName'
import { readGitWorkspace, switchWorkspaceBranch } from './branchControl'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import express from 'express'
import { WebSocketServer } from 'ws'
import { openStore, type Store } from './store'
import { acquireDaemonLock, type DaemonLock } from './lock'
import { createExclusiveLocks, createLimiter, createSerialQueues, type HeldLock } from './locks'
import { createRequestLedger, DedupConflictError } from './dedup'
import { scanOrphanWorktrees } from './orphans'
import { findSubRepos } from './repos'
import { contentFingerprint, createBudget, type Budget, type ContentFingerprint } from './fingerprint'
import * as sessions from './sessions'
import * as git from './git'
import { isCheckpointId, openCheckpointStore } from './checkpoints'
import { createTerminalHost, type TerminalEvent, type PreviewResult } from './terminalHost'
import { chunkText, type SnapshotScope } from './terminalState'
import { readUserEnvironment, runEnv } from './env'
import { AccountError, openClaudeAccounts, type ClaudePaths } from './claudeAccounts'
import { startClaudeLogin, type ClaudeLogin } from './claudeLogin'
import { installClaudeHook, openHookInbox, type HookEvent } from './claudeHooks'
import { createTranscriptSummaries } from './transcripts'
import { createClaudeAgents, isClaudeAgentId } from './claudeAgents'
import { createTranscriptIndex, type TranscriptEntry } from './claudeTranscripts'
import { lastLaunchFor, repeatLaunchCommand } from '../shared/launchPolicy'
import { resumeTargetFromTerminalText } from '../shared/resumeDetection'
import { terminalAttentionFromText } from '../shared/terminalAttention'
import { recoveryLaunch } from '../shared/workspacePolicy'
import {
  commandLabel,
  type DiffScope,
  type Isolation,
  type LastLaunch,
  type Project,
  type ProjectView,
  type RepoDiff,
  type Session,
  type SessionView,
  type TerminalAttention,
  type SessionWorktree,
  type ConversationRecord,
  type ConversationView,
  type ClaudeAgentView,
  type Work,
} from '../shared/types'

const PROTOCOL_VERSION = 2

/** Başlangıç rezervasyonları (spec §4). Fazla legacy kayıt kesilmez; create durur. */
const MAX_SESSIONS = 256
const MAX_LIVE_RUNS = 32
/** Açılışta çok sayıda CLI'ın aynı anda profil/önbellek açmasını önler. */
const STARTUP_RESTORE_CONCURRENCY = 3
/** Kısa devam çıktısı soru gibi görünse de bildirim oluşturmaz. */
/** Çıktı bu kadar durulunca ekran onay/soru için değerlendirilir. */
const ATTENTION_QUIET_MS = 900
/** Kesintisiz çıktıda en geç bu aralıkla yeniden bakılır; o sırada yalnız eski dikkat kalkar. */
const ATTENTION_MAX_WAIT_MS = 4000

/** Silme onayı daemon ömrüne bağlıdır ve 60 sn sonra düşer. */
const CONFIRMATION_TTL_MS = 60_000

/** Korunan branch görünümünde okunacak en çok ref (spec §6). */
const MAX_BRANCH_REFS = 1000

/** Proje/cwd erişilebilirliği bu süre önbelleklenir (spec §5). */
const HEALTH_CACHE_MS = 2000

/** Aynı anda önizleme istenebilecek kart sayısı (spec §4). */
const MAX_PREVIEW_IDS = 24

/** WS sınırları (spec §4). Chunk metni, JSON zarfı ve replay toplamı ayrıdır. */
const WS_CHUNK_TEXT_BYTES = 32 * 1024
const WS_ENVELOPE_BYTES = 256 * 1024
const WS_REPLAY_MAX_BYTES = 8 * 1024 * 1024
const WS_INPUT_TEXT_BYTES = 64 * 1024
const WS_INPUT_WIRE_BYTES = 512 * 1024
/** Yavaş izleyici üreticiyi bekletmez; kuyruğu şişen izleyici ayrılır. */
const WS_VIEWER_QUEUE_BYTES = 1024 * 1024

const ISOLATIONS: Isolation[] = ['worktree', 'shared']

/** Oturum başına saklanan en çok konuşma kaydı; eskiler düşer. */
const MAX_CONVERSATIONS_PER_SESSION = 100
/** Kaydı henüz yazılmamış oturumun kanca olayı bu süre bekletilir. */
const HOOK_EVENT_GRACE_MS = 60_000
const WORK_NAME_MAX = 80

export interface DaemonOptions {
  dataDir: string
  port?: number
  host?: string
  /** Derlenmiş web çıktısını servis et (üretim başlatıcısı için). */
  serveWeb?: boolean
  /** Her Run öncesi okunan kullanıcı ortam dosyası; verilmezse kullanıcı değeri eklenmez. */
  environmentFile?: string
  /** Claude hesap geçişi (ADR 0017). Verilmezse panel desteklenmez; canlı kimlik dosyalarına dokunulmaz. */
  claudeAccounts?: { live: ClaudePaths; command?: string }
  /** Claude konuşma kancasının ekleneceği settings.json (ADR 0018). Verilmezse ayarlara dokunulmaz. */
  claudeSettingsFile?: string
  /** Claude arka plan oturumlarını işe bağlama; verilmezse kapalıdır. */
  claudeAgents?: { command: string; claudeDir: string }
}

export interface Daemon {
  port: number
  token: string
  url: string
  daemonId: string
  close(): Promise<void>
}

interface Confirmation {
  sessionId: string
  runId: string | null
  cwd: string
  /** Dizin kimliği: yol aynı kalsa da başka bir dizine dönmüşse onay düşer. */
  dirIdentity: string
  contentDigest: string
  expiresAt: number
}

/** Proje veya iş onayı önizlemedeki Session kümesini ve her birinin onayını birlikte bağlar. */
interface GroupConfirmation {
  /** `project:<id>` veya `work:<id>` */
  owner: string
  sessions: Map<string, Confirmation>
  expiresAt: number
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function jsonError(res: express.Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json(details === undefined ? { code, message } : { code, message, details })
}

function sendError(res: express.Response, err: unknown): void {
  if (err instanceof HttpError) {
    jsonError(res, err.status, err.code, err.message, err.details)
    return
  }
  if (err instanceof DedupConflictError) {
    jsonError(res, 409, err.code, err.message)
    return
  }
  jsonError(res, 500, 'internal', (err as Error).message ?? 'Bilinmeyen hata')
}

/** Tarayıcıdaki herhangi bir sayfa 127.0.0.1'e istek açabilir; origin daraltılır. */
function originOk(origin: string | undefined): boolean {
  if (!origin) return true // curl/test gibi tarayıcı dışı istemciler
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

const COMBINING_MARKS = /[\u0300-\u036f]/g

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    // Noktasız ı NFD ile ayrışmaz; eşlenmezse harf branch adından düşer.
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return s || 'is'
}

/** 1-80 Unicode karakter, kontrol karakteri yok. Boş ad otomatik etiketlenir. */
function readName(raw: unknown, command: string | null, sessionId: string): string | { error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return `${commandLabel(command)} ${sessionId.slice(0, 6)}`
  }
  if (typeof raw !== 'string') return { error: 'Oturum adı metin olmalı' }
  const trimmed = raw.trim()
  if (trimmed === '') return `${commandLabel(command)} ${sessionId.slice(0, 6)}`
  if (Array.from(trimmed).length > 80) return { error: 'Oturum adı en çok 80 karakter olabilir' }
  if (/\p{Cc}/u.test(trimmed)) return { error: 'Oturum adında kontrol karakteri olamaz' }
  return trimmed
}

function readCommand(raw: unknown): string | null | { error: string } {
  if (raw === null) return null
  if (typeof raw !== 'string') return { error: 'command metin veya null olmalı' }
  if (raw === '') return { error: 'Boş komut çalıştırılamaz' }
  return raw
}

function readRequestId(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'requestId gerekli' }
  if (raw.length > 200) return { error: 'requestId çok uzun' }
  return raw
}

function digestOf(parts: string[]): string {
  const hash = crypto.createHash('sha256')
  for (const part of parts) {
    hash.update(String(part.length))
    hash.update(part)
  }
  return hash.digest('hex')
}

function dirIdentityOf(dir: string): string | null {
  try {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory()) return null
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

/**
 * Worktree'ler kalktıktan sonra kapsayıcı klasörlerden yalnız boş olanları
 * kaldırır. Recursive silme yoktur; içerik kalmışsa klasör korunur.
 */
function pruneEmptyDirs(cwd: string, rels: string[]): void {
  const dirs = new Set<string>()
  for (const rel of rels) {
    for (let dir = path.dirname(rel); dir !== '.'; dir = path.dirname(dir)) dirs.add(dir)
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const dir of [...deepestFirst.map((d) => path.join(cwd, d)), cwd]) {
    try {
      fs.rmdirSync(dir)
    } catch {
      // Boş değil veya zaten yok: dokunulmaz.
    }
  }
}

/** Yalnız ENOENT "yok" demektir; başka hata okunamazlıktır ve "yok" sayılmaz. */
function isMissing(target: string): boolean {
  try {
    fs.lstatSync(target)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** İzole oturumun cwd'ye göre worktree yolları: Git projesinde kök, klasör projesinde her alt depo. */
function worktreePaths(session: Session): string[] {
  return session.worktrees.length > 0 ? session.worktrees.map((w) => w.path) : ['.']
}

/** Bir deponun toplam görünüm referansı: klasör oturumunda o alt depo worktree'sinin, Git projesinde oturumun commit'i. */
function baseCommitFor(session: Session, rel: string): string | null {
  if (session.worktrees.length > 0) return session.worktrees.find((w) => w.path === rel)?.baseCommit ?? null
  return rel === '.' ? session.baseCommit : null
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  // Sözleşme: state'e dokunmadan önce tek yazar kilidi alınır.
  const lock: DaemonLock = await acquireDaemonLock(options.dataDir)
  let store: Store
  try {
    store = openStore(options.dataDir)
  } catch (err) {
    await lock.release()
    throw err
  }

  const daemonId = crypto.randomBytes(16).toString('hex')
  const token = store.token()
  // Ekran modeli ayrı bir iş parçacığında yaşar; HTTP/Git kontrol işleri onun
  // ayrıştırma yüküyle bloke olmaz (spec §4).
  const checkpoints = openCheckpointStore(options.dataDir)
  const host = createTerminalHost({ checkpoints })
  const sessionLocks = createExclusiveLocks()
  const gitQueues = createSerialQueues()
  /** Diff ve branch okuması HTTP kontrol işlerini boğmaz: aynı anda en çok iki Git işi (spec §5). */
  const gitReadSlots = createLimiter(2)
  const createLedger = createRequestLedger<Session>()
  const launchLedger = createRequestLedger<Session>()
  const confirmations = new Map<string, Confirmation>()
  const groupConfirmations = new Map<string, GroupConfirmation>()
  const projectsBeingDeleted = new Set<string>()
  /** Bir Run'ın çıkış kaydının diske yazılması; stop bunu bekler. */
  const pendingExitCommits = new Map<string, Promise<void>>()
  let shuttingDown = false

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // Auth'tan önce: masaüstü kabuğu porttaki sürecin bizim daemon olup
  // olmadığını token'sız ayırt edebilmeli. Hiçbir veri sızdırmaz.
  app.get('/api/health', (_req, res) => {
    res.json({ app: 'agentdeck', protocolVersion: PROTOCOL_VERSION, pid: process.pid })
  })

  app.use('/api', (req, res, next) => {
    if (!originOk(req.headers.origin)) return jsonError(res, 403, 'origin', 'Origin reddedildi')
    const supplied = req.headers['x-agentdeck-token'] ?? req.query.token
    if (supplied !== token) return jsonError(res, 401, 'token', 'Geçersiz token')
    if (shuttingDown && req.method !== 'GET') {
      return jsonError(res, 503, 'shutting_down', 'Daemon kapanıyor; yeni mutation kabul edilmiyor')
    }
    next()
  })

  /**
   * Proje kökü ve benzersiz cwd başına 2 sn önbellekli erişilebilirlik (spec §5).
   * Yalnız görünüm içindir; mutation'lar kendi taze kontrolünü yapar.
   */
  const directoryHealth = new Map<string, { at: number; problem: string | null }>()
  function directoryProblem(target: string): string | null {
    const now = Date.now()
    const cached = directoryHealth.get(target)
    if (cached && now - cached.at < HEALTH_CACHE_MS) return cached.problem
    let problem: string | null = null
    try {
      if (!fs.statSync(target).isDirectory()) problem = 'dizin değil'
    } catch (err) {
      problem = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'yok' : 'okunamıyor'
    }
    directoryHealth.set(target, { at: now, problem })
    return problem
  }

  function sessionView(session: Session): SessionView {
    const live = sessions.activity(session.id)
    const cwdProblem = directoryProblem(session.cwd)
    const foregroundAgent = sessions.foregroundAgent(session.id)
    return {
      ...session,
      name: sessionDisplayName(session, foregroundAgent),
      foregroundAgent,
      attention: terminalAttention(session.id, session.runId),
      activity: live?.activity ?? null,
      lastActivityAt: live?.lastActivityAt ?? null,
      remainingProcessGroup: sessions.hasLingeringGroup(session.id),
      degraded: cwdProblem === null ? null : `Çalışma dizini ${cwdProblem}: ${session.cwd}`,
      conversation: latestConversation(session),
    }
  }

  function latestConversation(session: Session): SessionView['conversation'] {
    const latest = session.conversations?.at(-1)
    if (!latest) return null
    const { title, firstPrompt, lastPrompt, updatedAt, current } = conversationView(session, latest)
    return { id: latest.id, title, firstPrompt, lastPrompt, updatedAt, current }
  }

  function projectView(project: Project): ProjectView {
    const problem = directoryProblem(project.path)
    return { ...project, degraded: problem === null ? null : `Proje klasörü ${problem}: ${project.path}` }
  }

  function findSession(id: string): Session | undefined {
    return store.get().sessions.find((s) => s.id === id)
  }

  function findWork(id: string): Work | undefined {
    return (store.get().works ?? []).find((w) => w.id === id)
  }

  // Claude konuşma takibi (ADR 0018): kanca olay dosyası bırakır, daemon oturuma yazar.
  const hookDir = path.join(options.dataDir, 'hooks', 'claude')
  let conversationTracking: { active: boolean; message: string | null } = {
    active: false,
    message: 'Claude ayar dosyası yapılandırılmadı',
  }
  if (options.claudeSettingsFile) {
    const installed = installClaudeHook(options.claudeSettingsFile)
    conversationTracking = installed.active ? { active: true, message: null } : { active: false, message: installed.message }
    if (!installed.active) console.warn(`[agentdeck] Claude konuşma takibi kapalı: ${installed.message}`)
  }
  const transcripts = createTranscriptSummaries()
  let pendingHookEvents: HookEvent[] = []

  function recordConversations(events: HookEvent[]): void {
    const all = [...pendingHookEvents, ...events]
    if (all.length === 0) return
    const known = new Set(store.get().sessions.map((s) => s.id))
    const now = Date.now()
    // Oturum kaydı PTY doğduktan sonra yazılır; kanca ondan önce gelebilir.
    pendingHookEvents = all.filter((e) => !known.has(e.sessionId) && now - e.at < HOOK_EVENT_GRACE_MS)
    const ready = all.filter((e) => known.has(e.sessionId))
    if (ready.length === 0) return
    void store.commit((draft) => {
      for (const event of ready) {
        const session = draft.sessions.find((s) => s.id === event.sessionId)
        if (!session) continue
        const list = session.conversations ?? []
        const existing = list.find((c) => c.id === event.conversationId)
        if (existing) {
          existing.lastSeenAt = Math.max(existing.lastSeenAt, event.at)
          existing.runId = event.runId
          if (event.transcriptPath) existing.transcriptPath = event.transcriptPath
        } else {
          list.push({
            cli: 'claude',
            id: event.conversationId,
            runId: event.runId,
            source: event.source,
            startedAt: event.at,
            lastSeenAt: event.at,
            transcriptPath: event.transcriptPath,
          })
        }
        list.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
        session.conversations = list.slice(-MAX_CONVERSATIONS_PER_SESSION)
      }
    }).catch(() => {
      // Store serviceError'u taşır; kayıt sonraki olayda yeniden denenmez, kanca yeniden başlatmada tekrar bildirir.
    })
  }
  const inbox = openHookInbox(hookDir, recordConversations)

  const claudeAgents = options.claudeAgents
    ? createClaudeAgents({ ...options.claudeAgents, env: process.env })
    : null

  /** Listede görünmeyen bağlı oturum silinmiş veya henüz okunmamış olabilir; uydurulmaz, unknown görünür. */
  function placeholderAgent(id: string, cwd: string): ClaudeAgentView {
    return { id, name: id, state: 'unknown', cwd, sessionId: null, startedAt: null, updatedAt: null, detail: null }
  }

  function workClaudeSessions(): Record<string, ClaudeAgentView[]> {
    const result: Record<string, ClaudeAgentView[]> = {}
    const state = store.get()
    for (const work of state.works ?? []) {
      if (!work.claudeSessions?.length) continue
      const project = state.projects.find((p) => p.id === work.projectId)
      if (!project) continue
      const listed = claudeAgents?.cached(project.path)?.agents ?? []
      result[work.id] = work.claudeSessions.map((id) => listed.find((a) => a.id === id) ?? placeholderAgent(id, project.path))
    }
    return result
  }

  const EMPTY_SUMMARY = { title: null, firstPrompt: null, lastPrompt: null, updatedAt: null }

  function conversationView(session: Session, record: ConversationRecord): ConversationView {
    const latest = session.conversations?.at(-1)
    return {
      ...(record.transcriptPath ? transcripts.get(record.transcriptPath) : EMPTY_SUMMARY),
      id: record.id,
      origin: 'terminal',
      sessionId: session.id,
      claudeSessionId: null,
      source: record.source,
      lastSeenAt: record.lastSeenAt,
      transcriptPath: record.transcriptPath,
      cwd: session.cwd,
      current: latest === record && session.lifecycle === 'live' && record.runId === session.runId,
    }
  }

  function transcriptView(entry: TranscriptEntry, origin: 'claude-session' | 'reference', current: boolean): ConversationView {
    return {
      ...transcripts.get(entry.path),
      id: entry.id,
      origin,
      sessionId: null,
      claudeSessionId: entry.job,
      source: null,
      lastSeenAt: entry.mtimeMs,
      transcriptPath: entry.path,
      cwd: entry.cwd,
      current,
    }
  }

  /**
   * Bir işin konuşmaları: terminallerinde görülenler, bağlı Claude
   * oturumlarının zincirleri ve bu işe taşınanlar. Başka bir işe taşınmış
   * konuşma burada görünmez. Aynı konuşma birden çok yoldan gelirse açık
   * olan, yoksa taşınan, yoksa en yeni görülen kalır.
   */
  function workConversations(work: Work, entries: TranscriptEntry[]): ConversationView[] {
    const state = store.get()
    const project = state.projects.find((p) => p.id === work.projectId)
    const movedAway = new Set((state.works ?? []).filter((w) => w.id !== work.id).flatMap((w) => w.conversationRefs ?? []))
    const agents = project ? (claudeAgents?.cached(project.path)?.agents ?? []) : []
    const views: ConversationView[] = []
    for (const session of state.sessions.filter((s) => s.workId === work.id)) {
      for (const record of session.conversations ?? []) views.push(conversationView(session, record))
    }
    for (const job of work.claudeSessions ?? []) {
      const agent = agents.find((a) => a.id === job)
      for (const entry of entries.filter((e) => e.job === job)) views.push(transcriptView(entry, 'claude-session', agent?.sessionId === entry.id))
    }
    for (const id of work.conversationRefs ?? []) {
      const entry = entries.find((e) => e.id === id)
      if (entry) views.push(transcriptView(entry, 'reference', agents.some((a) => a.sessionId === id && a.state === 'working')))
    }
    const rank = (v: ConversationView) => (v.current ? 2 : v.origin === 'reference' ? 1 : 0)
    const byId = new Map<string, ConversationView>()
    for (const view of views) {
      if (view.origin !== 'reference' && movedAway.has(view.id)) continue
      const seen = byId.get(view.id)
      if (!seen || rank(view) > rank(seen) || (rank(view) === rank(seen) && view.lastSeenAt > seen.lastSeenAt)) byId.set(view.id, view)
    }
    return [...byId.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
  }

  const transcriptIndex = options.claudeAgents ? createTranscriptIndex(path.join(options.claudeAgents.claudeDir, 'projects')) : null

  /** Durum görünümü için iş başına konuşma sayısı; yalnız önbellekten okunur, tarama beklenmez. */
  function workConversationCounts(): Record<string, number> {
    const state = store.get()
    const counts: Record<string, number> = {}
    for (const work of state.works ?? []) {
      const project = state.projects.find((p) => p.id === work.projectId)
      const entries = project && transcriptIndex && (work.claudeSessions?.length || work.conversationRefs?.length) ? transcriptIndex.cached(project.path) : []
      const count = workConversations(work, entries).length
      if (count > 0) counts[work.id] = count
    }
    return counts
  }

  /** Oturumların konuşmaları, en yeni önce; aynı konuşma birden çok oturumda görüldüyse en son görüleni kalır. */
  function conversationList(owned: Session[]): ConversationView[] {
    const byId = new Map<string, ConversationView>()
    for (const session of owned) {
      for (const record of session.conversations ?? []) {
        const view = conversationView(session, record)
        const seen = byId.get(view.id)
        if (!seen || seen.lastSeenAt < view.lastSeenAt || (view.current && !seen.current)) byId.set(view.id, view)
      }
    }
    return [...byId.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
  }

  const attentionBySession = new Map<string, { runId: string; attention: TerminalAttention }>()
  const pendingAttention = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>()

  function terminalAttention(sessionId: string, runId: string | null): TerminalAttention | null {
    const entry = attentionBySession.get(sessionId)
    return entry && entry.runId === runId ? entry.attention : null
  }

  function clearTerminalAttention(sessionId: string, runId?: string): void {
    if (runId) {
      const pending = pendingAttention.get(runId)
      if (pending) clearTimeout(pending.timer)
      pendingAttention.delete(runId)
    }
    const current = attentionBySession.get(sessionId)
    if (!current || runId === undefined || current.runId === runId) attentionBySession.delete(sessionId)
  }

  /**
   * Ajan TUI'leri ekranı imleç hareketleriyle yeniden çizer; ham akışın son
   * satırları ekranın son satırları değildir. Bu yüzden karar, çıktı durulduktan
   * sonra headless ekranın son satırlarından verilir. Kesintisiz çıktıda (spinner,
   * akan metin) yeni dikkat açılmaz, yalnız artık görünmeyen dikkat kalkar.
   */
  function scheduleTerminalAttention(sessionId: string, runId: string): void {
    const now = Date.now()
    const pending = pendingAttention.get(runId)
    if (pending) clearTimeout(pending.timer)
    const firstAt = pending?.firstAt ?? now
    const forced = now - firstAt + ATTENTION_QUIET_MS >= ATTENTION_MAX_WAIT_MS
    const timer = setTimeout(() => {
      pendingAttention.delete(runId)
      void evaluateTerminalAttention(sessionId, runId, !forced)
    }, forced ? Math.max(0, firstAt + ATTENTION_MAX_WAIT_MS - now) : ATTENTION_QUIET_MS)
    timer.unref?.()
    pendingAttention.set(runId, { timer, firstAt })
  }

  async function evaluateTerminalAttention(sessionId: string, runId: string, quiet: boolean): Promise<void> {
    if (!sessions.isLive(sessionId, runId)) return
    const screen = await host.preview(runId).catch(() => null)
    // Değerlendirme sürerken yeni çıktı geldiyse karar sıradaki durulmaya kalır.
    if (!sessions.isLive(sessionId, runId) || pendingAttention.has(runId)) return
    const text = screen?.state === 'ready' ? screen.preview.text : (resumeOutputTails.get(runId) ?? '')
    const candidate = terminalAttentionFromText(text)
    const active = terminalAttention(sessionId, runId)
    if (!candidate) {
      if (active) attentionBySession.delete(sessionId)
      return
    }
    // Aynı istem yeniden çizildiğinde veya metni değiştiğinde yeni bir dikkat anı sayılmaz.
    if (active && active.kind === candidate.kind) {
      if (active.message !== candidate.message) attentionBySession.set(sessionId, { runId, attention: { ...candidate, detectedAt: active.detectedAt } })
      return
    }
    if (!quiet) return
    attentionBySession.set(sessionId, { runId, attention: { ...candidate, detectedAt: Date.now() } })
  }

  /** Resume footer'ı parçalı PTY çıktısında bölünebilir; son 8 KiB yeterlidir. */
  const resumeOutputTails = new Map<string, string>()
  const observedResumeCommands = new Map<string, string>()
  const observedResumeTargets = new Map<string, NonNullable<ReturnType<typeof resumeTargetFromTerminalText>>>()

  function rememberResumeTarget(sessionId: string, runId: string, target: NonNullable<ReturnType<typeof resumeTargetFromTerminalText>>): void {
    void store.commit((draft) => {
      const session = draft.sessions.find((entry) => entry.id === sessionId)
      // Eski Run'ın çıktısı yeni Run'ın konuşma hedefini değiştiremez.
      if (!session || session.runId !== runId) return
      session.lastLaunch = { mode: 'resume', cli: target.cli, conversationId: target.conversationId }
      delete session.autoResumeAttempted
    }).catch(() => {
      // Store serviceError'u taşır; canlı PTY sırf hedef kaydedilemedi diye ölmez.
    })
  }

  function persistObservedResumeTarget(sessionId: string, runId: string): void {
    const target = observedResumeTargets.get(runId)
    if (target) rememberResumeTarget(sessionId, runId, target)
  }

  function recordTerminalOutput(sessionId: string, runId: string, chunk: string): void {
    host.feed(runId, chunk)
    const tail = `${resumeOutputTails.get(runId) ?? ''}${chunk}`.slice(-8192)
    resumeOutputTails.set(runId, tail)
    scheduleTerminalAttention(sessionId, runId)
    const target = resumeTargetFromTerminalText(tail)
    if (!target || observedResumeCommands.get(runId) === target.command) return
    observedResumeCommands.set(runId, target.command)
    observedResumeTargets.set(runId, target)
    rememberResumeTarget(sessionId, runId, target)
  }

  /**
   * Run öncesi kullanıcı ortamı taze okunur. Parse/izin hatasında Run başlamaz;
   * çağıran bunu durdurma veya worktree açma gibi yan etkilerden önce yapar.
   */
  function userEnvironment(): Record<string, string> {
    if (options.environmentFile === undefined) return {}
    const read = readUserEnvironment(options.environmentFile)
    if (!read.ok) {
      throw new HttpError(409, 'environment_invalid', `Ortam dosyası kullanılamıyor, Run başlatılmadı: ${read.message}`)
    }
    return read.values
  }

  /** Yeni Run için sıralı ekran modelini açar; PTY doğmadan önce hazırdır. */
  function openTerminal(sessionId: string, runId: string): void {
    clearTerminalAttention(sessionId)
    host.open({
      sessionId,
      runId,
      cols: sessions.DEFAULT_COLS,
      rows: sessions.DEFAULT_ROWS,
      // Sorgu cevabının tek sahibi daemon'daki terminaldir; bu yazım kullanıcı
      // girdisi değildir ve aktiviteyi ilerletmez.
      onReply: (data) => sessions.isLive(sessionId, runId) && sessions.respond(sessionId, data),
      onPause: () => sessions.isLive(sessionId, runId) && sessions.pause(sessionId),
      onResume: () => sessions.isLive(sessionId, runId) && sessions.resume(sessionId),
    })
  }

  /** Bir Run'ın gözlenen çıkışını kalıcı kayda yazar. */
  function recordExit(sessionId: string, exit: sessions.RunExit): void {
    clearTerminalAttention(sessionId, exit.runId)
    persistObservedResumeTarget(sessionId, exit.runId)
    resumeOutputTails.delete(exit.runId)
    observedResumeCommands.delete(exit.runId)
    observedResumeTargets.delete(exit.runId)
    // Çıkışta işlenmiş son çıktı checkpoint'e yazılır; sonra model bırakılır.
    const terminalClosed = host.close(exit.runId)
    const commit = store
      .commit((draft) => {
        const session = draft.sessions.find((s) => s.id === sessionId)
        // Geç gelen çıkış yeni Run'ın kaydına dokunmaz.
        if (!session || session.runId !== exit.runId) return
        session.lifecycle = 'exited'
        session.exitCode = exit.exitCode
        session.exitSignal = exit.exitSignal
        session.endedAt = exit.at
      })
      .catch(() => {
        // Disk hatası serviceError olarak görünür; PTY bu yüzden öldürülmez.
      })
    const completed = Promise.all([commit, terminalClosed]).then(() => undefined)
    pendingExitCommits.set(sessionId, completed)
    void completed.then(() => {
      if (pendingExitCommits.get(sessionId) === completed) pendingExitCommits.delete(sessionId)
    })
  }

  /**
   * Doğrulanmış durdurma + çıkış kaydının diske inmesini bekler. Sonuç
   * verified=false ise çağıran ne yeni Run başlatır ne de silme yapar.
   */
  async function stopVerified(sessionId: string): Promise<{ verified: boolean; reason?: string }> {
    const outcome = await sessions.stop(sessionId)
    await pendingExitCommits.get(sessionId)
    if (!outcome.verified) return { verified: false, reason: outcome.reason }

    // Kayıt hâlâ live diyorsa süreç grubunun gittiği bu anda gözlenmiştir.
    const session = findSession(sessionId)
    if (session && session.lifecycle === 'live') {
      try {
        await store.commit((draft) => {
          const target = draft.sessions.find((s) => s.id === sessionId)
          if (!target || target.lifecycle !== 'live') return
          target.lifecycle = 'exited'
          target.endedAt = Date.now()
        })
      } catch (err) {
        throw new HttpError(
          503,
          'persistence',
          `Durdurma kaydedilemedi: ${(err as Error).message}`,
        )
      }
    }
    return { verified: true }
  }

  /** Aynı common Git dizinindeki worktree mutasyonları sıralanır. */
  async function inRepoQueue<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    return gitQueues.run(await git.commonGitDir(repo), fn)
  }

  /**
   * Create sırasında açtığımız worktree'leri yalnız kendi kaynağımız olduğu,
   * beklenen OID'de durduğu ve içeriği hiç değişmediği doğrulanırsa kaldırır.
   * Aksi halde kaynağı korur ve bunu bildirir.
   */
  async function rollbackWorktrees(
    project: Project,
    cwd: string,
    targets: SessionWorktree[],
  ): Promise<'removed' | 'preserved'> {
    const managedRoot = path.resolve(store.worktreeRoot)
    if (!path.resolve(cwd).startsWith(managedRoot + path.sep)) return 'preserved'
    let outcome: 'removed' | 'preserved' = 'removed'
    for (const target of targets) {
      const repo = path.join(project.path, target.path)
      const worktree = path.join(cwd, target.path)
      const [head, status] = await Promise.all([git.headOid(worktree), git.porcelainStatus(worktree)])
      if (head !== target.baseCommit || status === null || status.length > 0) {
        outcome = 'preserved'
        continue
      }
      try {
        await inRepoQueue(repo, () => git.removeWorktree(repo, worktree))
      } catch {
        outcome = 'preserved'
      }
    }
    pruneEmptyDirs(cwd, targets.map((t) => t.path))
    return outcome
  }

  /**
   * Klasör projesinde izole oturumun hedefleri: alt klasörlerdeki her depo.
   * Eksik tarama veya commit'siz depo varsa hiçbir worktree açılmaz.
   */
  async function folderWorktreeTargets(project: Project): Promise<SessionWorktree[]> {
    const scan = await findSubRepos(project.path)
    if (scan.truncated) {
      throw new HttpError(
        409,
        'scan_incomplete',
        'Alt klasör taraması sınıra ulaştı; tüm depolar bulunamadığı için izole oturum açılmadı. Ortak klasörü seçin.',
      )
    }
    if (scan.repos.length === 0) {
      throw new HttpError(
        400,
        'git_required',
        'Bu klasörde ve alt klasörlerinde Git deposu yok. Oturumu ortak klasörde başlatın.',
      )
    }
    const heads = await Promise.all(scan.repos.map((rel) => git.headOid(path.join(project.path, rel))))
    const missing = scan.repos.filter((_, i) => heads[i] === null)
    if (missing.length > 0) {
      throw new HttpError(
        400,
        'head_missing',
        `Commit'i olmayan depo var: ${missing.join(', ')}. İlk commit sonrası tekrar deneyin veya ortak klasörü seçin.`,
      )
    }
    // Aynı branch bir Git dizininde iki kez açılamaz (ör. biri diğerinin linked worktree'si).
    const gitDirs = await Promise.all(scan.repos.map((rel) => git.commonGitDir(path.join(project.path, rel))))
    const sharing = scan.repos.filter((_, i) => gitDirs.indexOf(gitDirs[i]) !== gitDirs.lastIndexOf(gitDirs[i]))
    if (sharing.length > 0) {
      throw new HttpError(
        400,
        'shared_git_dir',
        `Aynı Git dizinini paylaşan depolar var: ${sharing.join(', ')}. Aynı branch iki kez açılamayacağı için izole oturum açılmadı; ortak klasörü seçin.`,
      )
    }
    return scan.repos.map((rel, i) => ({ path: rel, baseCommit: heads[i] as string }))
  }

  /**
   * Silme onayının bağlandığı içerik durumu. Ortak oturumda dosyalar korunduğu
   * için boştur; izole oturumda her worktree'nin içerik fingerprint'i
   * (ignored dosyalar dahil) yoluyla birlikte toplanır ve bütçe hepsine
   * paylaştırılır. Önceki kısmi silmede veya yerel Git ile kalkmış worktree
   * okunamaz değil yoktur ve özete böyle girer. Bütçe aşımı veya okuma
   * hatasında onay üretilmez; "değişmedi" sonucu çıkarılmaz.
   */
  async function deletionFingerprint(session: Session, budget: Budget): Promise<ContentFingerprint> {
    if (session.isolation === 'shared') return { ok: true, digest: digestOf([]), changedEntries: 0, ignoredEntries: 0 }
    const parts: string[] = []
    let changedEntries = 0
    let ignoredEntries = 0
    for (const rel of worktreePaths(session)) {
      const dir = path.join(session.cwd, rel)
      if (isMissing(dir)) {
        parts.push(`${rel}: (yok)`)
        continue
      }
      const result = await contentFingerprint(dir, budget)
      if (!result.ok) return result
      changedEntries += result.changedEntries
      ignoredEntries += result.ignoredEntries
      parts.push(`${rel}: ${result.digest}`)
    }
    return { ok: true, digest: digestOf(parts), changedEntries, ignoredEntries }
  }

  /** Hedefleri sırayla açar; biri başarısızsa açılmış olanlar geri alınır. */
  async function openWorktrees(project: Project, cwd: string, branch: string, targets: SessionWorktree[]): Promise<void> {
    const opened: SessionWorktree[] = []
    try {
      for (const target of targets) {
        const repo = path.join(project.path, target.path)
        const worktreePath = path.join(cwd, target.path)
        await inRepoQueue(repo, async () => {
          fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
          await git.addWorktree(repo, worktreePath, branch, target.baseCommit)
        })
        opened.push(target)
      }
    } catch (err) {
      const details =
        opened.length > 0
          ? { worktree: (await rollbackWorktrees(project, cwd, opened)) === 'removed' ? 'kaldırıldı' : 'korundu' }
          : undefined
      // Başarısız hedef için açılmış ara klasörlerden boş kalanlar da kaldırılır.
      pruneEmptyDirs(cwd, targets.map((t) => t.path))
      throw new HttpError(500, 'worktree_failed', `Worktree açılamadı: ${(err as Error).message}`, details)
    }
  }

  /**
   * Kart önizlemesi: canlı Run'da sıralı ekran modelinden, canlı olmayanda son
   * checkpoint'ten çıkar. Ekran modeli hazır değilse "hazırlanıyor" denir;
   * uydurma düz çıktı üretilmez.
   */
  async function previewFor(session: Session): Promise<PreviewResult> {
    if (session.runId === null) {
      return { state: 'unavailable', reason: 'Bu oturumda henüz Run çalışmadı' }
    }
    if (sessions.isLive(session.id, session.runId)) return host.preview(session.runId)
    return host.historyPreview(session.id, session.runId)
  }

  app.get('/api/state', async (req, res) => {
    const state = store.get()
    const raw = typeof req.query.previewIds === 'string' ? req.query.previewIds : ''
    const requested = raw.split(',').map((id) => id.trim()).filter((id) => id !== '')
    if (requested.length > MAX_PREVIEW_IDS) {
      return jsonError(res, 400, 'validation', `Bir istekte en çok ${MAX_PREVIEW_IDS} kart önizlemesi istenebilir`)
    }

    const previews: Record<string, PreviewResult> = {}
    for (const id of requested) {
      const session = state.sessions.find((s) => s.id === id)
      previews[id] = session
        ? await previewFor(session)
        : { state: 'unavailable', reason: 'Oturum kaydı yok' }
    }

    res.json({
      protocolVersion: PROTOCOL_VERSION,
      daemonId,
      revision: store.revision(),
      serverNow: Date.now(),
      projects: state.projects.map(projectView),
      // Kalıcı lifecycle canlılık tahminiyle ezilmez; kayıt tek doğrudur.
      sessions: state.sessions.map(sessionView),
      works: state.works ?? [],
      claudeSessions: workClaudeSessions(),
      workConversationCounts: workConversationCounts(),
      conversationTracking,
      previews,
      terminals: Object.fromEntries(state.sessions.filter((s) => s.runId).map((s) => [s.id, {
        failure: host.failure(s.runId!),
        checkpoint: host.checkpointStatus(s.runId!),
        outputPressure: host.outputPressure(s.runId!),
      }])),
      serviceError: store.serviceError(),
    })
  })

  app.get('/api/orphan-worktrees', (_req, res) => {
    const known = new Set(store.get().sessions.map((s) => s.cwd))
    res.json(scanOrphanWorktrees(store.worktreeRoot, known))
  })

  // Claude hesapları (ADR 0017). Yanıtlar token taşımaz.
  const claudeAccounts = options.claudeAccounts
    ? openClaudeAccounts(path.join(options.dataDir, 'claude-accounts.json'), options.claudeAccounts.live)
    : null
  let claudeLogin: ClaudeLogin | null = null

  const accountRoute = (handler: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
    if (!claudeAccounts) return jsonError(res, 404, 'unsupported', 'Hesap geçişi bu daemon için açık değil')
    try {
      res.json(handler(req) ?? {})
    } catch (err) {
      if (err instanceof AccountError) {
        return jsonError(res, err.code === 'not_found' ? 404 : err.code === 'unreadable' ? 500 : 409, err.code, err.message)
      }
      sendError(res, err)
    }
  }

  app.get('/api/claude-accounts', (req, res) => {
    if (!claudeAccounts) return res.json({ supported: false, accounts: [], unsaved: null, login: null })
    accountRoute(() => ({ supported: true, ...claudeAccounts.list(), login: claudeLogin?.view() ?? null }))(req, res)
  })
  app.post('/api/claude-accounts/save-live', accountRoute(() => ({ account: claudeAccounts!.saveLive() })))
  app.post('/api/claude-accounts/:id/activate', accountRoute((req) => ({ account: claudeAccounts!.activate(String(req.params.id)) })))
  app.delete('/api/claude-accounts/:id', accountRoute((req) => claudeAccounts!.remove(String(req.params.id))))
  app.post('/api/claude-accounts/login', accountRoute(() => {
    if (claudeLogin?.view().state === 'running') throw new HttpError(409, 'login_running', 'Süren bir giriş var')
    claudeLogin = startClaudeLogin({
      dataDir: options.dataDir,
      command: options.claudeAccounts!.command ?? 'claude',
      env: runEnv(process.env, { sessionId: 'claude-login', runId: 'claude-login' }, userEnvironment()),
      onSuccess: (source) => {
        // Hesap eklenince mevcut hesap da listeye girer; ikisi arasında hemen geçilebilir.
        try {
          claudeAccounts!.saveLive()
        } catch (err) {
          if (!(err instanceof AccountError)) throw err
        }
        return claudeAccounts!.importFrom(source)
      },
    })
    return { login: claudeLogin.view() }
  }))
  app.post('/api/claude-accounts/login/input', accountRoute((req) => {
    const text = req.body?.text
    if (typeof text !== 'string' || text.length > 4096) throw new HttpError(400, 'validation', 'Girdi metni gerekli')
    claudeLogin?.input(text)
  }))
  app.post('/api/claude-accounts/login/cancel', accountRoute(() => claudeLogin?.cancel()))

  app.post('/api/projects', async (req, res) => {
    const raw = String(req.body?.path ?? '').trim()
    if (!raw) return jsonError(res, 400, 'validation', 'Klasör yolu gerekli')

    const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw
    let dir: string
    try {
      // Alias'ların aynı Project'e çözülmesi için gerçek yol kullanılır.
      dir = fs.realpathSync(path.resolve(expanded))
      if (!fs.statSync(dir).isDirectory()) throw new Error('dizin değil')
    } catch {
      return jsonError(res, 400, 'validation', 'Klasör bulunamadı')
    }

    if (await git.isBare(dir)) {
      return jsonError(res, 400, 'validation', 'Bare depo Project olamaz: çalışma kopyası yok')
    }
    const gitRoot = await git.repoRoot(dir)
    const root = gitRoot ? fs.realpathSync(gitRoot) : dir

    const managedRoot = path.resolve(store.worktreeRoot)
    const resolvedRoot = path.resolve(root)
    if (resolvedRoot === managedRoot || resolvedRoot.startsWith(managedRoot + path.sep)) {
      return jsonError(res, 400, 'validation', "AgentDeck'in kendi çalışma kopyası Project olarak eklenemez")
    }

    const existing = store.get().projects.find((p) => p.path === root)
    if (existing) {
      return jsonError(res, 409, 'existing_project', 'Bu proje zaten ekli', { existingProjectId: existing.id })
    }

    const project: Project = {
      kind: gitRoot ? 'git' : 'folder',
      id: crypto.randomBytes(8).toString('hex'),
      name: path.basename(root),
      path: root,
      createdAt: Date.now(),
    }
    try {
      await store.commit((draft) => {
        draft.projects.push(project)
      })
    } catch (err) {
      return jsonError(res, 503, 'persistence', `Proje kaydedilemedi: ${(err as Error).message}`)
    }
    res.json(project)
  })

  app.post('/api/sessions', async (req, res) => {
    const requestId = readRequestId(req.body?.requestId)
    if (typeof requestId !== 'string') return jsonError(res, 400, 'validation', requestId.error)

    const payload = {
      projectId: req.body?.projectId ?? null,
      name: req.body?.name ?? null,
      command: req.body?.command === undefined ? undefined : req.body.command,
      isolation: req.body?.isolation ?? null,
      workId: req.body?.workId ?? null,
    }

    try {
      const session = await createLedger.run(requestId, payload, async () => {
        const project = store.get().projects.find((p) => p.id === payload.projectId)
        if (!project) throw new HttpError(404, 'not_found', 'Proje yok')
        if (projectsBeingDeleted.has(project.id)) {
          throw new HttpError(409, 'operation_in_progress', 'Proje silinirken yeni oturum açılmaz')
        }
        const workId = readWorkId(payload.workId, project.id)

        if (payload.command === undefined) {
          throw new HttpError(400, 'validation', 'command alanı gerekli (null = kabuk)')
        }
        const command = readCommand(payload.command)
        if (command !== null && typeof command === 'object') throw new HttpError(400, 'validation', command.error)
        const program = command as string | null

        const isolation = payload.isolation
        if (!ISOLATIONS.includes(isolation as Isolation)) {
          throw new HttpError(400, 'validation', `Geçersiz izolasyon: ${String(isolation)}`)
        }

        const state = store.get()
        if (state.sessions.length >= MAX_SESSIONS) {
          throw new HttpError(
            409,
            'capacity',
            `Kayıt sınırı ${MAX_SESSIONS} dolu; arşivler dahil hiçbir kayıt silinmedi`,
          )
        }
        if (sessions.liveCount() >= MAX_LIVE_RUNS) {
          throw new HttpError(409, 'capacity', `Canlı Run sınırı ${MAX_LIVE_RUNS} dolu`)
        }

        // Kimlik rastgele 128 bit; kullanıcı adı yol veya kimlik değildir.
        const sid = crypto.randomBytes(16).toString('hex')
        // İşteki terminal adı boş bırakılırsa işin adını alır; sonraki terminaller numaralanır ("Çeviri 2").
        const work = workId ? findWork(workId) : undefined
        const siblings = work ? store.get().sessions.filter((s) => s.workId === work.id && s.archivedAt === null).length : 0
        const workName = work ? (siblings > 0 ? `${work.name} ${siblings + 1}` : work.name) : undefined
        const name = readName(typeof payload.name === 'string' && payload.name.trim() === '' && workName ? workName : payload.name, program, sid)
        if (typeof name === 'object') throw new HttpError(400, 'validation', name.error)
        const userEnv = userEnvironment()

        let cwd = project.path
        let branch: string | null = null
        let baseCommit: string | null = null
        // Git projesinde kökün kendisi, klasör projesinde her alt depo aynı
        // göreli yolda worktree olur.
        let targets: SessionWorktree[] = []

        if (isolation === 'worktree') {
          if (project.kind === 'folder') {
            targets = await folderWorktreeTargets(project)
          } else {
            const base = await git.headOid(project.path)
            if (!base) {
              throw new HttpError(
                400,
                'head_missing',
                'Projede commit yok: worktree oturumu açılamaz. İlk commit sonrası tekrar deneyin veya ortak çalışma kopyasını seçin.',
              )
            }
            baseCommit = base
            targets = [{ path: '.', baseCommit: base }]
          }
          branch = `agentdeck/${slugify(name)}-${sid}`
          cwd = path.join(store.worktreeRoot, project.id, sid)
          await openWorktrees(project, cwd, branch, targets)
        }

        const runId = crypto.randomBytes(16).toString('hex')
        openTerminal(sid, runId)
        try {
          sessions.spawn({
            sessionId: sid,
            runId,
            command: program,
            cwd,
            userEnv,
            hookDir,
            onData: (chunk) => recordTerminalOutput(sid, runId, chunk),
            onExit: (exit) => recordExit(sid, exit),
          })
        } catch (err) {
          // Kayda girmemiş Run'ın görüntüsü atılır; önceki kayıtlara dokunulmaz.
          await host.discard(sid, runId)
          const detail: Record<string, unknown> = { cwd }
          if (isolation === 'worktree') {
            detail.worktree = (await rollbackWorktrees(project, cwd, targets)) === 'removed' ? 'kaldırıldı' : 'korundu'
          }
          throw new HttpError(500, 'spawn_failed', `Oturum başlatılamadı: ${(err as Error).message}`, detail)
        }

        // live yalnız yeni PTY doğduktan sonra kayda girer.
        const session: Session = {
          id: sid,
          projectId: project.id,
          name,
          command: program,
          isolation: isolation as Isolation,
          cwd,
          branch,
          baseCommit,
          worktrees: project.kind === 'folder' ? targets : [],
          lifecycle: 'live',
          exitCode: null,
          exitSignal: null,
          createdAt: Date.now(),
          endedAt: null,
          runId,
          archivedAt: null,
          lastLaunch: { mode: 'command', command: program },
          ...(workId ? { workId } : {}),
        }

        try {
          await store.commit((draft) => {
            // İş bu arada kaldırıldıysa oturum işsiz açılır.
            if (session.workId && !(draft.works ?? []).some((w) => w.id === session.workId)) delete session.workId
            draft.sessions.push(session)
          })
        } catch (err) {
          // PTY doğdu ama kayıt yazılamadı: yalnız kendi grubumuz durdurulur.
          await sessions.stop(sid)
          await host.discard(sid, runId)
          const detail: Record<string, unknown> = { cwd }
          if (isolation === 'worktree') {
            detail.worktree = (await rollbackWorktrees(project, cwd, targets)) === 'removed' ? 'kaldırıldı' : 'korundu'
          }
          throw new HttpError(503, 'persistence', `Oturum kaydedilemedi: ${(err as Error).message}`, detail)
        }
        persistObservedResumeTarget(sid, runId)
        await host.publish(sid, runId)
        return session
      })
      // Yanıt kalıcı kayıttan okunur: Run bu arada çıkmışsa görünüm bunu söyler.
      res.json(sessionView(findSession(session.id) ?? session))
    } catch (err) {
      sendError(res, err)
    }
  })

  /** null/undefined işsiz demektir; iş aynı projeye ait olmalıdır. */
  function readWorkId(raw: unknown, projectId: string): string | null {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string') throw new HttpError(400, 'validation', 'workId string veya null olmalı')
    const found = findWork(raw)
    if (!found) throw new HttpError(404, 'not_found', 'İş yok')
    if (found.projectId !== projectId) throw new HttpError(400, 'validation', 'İş başka bir projeye ait')
    return found.id
  }

  function readWorkName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim() === '') throw new HttpError(400, 'validation', 'İş adı gerekli')
    const name = raw.trim().replace(/\s+/g, ' ')
    if (name.length > WORK_NAME_MAX) throw new HttpError(400, 'validation', `İş adı en çok ${WORK_NAME_MAX} karakter olabilir`)
    return name
  }

  app.post('/api/works', async (req, res) => {
    try {
      const project = store.get().projects.find((p) => p.id === req.body?.projectId)
      if (!project) throw new HttpError(404, 'not_found', 'Proje yok')
      if (projectsBeingDeleted.has(project.id)) throw new HttpError(409, 'operation_in_progress', 'Proje silinirken iş açılmaz')
      const work: Work = { id: crypto.randomBytes(16).toString('hex'), projectId: project.id, name: readWorkName(req.body?.name), createdAt: Date.now() }
      await store.commit((draft) => {
        if (!draft.projects.some((p) => p.id === project.id)) throw new HttpError(404, 'not_found', 'Proje yok')
        draft.works = [...(draft.works ?? []), work]
      })
      res.json(work)
    } catch (err) {
      sendError(res, err)
    }
  })

  app.patch('/api/works/:id', async (req, res) => {
    try {
      const name = readWorkName(req.body?.name)
      if (!findWork(req.params.id)) throw new HttpError(404, 'not_found', 'İş yok')
      await store.commit((draft) => {
        const target = (draft.works ?? []).find((w) => w.id === req.params.id)
        if (target) target.name = name
      })
      res.json(findWork(req.params.id))
    } catch (err) {
      sendError(res, err)
    }
  })

  /** İş kaydını kaldırır; oturumlar, dosyalar ve konuşmalar yerinde kalır, yalnız işsiz olur. */
  /** İşin bütün oturumlarını tek onaya bağlar; proje silmedeki önizlemenin aynısıdır. */
  app.post('/api/works/:id/delete-preview', async (req, res) => {
    try {
      const work = findWork(req.params.id)
      if (!work) throw new HttpError(404, 'not_found', 'İş yok')
      const group = await previewSessionGroup(store.get().sessions.filter((s) => s.workId === work.id))
      const confirmationToken = crypto.randomBytes(24).toString('hex')
      groupConfirmations.set(confirmationToken, { owner: `work:${work.id}`, expiresAt: group.expiresAt, sessions: group.sessions })
      res.json({ confirmationToken, expiresInMs: CONFIRMATION_TTL_MS, workId: work.id, sessions: group.view, keepsBranches: true })
    } catch (err) {
      sendError(res, err)
    }
  })

  /**
   * İş, oturumlarıyla birlikte silinir: terminaller durur, izole çalışma
   * kopyaları kalkar, branch'ler ve ortak klasör dosyaları korunur. Bağlı
   * Claude arka plan oturumları Claude'a aittir; yalnız bağları kalkar.
   */
  app.delete('/api/works/:id', async (req, res) => {
    try {
      const work = findWork(req.params.id)
      if (!work) throw new HttpError(404, 'not_found', 'İş yok')
      const owned = store.get().sessions.filter((s) => s.workId === work.id)
      const confirmation = owned.length > 0
        ? takeGroupConfirmation((req.body ?? {}).confirmationToken, `work:${work.id}`, owned, 'work_has_sessions', 'İşte oturum kayıtları var; önce silme önizlemesi alın')
        : undefined
      await deleteSessionGroup(owned, confirmation, 'work_delete_partial', 'İş ve kalan oturumlar korunur.')
      await store.commit((draft) => {
        draft.works = (draft.works ?? []).filter((w) => w.id !== work.id)
        // Onaydan sonra açılmış bir oturum silinmez; işsiz kalır.
        for (const session of draft.sessions) if (session.workId === work.id) delete session.workId
      })
      res.json({ ok: true })
    } catch (err) {
      sendError(res, err)
    }
  })


  /** Transcript özetleri en çok bu kadar beklenir; yetişmeyen özet sonraki istekte gelir. */
  async function conversationsOf(owned: Session[]): Promise<ConversationView[]> {
    const files = owned.flatMap((s) => (s.conversations ?? []).flatMap((c) => (c.transcriptPath ? [c.transcriptPath] : [])))
    await transcripts.settle(files, 1500)
    return conversationList(owned)
  }

  /** Projenin (alt klasörleri dahil) Claude arka plan oturumları; hangi işe bağlı oldukları ile. */
  app.get('/api/projects/:id/claude-sessions', async (req, res) => {
    const project = store.get().projects.find((p) => p.id === req.params.id)
    if (!project) return jsonError(res, 404, 'not_found', 'Proje yok')
    if (!claudeAgents) return res.json({ supported: false, error: null, sessions: [] })
    const listed = await claudeAgents.list(project.path)
    const owner = new Map<string, string>()
    for (const work of store.get().works ?? []) for (const id of work.claudeSessions ?? []) owner.set(id, work.id)
    res.json({
      supported: true,
      error: listed.error,
      sessions: listed.agents
        .map((agent) => ({ ...agent, workId: owner.get(agent.id) ?? null }))
        .sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0)),
    })
  })

  /** Claude oturumu tek bir işe bağlıdır: başka işteyse oradan alınır. */
  app.post('/api/works/:id/claude-sessions', async (req, res) => {
    try {
      const work = findWork(req.params.id)
      if (!work) throw new HttpError(404, 'not_found', 'İş yok')
      const ids: unknown = req.body?.ids
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every(isClaudeAgentId)) {
        throw new HttpError(400, 'validation', 'ids 1-50 Claude oturum kimliği (8 hex) olmalı')
      }
      await store.commit((draft) => {
        for (const other of draft.works ?? []) {
          if (other.id !== work.id && other.claudeSessions) other.claudeSessions = other.claudeSessions.filter((id) => !ids.includes(id))
        }
        const target = (draft.works ?? []).find((w) => w.id === work.id)
        if (target) target.claudeSessions = [...new Set([...(target.claudeSessions ?? []), ...ids])]
      })
      res.json(findWork(work.id))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.delete('/api/works/:id/claude-sessions/:sessionId', async (req, res) => {
    try {
      if (!findWork(req.params.id)) throw new HttpError(404, 'not_found', 'İş yok')
      await store.commit((draft) => {
        const target = (draft.works ?? []).find((w) => w.id === req.params.id)
        if (target?.claudeSessions) target.claudeSessions = target.claudeSessions.filter((id) => id !== req.params.sessionId)
      })
      res.json(findWork(req.params.id))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.get('/api/works/:id/conversations', async (req, res) => {
    const work = findWork(req.params.id)
    if (!work) return jsonError(res, 404, 'not_found', 'İş yok')
    const project = store.get().projects.find((p) => p.id === work.projectId)
    const entries = project && transcriptIndex ? await transcriptIndex.list(project.path) : []
    if (project && claudeAgents && work.claudeSessions?.length) await claudeAgents.list(project.path)
    const first = workConversations(work, entries)
    await transcripts.settle(first.flatMap((c) => (c.transcriptPath ? [c.transcriptPath] : [])), 1500)
    res.json({ conversations: workConversations(work, entries) })
  })

  /**
   * Konuşmayı bu işe taşır: yalnız AgentDeck kaydı değişir, Claude dosyası
   * yerinde kalır. Konuşma başka bir işe taşınmışsa oradan alınır.
   */
  app.post('/api/works/:id/conversation-refs', async (req, res) => {
    try {
      const work = findWork(req.params.id)
      if (!work) throw new HttpError(404, 'not_found', 'İş yok')
      const project = store.get().projects.find((p) => p.id === work.projectId)
      if (!project || !transcriptIndex) throw new HttpError(409, 'unsupported', 'Bu daemon Claude konuşmalarını okumuyor')
      const ids: unknown = req.body?.ids
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((id) => typeof id === 'string' && uuid.test(id))) {
        throw new HttpError(400, 'validation', 'ids 1-100 konuşma kimliği (UUID) olmalı')
      }
      const entries = await transcriptIndex.list(project.path)
      const missing = ids.filter((id) => !entries.some((e) => e.id === id))
      if (missing.length > 0) throw new HttpError(404, 'not_found', `Projede bulunmayan konuşma: ${missing.join(', ')}`)
      await store.commit((draft) => {
        for (const other of draft.works ?? []) {
          if (other.id !== work.id && other.conversationRefs) other.conversationRefs = other.conversationRefs.filter((id) => !ids.includes(id))
        }
        const target = (draft.works ?? []).find((w) => w.id === work.id)
        if (target) target.conversationRefs = [...new Set([...(target.conversationRefs ?? []), ...(ids as string[])])]
      })
      res.json(findWork(work.id))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.delete('/api/works/:id/conversation-refs/:conversationId', async (req, res) => {
    try {
      if (!findWork(req.params.id)) throw new HttpError(404, 'not_found', 'İş yok')
      await store.commit((draft) => {
        const target = (draft.works ?? []).find((w) => w.id === req.params.id)
        if (target?.conversationRefs) target.conversationRefs = target.conversationRefs.filter((id) => id !== req.params.conversationId)
      })
      res.json(findWork(req.params.id))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.get('/api/sessions/:id/conversations', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
    res.json({ conversations: await conversationsOf([session]) })
  })

  /** Oturumu bir işe bağlar veya işten çıkarır; Run ve dosyalar etkilenmez. */
  app.post('/api/sessions/:id/work', async (req, res) => {
    try {
      const session = findSession(req.params.id)
      if (!session) throw new HttpError(404, 'not_found', 'Oturum yok')
      const workId = readWorkId(req.body?.workId, session.projectId)
      await store.commit((draft) => {
        const target = draft.sessions.find((s) => s.id === session.id)
        if (!target) return
        if (workId && (draft.works ?? []).some((w) => w.id === workId)) target.workId = workId
        else delete target.workId
      })
      res.json(sessionView(findSession(session.id) as Session))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.post('/api/sessions/:id/stop', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      if (req.body?.expectedRunId !== undefined && req.body.expectedRunId !== session.runId) {
        return jsonError(res, 409, 'stale_run', 'Beklenen Run artık geçerli değil; görünüm tazelendi', {
          currentRunId: session.runId,
        })
      }
      const outcome = await stopVerified(session.id)
      if (!outcome.verified) {
        return jsonError(
          res,
          409,
          'stop_unverified',
          'Süreç grubunun durduğu doğrulanamadı; oturum canlı sayılmaya devam ediyor',
          { reason: outcome.reason },
        )
      }
      res.json(sessionView(findSession(session.id) as Session))
    } catch (err) {
      sendError(res, err)
    } finally {
      held.release()
    }
  })

  /**
   * Arşiv çalışma kaydını aktif taramadan kaldırır; worktree, branch ve terminal
   * görüntülerine dokunmaz. Canlı iş yalnız açık stopIfLive isteğiyle ve
   * doğrulanmış durdurmayla kapanır.
   */
  app.post('/api/sessions/:id/archive', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
    const stopIfLive = req.body?.stopIfLive ?? false
    if (typeof stopIfLive !== 'boolean') return jsonError(res, 400, 'validation', 'stopIfLive true/false olmalı')

    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      if (req.body?.expectedRunId !== undefined && req.body.expectedRunId !== session.runId) {
        return jsonError(res, 409, 'stale_run', 'Beklenen Run artık geçerli değil; görünüm tazelendi', {
          currentRunId: session.runId,
        })
      }
      const running =
        session.lifecycle === 'live' || sessions.isLive(session.id) || sessions.hasLingeringGroup(session.id)
      if (running) {
        if (!stopIfLive) {
          return jsonError(res, 409, 'live_requires_stop', 'Canlı oturum arşivlenmeden önce durdurulmalı; "Durdur ve arşivle" seçin')
        }
        const stopped = await stopVerified(session.id)
        if (!stopped.verified) {
          return jsonError(res, 409, 'stop_unverified', 'Süreç grubunun durduğu doğrulanamadı; oturum arşivlenmedi', {
            reason: stopped.reason,
          })
        }
      }
      try {
        await store.commit((draft) => {
          const target = draft.sessions.find((s) => s.id === session.id)
          if (target && target.archivedAt === null) target.archivedAt = Date.now()
        })
      } catch (err) {
        return jsonError(res, 503, 'persistence', `Arşiv kaydedilemedi: ${(err as Error).message}`)
      }
      res.json(sessionView(findSession(session.id) as Session))
    } finally {
      held.release()
    }
  })

  /** Arşivden çıkarma yalnız kaydı aktif taramaya döndürür; Run başlatmaz, dosyalara dokunmaz. */
  app.post('/api/sessions/:id/unarchive', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      await store.commit((draft) => {
        const target = draft.sessions.find((s) => s.id === session.id)
        if (target) target.archivedAt = null
      })
      res.json(sessionView(findSession(session.id) as Session))
    } catch (err) {
      jsonError(res, 503, 'persistence', `Arşivden çıkarma kaydedilemedi: ${(err as Error).message}`)
    } finally {
      held.release()
    }
  })

  /** Yeni PTY doğurur ve yalnız kalıcı kayıt başarıyla yazılırsa canlı olarak yayımlar. */
  async function startRun(
    current: Session,
    command: string | null,
    userEnv: Record<string, string>,
    lastLaunch: LastLaunch,
    autoResumeAttempted = false,
  ): Promise<Session> {
    // cwd eksikse yeni Run yok: dizin yaratma veya shared fallback yok.
    if (dirIdentityOf(current.cwd) === null) {
      throw new HttpError(400, 'cwd_missing', `Çalışma dizini yok: ${current.cwd}`)
    }

    const runId = crypto.randomBytes(16).toString('hex')
    openTerminal(current.id, runId)
    try {
      sessions.spawn({
        sessionId: current.id,
        runId,
        command,
        cwd: current.cwd,
        userEnv,
        hookDir,
        onData: (chunk) => recordTerminalOutput(current.id, runId, chunk),
        onExit: (exit) => recordExit(current.id, exit),
      })
    } catch (err) {
      await host.discard(current.id, runId)
      throw new HttpError(500, 'spawn_failed', `Run başlatılamadı: ${(err as Error).message}`)
    }

    try {
      await store.commit((draft) => {
        const target = draft.sessions.find((s) => s.id === current.id)
        if (!target) throw new HttpError(404, 'not_found', 'Oturum yok')
        target.lifecycle = 'live'
        target.runId = runId
        target.exitCode = null
        target.exitSignal = null
        target.endedAt = null
        target.lastLaunch = lastLaunch
        if (autoResumeAttempted) target.autoResumeAttempted = true
        else delete target.autoResumeAttempted
      })
    } catch (err) {
      await sessions.stop(current.id)
      await host.discard(current.id, runId)
      if (err instanceof HttpError) throw err
      throw new HttpError(503, 'persistence', `Yeni Run kaydedilemedi: ${(err as Error).message}`)
    }
    // PTY çok hızlı footer yazdıysa, artık kalıcı Run kimliğiyle ilişkilendirilebilir.
    persistObservedResumeTarget(current.id, runId)
    // Yeni Run kayda girdi: saklama sınırı ancak şimdi eski kayıtları budar.
    await host.publish(current.id, runId)
    return findSession(current.id) as Session
  }

  /**
   * Mevcut çalışma kopyasında yeni Run. Canlı iş önce doğrulanmış biçimde
   * durdurulur; cwd yoksa yeni Run açılmaz. Başarılı Run lastLaunch'a yazılır,
   * başlangıç Command'ı değişmez. Spawn veya commit başarısızsa önceki niyet korunur.
   */
  async function relaunch(
    req: express.Request,
    res: express.Response,
    requestId: string,
    payload: Record<string, unknown>,
    commandFor: (current: Session) => string | null | undefined,
    intentFor: (current: Session, command: string | null) => LastLaunch,
  ): Promise<void> {
    const existing = findSession(String(req.params.id))
    if (!existing) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const held = sessionLocks.tryAcquire(existing.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      const session = await launchLedger.run(
        requestId,
        { sessionId: existing.id, expectedRunId: req.body?.expectedRunId ?? null, ...payload },
        async () => {
          const current = findSession(existing.id)
          if (!current) throw new HttpError(404, 'not_found', 'Oturum yok')
          // Arşivdeki oturum aktif taramada görünmez; orada sessizce canlanmaz.
          if (current.archivedAt !== null) {
            throw new HttpError(409, 'session_archived', 'Oturum arşivde; yeni Run için önce arşivden çıkarın')
          }
          if (req.body?.expectedRunId !== undefined && req.body.expectedRunId !== current.runId) {
            throw new HttpError(409, 'stale_run', 'Beklenen Run artık geçerli değil; görünüm tazelendi', {
              currentRunId: current.runId,
            })
          }
          const command = commandFor(current)
          if (command === undefined) {
            throw new HttpError(400, 'launch_unavailable', 'Önceki başlatma niyeti desteklenmiyor; bu çalışma kopyasında komutu açıkça seçin')
          }
          // Bozuk ortam dosyası canlı işi durdurmadan reddedilir.
          const userEnv = userEnvironment()

          const stopped = await stopVerified(current.id)
          if (!stopped.verified) {
            throw new HttpError(409, 'stop_unverified', 'Canlı iş durdurulamadı; yeni Run başlatılmadı', {
              reason: stopped.reason,
            })
          }

          return startRun(current, command, userEnv, intentFor(current, command))
        },
      )
      res.json(sessionView(findSession(session.id) ?? session))
    } catch (err) {
      sendError(res, err)
    } finally {
      held.release()
    }
  }

  /** Checkpoint'teki doğrulanmış footer, eski Run'a aitse yalnız o Run'ın hedefini günceller. */
  async function backfillResumeTargetsFromCheckpoints(): Promise<void> {
    const candidates = store.get().sessions.filter((session) =>
      session.archivedAt === null && session.runId !== null && session.lastLaunch?.mode !== 'resume',
    )
    const limiter = createLimiter(2)
    await Promise.all(candidates.map((session) => limiter.run(async () => {
      const runId = session.runId as string
      const saved = await checkpoints.read(session.id, runId)
      if (saved.state !== 'ready') return
      const target = resumeTargetFromTerminalText(saved.checkpoint.text)
      if (!target) return
      await store.commit((draft) => {
        const current = draft.sessions.find((entry) => entry.id === session.id)
        if (!current || current.runId !== runId) return
        current.lastLaunch = { mode: 'resume', cli: target.cli, conversationId: target.conversationId }
        delete current.autoResumeAttempted
      })
    }).catch((err) => {
      console.warn(`[agentdeck] terminal geçmişinden resume hedefi okunamadı (${session.id}): ${(err as Error).message}`)
    })))
  }

  /** Hedef yazılmadan önce işaretlenir; spawn/env hatası sonraki açılışta döngü oluşturmaz. */
  async function markAutoResumeAttempted(session: Session): Promise<void> {
    await store.commit((draft) => {
      const current = draft.sessions.find((entry) => entry.id === session.id)
      if (!current || current.runId !== session.runId) return
      current.autoResumeAttempted = true
    })
  }

  /**
   * Kesilmiş canlı Run'lar ile checkpoint'ten açık konuşma kimliği bulunan eski
   * Run'lar yeni PTY olarak geri açılır. Genel komutlar ve kimliği olmayan
   * bitmiş işler aday değildir.
   */
  async function restoreResumableSession(sessionId: string, interrupted: ReadonlySet<string>): Promise<void> {
    const held = sessionLocks.tryAcquire(sessionId)
    if (!held) return
    try {
      const current = findSession(sessionId)
      if (!current || current.archivedAt !== null || current.runId === null || current.lifecycle === 'live') return
      const hasInterruptedRun = interrupted.has(current.id)
      const hasSavedResume = current.lastLaunch?.mode === 'resume' && current.autoResumeAttempted !== true
      if (!hasInterruptedRun && !hasSavedResume) return

      const recovery = recoveryLaunch(sessionView(current))
      if (!recovery) return
      if (sessions.liveCount() >= MAX_LIVE_RUNS) {
        console.warn(`[agentdeck] otomatik geri açma atlandı (canlı Run sınırı): ${current.id}`)
        return
      }

      const nextLastLaunch = current.lastLaunch?.mode === 'resume' && recovery.mode === 'command'
        ? current.lastLaunch
        : lastLaunchFor(recovery.mode, recovery.command)
      if (!nextLastLaunch) return
      await markAutoResumeAttempted(current)
      await startRun(current, recovery.command, userEnvironment(), nextLastLaunch, true)
    } catch (err) {
      // İşaret kalıcıdır: açılış hatası aynı eski hedefi yeniden çalıştırmaz.
      console.warn(`[agentdeck] oturum otomatik geri açılamadı (${sessionId}): ${(err as Error).message}`)
    } finally {
      held.release()
    }
  }

  async function restoreResumableSessions(): Promise<void> {
    await backfillResumeTargetsFromCheckpoints()
    const interrupted = new Set(store.interruptedSessionIds())
    const candidates = new Set([
      ...interrupted,
      ...store.get().sessions
        .filter((session) => session.archivedAt === null && session.lastLaunch?.mode === 'resume' && session.autoResumeAttempted !== true)
        .map((session) => session.id),
    ])
    if (candidates.size === 0) return
    const limiter = createLimiter(STARTUP_RESTORE_CONCURRENCY)
    await Promise.all([...candidates].map((id) => limiter.run(() => restoreResumableSession(id, interrupted))))
  }

  app.post('/api/sessions/:id/restart', async (req, res) => {
    const requestId = readRequestId(req.body?.requestId)
    if (typeof requestId !== 'string') return jsonError(res, 400, 'validation', requestId.error)
    // lastLaunch niyeti tekrarlanır. UUID üretilmez: fresh literal CLI,
    // picker seçici komutu. V0 resume kaydı yazmaz; varsa legacy kayıt tekrarlanır.
    await relaunch(req, res, requestId, {}, repeatLaunchCommand, (current, command) => {
      const last = current.lastLaunch
      if (last?.mode === 'fresh') return { ...last, conversationId: null }
      if (last && last.mode !== 'command') return last
      return { mode: 'command', command }
    })
  })

  const LAUNCH_FIELDS = new Set(['requestId', 'expectedRunId', 'mode', 'command'])

  app.post('/api/sessions/:id/launch', async (req, res) => {
    const requestId = readRequestId(req.body?.requestId)
    if (typeof requestId !== 'string') return jsonError(res, 400, 'validation', requestId.error)
    const body = (req.body ?? {}) as Record<string, unknown>
    if (body.mode === 'resume') {
      return jsonError(
        res,
        400,
        'mode_unsupported',
        "Yönetilen konuşma eylemleri G2 kabul testi geçmeden kapalı; CLI'ın kendi seçicisini komut olarak çalıştırın (ör. claude --resume)",
      )
    }
    if (body.mode !== 'command' && body.mode !== 'fresh' && body.mode !== 'picker') {
      return jsonError(res, 400, 'validation', 'mode command, fresh veya picker olmalı')
    }
    const extra = Object.keys(body).filter((key) => !LAUNCH_FIELDS.has(key))
    if (extra.length > 0) return jsonError(res, 400, 'validation', `Bu modda izinli olmayan alan: ${extra.join(', ')}`)
    if (!('command' in body)) return jsonError(res, 400, 'validation', 'command alanı gerekli (null = kabuk)')
    const command = readCommand(body.command)
    if (command !== null && typeof command === 'object') return jsonError(res, 400, 'validation', command.error)
    const program = command as string | null
    const intent = lastLaunchFor(body.mode, program)
    if (!intent) {
      return jsonError(
        res,
        400,
        'validation',
        body.mode === 'fresh'
          ? 'fresh yalnız argümansız literal claude, gemini veya codex kabul eder'
          : "picker yalnız CLI'ın kendi seçicisidir (ör. claude --resume)",
      )
    }

    await relaunch(req, res, requestId, { mode: body.mode, command: program }, () => program, () => intent)
  })

  /** Saklanmış görüntüsü olan önceki Run'lar; salt okunur inceleme WS'te runId ile açılır. */
  app.get('/api/sessions/:id/runs', (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
    // Launch sürerken kayda girmemiş Run'ın görüntüsü önceki Run gibi listelenmez.
    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    held.release()
    res.json({
      currentRunId: session.runId,
      previous: host.listRuns(session.id).filter((run) => run.runId !== session.runId),
    })
  })

  app.post('/api/sessions/:id/delete-preview', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const dirIdentity = dirIdentityOf(session.cwd)
    if (dirIdentity === null) {
      return jsonError(res, 409, 'cwd_missing', `Çalışma dizini okunamıyor: ${session.cwd}`, { cwd: session.cwd })
    }
    const fingerprint = await deletionFingerprint(session, createBudget())
    if (!fingerprint.ok) {
      // Bütçenin bypass/force yolu yoktur; kullanıcı dosyaları yerel araçla temizler.
      return jsonError(
        res,
        409,
        fingerprint.reason === 'budget' ? 'preview_budget_exceeded' : 'status_unreadable',
        `Klasör büyük veya okunamıyor (${fingerprint.message}); dosyaları yerel araçla inceleyip temizleyin, ardından tekrar deneyin: ${session.cwd}`,
        { cwd: session.cwd, reason: fingerprint.message },
      )
    }

    const confirmationToken = crypto.randomBytes(24).toString('hex')
    confirmations.set(confirmationToken, {
      sessionId: session.id,
      runId: session.runId,
      cwd: session.cwd,
      dirIdentity,
      contentDigest: fingerprint.digest,
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    })

    res.json({
      confirmationToken,
      expiresInMs: CONFIRMATION_TTL_MS,
      cwd: session.cwd,
      branch: session.branch,
      isolation: session.isolation,
      changedEntries: fingerprint.changedEntries,
      ignoredEntries: fingerprint.ignoredEntries,
      // Ortak klasörde dosyalar korunur; içerik okunmaz, yalnız dizin kimliği bağlanır.
      fingerprintScope: session.isolation === 'shared' ? 'dir-identity' : 'content',
      keepsBranch: true,
    })
  })

  /*
   * Silme üç adımdır ve çağıran Session kilidini tutar: onayın Run'ı kapsadığı
   * denetlenir, süreç grubu doğrulanmış biçimde durdurulur, içerik yeniden
   * okunup onayla karşılaştırılır; ancak sonra dosyalar ve kayıt kaldırılır.
   */

  /** Onaydan sonra yeni bir Run başladıysa onay onu kapsamaz; yeni Run durdurulmaz. */
  function assertConfirmedRun(session: Session, confirmation: Confirmation): void {
    if (confirmation.runId !== session.runId) {
      throw new HttpError(409, 'confirmation_stale', 'Onaydan sonra yeni bir Run başladı; yeniden önizleme alın', {
        currentRunId: session.runId,
      })
    }
  }

  async function stopForDeletion(session: Session): Promise<void> {
    const stopped = await stopVerified(session.id)
    if (!stopped.verified) {
      throw new HttpError(409, 'stop_unverified', 'Süreç grubu durdurulamadı; silme başlatılmadı', {
        reason: stopped.reason,
      })
    }
  }

  /**
   * Durdurmadan sonra dizin kimliği ve içerik fingerprint'i yeniden okunur. Ortak
   * klasörde dosyalar silinmediği için yalnız dizin kimliği bağlanır. Bütçe,
   * proje silmede bütün oturumların yeniden okumasına paylaştırılır.
   */
  async function verifyDeletionConfirmation(session: Session, confirmation: Confirmation, budget: Budget): Promise<void> {
    const dirIdentity = dirIdentityOf(session.cwd)
    const fingerprint = await deletionFingerprint(session, budget)
    if (dirIdentity === null || !fingerprint.ok) {
      throw new HttpError(409, 'confirmation_stale', 'Çalışma kopyası artık okunamıyor veya bütçeyi aşıyor; silme yapılmadı', {
        cwd: session.cwd,
      })
    }
    if (dirIdentity !== confirmation.dirIdentity || fingerprint.digest !== confirmation.contentDigest) {
      throw new HttpError(409, 'confirmation_stale', 'Klasör içeriği onaydan sonra değişti; silme yapılmadı', {
        cwd: session.cwd,
      })
    }
  }

  /**
   * Doğrulanmış oturumun worktree'lerini ve kaydını kaldırır. rmSync fallback
   * yoktur: bir worktree kaldırılamazsa kaldırılanlar kayıttan düşer, kalan
   * worktree'ler, dosyaları ve kayıt korunur.
   */
  async function removeVerifiedSession(session: Session): Promise<void> {
    if (session.isolation === 'worktree') {
      const project = store.get().projects.find((p) => p.id === session.projectId)
      if (!project) {
        throw new HttpError(409, 'project_missing', 'Projenin kaydı yok; worktree güvenle kaldırılamaz')
      }
      const rels = worktreePaths(session)
      const removed: string[] = []
      for (const rel of rels) {
        const repo = path.join(project.path, rel)
        const worktree = path.join(session.cwd, rel)
        try {
          // Önceki kısmi silmede veya yerel Git ile kalkmış worktree için iş yoktur.
          if (!isMissing(worktree)) await inRepoQueue(repo, () => git.removeWorktree(repo, worktree))
          removed.push(rel)
        } catch (err) {
          let recordUpdated = true
          if (removed.length > 0) {
            await store
              .commit((draft) => {
                const target = draft.sessions.find((s) => s.id === session.id)
                if (target) target.worktrees = target.worktrees.filter((w) => !removed.includes(w.path))
              })
              .catch(() => {
                // Kaldırılan yollar kayıtta kalsa da yeniden denemede "yok" olarak atlanır.
                recordUpdated = false
              })
          }
          throw new HttpError(
            500,
            'worktree_remove_failed',
            removed.length === 0
              ? `Worktree kaldırılamadı; hiçbir dosya silinmedi: ${(err as Error).message}`
              : `${rel} worktree'si kaldırılamadı; ${removed.join(', ')} kaldırıldı, kalanlar korundu${recordUpdated ? '' : ' (kayıt güncellenemedi)'}: ${(err as Error).message}`,
            {
              cwd: session.cwd,
              removed,
              degraded: !recordUpdated,
              recovery: 'Klasörü yerel araçla inceleyip git worktree remove ile tekrar deneyin',
            },
          )
        }
      }
      pruneEmptyDirs(session.cwd, rels)
    }

    try {
      await store.commit((draft) => {
        draft.sessions = draft.sessions.filter((s) => s.id !== session.id)
      })
    } catch (err) {
      // Worktree kaldırıldı ama kayıt yazılamadı: kayıt korunur, kısmi sonuç görünür.
      throw new HttpError(
        503,
        'persistence',
        `${session.isolation === 'shared' ? 'Dosyalar korundu fakat oturum kaydı kaldırılamadı' : 'Dosyalar kaldırıldı ama kayıt güncellenemedi'}: ${(err as Error).message}`,
        { cwd: session.cwd, degraded: true },
      )
    }
    // Session silindi: ona ait terminal checkpoint'leri de kalkar.
    host.removeSession(session.id)
  }

  app.delete('/api/sessions/:id', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    // V0'da branch silme yoktur; eski istemciden gelirse sessizce yok sayılmaz.
    if ('deleteBranch' in body || req.query.deleteBranch !== undefined) {
      return jsonError(res, 400, 'unsupported_field', 'Branch silme V0 kapsamında değil; branch korunur')
    }
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const confirmationToken = body.confirmationToken
    if (typeof confirmationToken !== 'string') {
      return jsonError(res, 400, 'validation', 'confirmationToken gerekli; önce delete-preview çağrılır')
    }
    const confirmation = confirmations.get(confirmationToken)
    if (!confirmation || confirmation.sessionId !== session.id) {
      return jsonError(res, 409, 'confirmation_unknown', 'Onay bulunamadı; yeniden önizleme alın')
    }
    if (confirmation.expiresAt < Date.now()) {
      confirmations.delete(confirmationToken)
      return jsonError(res, 409, 'confirmation_stale', 'Onay süresi doldu; yeniden önizleme alın')
    }
    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      assertConfirmedRun(session, confirmation)
      await stopForDeletion(session)
      await verifyDeletionConfirmation(session, confirmation, createBudget())
      await removeVerifiedSession(session)
      confirmations.delete(confirmationToken)
      res.json({ ok: true, branchKept: session.branch })
    } catch (err) {
      // Eskimiş onay yeniden kullanılamaz; durdurma veya worktree hatasında aynı onayla yeniden denenebilir.
      if (err instanceof HttpError && err.code === 'confirmation_stale') confirmations.delete(confirmationToken)
      sendError(res, err)
    } finally {
      held.release()
    }
  })

  /**
   * Proje silme önizlemesi bütün oturumları tek onaya bağlar. Bütçe oturumlar
   * arasında paylaşılır: sınır oturum sayısıyla gizlice aşılmaz, aşımda
   * oturumları tek tek temizlemek önerilir.
   */
  /**
   * Bir oturum kümesini (projenin veya işin bütün oturumları) tek onaya bağlar;
   * içerik bütçesi oturumlar arasında paylaşılır.
   */
  async function previewSessionGroup(owned: Session[]): Promise<{ sessions: Map<string, Confirmation>; expiresAt: number; view: object[] }> {
    const budget = createBudget()
    const reads: { session: Session; dirIdentity: string; fingerprint: Extract<ContentFingerprint, { ok: true }> }[] = []
    for (const session of owned) {
      const dirIdentity = dirIdentityOf(session.cwd)
      if (dirIdentity === null) {
        throw new HttpError(
          409,
          'cwd_missing',
          `"${session.name}" oturumunun çalışma dizini okunamıyor; oturumu tek tek inceleyip silin: ${session.cwd}`,
          { sessionId: session.id, cwd: session.cwd },
        )
      }
      const fingerprint = await deletionFingerprint(session, budget)
      if (!fingerprint.ok) {
        throw new HttpError(
          409,
          fingerprint.reason === 'budget' ? 'preview_budget_exceeded' : 'status_unreadable',
          `Çalışma kopyaları birlikte büyük veya okunamıyor (${fingerprint.message}); oturumları tek tek temizleyip silin, ardından tekrar deneyin: ${session.cwd}`,
          { sessionId: session.id, cwd: session.cwd, reason: fingerprint.message },
        )
      }
      reads.push({ session, dirIdentity, fingerprint })
    }
    const expiresAt = Date.now() + CONFIRMATION_TTL_MS
    return {
      expiresAt,
      sessions: new Map(
        reads.map(({ session, dirIdentity, fingerprint }) => [
          session.id,
          { sessionId: session.id, runId: session.runId, cwd: session.cwd, dirIdentity, contentDigest: fingerprint.digest, expiresAt },
        ]),
      ),
      view: reads.map(({ session, fingerprint }) => ({
        id: session.id,
        name: session.name,
        cwd: session.cwd,
        branch: session.branch,
        isolation: session.isolation,
        changedEntries: fingerprint.changedEntries,
        ignoredEntries: fingerprint.ignoredEntries,
      })),
    }
  }

  /** Tek kullanımlık küme onayını tüketir; küme önizlemeden sonra değiştiyse onay düşer. */
  function takeGroupConfirmation(token: unknown, owner: string, owned: Session[], hasSessionsCode: string, hasSessionsMessage: string): GroupConfirmation {
    if (typeof token !== 'string') {
      // Gizli cascade yok: oturumu olan küme yalnız kendi onayıyla silinir.
      throw new HttpError(409, hasSessionsCode, hasSessionsMessage, { sessionIds: owned.map((s) => s.id) })
    }
    const confirmation = groupConfirmations.get(token)
    if (!confirmation || confirmation.owner !== owner) throw new HttpError(409, 'confirmation_unknown', 'Onay bulunamadı; yeniden önizleme alın')
    // Onay tek kullanımlıktır; her deneme taze bir önizlemeyle başlar.
    groupConfirmations.delete(token)
    if (confirmation.expiresAt < Date.now()) throw new HttpError(409, 'confirmation_stale', 'Onay süresi doldu; yeniden önizleme alın')
    const covered = [...confirmation.sessions.keys()].sort().join(',')
    if (covered !== owned.map((s) => s.id).sort().join(',')) {
      throw new HttpError(409, 'confirmation_stale', 'Onaydan sonra oturumlar değişti; yeniden önizleme alın')
    }
    return confirmation
  }

  /**
   * Onaylı oturum kümesini siler. Bütün kilitler önce alınır; biri meşgulse
   * hiçbir şey durdurulmaz. Silme ilk hatada durur ve kısmi sonuç bildirilir.
   */
  async function deleteSessionGroup(owned: Session[], confirmation: GroupConfirmation | undefined, partialCode: string, keeps: string): Promise<string[]> {
    const held: HeldLock[] = []
    try {
      if (confirmation) {
        const confirmed = (session: Session) => confirmation.sessions.get(session.id) as Confirmation
        for (const session of owned) {
          const lock = sessionLocks.tryAcquire(session.id)
          if (!lock) {
            throw new HttpError(409, 'operation_in_progress', `"${session.name}" oturumunda başka bir işlem sürüyor; hiçbir şey silinmedi`)
          }
          held.push(lock)
        }
        for (const session of owned) assertConfirmedRun(session, confirmed(session))
        for (const session of owned) await stopForDeletion(session)
        // Durdurmadan sonra içerik tek bütçeyle yeniden okunur; sınır oturum sayısıyla aşılmaz.
        const budget = createBudget()
        for (const session of owned) await verifyDeletionConfirmation(session, confirmed(session), budget)
      }
      const removed: string[] = []
      for (const session of owned) {
        try {
          await removeVerifiedSession(session)
        } catch (err) {
          if (!(err instanceof HttpError) || removed.length === 0) throw err
          throw new HttpError(
            err.status,
            partialCode,
            `${removed.length} oturum silindi; "${session.name}" silinemedi: ${err.message}. ${keeps}`,
            {
              cause: err.code,
              sessionId: session.id,
              removedSessionIds: removed,
              remainingSessionIds: owned.map((s) => s.id).filter((id) => !removed.includes(id)),
              details: err.details,
            },
          )
        }
        removed.push(session.id)
      }
      return removed
    } finally {
      for (const lock of held) lock.release()
    }
  }

  app.post('/api/projects/:id/delete-preview', async (req, res) => {
    try {
      const project = store.get().projects.find((p) => p.id === req.params.id)
      if (!project) throw new HttpError(404, 'not_found', 'Proje yok')
      const group = await previewSessionGroup(store.get().sessions.filter((s) => s.projectId === project.id))
      const confirmationToken = crypto.randomBytes(24).toString('hex')
      groupConfirmations.set(confirmationToken, { owner: `project:${project.id}`, expiresAt: group.expiresAt, sessions: group.sessions })
      res.json({ confirmationToken, expiresInMs: CONFIRMATION_TTL_MS, projectId: project.id, sessions: group.view, keepsBranches: true })
    } catch (err) {
      sendError(res, err)
    }
  })

  app.delete('/api/projects/:id', async (req, res) => {
    const project = store.get().projects.find((p) => p.id === req.params.id)
    if (!project) return jsonError(res, 404, 'not_found', 'Proje yok')

    const owned = store.get().sessions.filter((s) => s.projectId === project.id)
    projectsBeingDeleted.add(project.id)
    try {
      const confirmation = owned.length > 0
        ? takeGroupConfirmation((req.body ?? {}).confirmationToken, `project:${project.id}`, owned, 'project_has_sessions', 'Projede oturum kayıtları var; önce silme önizlemesi alın')
        : undefined
      const removed = await deleteSessionGroup(owned, confirmation, 'project_delete_partial', 'Proje ve kalan oturumlar korunur.')
      try {
        await store.commit((draft) => {
          draft.projects = draft.projects.filter((p) => p.id !== project.id)
          if (draft.works) draft.works = draft.works.filter((w) => w.projectId !== project.id)
        })
      } catch (err) {
        throw new HttpError(503, 'persistence', `Proje kaydı silinemedi: ${(err as Error).message}`, {
          removedSessionIds: removed,
        })
      }
      res.json({ ok: true })
    } catch (err) {
      sendError(res, err)
    } finally {
      projectsBeingDeleted.delete(project.id)
    }
  })

  /**
   * Korunan branch'ler: agentdeck/ ref adları ve tip OID'leri. Branch'i
   * gösteren kayıt yoksa görev bilgisi uydurulmaz; Git hatası boş listeyle
   * karıştırılmaz. Klasör projesinde her alt depo ayrı okunur.
   */
  /**
   * Worktree preset'i HEAD yoksa açıklamayla kapanır; bu okuma oluşturmaz.
   * Klasör projesinde alt depo HEAD'i oturum açılışında bakılır.
   */
  app.get('/api/projects/:id/head', async (req, res) => {
    const project = store.get().projects.find((p) => p.id === req.params.id)
    if (!project) return jsonError(res, 404, 'not_found', 'Proje yok')
    if (project.kind === 'folder') {
      res.json({ kind: 'folder', hasHead: null })
      return
    }
    const oid = await git.headOid(project.path)
    res.json({ kind: 'git', hasHead: oid !== null })
  })

  app.get('/api/projects/:id/branches', async (req, res) => {
    const project = store.get().projects.find((p) => p.id === req.params.id)
    if (!project) return jsonError(res, 404, 'not_found', 'Proje yok')
    const scan = project.kind === 'folder' ? await findSubRepos(project.path) : { repos: ['.'], truncated: false }
    const sessionByBranch = new Map(
      store
        .get()
        .sessions.filter((s) => s.projectId === project.id && s.branch !== null)
        .map((s) => [s.branch as string, s.id]),
    )
    // 1000 ref sınırı projedeki bütün depolar içindir.
    let remaining = MAX_BRANCH_REFS
    const repos = []
    for (const rel of scan.repos) {
      const read = await gitReadSlots.run(() => git.agentdeckBranches(path.join(project.path, rel), remaining))
      remaining = Math.max(0, remaining - read.branches.length)
      repos.push({
        path: rel,
        branches: read.branches.map((b) => ({ ...b, sessionId: sessionByBranch.get(b.name) ?? null })),
        truncated: read.truncated,
        error: read.error,
      })
    }
    res.json({ repos, truncated: scan.truncated })
  })

  async function workspaceRepos(session: Session) {
    const project = store.get().projects.find(p => p.id === session.projectId)
    if (dirIdentityOf(session.cwd) === null) throw new HttpError(409, 'cwd_missing', 'Çalışma klasörü erişilemiyor')
    return project?.kind === 'folder'
      ? findSubRepos(session.cwd)
      : { repos: (await git.repoRoot(session.cwd)) ? ['.'] : [], truncated: false }
  }

  const workspaceGitCache = new Map<string, { at: number; read: ReturnType<typeof readGitWorkspace> }>()
  app.get('/api/sessions/:id/git', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
    try {
      const scan = await workspaceRepos(session)
      const repos = []
      for (const rel of scan.repos) {
        const cwd = path.join(session.cwd, rel)
        const key = `${cwd}:${req.query.branches === '1'}`
        let cached = workspaceGitCache.get(key)
        if (!cached || Date.now() - cached.at >= 2000) {
          if (workspaceGitCache.size >= 128) workspaceGitCache.clear()
          cached = { at: Date.now(), read: gitReadSlots.run(() => readGitWorkspace(cwd, req.query.branches === '1')) }
          workspaceGitCache.set(key, cached)
        }
        const current = await cached.read
        repos.push({ ...current, path: rel })
      }
      res.json({ repos, truncated: scan.truncated })
    } catch (error) { jsonError(res, 409, 'git_read_failed', (error as Error).message) }
  })

  app.post('/api/sessions/:id/git/switch', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
    const body = req.body ?? {}
    if (typeof body.repo !== 'string' || typeof body.branch !== 'string' || body.branch.length > 255 || typeof body.create !== 'boolean' ||
        !(body.expectedHead === null || typeof body.expectedHead === 'string') || !(body.expectedBranch === null || typeof body.expectedBranch === 'string') ||
        Object.keys(body).some(key => !['repo', 'branch', 'create', 'expectedHead', 'expectedBranch', 'expectedRunId'].includes(key))) {
      return jsonError(res, 400, 'validation', 'Branch isteği geçersiz')
    }
    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      if (body.expectedRunId !== session.runId) throw new Error('Oturum yeniden başladı; görünümü yenileyin')
      if (projectsBeingDeleted.has(session.projectId)) throw new Error('Proje kaldırılıyor; branch değiştirilemez')
      const scan = await workspaceRepos(session)
      if (!scan.repos.includes(body.repo)) throw new Error('Depo bu çalışma alanına ait değil')
      const cwd = path.join(session.cwd, body.repo)
      const current = await gitQueues.run(await git.commonGitDir(cwd), () => switchWorkspaceBranch(cwd, body))
      workspaceGitCache.clear()
      res.json({ ...current, path: body.repo })
    } catch (error) { jsonError(res, 409, 'git_switch_failed', (error as Error).message) }
    finally { held.release() }
  })

  app.get('/api/sessions/:id/diff', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
    const rawScope = req.query.scope
    if (rawScope !== undefined && rawScope !== 'work' && rawScope !== 'uncommitted') {
      return jsonError(res, 400, 'validation', 'scope work veya uncommitted olmalı')
    }
    // Worktree'de varsayılan "Bu çalışma"dır; ortak kopya commit edilmemiş farkla
    // açılır ve bir ajana atfedilmez.
    const scope: DiffScope = rawScope ?? (session.isolation === 'worktree' ? 'work' : 'uncommitted')
    if (dirIdentityOf(session.cwd) === null) {
      return jsonError(res, 409, 'cwd_missing', `Çalışma dizini yok: ${session.cwd}`)
    }
    const project = store.get().projects.find((p) => p.id === session.projectId)
    // Git projesinde çalışma dizini tek depodur; klasör projesinde alt klasörlerdeki
    // depolar ayrı ayrı incelenir. Depo yoksa temiz diff gibi gösterilmez.
    const scan =
      project?.kind === 'folder'
        ? await findSubRepos(session.cwd)
        : { repos: (await git.repoRoot(session.cwd)) ? ['.'] : [], truncated: false }
    if (scan.repos.length === 0) {
      return jsonError(
        res, 409, 'git_required',
        project?.kind !== 'folder'
          ? 'Bu klasörde Git diff kullanılamıyor.'
          : scan.truncated
            ? 'Alt klasör taraması sınıra ulaştı ve depo bulunamadı; liste eksik olabilir.'
            : 'Bu klasörde ve alt klasörlerinde Git deposu bulunamadı; diff gösterilemiyor.',
        { truncated: scan.truncated },
      )
    }
    const capturedAt = Date.now()
    const repos: RepoDiff[] = []
    // Her depo birkaç git süreci açar; depolar sırayla okunur.
    for (const rel of scan.repos) {
      const dir = path.join(session.cwd, rel)
      const baseCommit = baseCommitFor(session, rel)
      const branch = await git.currentBranch(dir)
      if (scope === 'work' && baseCommit === null) {
        // Base bilinmiyorsa hareketli HEAD/main ile sessiz ikame yapılmaz.
        repos.push({
          path: rel,
          branch,
          baseCommit,
          diff: '',
          status: '',
          patchTruncated: false,
          statusTruncated: false,
          stale: false,
          error:
            session.isolation === 'shared'
              ? 'Ortak çalışma kopyasının başlangıç commit\'i yoktur; "Commit edilmemiş" görünümünü kullanın.'
              : 'Bu deponun başlangıç commit\'i bilinmiyor; toplam görünüm kapalı.',
        })
        continue
      }
      const read = await gitReadSlots.run(() => git.diff(dir, scope === 'work' ? (baseCommit as string) : 'HEAD'))
      repos.push({ path: rel, branch, baseCommit, ...read })
    }
    res.json({ scope, capturedAt, repos, truncated: scan.truncated })
  })

  if (options.serveWeb) {
    // Yalnızca derlenmiş çıktıyı servis et; ham kaynağı servis etmemeliyiz.
    const webDist = path.join(__dirname, '..', 'web')
    if (fs.existsSync(path.join(webDist, 'index.html'))) {
      app.use(express.static(webDist))
      app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
    }
  }

  const server = http.createServer(app)
  // Frame tavanı sunucuda uygulanır; aşan istemci frame'i kabul edilmez.
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: WS_INPUT_WIRE_BYTES,
    verifyClient: ({ req }: { req: http.IncomingMessage }) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      return originOk(req.headers.origin) && url.searchParams.get('token') === token
    },
  })
  const controls = new Map<string, { owner: object | null; generation: number; viewers: Map<object, () => void> }>()
  let listening = false

  // HTTP sunucusunun hatası ws tarafına da yansır. Burada tutulmazsa 'error'
  // olayı yakalanmamış istisnaya dönüşüp daemon'ı çökertir; başlatma hatası
  // zaten listen reddiyle bildirilir.
  wss.on('error', (err) => {
    if (!listening) return
    console.error(`[agentdeck] ws sunucu hatası: ${err.message}`)
  })

  /**
   * Terminal protokolü (spec §4). Replay tek parça gönderilmez: replay-start,
   * sıralı replay-chunk'lar ve replay-end. İstemci reset'i yalnız
   * replay-start'ta yapar; input replay-end'den önce açılmaz.
   */
  wss.on('connection', (ws, req) => {
    // Origin ve token upgrade öncesi verifyClient'ta doğrulandı.
    const url = new URL(req.url ?? '', 'http://localhost')

    /** Yavaş izleyici üreticiyi bekletmez; kuyruğu şişerse ayrılır. */
    function sendJson(payload: unknown): boolean {
      if (ws.readyState !== ws.OPEN) return false
      if (ws.bufferedAmount > WS_VIEWER_QUEUE_BYTES) {
        ws.close(1013, 'izleyici yetişemiyor')
        return false
      }
      ws.send(JSON.stringify(payload))
      return true
    }

    /** Chunk metni 32 KiB, JSON zarfı 256 KiB; kaçış genişlemesi hesaba katılır. */
    function wireChunks(text: string): string[] {
      let budget = WS_CHUNK_TEXT_BYTES
      while (budget > 1024) {
        const parts = chunkText(text, budget)
        const envelope = (part: string) =>
          Buffer.byteLength(JSON.stringify({ type: 'replay-chunk', snapshotId: 'x'.repeat(32), index: 0, text: part }))
        if (parts.every((part) => envelope(part) <= WS_ENVELOPE_BYTES)) return parts
        budget = Math.floor(budget / 2)
      }
      return chunkText(text, 1024)
    }

    async function sendReplay(input: {
      sessionId: string
      runId: string
      text: string
      scope: SnapshotScope
      sequence: number
      cols: number
      rows: number
      formatVersion: number
      mode: 'live' | 'inspect'
    }): Promise<boolean> {
      const totalBytes = Buffer.byteLength(input.text)
      if (totalBytes > WS_REPLAY_MAX_BYTES) {
        sendJson({ type: 'terminal-error', message: `Terminal görüntüsü ${WS_REPLAY_MAX_BYTES} bayt tavanını aştı` })
        return false
      }
      const snapshotId = crypto.randomBytes(16).toString('hex')
      const chunks = wireChunks(input.text)
      if (
        !sendJson({
          type: 'replay-start',
          snapshotId,
          daemonId,
          sessionId: input.sessionId,
          runId: input.runId,
          sequence: input.sequence,
          cols: input.cols,
          rows: input.rows,
          formatVersion: input.formatVersion,
          scope: input.scope,
          mode: input.mode,
          totalBytes,
        })
      ) {
        return false
      }
      for (let index = 0; index < chunks.length; index++) {
        if (ws.readyState !== ws.OPEN) return false
        const sent = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { ws.close(1013, 'izleyici yetişemiyor'); resolve(false) }, 10000)
          ws.send(JSON.stringify({ type: 'replay-chunk', snapshotId, index, text: chunks[index] }), (err) => {
            clearTimeout(timer)
            resolve(!err)
          })
        })
        if (!sent) return false
      }
      return sendJson({ type: 'replay-end', snapshotId, chunkCount: chunks.length })
    }

    const sessionId = url.searchParams.get('session')
    const session = sessionId ? findSession(sessionId) : undefined
    if (!session || !sessionId) {
      sendJson({ type: 'error', code: 'not_found', message: 'Oturum kaydı yok' })
      ws.close(1008, 'oturum yok')
      return
    }

    const requestedRun = url.searchParams.get('run')
    const liveRunId = sessions.currentRunId(sessionId)
    const live = liveRunId !== null && (requestedRun === null || requestedRun === liveRunId)

    if (!live) {
      // Salt okunur inceleme: istenen Run kimliğiyle yetkilendirilir ve yalnız
      // saklanmış görüntüyü açar. Sahte ekran kurulmaz.
      const runId = requestedRun ?? session.runId
      if (runId === null) {
        sendJson({ type: 'history-missing', message: 'Bu oturumda henüz Run çalışmadı' })
        ws.close(1000, 'geçmiş yok')
        return
      }
      if (!isCheckpointId(runId)) {
        sendJson({ type: 'error', code: 'validation', message: 'Run kimliği geçersiz' })
        ws.close(1008, 'geçersiz Run kimliği')
        return
      }
      void host
        .history(sessionId, runId)
        .then(async (stored) => {
          if (stored.state === 'missing') {
            sendJson({ type: 'history-missing', message: 'Bu Run için saklanmış terminal görüntüsü yok' })
          } else if (stored.state === 'unreadable') {
            sendJson({ type: 'history-unreadable', message: `Saklanmış görüntü okunamadı: ${stored.reason}` })
          } else {
            const checkpoint = stored.checkpoint
            await sendReplay({
              sessionId,
              runId,
              text: checkpoint.text,
              scope: checkpoint.scope,
              sequence: checkpoint.sequence,
              cols: checkpoint.cols,
              rows: checkpoint.rows,
              formatVersion: checkpoint.formatVersion,
              mode: 'inspect',
            })
            sendJson({
              type: 'run-ended',
              runId,
              exitCode: runId === session.runId ? session.exitCode : null,
              capturedAt: checkpoint.capturedAt,
            })
          }
          ws.close(1000, 'inceleme bitti')
        })
        .catch((err: Error) => {
          sendJson({ type: 'history-unreadable', message: err.message })
          ws.close(1011, 'geçmiş okunamadı')
        })
      return
    }

    const runId = liveRunId as string
    let control = controls.get(runId)
    if (!control) {
      control = { owner: ws, generation: 1, viewers: new Map() }
      controls.set(runId, control)
    }
    const lease = control
    // vacant: kontrolün sahibi yok; almak kimseyi düşürmez. Sahipten almak yine açık eylemdir.
    const notifyControl = () =>
      sendJson({ type: 'control', owned: lease.owner === ws, generation: lease.generation, vacant: lease.owner === null })
    lease.viewers.set(ws, notifyControl)
    let inputOpen = false
    let replaying = false
    const attachment = host.attach(runId, (event: TerminalEvent) => {
      switch (event.type) {
        case 'output':
          sendJson({ type: 'output', sequence: event.sequence, text: event.text })
          return
        case 'resize':
          sendJson({ type: 'resize', sequence: event.sequence, cols: event.cols, rows: event.rows })
          return
        case 'failure':
          // Temsil hatasında input kapanır; PTY öldürülmez, stop erişilebilir kalır.
          inputOpen = false
          sendJson({ type: 'terminal-error', message: event.failure.message })
          return
        case 'pressure':
          sendJson({ type: 'output-pressure', active: event.active })
          return
        case 'overflow':
          ws.close(1013, 'izleyici yetişemiyor')
          return
        case 'ended':
          inputOpen = false
          sendJson({ type: 'run-ended', runId, exitCode: findSession(sessionId)?.exitCode ?? null })
          return
      }
    })
    if (!attachment) {
      sendJson({ type: 'error', code: 'not_live', message: 'Canlı Run yok' })
      ws.close(1000, 'canlı Run yok')
      return
    }

    /** Katman isteği: varsayılan yalnız ekran, scrollback açık istekle gelir. */
    async function replayLayer(scope: SnapshotScope): Promise<void> {
      if (replaying) return
      replaying = true
      inputOpen = false
      try {
        const replay = await attachment!.snapshot(scope)
        const ok = await sendReplay({
          sessionId: sessionId as string,
          runId,
          text: replay.snapshot.text,
          scope: replay.snapshot.scope,
          sequence: replay.sequence,
          cols: replay.snapshot.cols,
          rows: replay.snapshot.rows,
          formatVersion: replay.snapshot.formatVersion,
          mode: 'live',
        })
        attachment!.resume()
        if (ok && sessions.isLive(sessionId as string, runId) && !host.failure(runId)) inputOpen = true
        notifyControl()
        if (host.outputPressure(runId)) sendJson({ type: 'output-pressure', active: true })
      } catch (err) {
        inputOpen = false
        sendJson({ type: 'terminal-error', message: (err as Error).message })
      } finally {
        replaying = false
      }
    }

    const requestedScope: SnapshotScope = url.searchParams.get('scope') === 'scrollback' ? 'scrollback' : 'screen'
    void replayLayer(requestedScope)

    ws.on('message', (raw) => {
      let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown; generation?: unknown }
      try {
        const parsed: unknown = JSON.parse(raw.toString())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        msg = parsed as typeof msg
      } catch {
        return
      }

      if (msg.type === 'take-control' && inputOpen && sessions.isLive(sessionId as string, runId)) {
        lease.owner = ws
        lease.generation += 1
        for (const notify of lease.viewers.values()) notify()
        return
      }

      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (!inputOpen || lease.owner !== ws || msg.generation !== lease.generation || !sessions.isLive(sessionId as string, runId)) return
        if (Buffer.byteLength(msg.data) > WS_INPUT_TEXT_BYTES) {
          sendJson({ type: 'error', code: 'input_too_large', message: 'Girdi parçası 64 KiB tavanını aşıyor' })
          return
        }
        clearTerminalAttention(sessionId as string, runId)
        sessions.write(sessionId as string, msg.data)
        return
      }

      if (msg.type === 'resize' && typeof msg.cols === 'number' && Number.isFinite(msg.cols) && typeof msg.rows === 'number' && Number.isFinite(msg.rows)) {
        if (!inputOpen || lease.owner !== ws || msg.generation !== lease.generation || !sessions.isLive(sessionId as string, runId)) return
        // Önce sıralı ekran modeline, sonra PTY'ye uygulanır (spec §4).
        void host.resize(runId, msg.cols, msg.rows).then((applied) => {
          if (applied && sessions.isLive(sessionId as string, runId)) sessions.resize(sessionId as string, applied.cols, applied.rows)
        })
        return
      }

      if (msg.type === 'request-scrollback') {
        void replayLayer('scrollback')
      }
    })

    let pongTimer: NodeJS.Timeout | null = null
    const pingTimer = setInterval(() => {
      ws.ping()
      pongTimer = setTimeout(() => ws.terminate(), 10000)
    }, 15000)
    ws.on('pong', () => { if (pongTimer) clearTimeout(pongTimer) })
    ws.on('error', () => ws.close())
    ws.on('close', () => {
      clearInterval(pingTimer)
      if (pongTimer) clearTimeout(pongTimer)
      attachment.close()
      lease.viewers.delete(ws)
      if (lease.owner === ws) {
        lease.owner = null
        lease.generation += 1
        for (const notify of lease.viewers.values()) notify()
      }
      if (lease.viewers.size === 0) controls.delete(runId)
    })
  })

  let port: number
  try {
    port = await new Promise<number>((resolve, reject) => {
      // Port başkasındaysa yabancı süreç öldürülmez; yalnız başlatma başarısız olur.
      server.once('error', reject)
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        listening = true
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : (options.port ?? 0))
      })
    })
  } catch (err) {
    // Kilit ve kanca izleyicisi sızdırılmaz: açılamayan daemon veri dizinini tutmaya devam etmez.
    inbox.close()
    await lock.release()
    throw err
  }

  // Açılışta salt okunur yetim keşfi: hiçbir şey silinmez veya sahiplenilmez.
  const scan = scanOrphanWorktrees(store.worktreeRoot, new Set(store.get().sessions.map((s) => s.cwd)))
  if (scan.entries.length > 0 || scan.truncated || scan.unreadable.length > 0) {
    console.warn(
      `[agentdeck] kayıtsız çalışma kopyası: ${scan.entries.length}` +
        (scan.truncated ? ' (tarama kesik: liste eksik)' : '') +
        (scan.unreadable.length > 0 ? ` (okunamayan dizin: ${scan.unreadable.length})` : ''),
    )
  }

  await restoreResumableSessions()

  let closed: Promise<void> | null = null
  return {
    port,
    token,
    daemonId,
    url: `http://127.0.0.1:${port}`,
    close() {
      if (closed) return closed
      closed = (async () => {
        shuttingDown = true
        inbox.close()
        claudeLogin?.cancel()
        for (const client of wss.clients) client.close(1001, 'kapanıyor')
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await sessions.stopAll()
        // Çıkış kayıtlarının diske inmesi; SIGTERM sonrası live kalırsa sonraki açılış orphaned olur.
        await Promise.all([...pendingExitCommits.values()])
        // İşlenmiş son çıktı checkpoint'e yazılır, sonra worker kapanır.
        await host.shutdown()
        // Socket en son bırakılır.
        await lock.release()
      })()
      return closed
    },
  }
}
