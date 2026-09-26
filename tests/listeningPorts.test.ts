import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { allocatePort, ownedProcesses, parseListening, parseStat, PORT_RANGE, scanListeningPorts } from '../src/server/listeningPorts'

test('/proc/net/tcp satırlarından yalnız dinleyen soketler alınır', () => {
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:1F91 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 0000000000000000 20 4 30 10 -1',
    '   2: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55503 1 0000000000000000 100 0 0 10 0',
  ].join('\n')
  assert.deepEqual([...parseListening(text)], [['55501', 8080], ['55503', 5173]])
})

test('stat alanları parantezli komut adından sonra okunur', () => {
  assert.deepEqual(parseStat('4242 (node (vite) x) S 4200 4242 4100 34816 4242 4194304'), { ppid: 4200, sid: 4100 })
})

test('süreç oturumdaki veya kökün soyundaki pid ise oturuma aittir', () => {
  const procs = new Map([
    [100, { ppid: 1, sid: 100 }], // PTY lideri
    [101, { ppid: 100, sid: 100 }],
    [102, { ppid: 1, sid: 100 }], // arka plana atılıp init'e bırakılmış, oturumda kalmış
    [103, { ppid: 101, sid: 103 }], // kendi oturumunu açmış torun
    [200, { ppid: 1, sid: 200 }], // başka oturum
  ])
  const owned = ownedProcesses(procs, new Map([['a', 100], ['b', 999]]))
  assert.deepEqual(owned.get('a')?.sort(), [100, 101, 102, 103])
  assert.deepEqual(owned.get('b'), [999])
})

test('çocuk sürecin dinlediği port oturuma yazılır', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const port = await new Promise<number>((resolve) => child.stdout!.once('data', (data) => resolve(Number(String(data).trim()))))
    const found = await scanListeningPorts(new Map([['oturum', child.pid!]]))
    assert.deepEqual(found.oturum, [port])
  } finally {
    child.kill()
  }
})

test('ayrılan port kayıtlı ve kullanılan portları atlar', async () => {
  const busy = net.createServer()
  await new Promise<void>((resolve, reject) => {
    busy.once('error', reject)
    busy.listen(PORT_RANGE.first + 1, '127.0.0.1', () => resolve())
  }).catch(() => undefined)
  try {
    const port = await allocatePort(new Set([PORT_RANGE.first]))
    assert.ok(port !== null && port >= PORT_RANGE.first + 2 && port <= PORT_RANGE.last, String(port))
  } finally {
    busy.close()
  }
})
