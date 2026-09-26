import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffFiles } from '../src/shared/diffFiles'
import { fileTree, hunkContext, intralineSpans, pairChanges, splitRows, treeOrder } from '../src/shared/diffLayout'
import { composeReviewMessage, locateComment, nextUnviewed, type ReviewComment } from '../src/shared/review'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@ export function greet()',
  ' const a = 1',
  '-const name = "dünya"',
  '-const b = 2',
  '+const name = "evren"',
  '+const b = 2',
  '+const c = 3',
  ' return a',
  '',
].join('\n')

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1', source: 'work', repo: '.', path: 'src/a.ts', side: 'new', startLine: 2, line: 2,
  snippet: ['const name = "evren"'], body: 'Adı sabite taşı', createdAt: 0, sentAt: null, ...over,
})

test('silme bloğu onu izleyen ekleme bloğuyla satır satır eşlenir, fazlası eşsiz kalır', () => {
  const [file] = diffFiles(PATCH)
  const pairs = pairChanges(file.lines)
  const index = (text: string) => file.lines.findIndex(line => line.text === text)
  assert.equal(pairs.get(index('-const name = "dünya"')), index('+const name = "evren"'))
  assert.equal(pairs.get(index('+const b = 2')), index('-const b = 2'))
  assert.equal(pairs.has(index('+const c = 3')), false)
})

test('yan yana görünüm silinenleri sola, eklenenleri sağa dağıtır; bağlam iki tarafta aynı satırdır', () => {
  const [file] = diffFiles(PATCH)
  const rows = splitRows(file.lines)
  assert.deepEqual(rows.map(row => row.kind === 'pair'
    ? [row.left === null ? null : file.lines[row.left].text, row.right === null ? null : file.lines[row.right].text]
    : row.kind), [
    'hunk',
    [' const a = 1', ' const a = 1'],
    ['-const name = "dünya"', '+const name = "evren"'],
    ['-const b = 2', '+const b = 2'],
    [null, '+const c = 3'],
    [' return a', ' return a'],
  ])
})

test('satır içi fark yalnız değişen kelimeyi işaretler; hiç benzemeyen satırlarda vurgu yoktur', () => {
  const spans = intralineSpans('const name = "dünya"', 'const name = "evren"')
  assert.deepEqual(spans, { old: [{ start: 14, end: 19 }], next: [{ start: 14, end: 19 }] })
  assert.equal(intralineSpans('return a', 'import { x } from "y"'), null)
})

test('hunk başlığındaki işlev bağlamı ayrılır', () => {
  assert.equal(hunkContext('@@ -1,4 +1,5 @@ export function greet()'), 'export function greet()')
  assert.equal(hunkContext('@@ -1 +1 @@'), '')
})

test('dosya ağacı tek çocuklu klasörleri birleştirir, klasörleri dosyalardan önce sıralar', () => {
  const tree = fileTree(['src/web/components/A.tsx', 'src/web/components/B.tsx', 'src/server/x.ts', 'README.md'])
  assert.deepEqual(tree.map(node => node.name), ['src', 'README.md'])
  assert.deepEqual(tree[0].children.map(node => node.name), ['server', 'web/components'])
  assert.deepEqual(tree[0].children[1].children.map(node => [node.name, node.file]), [['A.tsx', 0], ['B.tsx', 1]])
  assert.deepEqual(treeOrder(tree), [2, 0, 1, 3], 'liste ağaçtaki sırayı izler')
})

test('yorum kayıtlı satırında bulunur; satır kaydıysa aynı metinli en yakın satıra taşınır', () => {
  const files = diffFiles(PATCH)
  const at = locateComment(files, comment())
  assert.equal(files[0].lines[at!.index].text, '+const name = "evren"')
  const moved = locateComment(files, comment({ line: 40 }))
  assert.equal(files[0].lines[moved!.index].text, '+const name = "evren"')
  assert.equal(moved!.outdated, false)
})

test('metni farkta kalmayan yorum eskimiş işaretlenir, başka dosyadaki yorum bulunmaz', () => {
  const files = diffFiles(PATCH)
  assert.deepEqual(locateComment(files, comment({ snippet: ['silinmiş kod'] })), { file: 0, index: -1, outdated: true })
  assert.equal(locateComment(files, comment({ path: 'yok.ts' })), null)
})

test('silinen satıra yazılan yorum eski satır numarasıyla bulunur', () => {
  const files = diffFiles(PATCH)
  const at = locateComment(files, comment({ side: 'old', line: 2, startLine: 2, snippet: ['const name = "dünya"'] }))
  assert.equal(files[0].lines[at!.index].text, '-const name = "dünya"')
})

test('ajan mesajı notları konum, kod ve metinle numaralar; genel not ve talimat eklenir', () => {
  const message = composeReviewMessage([
    comment(),
    comment({ id: 'c2', startLine: 1, line: 3, snippet: ['a', 'b', 'c'], body: 'Satır 1\nSatır 2' }),
    comment({ id: 'c3', path: null, line: null, startLine: null, snippet: [], body: 'Testleri de güncelle', author: 'ayse' }),
  ], { context: 'PR #7', summary: 'Genel olarak iyi' })
  assert.equal(message, [
    'Kod incelemesinden 3 not (PR #7):',
    '1. src/a.ts:2\n   ```\n   const name = "evren"\n   ```\n   Adı sabite taşı',
    '2. src/a.ts:1-3\n   ```\n   a\n   b\n   c\n   ```\n   Satır 1\n   Satır 2',
    '3. Genel — @ayse (GitHub)\n   Testleri de güncelle',
    'Genel not: Genel olarak iyi',
    'Her notu ele al; bitince neyi nasıl değiştirdiğini not numaralarıyla kısaca yaz.',
  ].join('\n\n'))
})

test('alt depodaki silinen satır notu depo yolunu ve tarafı yazar', () => {
  const message = composeReviewMessage([comment({ repo: 'web', side: 'old', snippet: [] })])
  assert.match(message, /^Kod incelemesinden bir not:\n\n1\. web\/src\/a\.ts:2 \(silinen satır\)\n   Adı sabite taşı/)
})

test('sıradaki görülmemiş dosya bulunulan dosyadan sonra aranır, sonda başa döner, hepsi görüldüyse yoktur', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.equal(nextUnviewed(ids, new Set(['b']), 'a'), 'c')
  assert.equal(nextUnviewed(ids, new Set(['d']), 'c'), 'a')
  assert.equal(nextUnviewed(ids, new Set(), null), 'a')
  assert.equal(nextUnviewed(ids, new Set(['a', 'b', 'c', 'd']), 'b'), null)
  assert.equal(nextUnviewed(ids, new Set(['a', 'c', 'd']), 'b'), 'b', 'tek kalan kendisi olabilir')
})
