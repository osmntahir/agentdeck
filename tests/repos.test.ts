import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { findNestedRepos } from '../src/server/repos'
import { tempDir, removeDir } from './helpers'

/** Tarayıcı yalnız `.git` girdisine bakar; gerçek depo kurmaya gerek yok. */
function fakeRepo(root: string, rel: string, gitAs: 'dir' | 'file' = 'dir'): void {
  const dir = path.join(root, rel)
  fs.mkdirSync(dir, { recursive: true })
  if (gitAs === 'dir') fs.mkdirSync(path.join(dir, '.git'))
  else fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /tmp/elsewhere\n')
}

test('alt klasörlerdeki depolar göreli yol sırasıyla bulunur; depo içine inilmez', () => {
  const root = tempDir()
  try {
    fakeRepo(root, 'web')
    fakeRepo(root, 'org/api', 'file')
    fakeRepo(root, 'web/vendored')
    fs.mkdirSync(path.join(root, 'notlar'))
    fs.writeFileSync(path.join(root, 'README.txt'), 'depo değil')

    assert.deepEqual(findNestedRepos(root), { repos: ['org/api', 'web'], truncated: false })
  } finally {
    removeDir(root)
  }
})

test('node_modules, gizli klasör ve symlink atlanır; 4 seviyeden derine inilmez', () => {
  const root = tempDir()
  const outside = tempDir()
  try {
    fakeRepo(root, 'node_modules/paket')
    fakeRepo(root, '.cache/depo')
    fakeRepo(outside, 'disarida')
    fs.symlinkSync(path.join(outside, 'disarida'), path.join(root, 'baglanti'))
    fakeRepo(root, 'a/b/c/d')
    fakeRepo(root, 'a/b/c/d2/e')

    assert.deepEqual(findNestedRepos(root), { repos: ['a/b/c/d'], truncated: false })
  } finally {
    removeDir(root)
    removeDir(outside)
  }
})

test('depo sınırı aşılırsa liste eksik olduğunu söyler', () => {
  const root = tempDir()
  try {
    for (const name of ['r1', 'r2', 'r3']) fakeRepo(root, name)
    assert.deepEqual(findNestedRepos(root, { maxRepos: 2 }), { repos: ['r1', 'r2'], truncated: true })
  } finally {
    removeDir(root)
  }
})

test('kök klasör depoysa tek sonuç "." olur', () => {
  const root = tempDir()
  try {
    fakeRepo(root, '.')
    fakeRepo(root, 'alt')
    assert.deepEqual(findNestedRepos(root), { repos: ['.'], truncated: false })
  } finally {
    removeDir(root)
  }
})
