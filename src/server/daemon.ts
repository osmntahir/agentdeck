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
import * as sessions from './sessions'
import * as git from './git'
import { commandLabel, type Isolation, type Project, type Session, type SessionView } from '../shared/types'

const PROTOCOL_VERSION = 2

/** Başlangıç rezervasyonları (spec §4). Fazla legacy kayıt kesilmez; create durur. */
const MAX_SESSIONS = 256
const MAX_LIVE_RUNS = 32

/** Silme onayı daemon ömrüne bağlıdır ve 60 sn sonra düşer. */
const CONFIRMATION_TTL_MS = 60_000

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

  /** Bir Run'ın gözlenen çıkışını kalıcı kayda yazar. */
  function recordExit(sessionId: string, exit: sessions.RunExit): void {
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
    pendingExitCommits.set(sessionId, commit)
    void commit.then(() => {
      if (pendingExitCommits.get(sessionId) === commit) pendingExitCommits.delete(sessionId)
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

  /**
   * Create sırasında açtığımız worktree'yi yalnız kendi kaynağımız olduğu,
   * beklenen OID'de durduğu ve içeriği hiç değişmediği doğrulanırsa kaldırır.
   * Aksi halde kaynağı korur ve bunu bildirir.
   */
  async function rollbackWorktree(project: Project, cwd: string, expectedBase: string): Promise<'removed' | 'preserved'> {
    const managedRoot = path.resolve(store.worktreeRoot)
    if (!path.resolve(cwd).startsWith(managedRoot + path.sep)) return 'preserved'
    const [head, status] = await Promise.all([git.headOid(cwd), git.porcelainStatus(cwd)])
    if (head !== expectedBase || status === null || status.length > 0) return 'preserved'
    try {
      const key = await git.commonGitDir(project.path)
      await gitQueues.run(key, () => git.removeWorktree(project.path, cwd))
      return 'removed'
    } catch {
      return 'preserved'
    }
  }

  app.get('/api/state', (_req, res) => {
    const state = store.get()
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      daemonId,
      revision: store.revision(),
      serverNow: Date.now(),
      projects: state.projects,
      // Kalıcı lifecycle canlılık tahminiyle ezilmez; kayıt tek doğrudur.
      sessions: state.sessions.map(sessionView),
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
    const root = await git.repoRoot(dir)
    if (!root) return jsonError(res, 400, 'validation', 'Burası bir git deposu değil')

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

        if (isolation === 'worktree') {
          const base = await git.headOid(project.path)
          if (!base) {
            throw new HttpError(
              400,
              'head_missing',
              'Projede commit yok: worktree oturumu açılamaz. İlk commit sonrası tekrar deneyin veya ortak çalışma kopyasını seçin.',
            )
          }
          baseCommit = base
          branch = `agentdeck/${slugify(name)}-${sid}`
          cwd = path.join(store.worktreeRoot, project.id, sid)
          const key = await git.commonGitDir(project.path)
          const worktreeBranch = branch
          const worktreePath = cwd
          try {
            await gitQueues.run(key, async () => {
              fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
              await git.addWorktree(project.path, worktreePath, worktreeBranch, base)
            })
          } catch (err) {
            throw new HttpError(500, 'worktree_failed', `Worktree açılamadı: ${(err as Error).message}`)
          }
        }

        const runId = crypto.randomBytes(16).toString('hex')
        try {
          sessions.spawn({
            sessionId: sid,
            runId,
            command: program,
            cwd,
            onExit: (exit) => recordExit(sid, exit),
          })
        } catch (err) {
          const detail: Record<string, unknown> = { cwd }
          if (isolation === 'worktree' && baseCommit) {
            detail.worktree = (await rollbackWorktree(project, cwd, baseCommit)) === 'removed' ? 'kaldırıldı' : 'korundu'
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
          const detail: Record<string, unknown> = { cwd }
          if (isolation === 'worktree' && baseCommit) {
            detail.worktree = (await rollbackWorktree(project, cwd, baseCommit)) === 'removed' ? 'kaldırıldı' : 'korundu'
          }
          throw new HttpError(503, 'persistence', `Oturum kaydedilemedi: ${(err as Error).message}`, detail)
        }
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
          try {
            sessions.spawn({
              sessionId: current.id,
              runId,
              command,
              cwd: current.cwd,
              onExit: (exit) => recordExit(current.id, exit),
            })
          } catch (err) {
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
            throw new HttpError(503, 'persistence', `Yeni Run kaydedilemedi: ${(err as Error).message}`)
          }
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
    const status = await git.porcelainStatus(session.cwd)
    if (status === null) {
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
      statusDigest: digestOf(status),
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    })

    res.json({
      confirmationToken,
      expiresInMs: CONFIRMATION_TTL_MS,
      cwd: session.cwd,
      branch: session.branch,
      isolation: session.isolation,
      changedEntries: status.length,
      // Sözleşmenin içerik fingerprint'i ve ignored dosya bütçesi §8/4'te
      // eklenir; bu onay dizin kimliği ve Git durumuna bağlıdır.
      fingerprintScope: 'dir-identity+git-status',
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

      // Onay alındıktan sonra dosya durumu tekrar okunur.
      const dirIdentity = dirIdentityOf(session.cwd)
      const status = await git.porcelainStatus(session.cwd)
      if (dirIdentity === null || status === null) {
        return jsonError(res, 409, 'confirmation_stale', 'Çalışma kopyası artık okunamıyor; silme yapılmadı', {
          cwd: session.cwd,
        })
      }
      if (dirIdentity !== confirmation.dirIdentity || digestOf(status) !== confirmation.statusDigest) {
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
        try {
          const key = await git.commonGitDir(project.path)
          await gitQueues.run(key, () => git.removeWorktree(project.path, session.cwd))
        } catch (err) {
          // Sözleşme: rmSync fallback yok. Kayıt ve dosyalar korunur.
          return jsonError(
            res,
            500,
            'worktree_remove_failed',
            `Worktree kaldırılamadı; hiçbir dosya silinmedi: ${(err as Error).message}`,
            {
              cwd: session.cwd,
              recovery: 'Klasörü yerel araçla inceleyip git worktree remove ile tekrar deneyin',
            },
          )
        }
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
          `Dosyalar kaldırıldı ama kayıt güncellenemedi: ${(err as Error).message}`,
          { cwd: session.cwd, degraded: true },
        )
      }
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
    const [{ diff, status }, branch] = await Promise.all([git.diff(session.cwd), git.currentBranch(session.cwd)])
    res.json({ diff, status, branch })
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
  const wss = new WebSocketServer({ server, path: '/ws' })
  let listening = false

  // HTTP sunucusunun hatası ws tarafına da yansır. Burada tutulmazsa 'error'
  // olayı yakalanmamış istisnaya dönüşüp daemon'ı çökertir; başlatma hatası
  // zaten listen reddiyle bildirilir.
  wss.on('error', (err) => {
    if (!listening) return
    console.error(`[agentdeck] ws sunucu hatası: ${err.message}`)
  })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (!originOk(req.headers.origin) || url.searchParams.get('token') !== token) {
      ws.close(1008, 'yetkisiz')
      return
    }

    const sessionId = url.searchParams.get('session')
    if (!sessionId || !findSession(sessionId) || !sessions.isLive(sessionId)) {
      ws.send(JSON.stringify({ type: 'exit', code: -1 }))
      ws.close()
      return
    }

    // NOT: sözleşmenin replay-start/chunk/end protokolü, snapshot'ı, güvenli
    // kesimi ve terminal control lease'i §8/3'ün işidir. Buradaki yol prototip
    // ham tamponudur ve doğru ekran temsili olarak sunulmaz.
    ws.send(JSON.stringify({ type: 'data', data: sessions.buffer(sessionId) }))

    const unsubscribe = sessions.subscribe(
      sessionId,
      (data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'data', data })),
      (exit) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'exit', code: exit.exitCode })),
    )

    ws.on('message', (raw) => {
      let msg: { type: string; data?: string; cols?: number; rows?: number }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        sessions.write(sessionId, msg.data)
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        // cols 2-300, rows 1-120 (spec §4).
        const cols = Math.min(300, Math.max(2, Math.floor(msg.cols)))
        const rows = Math.min(120, Math.max(1, Math.floor(msg.rows)))
        sessions.resize(sessionId, cols, rows)
      }
    })

    ws.on('close', unsubscribe)
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
      // Socket en son bırakılır.
      await lock.release()
    },
  }
}
