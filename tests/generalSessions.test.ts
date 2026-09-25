import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { startDaemon, type Daemon } from '../src/server/daemon'
import type { Project, SessionView, StateResponse } from '../src/shared/types'
import { tempDir, removeDir } from './helpers'

function client(daemon: Daemon) {
  return async <T>(method: string, route: string, body?: unknown) => {
    const res = await fetch(`${daemon.url}${route}`, {
      method,
      headers: { 'X-Agentdeck-Token': daemon.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T }
  }
}

test('projesiz oturum ev klasöründeki tek Genel kayıtta, yalnız ortak klasörde açılır', { timeout: 30000 }, async () => {
  const dataDir = tempDir()
  const project = tempDir()
  let daemon = await startDaemon({ dataDir, port: 0 })
  let call = client(daemon)
  try {
    await call('POST', '/api/projects', { path: project })
    const [a, b] = await Promise.all([call<Project>('POST', '/api/projects/general'), call<Project>('POST', '/api/projects/general')])
    assert.equal(a.body.id, b.body.id, 'eşzamanlı istekler tek kayıt açar')
    assert.equal(a.body.general, true)
    assert.equal(a.body.path, fs.realpathSync(os.homedir()))
    assert.equal((await call<Project>('POST', '/api/projects/general')).body.id, a.body.id)

    const state = (await call<StateResponse>('GET', '/api/state')).body
    assert.equal(state.projects[0]!.id, a.body.id, 'Genel listenin başında durur')
    assert.equal(state.projects.filter((p) => p.general).length, 1)

    const isolated = await call<{ code: string }>('POST', '/api/sessions', { requestId: 'g-1', projectId: a.body.id, name: '', command: 'sleep 30', isolation: 'worktree' })
    assert.equal(isolated.status, 400)
    const shared = await call<SessionView>('POST', '/api/sessions', { requestId: 'g-2', projectId: a.body.id, name: '', command: 'sleep 30', isolation: 'shared' })
    assert.equal(shared.status, 200, JSON.stringify(shared.body))
    assert.equal(shared.body.cwd, fs.realpathSync(os.homedir()))

    await daemon.close()
    daemon = await startDaemon({ dataDir, port: 0 })
    call = client(daemon)
    const reopened = (await call<StateResponse>('GET', '/api/state')).body
    assert.equal(reopened.projects.find((p) => p.id === a.body.id)?.general, true, 'bayrak kayıtta kalır')
  } finally {
    await daemon.close()
    removeDir(dataDir)
    removeDir(project)
  }
})
