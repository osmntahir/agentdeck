import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { findSubRepos } from '../src/server/repos'
import { tempDir, removeDir, isRoot } from './helpers'

/** Tarayıcı yalnız `.git` girdisine bakar; gerçek depo kurmaya gerek yok. */
function fakeRepo(root: string, rel: string, gitAs: 'dir' | 'file' = 'dir'): void {
  const dir = path.join(root, rel)
  fs.mkdirSync(dir, { recursive: true })
  if (gitAs === 'dir') fs.mkdirSync(path.join(dir, '.git'))
  else fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /tmp/elsewhere\n')
}

test('alt klasörlerdeki depolar göreli yol sırasıyla bulunur; depo içine inilmez', async () => {
  const root = tempDir()
  try {
    fakeRepo(root, 'web')
    fakeRepo(root, 'org/api', 'file')
    fakeRepo(root, 'web/vendored')
    fs.mkdirSync(path.join(root, 'notlar'))
    fs.writeFileSync(path.join(root, 'README.txt'), 'depo değil')

    assert.deepEqual(await findSubRepos(root), { repos: ['org/api', 'web'], truncated: false })
  } finally {
    removeDir(root)
  }
})

test('node_modules, gizli klasör ve symlink atlanır; 4 seviyeden derine inilmez', async () => {
  const root = tempDir()
  const outside = tempDir()
  try {
    fakeRepo(root, 'node_modules/paket')
    fakeRepo(root, '.cache/depo')
    fakeRepo(outside, 'disarida')
    fs.symlinkSync(path.join(outside, 'disarida'), path.join(root, 'baglanti'))
    fakeRepo(root, 'a/b/c/d')
    fakeRepo(root, 'a/b/c/d2/e')

    assert.deepEqual(await findSubRepos(root), { repos: ['a/b/c/d'], truncated: false })
  } finally {
    removeDir(root)
    removeDir(outside)
  }
})

test('depo sınırı aşılırsa liste eksik olduğunu söyler', async () => {
  const root = tempDir()
  try {
    for (const name of ['r1', 'r2', 'r3']) fakeRepo(root, name)
    assert.deepEqual(await findSubRepos(root, { maxRepos: 2 }), { repos: ['r1', 'r2'], truncated: true })
  } finally {
    removeDir(root)
  }
})

test('giriş bütçesi aşılırsa liste eksik olduğunu söyler', async () => {
  const root = tempDir()
  try {
    for (const name of ['r1', 'r2']) fakeRepo(root, name)
    assert.deepEqual(await findSubRepos(root, { maxEntries: 1 }), { repos: ['r1'], truncated: true })
  } finally {
    removeDir(root)
  }
})

test('okunamayan dizin taramayı eksik yapar; "depo yok" sonucu çıkarılmaz', { skip: isRoot ? 'root her dizini okur' : false }, async () => {
  const root = tempDir()
  const closed = path.join(root, 'kapali')
  try {
    fakeRepo(root, 'acik')
    fs.mkdirSync(closed)
    fs.chmodSync(closed, 0o000)
    assert.deepEqual(await findSubRepos(root), { repos: ['acik'], truncated: true })
  } finally {
    fs.chmodSync(closed, 0o755)
    removeDir(root)
  }
})

test('kök klasör depoysa tek sonuç "." olur', async () => {
  const root = tempDir()
  try {
    fakeRepo(root, '.')
    fakeRepo(root, 'alt')
    assert.deepEqual(await findSubRepos(root), { repos: ['.'], truncated: false })
  } finally {
    removeDir(root)
  }
})
