import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  classifyGhFailure,
  createPullRequest,
  githubStatus,
  pickBranchPullRequest,
  publishReview,
  pullRequestDetail,
  reviewPayload,
  toNotes,
  toSummary,
} from '../src/server/github'
import { bracketedPaste } from '../src/shared/terminalStream'
import { tempDir, removeDir } from './helpers'

const summary = (over: Record<string, unknown> = {}) => ({
  number: 7, title: 'Özellik', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false,
  baseRefName: 'main', headRefName: 'feat/x', author: { login: 'ayse' }, additions: 3, deletions: 1,
  changedFiles: 1, reviewDecision: '', updatedAt: '2026-09-20T10:00:00Z', ...over,
})

/**
 * PATH'in başına konan sahte gh: argümanları ve stdin'i log dosyasına yazar,
 * yanıtı argümanlara göre fixture'dan verir. Gerçek ağa hiç çıkılmaz.
 */
function withFakeGh(script: string, fn: (ctx: { repo: string; log: () => string[] }) => Promise<void>): Promise<void> {
  const bin = tempDir()
  const repo = tempDir()
  const logFile = path.join(bin, 'calls.log')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${logFile}'\n${script}\n`, { mode: 0o755 })
  execFileSync('git', ['init', '-b', 'feat/x'], { cwd: repo, stdio: 'pipe' })
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  return fn({ repo, log: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [] })
    .finally(() => { process.env.PATH = previous; removeDir(bin); removeDir(repo) })
}

test('gh hataları kullanıcıya gösterilecek duruma ayrılır', () => {
  assert.equal(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login').state, 'unauthenticated')
  assert.equal(classifyGhFailure('none of the git remotes configured for this repository point to a known GitHub host').state, 'not_github')
  const other = classifyGhFailure('line one\nGraphQL: Something broke')
  assert.equal(other.state, 'error')
  assert.match(other.message, /Something broke/)
})

test('branch PR seçimi açık olanı, yoksa en yeniyi alır', () => {
  const closed = toSummary(summary({ number: 3, state: 'CLOSED' }))
  const open = toSummary(summary({ number: 5 }))
  assert.equal(pickBranchPullRequest([closed, open])?.number, 5)
  assert.equal(pickBranchPullRequest([closed])?.number, 3)
  assert.equal(pickBranchPullRequest([]), null)
  assert.equal(open.author, 'ayse')
  assert.equal(open.reviewDecision, null, 'boş karar null olur')
})

test('satıra bağlı olmayan konuşma zamana göre sıralanır; boş gövdeli yalnız yorum incelemesi atlanır', () => {
  const notes = toNotes({
    ...summary(), body: '', headRefOid: 'a'.repeat(40),
    comments: [{ author: { login: 'can' }, body: 'Genel yorum', createdAt: '2026-09-21T00:00:00Z', url: 'u1' }],
    reviews: [
      { author: { login: 'ayse' }, body: '', state: 'APPROVED', submittedAt: '2026-09-22T00:00:00Z' },
      { author: { login: 'ayse' }, body: '', state: 'COMMENTED', submittedAt: '2026-09-20T00:00:00Z' },
      { author: { login: 'deniz' }, body: 'Şunu düzelt', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-19T00:00:00Z' },
    ],
  })
  assert.deepEqual(notes.map(n => [n.author, n.state]), [['deniz', 'CHANGES_REQUESTED'], ['can', null], ['ayse', 'APPROVED']])
})

test('inceleme isteği aralıklı yorumda start alanlarını, tek satırda yalnız line alanını taşır', () => {
  const payload = reviewPayload('c'.repeat(40), 'Özet', [
    { path: 'a.ts', side: 'new', line: 12, startLine: 10, body: 'aralık' },
    { path: 'b.ts', side: 'old', line: 4, startLine: 4, body: 'tek' },
  ])
  assert.deepEqual(payload, {
    commit_id: 'c'.repeat(40), body: 'Özet', event: 'COMMENT',
    comments: [
      { path: 'a.ts', body: 'aralık', line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT' },
      { path: 'b.ts', body: 'tek', line: 4, side: 'LEFT' },
    ],
  })
})

test('durum okuması depo, varsayılan branch ve bu branch in açık PR ını verir', async () => {
  await withFakeGh(`
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;
  "pr list") echo '${JSON.stringify([summary({ number: 2, state: 'MERGED' }), summary()])}' ;;
esac`, async ({ repo, log }) => {
    const status = await githubStatus(repo)
    assert.equal(status.state, 'ready')
    assert.equal(status.repo, 'o/r')
    assert.equal(status.defaultBranch, 'main')
    assert.equal(status.branch, 'feat/x')
    assert.equal(status.pullRequest?.number, 7)
    assert.match(log()[1], /^pr list --head feat\/x --state all/)
  })
})

test('gh oturumu yoksa durum hata fırlatmaz, unauthenticated döner', async () => {
  await withFakeGh(`echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`, async ({ repo }) => {
    const status = await githubStatus(repo)
    assert.equal(status.state, 'unauthenticated')
    assert.match(status.message ?? '', /gh auth login/)
    assert.equal(status.pullRequest, null)
  })
})

test('PR ayrıntısı farkı, satır yorumlarını ve konuşmayı birlikte okur', async () => {
  const comment = { id: 11, path: 'a.ts', line: null, start_line: null, side: 'RIGHT', body: 'eski', user: 'can', created_at: 't', html_url: 'u', in_reply_to_id: null }
  await withFakeGh(`
case "$1 $2" in
  "pr view") echo '${JSON.stringify({ ...summary(), body: 'Açıklama', headRefOid: 'b'.repeat(40), comments: [], reviews: [] })}' ;;
  "pr diff") printf 'diff --git a/a.ts b/a.ts\\n+yeni\\n' ;;
  "api --paginate") echo '${JSON.stringify(comment)}'; echo '${JSON.stringify({ ...comment, id: 12, line: 3, side: 'LEFT', in_reply_to_id: 11 })}' ;;
esac`, async ({ repo }) => {
    const detail = await pullRequestDetail(repo, 7)
    assert.equal(detail.pullRequest.headRefOid, 'b'.repeat(40))
    assert.equal(detail.pullRequest.body, 'Açıklama')
    assert.match(detail.diff, /\+yeni/)
    assert.equal(detail.truncated, false)
    assert.deepEqual(detail.comments.map(c => [c.id, c.line, c.side, c.inReplyTo]), [[11, null, 'new', null], [12, 3, 'old', 11]])
  })
})

test('inceleme yayımlama gövdeyi stdin ile gh api ye verir', async () => {
  await withFakeGh(`cat > "$(dirname "$0")/stdin.json"; echo '{"html_url":"https://github.com/o/r/pull/7#review"}'`, async ({ repo, log }) => {
    const result = await publishReview(repo, 7, 'c'.repeat(40), 'Özet', [{ path: 'a.ts', side: 'new', line: 2, startLine: null, body: 'not' }])
    assert.equal(result.url, 'https://github.com/o/r/pull/7#review')
    assert.equal(log()[0], 'api --method POST repos/{owner}/{repo}/pulls/7/reviews --input -')
    const bin = process.env.PATH!.split(':')[0]
    const sent = JSON.parse(fs.readFileSync(path.join(bin, 'stdin.json'), 'utf8'))
    assert.equal(sent.event, 'COMMENT')
    assert.deepEqual(sent.comments, [{ path: 'a.ts', body: 'not', line: 2, side: 'RIGHT' }])
  })
})

test('PR oluşturma önce branch i gönderir, sonra açıklamayı stdin ile verip açılan PR ı okur', async () => {
  const remote = tempDir()
  try {
    execFileSync('git', ['init', '--bare'], { cwd: remote, stdio: 'pipe' })
    await withFakeGh(`
case "$1 $2" in
  "pr create") cat > "$(dirname "$0")/body.txt" ;;
  "pr list") echo '${JSON.stringify([summary({ number: 9 })])}' ;;
esac`, async ({ repo, log }) => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'ilk')
      git('remote', 'add', 'origin', remote)
      const created = await createPullRequest(repo, { branch: 'feat/x', base: 'main', title: 'Başlık', body: 'Gövde', draft: true })
      assert.equal(created.number, 9)
      assert.equal(log()[0], 'pr create --head feat/x --base main --title Başlık --body-file - --draft')
      const bin = process.env.PATH!.split(':')[0]
      assert.equal(fs.readFileSync(path.join(bin, 'body.txt'), 'utf8'), 'Gövde')
      assert.ok(execFileSync('git', ['rev-parse', 'refs/heads/feat/x'], { cwd: remote }).toString().trim(), 'branch uzak depoya gönderildi')
    })
  } finally {
    removeDir(remote)
  }
})

test('yapıştırma metni satır sonlarını CR yapar ve kontrol karakterlerini atar', () => {
  assert.equal(bracketedPaste('a\nb\r\nc\td'), '\x1b[200~a\rb\rc\td\x1b[201~')
  assert.equal(bracketedPaste('x\x1b[201~\x07y'), '\x1b[200~x[201~y\x1b[201~', 'yapıştırma erken kapatılamaz')
})
