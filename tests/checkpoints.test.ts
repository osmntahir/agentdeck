import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openCheckpointStore } from '../src/server/checkpoints'
import { FORMAT_VERSION } from '../src/server/terminalState'
import { isRoot, removeDir, tempDir } from './helpers'

function input(sessionId: string, runId: string, text = 'ekran'): Parameters<ReturnType<typeof openCheckpointStore>['write']>[0] {
  return { sessionId, runId, text, scope: 'scrollback', cols: 80, rows: 24, sequence: 7, capturedAt: Date.now() }
}

test('checkpoint yazılıp geri okunur; dosya yalnız sahibine açıktır', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1', 'merhaba\x1b[31m'))

    const read = await store.read('s1', 'r1')
    assert.equal(read.state, 'ready')
    if (read.state !== 'ready') return
    assert.equal(read.checkpoint.text, 'merhaba\x1b[31m')
    assert.equal(read.checkpoint.sequence, 7)
    assert.equal(read.checkpoint.cols, 80)
    assert.equal(read.checkpoint.formatVersion, FORMAT_VERSION)

    const file = store.fileFor('s1', 'r1')
    if (!isRoot) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'atomik yazımdan geçici dosya kalmamalı')
  } finally {
    removeDir(dir)
  }
})

test('hiç yazılmamış Run için "geçmiş yok" döner', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    assert.equal((await store.read('s1', 'yok')).state, 'missing')
  } finally {
    removeDir(dir)
  }
})

test('bozuk checkpoint boş geçmişle karıştırılmaz', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1'))

    const file = store.fileFor('s1', 'r1')
    fs.writeFileSync(file, '{ yarım json')
    const broken = await store.read('s1', 'r1')
    assert.equal(broken.state, 'unreadable')

    // Boyut alanı gövdeyle uyuşmuyorsa da doğru ekran diye sunulmaz.
    const record = { ...JSON.parse(JSON.stringify(input('s1', 'r1'))), formatVersion: FORMAT_VERSION, byteLength: 999 }
    fs.writeFileSync(file, JSON.stringify(record))
    assert.equal((await store.read('s1', 'r1')).state, 'unreadable')

    // Daha yeni bir biçim de sessizce okunmaz.
    fs.writeFileSync(file, JSON.stringify({ ...record, formatVersion: FORMAT_VERSION + 1, byteLength: 5 }))
    assert.equal((await store.read('s1', 'r1')).state, 'unreadable')
  } finally {
    removeDir(dir)
  }
})

test('başka Run un kaydı o Run un geçmişi diye gösterilmez', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1'))
    fs.copyFileSync(store.fileFor('s1', 'r1'), store.fileFor('s1', 'r2'))
    assert.equal((await store.read('s1', 'r2')).state, 'unreadable')
  } finally {
    removeDir(dir)
  }
})

test('son iki Run tutulur; yeni Run önceki Run un kaydını silmez', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1'))
    await store.write(input('s1', 'r2'))
    await store.write(input('s1', 'r3'))
    // Saklama sınırı yalnız kayda girmiş Run yayımlanınca uygulanır.
    store.prune('s1', 'r3')

    assert.equal((await store.read('s1', 'r3')).state, 'ready')
    assert.equal((await store.read('s1', 'r2')).state, 'ready', 'önceki Run un görüntüsü korunur')
    assert.equal((await store.read('s1', 'r1')).state, 'missing', 'üçüncü eski kayıt tutulmaz')
  } finally {
    removeDir(dir)
  }
})

test('Session silinince yalnız o Session un dosyaları kalkar', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1'))
    await store.write(input('s2', 'r1'))

    store.removeSession('s1')
    assert.equal((await store.read('s1', 'r1')).state, 'missing')
    assert.equal((await store.read('s2', 'r1')).state, 'ready')
  } finally {
    removeDir(dir)
  }
})

test('eşzamanlı yükleme ikiyle sınırlıdır', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    for (const runId of ['r1', 'r2']) await store.write(input('s1', runId, 'x'.repeat(64 * 1024)))
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.read('s1', i % 2 === 0 ? 'r1' : 'r2')))
    assert.ok(store.stats().peakConcurrentReads <= 2, `eşzamanlılık: ${store.stats().peakConcurrentReads}`)
  } finally {
    removeDir(dir)
  }
})

test('yazılamayan checkpoint hata olarak bildirilir ve yarım dosya bırakmaz', async (t) => {
  if (isRoot) return t.skip('root izin hatası üretemez')
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1'))
    const sessionDir = path.dirname(store.fileFor('s1', 'r1'))
    fs.chmodSync(sessionDir, 0o500)
    await assert.rejects(() => store.write(input('s1', 'r2')), /checkpoint/i)
    fs.chmodSync(sessionDir, 0o700)
    assert.deepEqual(
      fs.readdirSync(sessionDir).filter((f) => f.endsWith('.tmp')),
      [],
    )
    assert.equal((await store.read('s1', 'r1')).state, 'ready', 'eski kayıt korunur')
  } finally {
    removeDir(dir)
  }
})

test('çöküşten kalan tmp dosyası Run kaydı veya bozuk geçmiş sayılmaz', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1', 'sağlam'))
    await store.write(input('s1', 'r2', 'ikinci'))
    fs.writeFileSync(`${store.fileFor('s1', 'r2')}.crash.tmp`, '{ yarım')
    assert.equal((await store.read('s1', 'r1')).state, 'ready')
    assert.equal((await store.read('s1', 'r2')).state, 'ready')
    assert.deepEqual(store.list('s1').map((run) => run.runId).sort(), ['r1', 'r2'])
    const leftovers = fs.readdirSync(path.dirname(store.fileFor('s1', 'r1'))).filter((f) => f.endsWith('.tmp'))
    assert.equal(leftovers.length, 1, 'tmp durur ama okunmaz')
  } finally {
    removeDir(dir)
  }
})

test('yazım tek başına eski kayıtları budamaz', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    for (const runId of ['r1', 'r2', 'r3']) await store.write(input('s1', runId))
    for (const runId of ['r1', 'r2', 'r3']) assert.equal((await store.read('s1', runId)).state, 'ready')
  } finally {
    removeDir(dir)
  }
})

test('tek Run kaydı kaldırılınca boşalan oturum dizini de kalkar', async () => {
  const dir = tempDir()
  try {
    const store = openCheckpointStore(dir)
    await store.write(input('s1', 'r1'))
    await store.write(input('s2', 'r1'))
    await store.write(input('s2', 'r2'))

    store.removeRun('s1', 'r1')
    assert.equal(fs.existsSync(path.join(store.root, 's1')), false, 'boş oturum dizini kaldı')
    store.removeRun('s2', 'r1')
    assert.equal((await store.read('s2', 'r2')).state, 'ready', 'aynı oturumun diğer kaydı korunur')
  } finally {
    removeDir(dir)
  }
})
