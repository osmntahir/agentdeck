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

test('Claude Code izin kutusu ekranın altındayken onay sayılır', () => {
  const screen = [
    '● Update(src/app.ts)',
    ' Do you want to make this edit to app.ts?',
    ' ❯ 1. Yes',
    '   2. Yes, allow all edits during this session (shift+tab)',
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n')
  assert.equal(terminalAttentionFromText(screen)?.kind, 'approval')
})

test('Codex komut onayı onay sayılır', () => {
  assert.equal(terminalAttentionFromText('Would you like to run the following command?\n  $ npm test\n› 1. Yes, proceed\n  2. No')?.kind, 'approval')
})

test('model metnindeki soru, altında giriş kutusu ve durum satırı varken dikkat üretmez', () => {
  const screen = [
    '❓ Q20 - Bir key eksik kalırsa ekranda ne görünsün?',
    '(A) Türkçeye düş (B) Key göster (C) Boş bırak',
    '✻ Churned for 3m 35s',
    '────────────────────────────',
    '> ',
    '────────────────────────────',
    '  Opus 5.5 | ctx 17% | $8.02',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n')
  assert.equal(terminalAttentionFromText(screen), null)
})
