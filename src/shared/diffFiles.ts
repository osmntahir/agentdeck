export interface DiffLine { text: string; kind: 'add' | 'del' | 'context' | 'hunk' | 'meta'; old: number | null; next: number | null }
export interface DiffFile { path: string; lines: DiffLine[]; added: number; removed: number; binary: boolean; change: 'modified' | 'added' | 'deleted' | 'renamed' }

/** Git C-quoted paths include UTF-8 bytes encoded as octal. */
function pathText(raw: string): string {
  const value = raw.endsWith('\t') ? raw.slice(0, -1) : raw
  if (!value.startsWith('"')) return value
  const bytes: number[] = []
  const inside = value.slice(1, -1)
  for (let i = 0; i < inside.length;) {
    if (inside[i] === '\\') {
      const octal = inside.slice(i + 1).match(/^[0-7]{1,3}/)?.[0]
      if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length + 1; continue }
      const escaped: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' }
      bytes.push(...new TextEncoder().encode(escaped[inside[i + 1]] ?? inside[i + 1])); i += 2
    } else {
      const point = String.fromCodePoint(inside.codePointAt(i)!)
      bytes.push(...new TextEncoder().encode(point)); i += point.length
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function diffFiles(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let old = 0; let next = 0; let inHunk = false
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const header = text.slice(11)
      const destination = header.match(/ ("b\/.*"|b\/.*)$/)?.[1]
      file = { path: destination ? pathText(destination).slice(2) : header, lines: [], added: 0, removed: 0, binary: false, change: 'modified' }
      files.push(file); inHunk = false
      continue
    }
    if (!file) continue
    if (!inHunk && (text.startsWith('new file mode') || text === '--- /dev/null')) file.change = 'added'
    if (!inHunk && (text.startsWith('deleted file mode') || text === '+++ /dev/null')) file.change = 'deleted'
    if (!inHunk && text.startsWith('rename from ')) file.change = 'renamed'
    if (!inHunk && text.startsWith('+++ ') && text.slice(4) !== '/dev/null') file.path = pathText(text.slice(4)).replace(/^b\//, '')
    if (!inHunk && text.startsWith('--- ') && text.slice(4) !== '/dev/null') file.path = pathText(text.slice(4)).replace(/^a\//, '')
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true }
    const kind = hunk ? 'hunk' : !inHunk ? 'meta' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : text.startsWith(' ') ? 'context' : 'meta'
    const line: DiffLine = { text, kind, old: null, next: null }
    if (kind === 'add') { file.added++; line.next = next++ }
    if (kind === 'del') { file.removed++; line.old = old++ }
    if (kind === 'context') { line.old = old++; line.next = next++ }
    if (text.startsWith('Binary files ') || text === 'GIT binary patch') file.binary = true
    if (text !== '') file.lines.push(line)
  }
  return files
}
