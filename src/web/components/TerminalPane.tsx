import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionView } from '../../shared/types'
import { inputChunks, TerminalStream, type StreamStatus } from '../../shared/terminalStream'
import { TOKEN } from '../api'

interface Props {
  session: SessionView
  daemonId: string
  stateHealthy: boolean
  /** Tek görünümde terminal odağı alır; grid'de paneller birbirinin odağını çalmaz. */
  autoFocus?: boolean
  /** Grid paneli: durum şeridi terminalin üstünde yüzen kompakt çubuk olur. */
  compact?: boolean
  /** Salt okunur incelenecek önceki Run; verilmezse oturumun güncel Run'ı açılır. */
  runId?: string | null
}

export function TerminalPane({
  session,
  daemonId,
  stateHealthy,
  autoFocus = true,
  compact = false,
  runId: inspectRunId = null,
}: Props) {
  const runId = inspectRunId ?? session.runId
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const actions = useRef({ history: () => {}, control: () => {} })
  const healthy = useRef(stateHealthy)
  healthy.current = stateHealthy
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState<StreamStatus | null>(null)

  useEffect(() => {
    if (!runId) { setStatus(null); return }
    const term = new Terminal({
      cols: 120, rows: 32, scrollback: 1000,
      fontSize: 13,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
      cursorBlink: true, disableStdin: true,
      theme: {
        background: '#0e1116', foreground: '#d5dae2', cursor: '#7aa2f7',
        // Uygulamanın kaydırma çubuklarıyla aynı palet.
        scrollbarSliderBackground: 'rgba(160, 163, 174, 0.22)',
        scrollbarSliderHoverBackground: 'rgba(160, 163, 174, 0.42)',
        scrollbarSliderActiveBackground: 'rgba(155, 180, 255, 0.55)',
      },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    let disposed = false
    let socket: WebSocket | null = null
    let stream: TerminalStream | null = null
    let reconnect: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let requestedSize = ''

    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    const canInput = () => healthy.current && stream?.status.ready && stream.status.live && stream.status.owned
    const resize = () => {
      if (!canInput()) return
      const size = fit.proposeDimensions()
      if (!size) return
      const cols = Math.max(2, Math.min(300, size.cols))
      const rows = Math.max(1, Math.min(120, size.rows))
      const key = `${cols}:${rows}`
      if (key === requestedSize || (cols === term.cols && rows === term.rows)) return
      requestedSize = key
      send({ type: 'resize', cols, rows, generation: stream!.status.generation })
    }

    const connect = () => {
      if (disposed) return
      requestedSize = ''
      let claimed = 0
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const query = new URLSearchParams({ session: session.id, run: runId, token: TOKEN })
      const ws = new WebSocket(`${proto}://${location.host}/ws?${query}`)
      socket = ws
      let protocolFailed = false
      const consumer = new TerminalStream(term, { daemonId, sessionId: session.id, runId }, (next) => {
        if (disposed || socket !== ws) return
        setStatus(next)
        term.options.disableStdin = !healthy.current || !next.ready || !next.live || !next.owned
        if (next.ready) { attempts = 0; resize() }
        // Sahipsiz kontrol kimseden alınmaz: grid ile tek görünüm arasında geçişte
        // eski bağlantı yeni bağlantıdan sonra kapansa da terminal girdiye açılır.
        if (next.ready && next.live && !next.owned && next.vacant && claimed !== next.generation) {
          claimed = next.generation
          send({ type: 'take-control' })
        }
      }, () => { protocolFailed = true; ws.close() })
      stream = consumer
      setStatus(consumer.status)
      ws.onmessage = (event) => { if (typeof event.data === 'string') void consumer.receive(event.data) }
      ws.onclose = (event) => {
        if (disposed || socket !== ws) return
        // İnceleme bağlantısı replay kuyruğa alındıktan sonra kapanır; yazımlar kendi callback'leriyle biter.
        if (event.code === 1000 || protocolFailed) return
        consumer.dispose()
        term.options.disableStdin = true
        if (event.code === 1008) { setStatus({ ...consumer.status, message: 'Erişim reddedildi; bağlantı bilgilerini kontrol edin' }); return }
        const delay = [2000, 4000, 8000, 10000][Math.min(attempts++, 3)]
        setStatus({ ...consumer.status, message: `Bağlantı koptu · ${delay / 1000} sn sonra yeniden denenecek` })
        reconnect = setTimeout(connect, delay)
      }
    }
    connect()
    const input = term.onData((data) => {
      if (!canInput()) return
      for (const part of inputChunks(data)) {
        if (!canInput() || socket?.readyState !== WebSocket.OPEN) break
        if (socket.bufferedAmount > 1024 * 1024) {
          stream?.suspend('Girdi gönderimi yetişmiyor; kalan yapıştırma gönderilmedi')
          break
        }
        send({ type: 'input', data: part, generation: stream!.status.generation })
      }
    })
    actions.current = {
      history: () => {
        if (!stream?.status.ready || !stream.status.live || stream.status.historyLoaded) return
        stream.suspend('Geçmiş yükleniyor…')
        send({ type: 'request-scrollback' })
      },
      control: () => send({ type: 'take-control' }),
    }
    const observer = new ResizeObserver(resize)
    observer.observe(hostRef.current!)
    if (autoFocus) term.focus()
    return () => {
      disposed = true
      if (reconnect) clearTimeout(reconnect)
      observer.disconnect()
      input.dispose()
      stream?.dispose()
      socket?.close()
      termRef.current = null
      term.dispose()
    }
  }, [session.id, runId, daemonId, retry])

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = !stateHealthy || !status?.ready || !status.live || !status.owned
  }, [stateHealthy, status])

  const needsControl = Boolean(status?.ready && status.live && !status.owned)
  // Salt okunur kalma veya bağlantı mesajı kompakt şeritte de sürekli görünür.
  const attention = !stateHealthy || Boolean(status?.message) || needsControl
  return (
    <div className="terminal-pane">
      <div className={`terminal-status${compact ? ' compact' : ''}${attention ? ' attention' : ''}`} role="status">
        <span>{!stateHealthy ? 'Durum güncel değil · girdi kapalı' : status?.message || (status?.owned ? 'Kontrol sizde' : 'Salt okunur izleyici')}</span>
        {needsControl && <button onClick={() => actions.current.control()}>Kontrolü al</button>}
        {status?.ready && status.live && !status.historyLoaded && (
          <button title="Terminal geçmişini yükle" onClick={() => actions.current.history()}>
            {compact ? 'Geçmiş' : 'Terminal geçmişini yükle'}
          </button>
        )}
        <button title="Yeniden bağlan" aria-label="Yeniden bağlan" onClick={() => setRetry((value) => value + 1)}>
          {compact ? '↻' : 'Yeniden bağlan'}
        </button>
      </div>
      {!runId && <p>Bu oturumda henüz Run çalışmadı.</p>}
      <div ref={hostRef} className="term-host" />
    </div>
  )
}
