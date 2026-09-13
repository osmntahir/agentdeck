import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import express from 'express'
import { WebSocketServer } from 'ws'
import { openStore, type Store } from './store'
import { acquireDaemonLock, type DaemonLock } from './lock'
import { createExclusiveLocks, createSerialQueues } from './locks'
import { createRequestLedger, DedupConflictError } from './dedup'
import { scanOrphanWorktrees } from './orphans'
import { findSubRepos } from './repos'
import * as sessions from './sessions'
import * as git from './git'
import { isCheckpointId, openCheckpointStore } from './checkpoints'
import { createTerminalHost, type TerminalEvent, type PreviewResult } from './terminalHost'
import { chunkText, type SnapshotScope } from './terminalState'
import {
  commandLabel,
  type Isolation,
  type Project,
  type Session,
  type SessionView,
  type SessionWorktree,
} from '../shared/types'

const PROTOCOL_VERSION = 2

/** Başlangıç rezervasyonları (spec §4). Fazla legacy kayıt kesilmez; create durur. */
const MAX_SESSIONS = 256
const MAX_LIVE_RUNS = 32

/** Silme onayı daemon ömrüne bağlıdır ve 60 sn sonra düşer. */
const CONFIRMATION_TTL_MS = 60_000

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

export interface DaemonOptions {
  dataDir: string
  port?: number
  host?: string
  /** Derlenmiş web çıktısını servis et (üretim başlatıcısı için). */
  serveWeb?: boolean
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
  statusDigest: string
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
  const host = createTerminalHost({ checkpoints: openCheckpointStore(options.dataDir) })
  const sessionLocks = createExclusiveLocks()
  const gitQueues = createSerialQueues()
  const createLedger = createRequestLedger<Session>()
  const launchLedger = createRequestLedger<Session>()
  const confirmations = new Map<string, Confirmation>()
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

  function sessionView(session: Session): SessionView {
    const live = sessions.activity(session.id)
    return { ...session, activity: live?.activity ?? null, lastActivityAt: live?.lastActivityAt ?? null }
  }

  function findSession(id: string): Session | undefined {
    return store.get().sessions.find((s) => s.id === id)
  }

  /** Yeni Run için sıralı ekran modelini açar; PTY doğmadan önce hazırdır. */
  function openTerminal(sessionId: string, runId: string): void {
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
      await store.commit((draft) => {
        const target = draft.sessions.find((s) => s.id === sessionId)
        if (!target || target.lifecycle !== 'live') return
        target.lifecycle = 'exited'
        target.endedAt = Date.now()
      })
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
   * Silme onayının bağlandığı Git durumu. Ortak oturumda dosyalar korunduğu
   * için boştur; izole oturumda her worktree'nin durumu yoluyla birlikte
   * toplanır. Önceki kısmi silmede veya yerel Git ile kalkmış worktree
   * okunamaz değil yoktur ve özete böyle girer. Durumu okunamayan worktree
   * varsa null döner; "temiz" sonucu çıkarılmaz.
   */
  async function deletionFingerprint(session: Session): Promise<{ digest: string; changedEntries: number } | null> {
    if (session.isolation === 'shared') return { digest: digestOf([]), changedEntries: 0 }
    const parts: string[] = []
    let changedEntries = 0
    for (const rel of worktreePaths(session)) {
      const dir = path.join(session.cwd, rel)
      if (isMissing(dir)) {
        parts.push(`${rel}: (yok)`)
        continue
      }
      const status = await git.porcelainStatus(dir)
      if (status === null) return null
      changedEntries += status.length
      parts.push(...status.map((entry) => `${rel}: ${entry}`))
    }
    return { digest: digestOf(parts), changedEntries }
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
      projects: state.projects,
      // Kalıcı lifecycle canlılık tahminiyle ezilmez; kayıt tek doğrudur.
      sessions: state.sessions.map(sessionView),
      previews,
      terminals: Object.fromEntries(state.sessions.filter((s) => s.runId).map((s) => [s.id, {
        failure: host.failure(s.runId!), checkpoint: host.checkpointStatus(s.runId!),
      }])),
      serviceError: store.serviceError(),
    })
  })

  app.get('/api/orphan-worktrees', (_req, res) => {
    const known = new Set(store.get().sessions.map((s) => s.cwd))
    res.json(scanOrphanWorktrees(store.worktreeRoot, known))
  })

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
    }

    try {
      const session = await createLedger.run(requestId, payload, async () => {
        const project = store.get().projects.find((p) => p.id === payload.projectId)
        if (!project) throw new HttpError(404, 'not_found', 'Proje yok')
        if (projectsBeingDeleted.has(project.id)) {
          throw new HttpError(409, 'operation_in_progress', 'Proje silinirken yeni oturum açılmaz')
        }

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
        const name = readName(payload.name, program, sid)
        if (typeof name === 'object') throw new HttpError(400, 'validation', name.error)

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
            onData: (chunk) => host.feed(runId, chunk),
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
        }

        try {
          await store.commit((draft) => {
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
        await host.publish(sid, runId)
        return session
      })
      // Yanıt kalıcı kayıttan okunur: Run bu arada çıkmışsa görünüm bunu söyler.
      res.json(sessionView(findSession(session.id) ?? session))
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
    } finally {
      held.release()
    }
  })

  app.post('/api/sessions/:id/restart', async (req, res) => {
    const requestId = readRequestId(req.body?.requestId)
    if (typeof requestId !== 'string') return jsonError(res, 400, 'validation', requestId.error)

    const existing = findSession(req.params.id)
    if (!existing) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const held = sessionLocks.tryAcquire(existing.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      const session = await launchLedger.run(
        requestId,
        { sessionId: existing.id, expectedRunId: req.body?.expectedRunId ?? null },
        async () => {
          const current = findSession(existing.id)
          if (!current) throw new HttpError(404, 'not_found', 'Oturum yok')
          if (req.body?.expectedRunId !== undefined && req.body.expectedRunId !== current.runId) {
            throw new HttpError(409, 'stale_run', 'Beklenen Run artık geçerli değil; görünüm tazelendi', {
              currentRunId: current.runId,
            })
          }

          const stopped = await stopVerified(current.id)
          if (!stopped.verified) {
            throw new HttpError(409, 'stop_unverified', 'Canlı iş durdurulamadı; yeni Run başlatılmadı', {
              reason: stopped.reason,
            })
          }

          // cwd eksikse yeni Run yok: dizin yaratma veya shared fallback yok.
          if (dirIdentityOf(current.cwd) === null) {
            throw new HttpError(400, 'cwd_missing', `Çalışma dizini yok: ${current.cwd}`)
          }

          // lastLaunch niyeti tekrarlanır. §8/1'de yalnız command niyeti
          // üretilir; yönetilen kimlik (fresh/resume/picker) G2 geçmeden açılmaz.
          const intent = current.lastLaunch
          const command = intent && intent.mode === 'command' ? intent.command : current.command

          const runId = crypto.randomBytes(16).toString('hex')
          openTerminal(current.id, runId)
          try {
            sessions.spawn({
              sessionId: current.id,
              runId,
              command,
              cwd: current.cwd,
              onData: (chunk) => host.feed(runId, chunk),
              onExit: (exit) => recordExit(current.id, exit),
            })
          } catch (err) {
            await host.discard(current.id, runId)
            throw new HttpError(500, 'spawn_failed', `Yeniden başlatılamadı: ${(err as Error).message}`)
          }

          try {
            await store.commit((draft) => {
              const target = draft.sessions.find((s) => s.id === current.id)
              if (!target) return
              target.lifecycle = 'live'
              target.runId = runId
              target.exitCode = null
              target.exitSignal = null
              target.endedAt = null
              target.lastLaunch = { mode: 'command', command }
            })
          } catch (err) {
            await sessions.stop(current.id)
            await host.discard(current.id, runId)
            throw new HttpError(503, 'persistence', `Yeni Run kaydedilemedi: ${(err as Error).message}`)
          }
          // Yeni Run kayda girdi: saklama sınırı ancak şimdi eski kayıtları budar.
          await host.publish(current.id, runId)
          return findSession(current.id) as Session
        },
      )
      res.json(sessionView(findSession(session.id) ?? session))
    } catch (err) {
      sendError(res, err)
    } finally {
      held.release()
    }
  })

  app.post('/api/sessions/:id/delete-preview', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')

    const dirIdentity = dirIdentityOf(session.cwd)
    if (dirIdentity === null) {
      return jsonError(res, 409, 'cwd_missing', `Çalışma dizini okunamıyor: ${session.cwd}`, { cwd: session.cwd })
    }
    const fingerprint = await deletionFingerprint(session)
    if (fingerprint === null) {
      return jsonError(res, 409, 'status_unreadable', 'Çalışma kopyasının durumu okunamadı; onay üretilmedi', {
        cwd: session.cwd,
      })
    }

    const confirmationToken = crypto.randomBytes(24).toString('hex')
    confirmations.set(confirmationToken, {
      sessionId: session.id,
      runId: session.runId,
      cwd: session.cwd,
      dirIdentity,
      statusDigest: fingerprint.digest,
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    })

    res.json({
      confirmationToken,
      expiresInMs: CONFIRMATION_TTL_MS,
      cwd: session.cwd,
      branch: session.branch,
      isolation: session.isolation,
      changedEntries: fingerprint.changedEntries,
      // Sözleşmenin içerik fingerprint'i ve ignored dosya bütçesi §8/4'te
      // eklenir. Ortak klasörde dosyalar korunur; Git durumu gerekmez.
      fingerprintScope: session.isolation === 'shared' ? 'dir-identity' : 'dir-identity+git-status',
      keepsBranch: true,
    })
  })

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
    if (confirmation.runId !== session.runId) {
      // Onaydan sonra yeni bir Run başladı: onay o Run'ı kapsamıyor.
      confirmations.delete(confirmationToken)
      return jsonError(res, 409, 'confirmation_stale', 'Onaydan sonra yeni bir Run başladı; yeniden önizleme alın', {
        currentRunId: session.runId,
      })
    }

    const held = sessionLocks.tryAcquire(session.id)
    if (!held) return jsonError(res, 409, 'operation_in_progress', 'Bu oturumda başka bir işlem sürüyor')
    try {
      const stopped = await stopVerified(session.id)
      if (!stopped.verified) {
        return jsonError(res, 409, 'stop_unverified', 'Süreç grubu durdurulamadı; silme başlatılmadı', {
          reason: stopped.reason,
        })
      }

      // Ortak klasörde dosyalar silinmez; yalnız dizin kimliği doğrulanır.
      // Worktree kaldırılacaksa Git durumu da tekrar okunur.
      const dirIdentity = dirIdentityOf(session.cwd)
      const fingerprint = await deletionFingerprint(session)
      if (dirIdentity === null || fingerprint === null) {
        return jsonError(res, 409, 'confirmation_stale', 'Çalışma kopyası artık okunamıyor; silme yapılmadı', {
          cwd: session.cwd,
        })
      }
      if (dirIdentity !== confirmation.dirIdentity || fingerprint.digest !== confirmation.statusDigest) {
        confirmations.delete(confirmationToken)
        return jsonError(res, 409, 'confirmation_stale', 'Klasör içeriği onaydan sonra değişti; silme yapılmadı', {
          cwd: session.cwd,
        })
      }

      const project = store.get().projects.find((p) => p.id === session.projectId)
      if (session.isolation === 'worktree') {
        if (!project) {
          return jsonError(res, 409, 'project_missing', 'Projenin kaydı yok; worktree güvenle kaldırılamaz')
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
            // Sözleşme: rmSync fallback yok. Kaldırılanlar kayıttan düşer; kalan
            // worktree'ler, dosyaları ve kayıt korunur.
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
            return jsonError(
              res,
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

      confirmations.delete(confirmationToken)
      try {
        await store.commit((draft) => {
          draft.sessions = draft.sessions.filter((s) => s.id !== session.id)
        })
      } catch (err) {
        // Worktree kaldırıldı ama kayıt yazılamadı: kayıt korunur, kısmi sonuç görünür.
        return jsonError(
          res,
          503,
          'persistence',
          `${session.isolation === 'shared' ? 'Dosyalar korundu fakat oturum kaydı kaldırılamadı' : 'Dosyalar kaldırıldı ama kayıt güncellenemedi'}: ${(err as Error).message}`,
          { cwd: session.cwd, degraded: true },
        )
      }
      // Session silindi: ona ait terminal checkpoint'leri de kalkar.
      host.removeSession(session.id)
      res.json({ ok: true, branchKept: session.branch })
    } finally {
      held.release()
    }
  })

  app.delete('/api/projects/:id', async (req, res) => {
    const project = store.get().projects.find((p) => p.id === req.params.id)
    if (!project) return jsonError(res, 404, 'not_found', 'Proje yok')

    const owned = store.get().sessions.filter((s) => s.projectId === project.id)
    if (owned.length > 0) {
      // Kademeli silme ve onay fingerprint'i §8/4'ün işi; gizli cascade yok.
      return jsonError(res, 409, 'project_has_sessions', 'Projede oturum kayıtları var; önce onları silin', {
        sessionIds: owned.map((s) => s.id),
      })
    }

    projectsBeingDeleted.add(project.id)
    try {
      await store.commit((draft) => {
        draft.projects = draft.projects.filter((p) => p.id !== project.id)
      })
    } catch (err) {
      return jsonError(res, 503, 'persistence', `Proje kaydı silinemedi: ${(err as Error).message}`)
    } finally {
      projectsBeingDeleted.delete(project.id)
    }
    res.json({ ok: true })
  })

  app.get('/api/sessions/:id/diff', async (req, res) => {
    const session = findSession(req.params.id)
    if (!session) return jsonError(res, 404, 'not_found', 'Oturum yok')
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
    const repos = []
    // Her depo birkaç git süreci açar; depolar sırayla okunur.
    for (const rel of scan.repos) {
      const dir = path.join(session.cwd, rel)
      const [{ diff, status }, branch] = await Promise.all([git.diff(dir), git.currentBranch(dir)])
      repos.push({ path: rel, branch, diff, status })
    }
    res.json({ repos, truncated: scan.truncated })
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
    const notifyControl = () => sendJson({ type: 'control', owned: lease.owner === ws, generation: lease.generation })
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
    // Kilit sızdırılmaz: açılamayan daemon veri dizinini tutmaya devam etmez.
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

  return {
    port,
    token,
    daemonId,
    url: `http://127.0.0.1:${port}`,
    async close() {
      shuttingDown = true
      for (const client of wss.clients) client.close(1001, 'kapanıyor')
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await sessions.stopAll()
      // İşlenmiş son çıktı checkpoint'e yazılır, sonra worker kapanır.
      await host.shutdown()
      // Socket en son bırakılır.
      await lock.release()
    },
  }
}
