import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import { TerminalStream, inputChunks } from '../src/shared/terminalStream'

const identity = { daemonId: 'd', sessionId: 's', runId: 'r' }
const start = (extra = {}) => ({ type: 'replay-start', ...identity, snapshotId: 'snap', sequence: 2, cols: 60, rows: 8, formatVersion: 1, scope: 'screen', mode: 'live', totalBytes: 5, ...extra })

test('replay son write callback inden önce girdi açmaz', async () => {
  const term = new Terminal({ cols: 60, rows: 8, allowProposedApi: true })
  let finish: (() => void) | undefined
  const stream = new TerminalStream({ reset: () => term.reset(), resize: (c, r) => term.resize(c, r), write: (text, cb) => { term.write(text, () => { finish = cb }) } }, identity, () => {}, () => assert.fail('protokol hatası'))
  const send = (m: object) => stream.receive(JSON.stringify(m))
  await send(start())
  const chunk = send({ type: 'replay-chunk', snapshotId: 'snap', index: 0, text: 'hello' })
  const end = send({ type: 'replay-end', snapshotId: 'snap', chunkCount: 1 })
  while (!finish) await new Promise((r) => setTimeout(r, 1))
  assert.equal(stream.status.ready, false)
  finish()
  await Promise.all([chunk, end])
  assert.equal(stream.status.ready, true)
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'hello')
  stream.dispose()
  term.dispose()
})

for (const [name, frame] of [
  ['daemon değişimi', start({ daemonId: 'other' })],
  ['format değişimi', start({ formatVersion: 99 })],
  ['eksik parça', { type: 'replay-end', snapshotId: 'snap', chunkCount: 0 }],
  ['sıra boşluğu', { type: 'output', sequence: 8, text: 'bozuk' }],
] as const) {
  test(`${name} girdi kapatır ve yeniden attach gerektirir`, async () => {
    let failed = false
    const stream = new TerminalStream({ reset() {}, resize() {}, write(_t, cb) { cb() } }, identity, () => {}, () => { failed = true })
    await stream.receive(JSON.stringify(start()))
    await stream.receive(JSON.stringify(frame))
    assert.equal(failed, true)
    assert.equal(stream.status.ready, false)
  })
}

test('büyük paste Unicode kod noktalarını bölmeden 64 KiB parçalara ayrılır', () => {
  const input = '🙂ş'.repeat(30000)
  const chunks = inputChunks(input)
  assert.equal(chunks.join(''), input)
  assert.ok(chunks.length > 1)
  for (const part of chunks) {
    assert.ok(Buffer.byteLength(part) <= 65536)
    assert.equal(Buffer.from(part).toString(), part)
  }
})
