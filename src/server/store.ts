import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { AppState } from '../shared/types'

export const DATA_DIR = path.join(os.homedir(), '.agentdeck')
export const WORKTREE_DIR = path.join(DATA_DIR, 'worktrees')
const STATE_FILE = path.join(DATA_DIR, 'state.json')

let state: AppState = { projects: [], sessions: [] }

export function load(): AppState {
  fs.mkdirSync(WORKTREE_DIR, { recursive: true })
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      // PTY'ler sunucuyla birlikte öldü; worktree'ler duruyor.
      for (const s of state.sessions) {
        if (s.status === 'running') s.status = 'exited'
      }
    } catch {
      state = { projects: [], sessions: [] }
    }
  }
  return state
}

export function get(): AppState {
  return state
}

export function save(): void {
  // Yarım yazılmış JSON tüm proje/oturum kaydını çöpe atar: tmp + rename.
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

const TOKEN_FILE = path.join(DATA_DIR, 'token')

/** Yerel istemciyi doğrulamak için kalıcı rastgele token. */
export function token(): string {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  const value = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(TOKEN_FILE, value, { mode: 0o600 })
  return value
}
