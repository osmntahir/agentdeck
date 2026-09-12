import * as pty from 'node-pty'
import { EventEmitter } from 'node:events'
import type { AgentKind, Session } from '../shared/types'

/** Oturum başına saklanan scrollback üst sınırı. */
const MAX_BUFFER = 256 * 1024

interface Live {
  proc: pty.IPty
  buffer: string
  emitter: EventEmitter
  /** Süreç gerçekten öldüğünde çözülür; kill() bunu bekler. */
  exited: Promise<void>
  markExited: () => void
}

const live = new Map<string, Live>()

const AGENT_CMD: Record<AgentKind, string | null> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  shell: null,
}

export function spawn(session: Session, onExit: (code: number) => void): void {
  const shell = process.env.SHELL || '/bin/bash'
  const cmd = AGENT_CMD[session.agent]
  // Login kabuğu üzerinden çalıştırıyoruz ki ajan CLI'ları PATH'te bulunsun
  // (claude ~/.local/bin, codex/gemini nvm yolunda).
  const args = cmd ? ['-lc', `exec ${cmd}`] : ['-l']

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      // Daemon systemd altında başlarsa miras alınacak bir COLORTERM olmaz;
      // ajan TUI'ları 24-bit rengi bu değişkene bakarak açar.
      COLORTERM: 'truecolor',
      AGENTDECK_SESSION: session.id,
    },
  })

  let markExited!: () => void
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const entry: Live = { proc, buffer: '', emitter: new EventEmitter(), exited, markExited }
  entry.emitter.setMaxListeners(0)
  live.set(session.id, entry)

  proc.onData((data) => {
    entry.buffer += data
    if (entry.buffer.length > MAX_BUFFER) {
      let cut = entry.buffer.slice(-MAX_BUFFER)
      // Kesim bir vekil çiftinin ortasına denk gelmişse tek kalan yarıyı at.
      const first = cut.charCodeAt(0)
      if (first >= 0xdc00 && first <= 0xdfff) cut = cut.slice(1)
      entry.buffer = cut
    }
    entry.emitter.emit('data', data)
  })

  proc.onExit(({ exitCode }) => {
    entry.emitter.emit('exit', exitCode)
    entry.markExited()

    // Yeniden başlatmada bu süreç yerini yenisine bırakmış olabilir. Kaydı
    // kör kör silersek yeni PTY'yi öksüz bırakıp oturumu "öldü" işaretleriz.
    // Yalnızca hâlâ kayıtlı olan biz isek temizlik yapıyoruz.
    if (live.get(session.id) === entry) {
      live.delete(session.id)
      onExit(exitCode)
    }
  })
}

export function isLive(id: string): boolean {
  return live.has(id)
}

export function buffer(id: string): string {
  return live.get(id)?.buffer ?? ''
}

export function write(id: string, data: string): void {
  live.get(id)?.proc.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  const entry = live.get(id)
  if (!entry) return
  try {
    entry.proc.resize(cols, rows)
  } catch {
    // pencere yeniden boyutlanırken süreç ölmüş olabilir
  }
}

/** Süreç grubunu öldürür ve gerçekten ölene kadar bekler (en fazla 3sn). */
export function kill(id: string): Promise<void> {
  const entry = live.get(id)
  if (!entry) return Promise.resolve()
  const pid = entry.proc.pid
  live.delete(id)

  // Ajan CLI'ları alt süreç doğurur; sadece kabuğu öldürmek zombi bırakır ve
  // worktree kilitli kalır. forkpty setsid yaptığı için kabuk process group
  // lideridir — negatif pid sinyali tüm gruba gider.
  try {
    process.kill(-pid, 'SIGHUP')
  } catch {
    try {
      entry.proc.kill()
    } catch {
      // zaten ölmüş
    }
  }

  const hard = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // grup çoktan gitti
    }
  }, 500)

  // Takılan bir süreç API'yi kilitlemesin.
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
  return Promise.race([entry.exited, timeout]).then(() => {
    clearTimeout(hard)
  })
}

export function subscribe(
  id: string,
  onData: (d: string) => void,
  onExit: (code: number) => void,
): () => void {
  const entry = live.get(id)
  if (!entry) return () => {}
  entry.emitter.on('data', onData)
  entry.emitter.on('exit', onExit)
  return () => {
    entry.emitter.off('data', onData)
    entry.emitter.off('exit', onExit)
  }
}
