import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as pty from 'node-pty'
import { claudePaths, type ClaudePaths } from './claudeAccounts'
import type { ClaudeAccountView, ClaudeLoginView } from '../shared/types'

const OUTPUT_TAIL = 4096

// CSI, OSC (BEL veya ST ile biten) ve tek karakterli ESC dizileri.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export interface ClaudeLogin {
  view(): ClaudeLoginView
  /** Tarayıcı dönüşü olmadığında CLI'ın istediği kod gibi girdiler. */
  input(text: string): void
  cancel(): void
}

/**
 * `claude auth login` geçici bir CLAUDE_CONFIG_DIR içinde çalışır: canlı hesap
 * giriş sürerken bozulmaz. Başarılı çıkışta oluşan kimlik `onSuccess` ile
 * içe aktarılır; geçici dizin her sonuçta silinir.
 */
export function startClaudeLogin(input: {
  dataDir: string
  command: string
  env: Record<string, string>
  onSuccess: (source: ClaudePaths) => ClaudeAccountView
}): ClaudeLogin {
  const id = crypto.randomBytes(8).toString('hex')
  const configDir = fs.mkdtempSync(path.join(input.dataDir, 'claude-login-'))
  fs.chmodSync(configDir, 0o700)
  const state: ClaudeLoginView = { id, state: 'running', url: null, output: '', message: null, account: null }
  const cleanup = () => fs.rmSync(configDir, { recursive: true, force: true })

  let proc: pty.IPty
  try {
    // Geniş satır: uzun giriş adresi CLI tarafından bölünmez.
    proc = pty.spawn(input.command, ['auth', 'login'], {
      name: 'xterm-256color',
      cols: 1000,
      rows: 30,
      cwd: input.dataDir,
      env: { ...input.env, CLAUDE_CONFIG_DIR: configDir },
    })
  } catch (err) {
    cleanup()
    return {
      view: () => ({ ...state, state: 'failed', message: `claude başlatılamadı: ${(err as Error).message}` }),
      input: () => {},
      cancel: () => {},
    }
  }

  proc.onData((chunk) => {
    state.output = `${state.output}${chunk.replace(ANSI, '')}`.slice(-OUTPUT_TAIL)
    state.url ??= state.output.match(/https:\/\/[^\s"'<>]+/)?.[0] ?? null
  })
  proc.onExit(({ exitCode }) => {
    try {
      if (state.state === 'cancelled') return
      if (exitCode !== 0) {
        state.state = 'failed'
        state.message = `Giriş tamamlanmadı (çıkış kodu ${exitCode})`
        return
      }
      state.account = input.onSuccess(claudePaths({ CLAUDE_CONFIG_DIR: configDir }))
      state.state = 'done'
    } catch (err) {
      state.state = 'failed'
      state.message = (err as Error).message
    } finally {
      cleanup()
    }
  })

  return {
    view: () => ({ ...state }),
    input(text) {
      if (state.state === 'running') proc.write(text)
    },
    cancel() {
      if (state.state !== 'running') return
      state.state = 'cancelled'
      proc.kill()
    },
  }
}
