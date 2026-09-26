import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { startDaemon } from '../../dist/server/daemon.js'

/**
 * İnceleme ekranının duman testi: izole oturumun farkı açılır, satır ve aralık
 * notu yazılır, notlar ajana (girdiyi dosyaya yazan sahte ajan) gönderilir,
 * sonra sahte gh ile PR incelemesi ve GitHub yorumunun iletilmesi denenir.
 * SHOTS=dizin verilirse ekran görüntüleri kaydedilir.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-review-'))
const repo = path.join(root, 'project')
const shots = process.env.SHOTS
fs.mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
git('init', '-b', 'main')
fs.mkdirSync(path.join(repo, 'src', 'server'), { recursive: true })
fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n\nKısa açıklama.\n')
fs.writeFileSync(path.join(repo, 'src', 'server', 'greet.ts'), [
  'export function greet(name: string): string {',
  '  const prefix = "Merhaba"',
  '  return `${prefix}, ${name}!`',
  '}',
  '',
  'export function farewell(name: string): string {',
  '  return `Hoşça kal, ${name}`',
  '}',
  '',
].join('\n'))
git('add', '.')
git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture')

// Sahte gh: PR #42 ve bir satır yorumu döner.
const bin = path.join(root, 'bin')
fs.mkdirSync(bin)
const prDiff = [
  'diff --git a/src/server/greet.ts b/src/server/greet.ts',
  '--- a/src/server/greet.ts',
  '+++ b/src/server/greet.ts',
  '@@ -1,4 +1,5 @@ export function greet(name: string): string {',
  ' export function greet(name: string): string {',
  '-  const prefix = "Merhaba"',
  '+  const prefix = "Selam"',
  '+  if (!name) throw new Error("ad gerekli")',
  '   return `${prefix}, ${name}!`',
  ' }',
  '',
].join('\n')
const summary = { number: 42, title: 'Selamlama metnini değiştir', url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'feat/selam', author: { login: 'ayse' }, additions: 2, deletions: 1, changedFiles: 1, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-09-25T10:00:00Z' }
fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify({ ...summary, body: 'Selamlamayı kısalttım ve boş ad kontrolü ekledim.', headRefOid: 'a'.repeat(40), comments: [{ author: { login: 'can' }, body: 'CHANGELOG da güncellenmeli.', createdAt: '2026-09-25T11:00:00Z', url: 'https://github.com/o/r/pull/42#c1' }], reviews: [] }))
fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([summary]))
fs.writeFileSync(path.join(root, 'diff.txt'), prDiff)
fs.writeFileSync(path.join(root, 'comment.json'), JSON.stringify({ id: 901, path: 'src/server/greet.ts', line: 3, start_line: null, side: 'RIGHT', body: 'Hata mesajı İngilizce olsun.', user: 'deniz', created_at: '2026-09-25T12:00:00Z', html_url: 'https://github.com/o/r/pull/42#r901', in_reply_to_id: null }))
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;
  "pr list") if [[ "$*" == *"--head"* ]]; then echo '[]'; else cat '${root}/list.json'; fi ;;
  "pr view") cat '${root}/pr.json' ;;
  "pr diff") cat '${root}/diff.txt' ;;
  "api --paginate") cat '${root}/comment.json'; echo ;;
  "api --method") cat > '${root}/review-body.json'; echo '{"html_url":"https://github.com/o/r/pull/42#review"}' ;;
  *) echo "beklenmeyen: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`

const inbox = path.join(root, 'agent-input.txt')
const daemon = await startDaemon({ dataDir: path.join(root, 'data'), port: 0, serveWeb: true })
const executablePath = process.env.CHROME_BIN || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
let browser
try {
  const post = async (route, body) => {
    const response = await fetch(`${daemon.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentdeck-Token': daemon.token }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const project = await post('projects', { path: repo })
  // Sahte ajan: yapıştırılan her şeyi dosyaya yazar.
  const session = await post('sessions', { projectId: project.id, name: 'Selamlama', command: `sh -c 'stty -echo raw; cat > ${inbox}'`, isolation: 'worktree' })
  fs.writeFileSync(path.join(session.cwd, 'src', 'server', 'greet.ts'), [
    'export function greet(name: string): string {',
    '  const prefix = "Selam"',
    '  if (!name) throw new Error("ad gerekli")',
    '  return `${prefix}, ${name}!`',
    '}',
    '',
    'export function farewell(name: string, formal = false): string {',
    '  return formal ? `Güle güle, ${name}` : `Hoşça kal, ${name}`',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(session.cwd, 'src', 'server', 'names.ts'), 'export const NAMES = ["Ayşe", "Can", "Deniz"]\n')
  fs.rmSync(path.join(session.cwd, 'README.md'))

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-3d-apis'] })
  const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH || 1440), height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.setDefaultTimeout(10000)
  await page.goto(`${daemon.url}/?token=${daemon.token}`)
  await page.locator(`#session-row-${session.id}`).click()
  await page.getByRole('button', { name: 'Selamlama değişiklikleri' }).click()
  await page.waitForSelector('.diff-file')

  // Ağaç, dosya sayısı ve satır içi vurgu.
  assert.equal(await page.locator('.diff-file').count(), 3)
  assert.deepEqual(await page.locator('.tree-file .tree-name').allTextContents(), ['greet.ts', 'names.ts', 'README.md'])
  assert.ok(await page.locator('mark.word-add').count() > 0, 'satır içi vurgu var')
  if (shots) await page.screenshot({ path: path.join(shots, '1-unified.png') })

  // Aralık notu: satır 2'de +, Shift ile satır 3.
  const line = (n) => page.locator('.diff-file').first().locator('.dl.add').nth(n)
  await line(0).hover()
  await line(0).locator('.line-comment').click()
  await line(1).hover()
  await line(1).locator('.line-comment').click({ modifiers: ['Shift'] })
  await page.locator('.review-composer textarea').fill('Selam yerine "Merhaba" kalsın; boş ad kontrolünü ayrı fonksiyona al.')
  if (shots) await page.screenshot({ path: path.join(shots, '2-composer.png') })
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('.review-card.mine')
  assert.match(await page.locator('.review-card.mine').textContent(), /satır 2–3/)

  // Dosyaya genel not ve görüldü işareti.
  await page.locator('.diff-file').nth(1).getByRole('button', { name: 'Dosyaya not ekle' }).click()
  await page.locator('.review-composer textarea').fill('İsim listesini sabitler dosyasına taşı.')
  await page.getByRole('button', { name: 'Not ekle', exact: true }).click()
  await page.locator('.diff-file').nth(2).locator('.viewed-toggle input').check()
  assert.match(await page.locator('.viewed-progress').textContent(), /1\/3/)
  assert.equal(await page.locator('.review-item').count(), 2)

  // Yan yana düzen.
  await page.getByRole('button', { name: 'Yan yana', exact: true }).click()
  await page.waitForSelector('.diff-split .split-row')
  if (shots) await page.screenshot({ path: path.join(shots, '3-split.png') })
  await page.getByRole('button', { name: 'Birleşik', exact: true }).click()

  // Ajana gönder: önizleme, gönder, sahte ajan metni aldı.
  await page.getByRole('button', { name: /Ajana gönder \(2\)/ }).click()
  const preview = await page.locator('.send-preview').inputValue()
  assert.match(preview, /^Kod incelemesinden 2 not:/)
  assert.match(preview, /src\/server\/greet\.ts:2-3/)
  if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, '4-send.png') }) }
  await page.getByRole('button', { name: 'Gönder', exact: true }).click()
  await page.waitForSelector('.review-status')
  const deadline = Date.now() + 5000
  while (!(fs.existsSync(inbox) && fs.readFileSync(inbox, 'utf8').includes('\x1b[201~\r')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  const received = fs.readFileSync(inbox, 'utf8')
  assert.ok(received.startsWith('\x1b[200~Kod incelemesinden 2 not:'), JSON.stringify(received.slice(0, 60)))
  assert.ok(received.endsWith('\x1b[201~\r'), 'Enter basıldı')
  assert.equal(await page.locator('.review-item:not([data-sent])').count(), 0, 'gönderilen notlar taslaktan çıktı')

  // Notlar yeniden açılışta korunur.
  await page.reload()
  await page.locator(`#session-row-${session.id}`).click()
  await page.getByRole('button', { name: 'Selamlama değişiklikleri' }).click()
  await page.waitForSelector('.review-card.mine[data-sent]')

  // PR incelemesi: listeden PR #42, GitHub yorumu satırında, iletme ve yayımlama.
  await page.getByRole('button', { name: 'PR seç' }).click()
  await page.getByRole('menuitem', { name: /#42 Selamlama/ }).click()
  await page.waitForSelector('.pr-header')
  assert.match(await page.locator('.pr-header h2').textContent(), /Selamlama metnini değiştir/)
  assert.match(await page.locator('.review-card.github').first().textContent(), /Hata mesajı İngilizce olsun/)
  await page.getByRole('button', { name: 'Ajana iletilecek notlara ekle' }).click()
  assert.equal(await page.locator('.review-card.mine').count(), 0, 'iletilen GitHub yorumu satırda tekrar çizilmez')
  await page.getByRole('button', { name: 'Notlara ekle' }).click()
  const prLine = page.locator('.diff-file .dl.add').first()
  await prLine.hover()
  await prLine.locator('.line-comment').click()
  await page.locator('.review-composer textarea').fill('Selam fazla samimi.')
  await page.keyboard.press('Control+Enter')
  if (shots) await page.screenshot({ path: path.join(shots, '5-pr.png') })
  await page.getByRole('button', { name: /Ajana gönder \(3\)/ }).click()
  const prPreview = await page.locator('.send-preview').inputValue()
  assert.match(prPreview, /^Kod incelemesinden 3 not \(PR #42\):/)
  assert.match(prPreview, /@deniz \(GitHub\)/)
  assert.match(prPreview, /CHANGELOG/)
  await page.getByLabel(/1 notu PR #42 üzerinde/).check()
  await page.getByRole('button', { name: 'Gönder', exact: true }).click()
  await page.waitForFunction(() => /GitHub'da yayımlandı/.test(document.querySelector('.review-status')?.textContent ?? ''))
  const review = JSON.parse(fs.readFileSync(path.join(root, 'review-body.json'), 'utf8'))
  assert.deepEqual(review.comments, [{ path: 'src/server/greet.ts', body: 'Selam fazla samimi.', line: 2, side: 'RIGHT' }], 'yalnız kullanıcının kendi notu yayımlanır')
  assert.equal(review.commit_id, 'a'.repeat(40))

  // Paneldeki başka kaynağa ait not o farkı açar ve karta kayar.
  await page.getByRole('button', { name: /Ajana gidenler/ }).click()
  await page.locator('.review-item', { hasText: 'greet.ts:2–3' }).locator('.review-item-main').click()
  await page.waitForSelector('.review-card.mine:has-text("Selam yerine")')
  assert.equal(await page.getByRole('button', { name: 'Bu çalışma' }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.pr-header').count(), 0)

  assert.deepEqual(errors, [])
  console.log('inceleme duman testi geçti')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
