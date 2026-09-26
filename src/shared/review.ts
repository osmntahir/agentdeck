import type { DiffFile } from './diffFiles'
import { codeText } from './diffLayout'

/** Yorumun bağlandığı taraf: yeni kod (eklenen/bağlam) veya yalnız eski kodda kalan silinmiş satır. */
export type ReviewSide = 'new' | 'old'

/**
 * Kullanıcının incelemede yazdığı not veya GitHub'dan alınıp ajana iletilecek
 * yorum. Satır numarası farkın o anki hâline göredir; fark değişince yorum
 * snippet ile yeniden bulunur, bulunamazsa "eskimiş" gösterilir ama silinmez.
 */
export interface ReviewComment {
  id: string
  /** Yazıldığı fark: `work`, `uncommitted` veya `pr:<numara>`. */
  source: string
  /** Oturum çalışma dizinine göre depo yolu; git projesinde ".". */
  repo: string
  /** null: dosyaya bağlı olmayan genel not. */
  path: string | null
  side: ReviewSide
  /** Aralığın ilk ve son satırı; dosya düzeyi notta null. */
  startLine: number | null
  line: number | null
  /** Yorumlanan satırların kod metni; yeniden konumlandırma ve ajan mesajı için. */
  snippet: string[]
  body: string
  createdAt: number
  /** Ajana iletildiği an; iletilmemişse null. */
  sentAt: number | null
  /** GitHub incelemesi olarak yayımlandığı an. */
  publishedAt?: number | null
  /** GitHub'dan alınmış yorumun yazarı; kullanıcının kendi notunda yok. */
  author?: string
  url?: string
}

export interface CommentLocation { file: number; index: number; outdated: boolean }

/**
 * Yorumun fark içindeki yeri. Önce kayıtlı satır numarası ve metin birlikte
 * denenir; metin başka satıra kaymışsa en yakın aynı metinli satır seçilir.
 * Metin hiç yoksa yorum eski satır numarasına değil, dosyanın başına bağlanır.
 */
export function locateComment(files: DiffFile[], comment: ReviewComment): CommentLocation | null {
  if (comment.path === null) return null
  const file = files.findIndex(candidate => candidate.path === comment.path)
  if (file === -1) return null
  const lines = files[file].lines
  if (comment.line === null) return { file, index: -1, outdated: false }
  const numberOf = (i: number) => comment.side === 'new' ? lines[i].next : lines[i].kind === 'del' ? lines[i].old : null
  const target = comment.snippet[comment.snippet.length - 1]
  const matches = (i: number) => target === undefined || codeText(lines[i]) === target
  const exact = lines.findIndex((_, i) => numberOf(i) === comment.line)
  if (exact !== -1 && matches(exact)) return { file, index: exact, outdated: false }
  let best = -1
  lines.forEach((_, i) => {
    if (numberOf(i) === null || !matches(i)) return
    if (best === -1 || Math.abs(numberOf(i)! - comment.line!) < Math.abs(numberOf(best)! - comment.line!)) best = i
  })
  if (best !== -1) return { file, index: best, outdated: false }
  return { file, index: -1, outdated: true }
}

/** Yorum sayısına göre doğal Türkçe başlık. */
function heading(comments: ReviewComment[], context: string): string {
  const from = context ? ` (${context})` : ''
  return comments.length === 1 ? `Kod incelemesinden bir not${from}:` : `Kod incelemesinden ${comments.length} not${from}:`
}

function location(comment: ReviewComment): string {
  if (comment.path === null) return 'Genel'
  const repo = comment.repo === '.' ? '' : `${comment.repo}/`
  if (comment.line === null) return `${repo}${comment.path}`
  const range = comment.startLine !== null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : `${comment.line}`
  return `${repo}${comment.path}:${range}${comment.side === 'old' ? ' (silinen satır)' : ''}`
}

const MAX_SNIPPET_LINES = 12

/**
 * Ajan terminaline yapıştırılacak düz metin. Her not konumu, yorumlanan kod ve
 * notun kendisiyle numaralanır; ajan yanıtında aynı numaralara atıf yapabilir.
 */
export function composeReviewMessage(comments: ReviewComment[], options: { context?: string; summary?: string } = {}): string {
  const parts: string[] = []
  const summary = options.summary?.trim()
  if (comments.length > 0) parts.push(heading(comments, options.context ?? ''))
  else if (summary) parts.push(`Kod incelemesi${options.context ? ` (${options.context})` : ''}:`)
  comments.forEach((comment, index) => {
    const lines = [`${index + 1}. ${location(comment)}${comment.author ? ` — @${comment.author} (GitHub)` : ''}`]
    const snippet = comment.snippet.slice(-MAX_SNIPPET_LINES)
    if (snippet.length > 0) {
      lines.push('   ```')
      if (comment.snippet.length > snippet.length) lines.push('   …')
      for (const code of snippet) lines.push(`   ${code}`)
      lines.push('   ```')
    }
    for (const text of comment.body.trim().split('\n')) lines.push(`   ${text}`)
    parts.push(lines.join('\n'))
  })
  if (summary) parts.push(comments.length > 0 ? `Genel not: ${summary}` : summary)
  if (comments.length > 0) {
    parts.push(comments.length === 1
      ? 'Bu notu ele al; bitince ne değiştirdiğini kısaca yaz.'
      : 'Her notu ele al; bitince neyi nasıl değiştirdiğini not numaralarıyla kısaca yaz.')
  }
  return parts.join('\n\n')
}

/** Fark kaynağının kullanıcıya görünen adı. */
export function sourceLabel(source: string): string {
  if (source === 'work') return 'bu çalışma'
  if (source === 'uncommitted') return 'commit edilmemiş değişiklikler'
  if (source.startsWith('pr:')) return `PR #${source.slice(3)}`
  return source
}

/**
 * Sıradaki görülmemiş dosya: bulunulan dosyadan sonra gelen ilk görülmemiş,
 * yoksa baştan aranır. Hepsi görüldüyse null.
 */
export function nextUnviewed(ids: string[], viewed: Set<string>, current: string | null): string | null {
  const start = current === null ? -1 : ids.indexOf(current)
  for (let step = 1; step <= ids.length; step++) {
    const id = ids[(start + step + ids.length) % ids.length]
    if (!viewed.has(id)) return id
  }
  return null
}
