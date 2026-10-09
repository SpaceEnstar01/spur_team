import test from 'node:test'
import assert from 'node:assert/strict'

import { createHomeVoicePermissionPrimer } from '../../src/voice-agent/voicePermissionPrimer.ts'

test('home permission primer requests microphone before speech only when microphone is undecided', async () => {
  const order = []
  const prime = createHomeVoicePermissionPrimer({
    getMicrophone: async () => { order.push('check microphone'); return 'undetermined' },
    requestMicrophone: async () => { order.push('request microphone') },
    requestSpeech: async () => { order.push('request speech') },
  })
  await prime()
  assert.deepEqual(order, ['check microphone', 'request microphone', 'request speech'])
})

test('already decided microphone permission does not prompt again', async () => {
  const order = []
  const prime = createHomeVoicePermissionPrimer({
    getMicrophone: async () => { order.push('check microphone'); return 'denied' },
    requestMicrophone: async () => { order.push('request microphone') },
    requestSpeech: async () => { order.push('request speech') },
  })
  await prime()
  assert.deepEqual(order, ['check microphone', 'request speech'])
})

test('repeated home focus shares one permission sequence', async () => {
  const order = []
  const prime = createHomeVoicePermissionPrimer({
    getMicrophone: async () => { order.push('check microphone'); return 'granted' },
    requestMicrophone: async () => { order.push('request microphone') },
    requestSpeech: async () => { order.push('request speech') },
  })
  await Promise.all([prime(), prime()])
  await prime()
  assert.deepEqual(order, ['check microphone', 'request speech'])
})

test('a microphone API failure does not prevent the speech permission request', async () => {
  const order = []
  const prime = createHomeVoicePermissionPrimer({
    getMicrophone: async () => { throw new Error('microphone API unavailable') },
    requestMicrophone: async () => { order.push('request microphone') },
    requestSpeech: async () => { order.push('request speech') },
  })
  await prime()
  assert.deepEqual(order, ['request speech'])
})
