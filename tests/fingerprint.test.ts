import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { contentFingerprint, createBudget, type ContentFingerprint } from '../src/server/fingerprint'
import { tempDir, removeDir, isRoot } from './helpers'

type Git = (...args: string[]) => void

async function withRepo(fn: (dir: string, git: Git) => Promise<void>): Promise<void> {
  const dir = tempDir()
  const git: Git = (...args) => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  }
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@agentdeck.local')
    git('config', 'user.name', 'AgentDeck Test')
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n')
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
    git('add', '.')
    git('commit', '-qm', 'ilk')
    await fn(dir, git)
  } finally {
    removeDir(dir)
  }
}

async function fingerprint(dir: string): Promise<Extract<ContentFingerprint, { ok: true }>> {
  const result = await contentFingerprint(dir, createBudget())
  assert.equal(result.ok, true, JSON.stringify(result))
  return result as Extract<ContentFingerprint, { ok: true }>
}

test('temiz çalışma kopyasında takip edilen dosyalar okunmaz ve sonuç kararlıdır', async () => {
  await withRepo(async (dir) => {
    const clean = await contentFingerprint(dir, createBudget({ maxFiles: 0 }))
    assert.equal(clean.ok, true, 'temiz takip edilen dosya bütçeden okunmaz')
    const first = await fingerprint(dir)
    assert.equal(first.changedEntries, 0)
    assert.equal(first.ignoredEntries, 0)
    assert.equal((await fingerprint(dir)).digest, first.digest)
  })
})

test('aynı status altında içerik değişimi fingerprint i değiştirir', async () => {
  await withRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'birinci\n')
    fs.writeFileSync(path.join(dir, 'yeni.txt'), 'bir\n')
    const before = await fingerprint(dir)
    assert.equal(before.changedEntries, 2)

    fs.writeFileSync(path.join(dir, 'README.md'), 'ikinci\n')
    const tracked = await fingerprint(dir)
    assert.notEqual(tracked.digest, before.digest, 'değiştirilmiş takip edilen dosyanın içeriği hash edilir')

    fs.writeFileSync(path.join(dir, 'yeni.txt'), 'iki\n')
    assert.notEqual((await fingerprint(dir)).digest, tracked.digest, 'takip edilmeyen dosyanın içeriği hash edilir')
  })
})

test('yalnız index teki içerik farkı da fingerprint e girer', async () => {
  await withRepo(async (dir, git) => {
    const file = path.join(dir, 'README.md')
    fs.writeFileSync(file, 'index-a\n')
    git('add', 'README.md')
    fs.writeFileSync(file, 'çalışma\n')
    const first = await fingerprint(dir)

    fs.writeFileSync(file, 'index-b\n')
    git('add', 'README.md')
    fs.writeFileSync(file, 'çalışma\n')
    assert.notEqual((await fingerprint(dir)).digest, first.digest, 'çalışma ağacı aynı, index farklı')
  })
})

test('ignored dosya ve klasör içeriği onayın kapsamındadır', async () => {
  await withRepo(async (dir) => {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n')
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    const first = await fingerprint(dir)
    assert.equal(first.ignoredEntries, 2)
    assert.equal(first.changedEntries, 0)

    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=2\n')
    const env = await fingerprint(dir)
    assert.notEqual(env.digest, first.digest, '.env değişimi görülür')

    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 2\n')
    assert.notEqual((await fingerprint(dir)).digest, env.digest, 'ignored klasörün içindeki dosya görülür')
  })
})

test('symlink izlenmez; dış hedefin içeriği okunmaz, hedef metni hash edilir', async () => {
  const outside = tempDir()
  try {
    await withRepo(async (dir) => {
      fs.writeFileSync(path.join(outside, 'hedef.txt'), 'dış içerik\n')
      fs.writeFileSync(path.join(outside, 'baska.txt'), 'başka\n')
      fs.symlinkSync(path.join(outside, 'hedef.txt'), path.join(dir, 'link'))
      const first = await fingerprint(dir)

      fs.writeFileSync(path.join(outside, 'hedef.txt'), 'dış içerik değişti\n')
      assert.equal((await fingerprint(dir)).digest, first.digest, 'link hedefinin içeriği okunmaz')

      fs.rmSync(path.join(dir, 'link'))
      fs.symlinkSync(path.join(outside, 'baska.txt'), path.join(dir, 'link'))
      assert.notEqual((await fingerprint(dir)).digest, first.digest, 'link hedef metni değişimi görülür')
    })
  } finally {
    removeDir(outside)
  }
})

test('dosya, bayt veya süre bütçesi aşılırsa fingerprint üretilmez', async () => {
  await withRepo(async (dir) => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, name), 'x'.repeat(1024))

    const files = await contentFingerprint(dir, createBudget({ maxFiles: 2 }))
    assert.equal(files.ok, false)
    assert.equal(files.ok === false && files.reason, 'budget')

    const bytes = await contentFingerprint(dir, createBudget({ maxBytes: 2048 }))
    assert.equal(bytes.ok, false)
    assert.equal(bytes.ok === false && bytes.reason, 'budget')

    const time = await contentFingerprint(dir, createBudget({ timeoutMs: 0 }))
    assert.equal(time.ok, false)
    assert.equal(time.ok === false && time.reason, 'budget')

    // Bütçe çağrılar arasında paylaşılır: bir sınır N çağrıyla gizlice aşılamaz.
    const shared = createBudget({ maxFiles: 4 })
    assert.equal((await contentFingerprint(dir, shared)).ok, true)
    assert.equal((await contentFingerprint(dir, shared)).ok, false)
  })
})

test('okunamayan dosya "değişmedi" sayılmaz', { skip: isRoot ? 'root izinleri kontrolü atlar' : false }, async () => {
  await withRepo(async (dir) => {
    const secret = path.join(dir, 'kilitli.txt')
    fs.writeFileSync(secret, 'okunamaz\n')
    fs.chmodSync(secret, 0o000)
    try {
      const result = await contentFingerprint(dir, createBudget())
      assert.equal(result.ok, false)
      assert.equal(result.ok === false && result.reason, 'unreadable')
    } finally {
      fs.chmodSync(secret, 0o644)
    }
  })
})
