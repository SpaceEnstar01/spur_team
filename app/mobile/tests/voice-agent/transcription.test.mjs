import test from 'node:test'
import assert from 'node:assert/strict'

import { transcribeWithLocalFallback } from '../../src/voice-agent/transcriptionPolicy.ts'

test('a nonempty local transcript bypasses cloud transcription', async () => {
  let cloudCalls = 0
  const result = await transcribeWithLocalFallback({
    local: async () => ' 帮我打车去虹桥机场 ',
    cloud: async () => { cloudCalls++; return { transcript: 'wrong', intent: 'wrong' } },
  })
  assert.deepEqual(result, { transcript: '帮我打车去虹桥机场', intent: '帮我打车去虹桥机场' })
  assert.equal(cloudCalls, 0)
})

test('empty or failed local recognition falls back to cloud', async () => {
  let cloudCalls = 0
  const cloud = async () => { cloudCalls++; return { transcript: '你好', intent: '你好' } }
  assert.deepEqual(await transcribeWithLocalFallback({ local: async () => ' ', cloud }), { transcript: '你好', intent: '你好' })
  assert.deepEqual(await transcribeWithLocalFallback({ local: async () => { throw new Error('unsupported') }, cloud }), { transcript: '你好', intent: '你好' })
  assert.equal(cloudCalls, 2)
})

test('an aborted request never sends audio to cloud', async () => {
  const abort = new AbortController()
  let cloudCalls = 0
  const result = transcribeWithLocalFallback({
    local: () => new Promise(() => {}),
    cloud: async () => { cloudCalls++; return { transcript: 'wrong', intent: 'wrong' } },
    signal: abort.signal,
  })
  abort.abort()
  await assert.rejects(result, /cancelled/i)
  assert.equal(cloudCalls, 0)
})

test('local timeout cancels recognition and uses cloud', async () => {
  let cancelled = 0
  const result = await transcribeWithLocalFallback({
    local: () => new Promise(() => {}),
    cancelLocal: () => { cancelled++ },
    cloud: async () => ({ transcript: '云端结果', intent: '云端结果' }),
    localTimeoutMs: 5,
  })
  assert.equal(cancelled, 1)
  assert.equal(result.transcript, '云端结果')
})
