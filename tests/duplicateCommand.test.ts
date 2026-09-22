import { test } from 'node:test'
import assert from 'node:assert/strict'
import { duplicateCommand } from '../src/shared/workspacePolicy'

test('ajan kopyası konuşma kimliği taşımadan yeni çalıştırmadır', () => {
  assert.equal(duplicateCommand({ command: 'claude', lastLaunch: { mode: 'resume', cli: 'claude', conversationId: '0b8a3c1e-6a1f-4c1b-9a51-2f3d4e5f6a7b' }, foregroundAgent: 'claude' }), 'claude')
  assert.equal(duplicateCommand({ command: 'codex resume', lastLaunch: null, foregroundAgent: null }), 'codex')
})

test('kabukta elle başlatılan ajan kopyalanır, yoksa kabuk kalır', () => {
  assert.equal(duplicateCommand({ command: null, lastLaunch: null, foregroundAgent: 'gemini' }), 'gemini')
  assert.equal(duplicateCommand({ command: null, lastLaunch: null, foregroundAgent: null }), null)
})

test('tanınmayan komut aynen kopyalanır', () => {
  assert.equal(duplicateCommand({ command: 'npm run dev', lastLaunch: null, foregroundAgent: null }), 'npm run dev')
})
