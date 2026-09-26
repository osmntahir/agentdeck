import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { startDaemon } from '../../dist/server/daemon.js'

/**
 * Proje PR sayfasının duman testi: kenar çubuğundaki açık PR sayısı, PR
 * listesi (CI ve inceleme durumu), PR incelemesi, terminal seçilmeden
 * gönderimin kapalı olması, PR üzerinde ajan başlatma ve notun o ajana gitmesi.
 * Uzak depo yerel bir bare depodur; gh sahtedir. SHOTS=dizin ekran görüntüsü kaydeder.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pulls-'))
const repo = path.join(root, 'project')
const remote = path.join(root, 'remote.git')
const shots = process.env.SHOTS
fs.mkdirSync(repo)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
git(root, 'init', '--bare', remote)
git(repo, 'init', '-b', 'main')
git(repo, 'config', 'user.name', 'Test')
git(repo, 'config', 'user.email', 'test@example.test')
fs.writeFileSync(path.join(repo, 'app.ts'), 'export const greeting = "Merhaba"\n')
git(repo, 'add', '.')
git(repo, 'commit', '-m', 'ilk')
git(repo, 'remote', 'add', 'origin', remote)
git(repo, 'push', 'origin', 'main')
git(repo, 'checkout', '-b', 'feat/selam')
fs.writeFileSync(path.join(repo, 'app.ts'), 'export const greeting = "Selam"\nexport const farewell = "Görüşürüz"\n')
git(repo, 'commit', '-am', 'selam')
const oid = git(repo, 'rev-parse', 'HEAD')
const prDiff = git(repo, 'diff', 'main', 'feat/selam')
git(repo, 'push', 'origin', 'feat/selam', 'HEAD:refs/pull/42/head')
git(repo, 'checkout', 'main')
git(repo, 'branch', '-D', 'feat/selam')

const summary = { number: 42, title: 'Selamlamayı kısalt', url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'feat/selam', author: { login: 'ayse' }, additions: 2, deletions: 1, changedFiles: 1, reviewDecision: 'CHANGES_REQUESTED', updatedAt: new Date(Date.now() - 3600_000).toISOString(), statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }
const draft = { ...summary, number: 43, title: 'Taslak: çeviri', isDraft: true, headRefName: 'feat/ceviri', reviewDecision: '', statusCheckRollup: [] }
fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([summary, draft]))
fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify({ ...summary, body: 'Kısa açıklama.', headRefOid: oid, isCrossRepository: false, comments: [], reviews: [] }))
fs.writeFileSync(path.join(root, 'diff.txt'), prDiff + '\n')
const bin = path.join(root, 'bin')
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;
  "pr list") if [[ "$*" == *"--head"* ]]; then echo '[]'; else cat '${root}/list.json'; fi ;;
  "pr view") cat '${root}/pr.json' ;;
  "pr diff") cat '${root}/diff.txt' ;;
  "api --paginate") ;;
  "pr ready") node -e '
    const fs = require("fs"); const [n, undo] = process.argv.slice(1); const draft = undo === "--undo"
    for (const file of ["list.json", "pr.json"]) {
      const path = "${root}/" + file; const data = JSON.parse(fs.readFileSync(path, "utf8"))
      for (const pr of Array.isArray(data) ? data : [data]) if (String(pr.number) === n) pr.isDraft = draft
      fs.writeFileSync(path, JSON.stringify(data))
    }' "$3" "$4" ;;
  *) echo "beklenmeyen: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`

const daemon = await startDaemon({ dataDir: path.join(root, 'data'), port: 0, serveWeb: true })
const executablePath = process.env.CHROME_BIN || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
let browser
try {
  const call = async (route, init) => {
    const response = await fetch(`${daemon.url}/api/${route}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-Agentdeck-Token': daemon.token } })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const project = await call('projects', { method: 'POST', body: JSON.stringify({ path: repo }) })

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-3d-apis'] })
  const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH || 1440), height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.setDefaultTimeout(10000)
  await page.goto(`${daemon.url}/?token=${daemon.token}`)

  // Kenar çubuğunda açık PR sayısı; tıklayınca liste açılır.
  const chip = page.locator('.project-prs')
  await chip.waitFor()
  assert.equal((await chip.textContent()).replace(/\s+/g, ''), '2PR')
  await chip.click()
  await page.waitForSelector('.pr-row')
  assert.equal(await page.locator('.pr-row').count(), 2)
  const first = page.locator('.prs-items li').first()
  assert.match(await first.textContent(), /Selamlamayı kısalt/)
  assert.equal(await first.locator('.check-dot.failure').count(), 1, 'CI başarısız görünür')
  assert.match(await first.textContent(), /Değişiklik istendi/)
  assert.match(await page.locator('.prs-items li').nth(1).textContent(), /taslak/)
  await page.getByLabel('PR ara').fill('çeviri')
  assert.equal(await page.locator('.pr-row').count(), 1)
  await page.getByLabel('PR ara').fill('')
  if (shots) await page.screenshot({ path: path.join(shots, 'p1-list.png') })

  // İnceleme: PR başlığı, not, terminal seçilmeden gönderim kapalı.
  await first.locator('.pr-row').click()
  await page.waitForSelector('.pr-header')
  const line = page.locator('.diff-file .dl.add').first()
  await line.hover()
  await line.locator('.line-comment').click()
  await page.locator('.review-composer textarea').fill('Selam yerine Merhaba kalsın.')
  await page.keyboard.press('Control+Enter')
  assert.match(await page.locator('.review-target').textContent(), /Terminal seçilmedi/)
  assert.equal(await page.getByRole('button', { name: /Ajana gönder/ }).isDisabled(), true)
  if (shots) await page.screenshot({ path: path.join(shots, 'p2-review.png') })

  // Esc önce listeye, tekrar Esc sayfadan çıkar; not taslakta kalır.
  await page.locator('.review-scroll').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.pr-row')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.prs-view', { state: 'detached' })

  // Listeden "Ajan başlat": pencere PR kipinde açılır, oturum PR branch'inde doğar.
  await chip.click()
  await first.getByRole('button', { name: 'Ajan başlat' }).click()
  await page.waitForSelector('dialog[open] #new-session-title')
  assert.equal(await page.locator('#new-session-title').textContent(), 'PR üzerinde ajan başlat')
  assert.equal(await page.locator('.isolation-picker').count(), 0, 'çalışma yeri seçilmez')
  if (shots) await page.screenshot({ path: path.join(shots, 'p3-start.png') })
  await page.locator('.program-tile', { hasText: 'Kabuk' }).click()
  await page.getByRole('button', { name: 'Oturumu başlat' }).click()
  await page.waitForSelector('dialog[open]', { state: 'detached' })
  const state = await call('state')
  const session = state.sessions.find(s => s.pullRequest?.number === 42)
  assert.ok(session, 'PR oturumu kayıtta')
  assert.equal(session.name, 'PR #42')
  assert.equal(session.branch, 'feat/selam')
  assert.equal(git(session.cwd, 'rev-parse', 'HEAD'), oid)

  // PR sayfasına dönülünce satırda ajan görünür; inceleme o terminali hedef alır ve gönderir.
  await chip.click()
  await page.waitForSelector('.agent-chip')
  await first.locator('.pr-row').click()
  await page.waitForFunction(() => /PR #42/.test(document.querySelector('.review-target strong')?.textContent ?? ''))
  await page.getByRole('button', { name: /Ajana gönder \(1\)/ }).click()
  assert.match(await page.locator('.send-preview').inputValue(), /^Kod incelemesinden bir not \(PR #42\):/)
  await page.getByRole('button', { name: 'Gönder', exact: true }).click()
  await page.waitForFunction(() => /ajana gönderildi/.test(document.querySelector('.review-status')?.textContent ?? ''))
  if (shots) await page.screenshot({ path: path.join(shots, 'p4-sent.png') })

  // Palette de PR sayfası var.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+P')
  await page.keyboard.type("Pull request'ler")
  await page.keyboard.press('Enter')
  await page.waitForSelector('.pr-row')

  // Taslak süzgeci: sayılar, süzme ve boş durum.
  const filterButton = (label) => page.locator('.prs-filter button', { hasText: label })
  assert.match(await filterButton('Taslak').textContent(), /1/)
  await filterButton('Taslak').click()
  assert.deepEqual(await page.locator('.pr-row-title strong').allTextContents(), ['Taslak: çeviri'])
  await filterButton('Hazır').click()
  assert.deepEqual(await page.locator('.pr-row-title strong').allTextContents(), ['Selamlamayı kısalt'])

  // Hazır PR taslağa çevrilir; süzgeç, sayı ve başlık yeni durumu gösterir; sonra geri alınır.
  await page.locator('.pr-row').first().click()
  await page.getByRole('button', { name: 'Taslağa çevir' }).click()
  await page.getByRole('button', { name: 'İncelemeye hazır' }).waitFor()
  assert.equal(await page.locator('.pr-draft-note').count(), 1)
  assert.match(await page.locator('.pr-state').textContent(), /Taslak/)
  if (shots) await page.screenshot({ path: path.join(shots, 'p5-draft.png') })
  await page.locator('.prs-topbar .crumb', { hasText: "Pull request'ler" }).click()
  await page.waitForFunction(() => /2/.test([...document.querySelectorAll('.prs-filter button')].find(b => b.textContent.includes('Taslak'))?.textContent ?? ''))
  await page.getByText('İncelemeye hazır PR yok').waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, 'p6-empty-filter.png') })
  await page.getByRole('button', { name: 'Tümünü göster' }).click()
  await page.locator('.pr-row', { hasText: 'Selamlamayı kısalt' }).click()
  await page.getByRole('button', { name: 'İncelemeye hazır' }).click()
  await page.getByRole('button', { name: 'Taslağa çevir' }).waitFor()
  assert.equal(await page.locator('.pr-draft-note').count(), 0)

  assert.deepEqual(errors, [])
  console.log('PR sayfası duman testi geçti')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
