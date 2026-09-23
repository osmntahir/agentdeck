import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectDirName, readTranscriptHead } from '../src/server/claudeTranscripts'

test('Claude proje dizini adı yoldan türetilir', () => {
  assert.equal(projectDirName('/home/codexist/Desktop/kiosk'), '-home-codexist-Desktop-kiosk')
})

test('dosya başındaki ilk arka plan işareti oturumu, ilk cwd klasörü verir', () => {
  const head = [
    JSON.stringify({ type: 'user', isMeta: true, cwd: '/p/alt "x"', message: { content: 'Use `$CLAUDE_JOB_DIR/tmp` (`/home/u/.claude/jobs/93befcf9/tmp`) for temp files' } }),
    // Sonradan konuşmada geçen başka bir oturumun yolu sahipliği değiştirmez.
    JSON.stringify({ type: 'user', message: { content: 'Use `$CLAUDE_JOB_DIR/tmp` (`/home/u/.claude/jobs/11111111/tmp`)' } }),
  ].join('\n')
  assert.deepEqual(readTranscriptHead(head), { job: '93befcf9', cwd: '/p/alt "x"' })
  assert.deepEqual(readTranscriptHead('{"type":"user","cwd":"/p"}'), { job: null, cwd: '/p' })
})
