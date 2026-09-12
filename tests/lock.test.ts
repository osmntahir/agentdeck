import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { acquireDaemonLock, LockError } from '../src/server/lock'
import { tempDir, removeDir } from './helpers'

test('aynı veri dizini için ikinci yazar reddedilir', async () => {
  const dir = tempDir()
  const first = await acquireDaemonLock(dir)
  try {
    await assert.rejects(acquireDaemonLock(dir), (err: unknown) => {
      assert.ok(err instanceof LockError)
      assert.equal(err.code, 'data_dir_locked')
      return true
    })
  } finally {
    await first.release()
    removeDir(dir)
  }
})

test('symlink alias aynı kilide çözülür', async () => {
  const dir = tempDir()
  const alias = path.join(tempDir(), 'alias')
  fs.symlinkSync(dir, alias)
  const first = await acquireDaemonLock(dir)
  try {
    await assert.rejects(acquireDaemonLock(alias), (err: unknown) => {
      assert.equal((err as LockError).code, 'data_dir_locked')
      return true
    })
  } finally {
    await first.release()
    fs.unlinkSync(alias)
    removeDir(dir)
  }
})

test('kilit bırakıldıktan sonra yeniden alınabilir', async () => {
  const dir = tempDir()
  try {
    const first = await acquireDaemonLock(dir)
    await first.release()
    const second = await acquireDaemonLock(dir)
    await second.release()
  } finally {
    removeDir(dir)
  }
})

test('farklı veri dizinleri birbirini engellemez', async () => {
  const a = tempDir()
  const b = tempDir()
  const first = await acquireDaemonLock(a)
  const second = await acquireDaemonLock(b)
  try {
    assert.notEqual(first.address, second.address)
  } finally {
    await first.release()
    await second.release()
    removeDir(a)
    removeDir(b)
  }
})
