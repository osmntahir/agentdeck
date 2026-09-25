import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { ClaudeAgentView } from '../shared/types'

/**
 * Claude Code'un arka plan oturumları (`claude agents`). Liste CLI'ın betik
 * arayüzünden okunur; özet satırı ve son güncelleme yalnız varsa
 * `jobs/<id>/state.json` içinden eklenir. Bu dosya CLI'ın iç biçimidir:
 * okunamazsa alanlar boş kalır, liste yine gelir.
 */

const SHORT_ID = /^[0-9a-f]{8}$/
const LIST_TIMEOUT_MS = 5000
const CACHE_MS = 4000

export function isClaudeAgentId(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ID.test(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function time(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** `claude agents --json` çıktısı; kısa kimliği olmayan kayıt (etkileşimli oturum) açılamaz, atlanır. */
export function parseAgents(raw: string): ClaudeAgentView[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('beklenmeyen çıktı')
  const agents: ClaudeAgentView[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    if (!isClaudeAgentId(item.id) || typeof item.cwd !== 'string') continue
    agents.push({
      id: item.id,
      name: text(item.name) ?? item.id,
      state: text(item.state) ?? 'unknown',
      cwd: item.cwd,
      sessionId: text(item.sessionId),
      startedAt: time(item.startedAt),
      updatedAt: null,
      detail: null,
    })
  }
  return agents
}

function enrich(agent: ClaudeAgentView, claudeDir: string): ClaudeAgentView {
  try {
    const raw = fs.readFileSync(path.join(claudeDir, 'jobs', agent.id, 'state.json'), 'utf8')
    const state = JSON.parse(raw) as Record<string, unknown>
    const detail = text(state.detail)
    return {
      ...agent,
      detail: detail ? detail.replace(/\s+/g, ' ').slice(0, 240) : null,
      updatedAt: time(state.updatedAt),
    }
  } catch {
    return agent
  }
}

export interface ClaudeAgents {
  /** Önbellekteki liste; eskiyse arka planda tazelenir. İlk okumada null döner. */
  cached(cwd: string): { agents: ClaudeAgentView[]; error: string | null } | null
  /** Taze liste; en çok bir CLI çağrısı sürer. */
  list(cwd: string): Promise<{ agents: ClaudeAgentView[]; error: string | null }>
}

export function createClaudeAgents(options: { command: string; claudeDir: string; env: NodeJS.ProcessEnv }): ClaudeAgents {
  const cache = new Map<string, { at: number; value: { agents: ClaudeAgentView[]; error: string | null } }>()
  const running = new Map<string, Promise<{ agents: ClaudeAgentView[]; error: string | null }>>()

  function read(cwd: string): Promise<{ agents: ClaudeAgentView[]; error: string | null }> {
    const pending = running.get(cwd)
    if (pending) return pending
    const task = new Promise<{ agents: ClaudeAgentView[]; error: string | null }>((resolve) => {
      execFile(
        options.command,
        ['agents', '--json', '--all', '--cwd', cwd],
        { cwd, env: options.env, timeout: LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code
            const previous = cache.get(cwd)?.value.agents ?? []
            resolve({ agents: previous, error: code === 'ENOENT' ? 'claude komutu bulunamadı' : `claude agents çalışmadı: ${err.message.split('\n')[0]}` })
            return
          }
          try {
            resolve({ agents: parseAgents(stdout).map((agent) => enrich(agent, options.claudeDir)), error: null })
          } catch (parseError) {
            resolve({ agents: [], error: `claude agents çıktısı okunamadı: ${(parseError as Error).message}` })
          }
        },
      )
    }).then((value) => {
      cache.set(cwd, { at: Date.now(), value })
      running.delete(cwd)
      return value
    })
    running.set(cwd, task)
    return task
  }

  return {
    cached(cwd) {
      const entry = cache.get(cwd)
      if (!entry || Date.now() - entry.at >= CACHE_MS) void read(cwd)
      return entry?.value ?? null
    },
    async list(cwd) {
      const entry = cache.get(cwd)
      if (entry && Date.now() - entry.at < CACHE_MS) return entry.value
      return read(cwd)
    },
  }
}
