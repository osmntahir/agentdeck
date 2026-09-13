import { Terminal } from '@xterm/headless'
import type { ITerminalAddon } from '@xterm/headless'

/**
 * Ekranın tek doğru kaynağı (spec §4). Daemon her canlı Run için headless bir
 * xterm tutar; istemcinin gördüğü her şey bu durumdan çıkar.
 *
 * İki mekanizma birlikte zorunludur ve ayrı ayrı bozuk ekran üretir:
 *   1. Güvenli kesim — emülatöre yalnız tamamlanmış kontrol dizilerine kadar
 *      veri verilir; serialize parser'ın yarım kalan durumunu taşımaz.
 *   2. Bekletilen prefix — yarım kalan dizi tüketilmez, bir sonraki tamamlanan
 *      parçanın başında taşınır. Böylece snapshot'tan devam eden istemci ile
 *      kesintisiz izleyen istemci birebir aynı girdiyi görür.
 */

/** Bekleyen prefix üst sınırı; aşılırsa doğru olmayan snapshot yayımlanmaz. */
export const MAX_PENDING_BYTES = 4096

export const PREVIEW_LINES = 8
export const PREVIEW_BYTES = 2048

/** Her headless terminal en çok bu kadar normal scrollback satırı tutar. */
export const SCROLLBACK_LINES = 1000

export const MIN_COLS = 2
export const MAX_COLS = 300
export const MIN_ROWS = 1
export const MAX_ROWS = 120

/** Snapshot biçimi; checkpoint doğrulaması ve istemci uyumu buna bakar. */
export const FORMAT_VERSION = 1

export type SnapshotScope = 'screen' | 'scrollback'

export interface Snapshot {
  text: string
  scope: SnapshotScope
  cols: number
  rows: number
  formatVersion: number
  totalBytes: number
}

export interface Preview {
  text: string
  truncated: boolean
  capturedAt: number
}

/** Temsil hatası. Ekran kurulamıyorsa sahte snapshot üretmek yerine bu döner. */
export interface TerminalFailure {
  code: 'pending_overflow' | 'engine_error'
  message: string
}

export class TerminalRepresentationError extends Error {
  constructor(readonly failure: TerminalFailure) {
    super(failure.message)
    this.name = 'TerminalRepresentationError'
  }
}

/**
 * Cevap üreten, ekrana hiçbir şey çizmeyen diziler. Giden akıştan ayıklanırlar:
 * tarayıcı terminali otomatik cevap üretmez, dolayısıyla onun ürettiği her şey
 * gerçek kullanıcı girdisidir. Cevabın tek sahibi daemon'daki terminaldir.
 */
const QUERY_SEQUENCES = new RegExp(
  [
    '(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[cn]',
    '(?:\\x1b\\[|\\x9b)>[0-9;]*q',
    '(?:\\x1b\\[|\\x9b)\\??[0-9;]*\\$p',
    '(?:\\x1bP|\\x90)\\+q[0-9a-fA-F;]*(?:\\x1b\\\\|\\x9c)',
    '(?:\\x1bP|\\x90)[0-9;]*\\$q[^\\x1b\\x9c]*(?:\\x1b\\\\|\\x9c)',
  ].join('|'), 'g',
)

/** Remove query slots, preserving palette changes within the same OSC. */
export function stripQueries(text: string): string {
  return text.replace(QUERY_SEQUENCES, '').replace(
    /(\x1b\]|\x9d)(4|10|11|12);([^\x07\x1b\x9c]*)(\x07|\x1b\\|\x9c)/g,
    (whole: string, begin: string, command: string, body: string, end: string) => {
      if (!body.split(';').includes('?')) return whole
      const slots = body.split(';')
      if (command === '4') {
        const kept: string[] = []
        for (let i = 0; i + 1 < slots.length; i += 2) {
          if (slots[i + 1] !== '?') kept.push(slots[i], slots[i + 1])
        }
        return kept.length ? `${begin}4;${kept.join(';')}${end}` : ''
      }
      return slots.map((value, i) => value !== '?' && Number(command) + i <= 12
        ? `${begin}${Number(command) + i};${value}${end}` : '').join('')
    },
  )
}

type ScanState = 'ground' | 'esc' | 'csi' | 'string' | 'string-esc' | 'charset'

/**
 * İleri yönlü güvenli kesim tarayıcısı. Akış boyunca yaşayan bir parser durumu
 * tutar ve son *tamamlanmış* dizinin bittiği sınırı bildirir. Geriye dönük "son
 * ESC'i bul" yaklaşımı yanıltıcıdır: ST ile biten bir OSC'nin ESC'i tam kesim
 * noktasına denk geldiğinde yarım diziyi tam sanır.
 */
export class CutScanner {
  private state: ScanState = 'ground'
  private carry = ''
  private osc = false

  /** Tamamlanmış kısım ile bir sonrakine devredilen yarım prefix. */
  feed(chunk: string): { complete: string; pending: string } {
    const buffer = this.carry + chunk
    let completeEnd = this.state === 'ground' ? this.carry.length : 0

    for (let i = this.carry.length; i < buffer.length; i++) {
      const code = buffer.charCodeAt(i)

      // CAN/SUB her diziyi iptal eder ve tabana döner.
      if (code === 0x18 || code === 0x1a) {
        this.state = 'ground'
        completeEnd = i + 1
        continue
      }

      switch (this.state) {
        case 'ground':
          if (code === 0x1b) this.state = 'esc'
          else if (code === 0x9b) this.state = 'csi'
          else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = 'string'; this.osc = code === 0x9d }
          else completeEnd = i + 1
          break

        case 'esc': {
          const ch = buffer[i]
          if (code === 0x1b) break
          if (code < 0x20) break
          if (ch === '[') this.state = 'csi'
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') { this.state = 'string'; this.osc = ch === ']' }
          else if (code >= 0x20 && code <= 0x2f) {
            this.state = 'charset'
          } else {
            // Tek karakterli ESC dizisi (ESC 7, ESC =, ...) burada tamamlanır.
            this.state = 'ground'
            completeEnd = i + 1
          }
          break
        }

        case 'csi':
          if (code === 0x1b) { this.state = 'esc'; break }
          // Parametre (0x30-0x3f) ve ara bayt (0x20-0x2f) sonrası final 0x40-0x7e.
          if (code >= 0x40 && code <= 0x7e) {
            this.state = 'ground'
            completeEnd = i + 1
          }
          break

        case 'string':
          if ((code === 0x07 && this.osc) || code === 0x9c) {
            this.state = 'ground'
            completeEnd = i + 1
          } else if (code === 0x1b) {
            this.state = 'string-esc'
          }
          break

        case 'string-esc':
          if (buffer[i] === '\\') {
            this.state = 'ground'
            completeEnd = i + 1
          } else {
            // ESC dizgiyi iptal eder ve yeni bir dizi başlatır; bu karakteri
            // ESC sonrası ilk karakter gibi yeniden değerlendiririz.
            this.state = 'esc'
            i -= 1
          }
          break

        case 'charset':
          if (code === 0x1b) { this.state = 'esc'; break }
          if (code < 0x30) break
          this.state = 'ground'
          completeEnd = i + 1
          break
      }
    }

    const complete = buffer.slice(0, completeEnd)
    this.carry = buffer.slice(completeEnd)
    return { complete, pending: this.carry }
  }

  get pending(): string {
    return this.carry
  }
}

interface SerializeOptions {
  scrollback?: number
}

interface Serializer extends ITerminalAddon {
  serialize(options?: SerializeOptions): string
}

// Addon'ın kendi typing'i tarayıcı Terminal'ine bağlıdır; sunucu tarafında
// yalnız kullandığımız yüzeyi tanımlarız.
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: new () => Serializer }

export interface TerminalStateOptions {
  cols: number
  rows: number
  /** Emülatörün sorgulara ürettiği cevap; PTY'ye yazılır, aktivite saymaz. */
  onReply?: (data: string) => void
}

export function clampCols(cols: number): number {
  return Math.min(MAX_COLS, Math.max(MIN_COLS, (Number.isFinite(cols) ? Math.floor(cols) : 120)))
}

export function clampRows(rows: number): number {
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, (Number.isFinite(rows) ? Math.floor(rows) : 32)))
}

/**
 * Metni bayt bütçesine göre parçalar. Kesim ne UTF-8 kod noktasını ne de JS
 * vekil çiftini böler: bölünmüş bir kod noktası ekranda replacement karakteri
 * üretir (ölçüldü, docs/research/terminal-state-validation.md).
 */
export function chunkText(text: string, maxBytes: number): string[] {
  if (text === '') return []
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let bytes = 0
    while (end < text.length) {
      const code = text.charCodeAt(end)
      const isLead = code >= 0xd800 && code <= 0xdbff
      const width = isLead ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
      if (bytes + width > maxBytes && end > start) break
      bytes += width
      end += isLead ? 2 : 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/** UTF-8 bütçesinde keser; kod noktasını ve vekil çiftini bölmez. */
function truncateToBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text
  let cut = Buffer.from(text).subarray(0, limit).toString('utf8')
  // Yarım kalan kod noktası replacement karakteri üretir; onu at.
  if (cut.endsWith('�') && !text.startsWith(cut)) cut = cut.slice(0, -1)
  return cut
}

export class TerminalState {
  private readonly term: Terminal
  private readonly serializer: Serializer
  private readonly scanner = new CutScanner()
  private failed: TerminalFailure | null = null

  constructor(options: TerminalStateOptions) {
    this.term = new Terminal({
      cols: clampCols(options.cols),
      rows: clampRows(options.rows),
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
    if (options.onReply) {
      const onReply = options.onReply
      this.term.onData((data) => onReply(data))
    }
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  get failure(): TerminalFailure | null {
    return this.failed
  }

  /**
   * Ham PTY parçasını işler. Dönen metin izleyiciye gidecek olandır: yalnız
   * tamamlanmış diziler ve sorgular ayıklanmış hâlde. Söz, write callback'i
   * dönmeden çözülmez; temsil işlenmeden "işlendi" denmez.
   */
  async write(chunk: string): Promise<{ text: string }> {
    if (this.failed || chunk === '') return { text: '' }

    const { complete, pending } = this.scanner.feed(chunk)
    if (Buffer.byteLength(pending) > MAX_PENDING_BYTES) {
      this.fail({
        code: 'pending_overflow',
        message: `Yarım kalan kontrol dizisi ${MAX_PENDING_BYTES} bayt sınırını aştı; terminal temsili kuruldu sayılmaz`,
      })
      return { text: '' }
    }
    if (complete === '') return { text: '' }

    try {
      await new Promise<void>((resolve) => this.term.write(complete, resolve))
    } catch (err) {
      this.fail({ code: 'engine_error', message: `Terminal emülatörü hata verdi: ${(err as Error).message}` })
      return { text: '' }
    }
    return { text: stripQueries(complete) }
  }

  /** Önce emülatöre uygulanır; PTY'yi çağıran sonra boyutlandırır. */
  resize(cols: number, rows: number): void {
    if (this.failed) return
    this.term.resize(clampCols(cols), clampRows(rows))
  }

  snapshot(scope: SnapshotScope): Snapshot {
    if (this.failed) throw new TerminalRepresentationError(this.failed)
    const text = this.serializer.serialize({ scrollback: scope === 'screen' ? 0 : SCROLLBACK_LINES })
    return {
      text,
      scope,
      cols: this.term.cols,
      rows: this.term.rows,
      formatVersion: FORMAT_VERSION,
      totalBytes: Buffer.byteLength(text),
    }
  }

  /**
   * Kart önizlemesi: görünür viewport'un son boş olmayan satırları. Hücre
   * boşlukları korunur; ANSI silme yolu yoktur.
   */
  preview(): Preview {
    if (this.failed) throw new TerminalRepresentationError(this.failed)
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < this.term.rows; i++) {
      lines.push(buffer.getLine(buffer.baseY + i)?.translateToString(true).trimEnd() ?? '')
    }
    const visible = lines.filter((line) => line.trim() !== '').slice(-PREVIEW_LINES)
    const joined = visible.join('\n')
    const text = truncateToBytes(joined, PREVIEW_BYTES)
    return { text, truncated: text.length !== joined.length, capturedAt: Date.now() }
  }

  dispose(): void {
    this.term.dispose()
  }

  private fail(failure: TerminalFailure): void {
    this.failed = failure
  }
}
