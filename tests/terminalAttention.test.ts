import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalAttentionFromText } from '../src/shared/terminalAttention'

test('onay seçeneği terminal attention üretir', () => {
  assert.deepEqual(terminalAttentionFromText('Deploy production? [y/N]'), { kind: 'approval', message: 'İzin veya onay bekliyor' })
})

test('son satırdaki doğrudan soru attention üretir', () => {
  assert.deepEqual(terminalAttentionFromText('Which branch should I merge?'), { kind: 'question', message: 'Which branch should I merge?' })
})

test('sessizlik veya normal çıktı attention üretmez', () => {
  assert.equal(terminalAttentionFromText('Building project...'), null)
})
