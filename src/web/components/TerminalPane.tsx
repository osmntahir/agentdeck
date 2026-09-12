import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionView } from '../../shared/types'
import { TOKEN } from '../api'

interface Props {
  session: SessionView
  active: boolean
}

export function TerminalPane({ session, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
      cursorBlink: true,
      scrollback: 10000,
      theme: { background: '#0e1116', foreground: '#d5dae2', cursor: '#7aa2f7' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    termRef.current = term
    fitRef.current = fit

    if (session.lifecycle !== 'live') {
      // Kayıtlı terminal görüntüsü (checkpoint) uygulama sırası §8/3'te gelir;
      // o zamana kadar "önceki görüntü yok" denir, sahte ekran kurulmaz.
      term.write(
        '\x1b[90m[bu Run canlı değil; önceki terminal görüntüsü henüz saklanmıyor]\x1b[0m\r\n',
      )
      return () => {
        term.dispose()
      }
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/ws?session=${session.id}&token=${TOKEN}`

    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    let dead = false
    let attempt = 0

    const connect = () => {
      if (disposed || dead) return
      // Sunucu her bağlantıda scrollback'i baştan gönderir; ekranı sıfırlayıp
      // yazmazsak uyku/kopma sonrası içerik ikiye katlanır.
      let replayPending = true
      const socket = new WebSocket(url)
      ws = socket

      socket.onopen = () => {
        attempt = 0
        fit.fit()
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'data') {
          if (replayPending) {
            term.reset()
            replayPending = false
          }
          term.write(msg.data)
        } else if (msg.type === 'exit') {
          dead = true
          term.write(`\r\n\x1b[33m[oturum kapandı — çıkış kodu ${msg.code}]\x1b[0m\r\n`)
        }
      }

      socket.onclose = () => {
        if (disposed || dead) return
        attempt += 1
        const delay = Math.min(500 * attempt, 5000)
        term.write(`\r\n\x1b[90m[bağlantı koptu — ${delay / 1000}s sonra yeniden denenecek]\x1b[0m\r\n`)
        retryTimer = setTimeout(connect, delay)
      }
    }

    connect()

    const onData = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      onData.dispose()
      onResize.dispose()
      ws?.close()
      term.dispose()
    }
  }, [session.id, session.runId, session.lifecycle])

  // Gizliyken ölçüm yanlış çıkar; görünür olunca yeniden boyutla.
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => {
      fitRef.current?.fit()
      termRef.current?.focus()
    }, 0)
    const handle = () => fitRef.current?.fit()
    window.addEventListener('resize', handle)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', handle)
    }
  }, [active])

  return <div ref={hostRef} className="term-host" style={{ display: active ? 'block' : 'none' }} />
}
