import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionDisplayName } from '../src/shared/sessionName'

test('automatic shell title follows a manually launched agent and returns on exit', () => {
  const session = { id: 'ca8962-rest', name: 'Kabuk ca8962', command: null }
  assert.equal(sessionDisplayName(session, 'claude'), 'Claude Code ca8962')
  assert.equal(sessionDisplayName(session, 'opencode'), 'OpenCode ca8962')
  assert.equal(sessionDisplayName(session, 'agy'), 'Antigravity ca8962')
  assert.equal(sessionDisplayName(session, null), 'Kabuk ca8962')
  assert.equal(session.name, 'Kabuk ca8962')
})

test('custom names remain intact even when they contain a program label', () => {
  for (const name of ['Backend çalışması', 'Kabuk', 'Kabuk başka-id']) {
    assert.equal(sessionDisplayName({ id: 'ca8962-rest', name, command: null }, 'claude'), name)
  }
})
