import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appShortcut, type KeyLike } from '../src/shared/shortcuts'

const key = (over: Partial<KeyLike>): KeyLike => ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over })

test('palet her yerde Ctrl+Shift+P ile, terminal dışında Ctrl+K ile açılır', () => {
  assert.deepEqual(appShortcut(key({ code: 'KeyP', key: 'P', ctrlKey: true, shiftKey: true }), true), { kind: 'palette' })
  assert.deepEqual(appShortcut(key({ code: 'KeyK', key: 'k', ctrlKey: true }), false), { kind: 'palette' })
  // Ctrl+K kabukta satır sonuna kadar siler; terminale gitmelidir.
  assert.equal(appShortcut(key({ code: 'KeyK', key: 'k', ctrlKey: true }), true), null)
})

test('Alt+rakam klavye düzeninden bağımsız olarak oturuma atlar', () => {
  assert.deepEqual(appShortcut(key({ code: 'Digit3', key: '3', altKey: true }), true), { kind: 'jump', index: 2 })
  assert.equal(appShortcut(key({ code: 'Digit0', key: '0', altKey: true }), true), null)
  assert.equal(appShortcut(key({ code: 'Digit3', key: '#', altKey: true, shiftKey: true }), true), null)
})

test('Ctrl+PgUp/PgDn sıradaki oturuma geçer; sıradan tuşlar terminalde kalır', () => {
  assert.deepEqual(appShortcut(key({ key: 'PageDown', ctrlKey: true }), true), { kind: 'cycle', delta: 1 })
  assert.deepEqual(appShortcut(key({ key: 'PageUp', ctrlKey: true }), true), { kind: 'cycle', delta: -1 })
  for (const plain of [key({ key: 'PageDown' }), key({ key: 'c', code: 'KeyC', ctrlKey: true }), key({ key: 'Enter', code: 'Enter' }), key({ key: 'ArrowLeft', altKey: true })])
    assert.equal(appShortcut(plain, true), null)
})

test('yeni oturum ve panel büyütme Ctrl+Shift ailesindedir', () => {
  assert.deepEqual(appShortcut(key({ code: 'KeyN', key: 'N', ctrlKey: true, shiftKey: true }), true), { kind: 'new-session' })
  assert.deepEqual(appShortcut(key({ code: 'Enter', key: 'Enter', ctrlKey: true, shiftKey: true }), true), { kind: 'maximize' })
  assert.deepEqual(appShortcut(key({ code: 'KeyB', key: 'B', ctrlKey: true, shiftKey: true }), true), { kind: 'sidebar' })
  // Ctrl+B kabukta imleci geri alır; terminalde kalır.
  assert.equal(appShortcut(key({ code: 'KeyB', key: 'b', ctrlKey: true }), true), null)
})
