import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { startDaemon } from '../../dist/server/daemon.js'

/**
 * Klasör projesinin PR sayfası (ADR 0025): alt depolar ayrı gruplarda,
 * iki depoda aynı numaralı PR karışmaz, GitHub'a bağlı olmayan depo listeyi
 * bozmaz, kenar çubuğu toplamı gösterir. gh sahtedir; çalıştığı klasöre göre yanıt verir.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-folder-pulls-'))
const kiosk = path.join(root, 'kiosk')
const shots = process.env.SHOTS_DIR
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
for (const name of ['kiosk-api', 'kiosk-web', 'docs']) {
  const dir = path.join(kiosk, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
}
const pr = (number, title, head, extra = {}) => ({ number, title, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: head, author: { login: 'ayse' }, additions: 3, deletions: 1, changedFiles: 1, reviewDecision: 'REVIEW_REQUIRED', updatedAt: new Date(Date.now() - 3600_000).toISOString(), statusCheckRollup: [], ...extra })
const lists = {
  'kiosk-api': [pr(42, 'Ödeme uç noktasını ekle', 'feat/odeme'), pr(43, 'Taslak: rapor', 'feat/rapor', { isDraft: true })],
  'kiosk-web': [pr(42, 'Ödeme ekranı', 'feat/odeme-ekrani', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })],
}
for (const [name, list] of Object.entries(lists)) {
  fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(list))
  fs.writeFileSync(path.join(root, `${name}-pr.json`), JSON.stringify({ ...list[0], body: `${name} açıklaması`, headRefOid: '0'.repeat(40), isCrossRepository: false, comments: [], reviews: [] }))
}
const bin = path.join(root, 'bin')
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
name="$(basename "$PWD")"
if [ "$name" = "docs" ]; then echo "none of the git remotes configured for this repository point to a known GitHub host" >&2; exit 1; fi
case "$1 $2" in
  "pr list") cat '${root}/'"$name"'.json' ;;
  "pr view") cat '${root}/'"$name"'-pr.json' ;;
  "pr diff") printf 'diff --git a/%s.txt b/%s.txt\\n--- a/%s.txt\\n+++ b/%s.txt\\n@@ -1 +1 @@\\n-eski\\n+%s yeni\\n' "$name" "$name" "$name" "$name" "$name" ;;
  "api --paginate") ;;
  "repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;
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
    return { status: response.status, body: await response.json() }
  }
  const project = (await call('projects', { method: 'POST', body: JSON.stringify({ path: kiosk }) })).body
  assert.equal(project.kind, 'folder')

  // API: depo başına durum ve depo alanı; alt depo dışı istek reddedilir.
  const listed = (await call(`projects/${project.id}/github/pulls`)).body
  assert.deepEqual(listed.repos.map((r) => [r.path, r.count, r.error?.code ?? null]), [['docs', 0, 'not_github'], ['kiosk-api', 2, null], ['kiosk-web', 1, null]])
  assert.deepEqual(listed.pullRequests.map((p) => `${p.repo}#${p.number}`), ['kiosk-api#42', 'kiosk-api#43', 'kiosk-web#42'])
  assert.equal((await call(`projects/${project.id}/github/pulls/42?repo=kiosk-web`)).body.pullRequest.title, 'Ödeme ekranı')
  assert.equal((await call(`projects/${project.id}/github/pulls/42?repo=../x`)).status, 404)

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-3d-apis'] })
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.goto(`${daemon.url}/?token=${daemon.token}`)

  // Kenar çubuğu: alt depoların toplamı.
  const badge = page.locator('.project-prs')
  await badge.waitFor()
  assert.equal((await badge.innerText()).replace(/\s+/g, ''), '3PR')
  if (shots) await page.screenshot({ path: path.join(shots, 'folder-pulls-sidebar.png'), clip: { x: 0, y: 0, width: 300, height: 320 } })
  await badge.click()

  const groups = page.locator('.prs-repo')
  await groups.first().waitFor()
  assert.deepEqual(await page.locator('.prs-repo-head strong').allTextContents(), ['docs', 'kiosk-api', 'kiosk-web'])
  assert.match(await groups.nth(0).locator('.prs-repo-note').innerText(), /GitHub deposu değil/)
  assert.equal(await groups.nth(1).locator('.prs-items li').count(), 2)
  assert.equal(await groups.nth(2).locator('.pr-row-action').getAttribute('href'), 'https://github.com/o/r/pull/42')
  assert.deepEqual(await groups.nth(1).locator('.pr-number').allTextContents(), ['#42', '#43'])
  if (shots) await page.screenshot({ path: path.join(shots, 'folder-pulls-list.png') })

  // Aynı numaralı PR'lar karışmaz: kiosk-web#42 açılır ve kendi farkını gösterir.
  await groups.nth(2).locator('.pr-row').click()
  await page.locator('.repo-crumb', { hasText: 'kiosk-web' }).waitFor()
  await page.getByText('kiosk-web yeni').first().waitFor()
  assert.match(await page.locator('.prs-topbar h1').innerText(), /#42 Ödeme ekranı/)
  if (shots) await page.screenshot({ path: path.join(shots, 'folder-pulls-review.png') })

  // Seçiciyle öbür depodaki #42'ye geçilir.
  await page.locator('.pr-stepper select').selectOption({ label: 'kiosk-api · #42 Ödeme uç noktasını ekle' })
  await page.getByText('kiosk-api yeni').first().waitFor()

  // Arama depo adında da çalışır; boş kalan depo grubu gizlenir.
  await page.keyboard.press('Escape')
  await page.locator('.prs-toolbar input').fill('kiosk-web')
  await page.waitForFunction(() => document.querySelectorAll('.prs-repo').length === 1)

  assert.deepEqual(errors, [])
  console.log('folder pulls: ok')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
