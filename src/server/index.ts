import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import express from 'express'
import { WebSocketServer } from 'ws'
import * as store from './store'
import * as git from './git'
import * as sessions from './sessions'
import type { AgentKind, Isolation, Project, Session } from '../shared/types'

const PORT = Number(process.env.PORT || 4711)

const app = express()
app.use(express.json())

store.load()
const TOKEN = store.token()

/** Tarayıcıdaki herhangi bir sayfa 127.0.0.1'e WS açabilir; origin'i daraltıyoruz. */
function originOk(origin: string | undefined): boolean {
  if (!origin) return true // curl/test gibi tarayıcı dışı istemciler
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

// Auth'tan önce: masaüstü kabuğu porttaki sürecin bizim daemon olup
// olmadığını token'sız ayırt edebilmeli. Hiçbir veri sızdırmaz.
app.get('/api/health', (_req, res) => {
  res.json({ app: 'agentdeck', pid: process.pid })
})

app.use('/api', (req, res, next) => {
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Origin reddedildi' })
  const supplied = req.headers['x-agentdeck-token'] ?? req.query.token
  if (supplied !== TOKEN) return res.status(401).json({ error: 'Geçersiz token' })
  next()
})

const AGENTS: AgentKind[] = ['claude', 'codex', 'gemini', 'shell']
const ISOLATIONS: Isolation[] = ['worktree', 'shared']

const newId = () => crypto.randomBytes(6).toString('hex')

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return s || 'task'
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/** PTY'yi öldür, worktree'yi ve isteğe bağlı branch'i temizle, kaydı sil. */
async function destroySession(session: Session, dropBranch: boolean): Promise<void> {
  // Süreç grubu ölmeden worktree'yi silmek git ile yarışır.
  await sessions.kill(session.id)
  const state = store.get()
  const project = state.projects.find((p) => p.id === session.projectId)

  if (session.isolation === 'worktree' && project) {
    try {
      await git.removeWorktree(project.path, session.cwd)
    } catch {
      // worktree elle silinmiş olabilir; kayıt yine de kalkmalı
      fs.rmSync(session.cwd, { recursive: true, force: true })
    }
    if (dropBranch && session.branch) {
      try {
        await git.deleteBranch(project.path, session.branch)
      } catch {
        // branch merge edilmemiş ya da yok
      }
    }
  }

  state.sessions = state.sessions.filter((s) => s.id !== session.id)
  store.save()
}

app.get('/api/state', (_req, res) => {
  const state = store.get()
  res.json({
    projects: state.projects,
    sessions: state.sessions.map((s) => ({ ...s, status: sessions.isLive(s.id) ? 'running' : 'exited' })),
  })
})

app.post('/api/projects', async (req, res) => {
  const raw = String(req.body?.path ?? '').trim()
  if (!raw) return res.status(400).json({ error: 'Klasör yolu gerekli' })

  const dir = path.resolve(expandHome(raw))
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: 'Klasör bulunamadı' })
  }

  const root = await git.repoRoot(dir)
  if (!root) return res.status(400).json({ error: 'Burası bir git deposu değil' })

  const state = store.get()
  if (state.projects.some((p) => p.path === root)) {
    return res.status(409).json({ error: 'Bu proje zaten ekli' })
  }

  const project: Project = { id: newId(), name: path.basename(root), path: root, createdAt: Date.now() }
  state.projects.push(project)
  store.save()
  res.json(project)
})

app.delete('/api/projects/:id', async (req, res) => {
  const state = store.get()
  const project = state.projects.find((p) => p.id === req.params.id)
  if (!project) return res.status(404).json({ error: 'Proje yok' })

  for (const s of state.sessions.filter((s) => s.projectId === project.id)) {
    await destroySession(s, false)
  }
  state.projects = state.projects.filter((p) => p.id !== project.id)
  store.save()
  res.json({ ok: true })
})

app.post('/api/sessions', async (req, res) => {
  const state = store.get()
  const project = state.projects.find((p) => p.id === req.body?.projectId)
  if (!project) return res.status(404).json({ error: 'Proje yok' })

  const name = String(req.body?.name ?? '').trim() || 'oturum'

  // Bilinmeyen bir ajan sessizce düz kabuğa düşmesin.
  const agent = req.body?.agent ?? 'claude'
  if (!AGENTS.includes(agent)) return res.status(400).json({ error: `Bilinmeyen ajan: ${agent}` })
  const isolation = req.body?.isolation ?? 'worktree'
  if (!ISOLATIONS.includes(isolation)) return res.status(400).json({ error: `Geçersiz izolasyon: ${isolation}` })

  const sid = newId()
  let cwd = project.path
  let branch: string | null = null

  if (isolation === 'worktree') {
    branch = `agentdeck/${slugify(name)}-${sid.slice(0, 4)}`
    cwd = path.join(store.WORKTREE_DIR, project.id, sid)
    fs.mkdirSync(path.dirname(cwd), { recursive: true })
    try {
      await git.addWorktree(project.path, cwd, branch)
    } catch (err) {
      return res.status(500).json({ error: `Worktree açılamadı: ${(err as Error).message}` })
    }
  }

  const session: Session = {
    id: sid,
    projectId: project.id,
    name,
    agent,
    isolation,
    cwd,
    branch,
    status: 'running',
    exitCode: null,
    createdAt: Date.now(),
  }

  sessions.spawn(session, (code) => {
    session.status = 'exited'
    session.exitCode = code
    store.save()
  })

  state.sessions.push(session)
  store.save()
  res.json(session)
})

app.post('/api/sessions/:id/restart', async (req, res) => {
  const session = store.get().sessions.find((s) => s.id === req.params.id)
  if (!session) return res.status(404).json({ error: 'Oturum yok' })

  await sessions.kill(session.id)
  session.status = 'running'
  session.exitCode = null
  sessions.spawn(session, (code) => {
    session.status = 'exited'
    session.exitCode = code
    store.save()
  })
  store.save()
  res.json(session)
})

app.delete('/api/sessions/:id', async (req, res) => {
  const session = store.get().sessions.find((s) => s.id === req.params.id)
  if (!session) return res.status(404).json({ error: 'Oturum yok' })

  await destroySession(session, req.query.deleteBranch === 'true')
  res.json({ ok: true })
})

app.get('/api/sessions/:id/diff', async (req, res) => {
  const session = store.get().sessions.find((s) => s.id === req.params.id)
  if (!session) return res.status(404).json({ error: 'Oturum yok' })

  const [{ diff, status }, branch] = await Promise.all([
    git.diff(session.cwd),
    git.currentBranch(session.cwd),
  ])
  res.json({ diff, status, branch })
})

// Yalnızca derlenmiş çıktıyı servis et. Dev'de bu dosya src/server'dan
// çalışır ve '..' src/web'e denk gelir — ham kaynağı servis etmemeliyiz.
const isBuild = __dirname.split(path.sep).includes('dist')
const webDist = path.join(__dirname, '..', 'web')
if (isBuild && fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist))
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', 'http://localhost')
  if (!originOk(req.headers.origin) || url.searchParams.get('token') !== TOKEN) {
    ws.close(1008, 'yetkisiz')
    return
  }

  const sessionId = url.searchParams.get('session')
  if (!sessionId || !sessions.isLive(sessionId)) {
    ws.send(JSON.stringify({ type: 'exit', code: -1 }))
    ws.close()
    return
  }

  // Yeni bağlanan istemciye önce scrollback'i gönder, sonra canlı akışa bağla.
  ws.send(JSON.stringify({ type: 'data', data: sessions.buffer(sessionId) }))

  const unsubscribe = sessions.subscribe(
    sessionId,
    (data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'data', data })),
    (code) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'exit', code })),
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
      sessions.resize(sessionId, msg.cols, msg.rows)
    }
  })

  ws.on('close', unsubscribe)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`agentdeck hazır:  http://127.0.0.1:${PORT}/?token=${TOKEN}`)
  console.log(`vite ile geliştirme: http://127.0.0.1:4710/?token=${TOKEN}`)
})
