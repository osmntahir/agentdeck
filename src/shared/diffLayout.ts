import type { DiffFile, DiffLine } from './diffFiles'

/** Satır içindeki değişmiş aralık; başlangıç dahil, bitiş hariç, önek karakteri sayılmaz. */
export interface Span { start: number; end: number }

/** Satırın önek karakteri (+, -, boşluk) atılmış kod metni. */
export function codeText(line: DiffLine): string {
  return line.kind === 'add' || line.kind === 'del' || line.kind === 'context' ? line.text.slice(1) : line.text
}

/**
 * Silinen ve eklenen blokların satır satır eşi. Bir silme bloğunu hemen izleyen
 * ekleme bloğu aynı kodun yeni hâli sayılır; fazlası eşsiz kalır.
 */
export function pairChanges(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>()
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== 'del') { i++; continue }
    const delStart = i
    while (i < lines.length && lines[i].kind === 'del') i++
    const addStart = i
    while (i < lines.length && lines[i].kind === 'add') i++
    const count = Math.min(addStart - delStart, i - addStart)
    for (let k = 0; k < count; k++) {
      pairs.set(delStart + k, addStart + k)
      pairs.set(addStart + k, delStart + k)
    }
  }
  return pairs
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu
/** Uzun satırda LCS tablosu büyür; sınırı aşan eşte vurgulama yapılmaz, satır bütün olarak işaretli kalır. */
const MAX_CELLS = 40_000

/**
 * İki satırın kelime düzeyinde farkı. Satırlar birbirine hiç benzemiyorsa
 * (ortak kısım metnin yarısından azsa) vurgulama gürültü olacağından boş döner.
 */
export function intralineSpans(before: string, after: string): { old: Span[]; next: Span[] } | null {
  const a = before.match(TOKEN) ?? []
  const b = after.match(TOKEN) ?? []
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) return null
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const keepA = new Array<boolean>(a.length).fill(false)
  const keepB = new Array<boolean>(b.length).fill(false)
  let common = 0
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keepA[i] = keepB[j] = true; common += a[i].length; i++; j++ }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++
    else j++
  }
  if (common * 2 < Math.max(before.length, after.length)) return null
  return { old: spansOf(a, keepA), next: spansOf(b, keepB) }
}

function spansOf(tokens: string[], keep: boolean[]): Span[] {
  const spans: Span[] = []
  let offset = 0
  tokens.forEach((token, index) => {
    const end = offset + token.length
    if (!keep[index]) {
      const last = spans[spans.length - 1]
      if (last && last.end === offset) last.end = end
      else spans.push({ start: offset, end })
    }
    offset = end
  })
  return spans
}

/**
 * Git başlık satırları dosya başlığındaki rozet ve sayılarla özetlenir;
 * yalnız "\ No newline at end of file" gibi içerik notları gösterilir.
 */
export function isShownMeta(line: DiffLine): boolean {
  return line.kind !== 'meta' || line.text.startsWith('\\')
}

/** Yan yana görünümün tek satırı: hunk başlığı iki tarafı birden kaplar. */
export type SplitRow =
  | { kind: 'hunk'; index: number }
  | { kind: 'meta'; index: number }
  | { kind: 'pair'; left: number | null; right: number | null }

/** Birleşik satır dizisini sol (eski) ve sağ (yeni) sütunlara dağıtır; indeksler `lines` içindedir. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  for (let i = 0; i < lines.length;) {
    const kind = lines[i].kind
    if (kind === 'meta' && !isShownMeta(lines[i])) { i++; continue }
    if (kind === 'hunk' || kind === 'meta') { rows.push({ kind, index: i }); i++; continue }
    if (kind === 'context') { rows.push({ kind: 'pair', left: i, right: i }); i++; continue }
    const dels: number[] = []
    const adds: number[] = []
    while (i < lines.length && lines[i].kind === 'del') dels.push(i++)
    while (i < lines.length && lines[i].kind === 'add') adds.push(i++)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ kind: 'pair', left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return rows
}

/** Hunk başlığındaki işlev bağlamı: `@@ -1,2 +1,3 @@ function foo()` → `function foo()`. */
export function hunkContext(text: string): string {
  return text.replace(/^@@ [^@]* @@ ?/, '')
}

export interface TreeNode {
  /** Tek çocuklu klasörler birleşik yazılır: `src/web/components`. */
  name: string
  path: string
  children: TreeNode[]
  /** Yalnız dosya düğümünde; `files` dizisindeki indeks. */
  file?: number
}

/** Değişen dosya yollarından klasör ağacı; klasörler önce, sonra ada göre sıralı. */
export function fileTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  paths.forEach((full, file) => {
    const parts = full.split('/')
    let node = root
    parts.forEach((part, depth) => {
      const path = parts.slice(0, depth + 1).join('/')
      if (depth === parts.length - 1) { node.children.push({ name: part, path, children: [], file }); return }
      let next = node.children.find(child => child.file === undefined && child.name === part)
      if (!next) { next = { name: part, path, children: [] }; node.children.push(next) }
      node = next
    })
  })
  const compact = (node: TreeNode): TreeNode => {
    let current = node
    while (current.file === undefined && current.children.length === 1 && current.children[0].file === undefined) {
      const child = current.children[0]
      current = { ...child, name: `${current.name}/${child.name}` }
    }
    const children = current.children.map(compact).sort((x, y) =>
      Number(x.file !== undefined) - Number(y.file !== undefined) || x.name.localeCompare(y.name))
    return { ...current, children }
  }
  return root.children.map(compact).sort((x, y) =>
    Number(x.file !== undefined) - Number(y.file !== undefined) || x.name.localeCompare(y.name))
}

/** Dosya kimliği depo ve yol birleşimidir; aynı yol iki alt depoda olabilir. */
export function fileKey(repo: string, file: Pick<DiffFile, 'path'>): string {
  return `${repo}\u0000${file.path}`
}

/** Ağaçta yukarıdan aşağı görünen dosya sırası; liste ve j/k gezintisi ağaçla aynı sırayı izler. */
export function treeOrder(nodes: TreeNode[]): number[] {
  return nodes.flatMap(node => node.file !== undefined ? [node.file] : treeOrder(node.children))
}
