import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tempDir, removeDir } from './helpers'
import { readGitWorkspace, switchWorkspaceBranch } from '../src/server/branchControl'

test('gerçek branch okunur; oluşturma/geçiş yalnız temiz ve güncel HEAD üzerinde çalışır', async () => {
  const cwd = tempDir()
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@local')
    fs.writeFileSync(path.join(cwd, 'a'), 'one'); git('add', '.'); git('commit', '-m', 'initial')
    const initial = await readGitWorkspace(cwd, true)
    assert.equal(initial.branch, 'main'); assert.equal(initial.dirty, false)
    const created = await switchWorkspaceBranch(cwd, { branch: 'feature/test', create: true, expectedHead: initial.head, expectedBranch: initial.branch })
    assert.equal(created.branch, 'feature/test')
    await assert.rejects(switchWorkspaceBranch(cwd, { branch: 'main', create: false, expectedHead: initial.head, expectedBranch: 'main' }), /Branch değişti/)
    fs.writeFileSync(path.join(cwd, 'a'), 'unsaved')
    await assert.rejects(switchWorkspaceBranch(cwd, { branch: 'main', create: false, expectedHead: created.head, expectedBranch: created.branch }), /Kaydedilmemiş/)
    assert.equal(fs.readFileSync(path.join(cwd, 'a'), 'utf8'), 'unsaved')
    fs.writeFileSync(path.join(cwd, 'a'), 'one')
    for (const branch of ['--detach', '-c', 'bad name', '../escape']) await assert.rejects(switchWorkspaceBranch(cwd, { branch, create: true, expectedHead: created.head, expectedBranch: created.branch }))
    const final = await switchWorkspaceBranch(cwd, { branch: 'main', create: false, expectedHead: created.head, expectedBranch: created.branch })
    assert.equal(final.branch, 'main')
    assert.deepEqual(final.branches, ['feature/test', 'main'])
  } finally { removeDir(cwd) }
})
