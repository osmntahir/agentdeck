import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scanOrphanWorktrees } from '../src/server/orphans'
import { tempDir, removeDir } from './helpers'

function managed(root: string, projectId: string, sessionId: string, gitLink?: string): string {
  const dir = path.join(root, projectId, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'kullanici-isi.txt'), 'dokunulmamalı')
  if (gitLink) fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitLink}\n`)
  return dir
}

test('kayıtsız çalışma kopyası bildirilir, kayıtlı olan bildirilmez', () => {
  const root = tempDir()
  try {
    const known = managed(root, 'p1', 'kayitli')
    const orphan = managed(root, 'p1', 'yetim', '/tmp/repo/.git/worktrees/yetim')

    const scan = scanOrphanWorktrees(root, new Set([known]))
    assert.deepEqual(
      scan.entries.map((e) => e.path),
      [orphan],
    )
    assert.equal(scan.entries[0].gitLink, '/tmp/repo/.git/worktrees/yetim')
    assert.equal(scan.truncated, false)
    assert.deepEqual(scan.unreadable, [])
  } finally {
    removeDir(root)
  }
})

test('keşif hiçbir dosyaya dokunmaz', () => {
  const root = tempDir()
  try {
    const orphan = managed(root, 'p1', 'yetim')
    scanOrphanWorktrees(root, new Set())
    assert.equal(fs.existsSync(path.join(orphan, 'kullanici-isi.txt')), true)
    assert.equal(fs.existsSync(orphan), true)
  } finally {
    removeDir(root)
  }
})

test('symlink izlenmez, atlandığı bildirilir', () => {
  const root = tempDir()
  const outside = tempDir()
  try {
    fs.writeFileSync(path.join(outside, 'disarida.txt'), 'izlenmemeli')
    fs.mkdirSync(path.join(root, 'p1'), { recursive: true })
    const link = path.join(root, 'p1', 'baglanti')
    fs.symlinkSync(outside, link)

    const scan = scanOrphanWorktrees(root, new Set())
    assert.deepEqual(scan.entries, [{ path: link, kind: 'symlink-skipped', gitLink: null }])
    assert.equal(fs.existsSync(path.join(outside, 'disarida.txt')), true)
  } finally {
    removeDir(root)
    removeDir(outside)
  }
})

test('giriş bütçesi aşılırsa tarama kesik işaretlenir', () => {
  const root = tempDir()
  try {
    for (let i = 0; i < 6; i += 1) managed(root, 'p1', `s${i}`)
    const scan = scanOrphanWorktrees(root, new Set(), { maxEntries: 3 })
    assert.equal(scan.truncated, true, 'eksik tarama temiz sonucu doğurmaz')
    assert.ok(scan.entries.length <= 3)
  } finally {
    removeDir(root)
  }
})

test('süre bütçesi aşılırsa tarama kesik işaretlenir', () => {
  const root = tempDir()
  try {
    for (let i = 0; i < 4; i += 1) managed(root, 'p1', `s${i}`)
    let clock = 0
    const scan = scanOrphanWorktrees(root, new Set(), {
      deadlineMs: 10,
      // Her okumada saat ilerliyormuş gibi davran.
      now: () => (clock += 8),
    })
    assert.equal(scan.truncated, true)
  } finally {
    removeDir(root)
  }
})

test('okunamayan dizin eksik keşif olarak bildirilir', { skip: process.getuid?.() === 0 ? 'root izinleri kontrolü atlar' : false }, () => {
  const root = tempDir()
  const blocked = path.join(root, 'p1')
  try {
    managed(root, 'p1', 's1')
    fs.chmodSync(blocked, 0o000)
    const scan = scanOrphanWorktrees(root, new Set())
    assert.deepEqual(scan.unreadable, [blocked])
    assert.equal(scan.entries.length, 0)
  } finally {
    fs.chmodSync(blocked, 0o755)
    removeDir(root)
  }
})

test('yönetilen kök yoksa tarama boş ve kesiksizdir', () => {
  const scan = scanOrphanWorktrees('/tmp/agentdeck-olmayan-kok-xyz', new Set())
  assert.deepEqual(scan.entries, [])
  assert.equal(scan.truncated, false)
})
