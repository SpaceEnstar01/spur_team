import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyPrompt, extractRideDestination, validateTaxiURI } from '../../src/voice-agent/voiceAgentPolicy.ts'
import { createVoiceAgentController } from '../../src/voice-agent/VoiceAgentController.ts'
import { createTaxiURI } from '../../src/voice-agent/VoiceAgentAMapClient.ts'
import { visibleAnswer } from '../../src/voice-agent/VoiceAgentAIClient.ts'
import { generateVoiceAgentImage } from '../../src/voice-agent/VoiceAgentImageService.ts'

test('weather stays chat, image is explicit, and ride needs a destination', () => {
  assert.equal(classifyPrompt('今天天气怎么样'), 'chat')
  assert.equal(classifyPrompt('帮我画一张夜景图片'), 'image')
  assert.equal(classifyPrompt('帮我打车去虹桥机场'), 'ride')
  assert.equal(extractRideDestination('帮我打车'), undefined)
  assert.equal(extractRideDestination('帮我打车去虹桥机场'), '虹桥机场')
})

test('taxi link requires one matching destination and valid coordinates', () => {
  const good = 'amapuri://drive/takeTaxi?dlon=121.3&dlat=31.2&dname=%E8%99%B9%E6%A1%A5%E6%9C%BA%E5%9C%BA'
  assert.equal(validateTaxiURI(good, '虹桥机场', '121.3', '31.2'), true)
  assert.equal(validateTaxiURI(`${good}&dname=Other`, '虹桥机场', '121.3', '31.2'), false)
  assert.equal(validateTaxiURI(good.replace('121.3', '190'), '虹桥机场', '121.3', '31.2'), false)
  assert.equal(validateTaxiURI('https://example.com/', '虹桥机场', '121.3', '31.2'), false)
})

test('one long press creates one task, status duplicate does not navigate again', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  assert.equal(controller.onRingTrigger('touch', 1000), true)
  assert.equal(controller.onRecordingStatus(2, 1010), false)
  assert.equal(controller.onRingTrigger('touch', 1100), false)
  assert.equal(controller.getState().tasks.length, 1)
})

test('sync only claims a fresh short recording', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  controller.setKnownFiles(['old'])
  controller.onRingTrigger('touch', 1000)
  controller.onRecordingStatus(1, 1300)
  const claimed = controller.onSyncedFiles([
    { id: 'old', name: 'old.m4a', modifiedAt: 400, durationMs: 5000, uri: 'file://old' },
    { id: 'long', name: 'long.m4a', modifiedAt: 1400, durationMs: 30000, uri: 'file://long' },
    { id: 'new', name: 'new.m4a', modifiedAt: 1500, durationMs: 5000, uri: 'file://new' },
  ])
  assert.equal(claimed?.id, 'new')
  assert.equal(controller.isOwnedFile('new'), true)
  assert.equal(controller.isOwnedFile('old'), false)
})

test('AMap only accepts matching taxi URI from two successful MCP calls', async () => {
  const calls = []
  const fetcher = async (_url, init) => {
    const tool = JSON.parse(init.body).params.name
    calls.push(tool)
    return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: tool === 'maps_geo'
      ? JSON.stringify({ results: [{ location: '121.3,31.2' }] })
      : 'amapuri://drive/takeTaxi?dlon=121.3&dlat=31.2&dname=%E8%99%B9%E6%A1%A5%E6%9C%BA%E5%9C%BA' }] } }) }
  }
  assert.match(await createTaxiURI('虹桥机场', 'test-key', fetcher), /^amapuri:/)
  assert.deepEqual(calls, ['maps_geo', 'maps_schema_take_taxi'])
  await assert.rejects(createTaxiURI('虹桥机场', '', fetcher))
  await assert.rejects(createTaxiURI('虹桥机场', 'test-key', async () => ({ ok: true, json: async () => ({ result: { content: [{ type: 'text', text: 'invalid' }] } }) })))
})

test('a long clip remains an ordinary recording instead of going to the agent', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  controller.onRingTrigger('status', 1000)
  controller.onRecordingStatus(1, 1300)
  const claimed = controller.onSyncedFiles([{ id: 'meeting', name: 'meeting.m4a', modifiedAt: 1500, durationMs: 31000, uri: 'file://meeting' }])
  assert.equal(claimed, undefined)
  assert.equal(controller.getState().tasks[0].status, 'ordinary')
  assert.equal(controller.isOwnedFile('meeting'), false)
})

test('clearing history preserves owned clip IDs, and another recording can start after syncing', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  controller.onRingTrigger('touch', 1000)
  controller.onRecordingStatus(1, 1300)
  controller.onSyncedFiles([{ id: 'owned', name: 'owned.m4a', modifiedAt: 1600, durationMs: 3000, uri: 'file://owned' }])
  controller.clearHistory()
  assert.equal(controller.getState().tasks.length, 0)
  assert.equal(controller.isOwnedFile('owned'), true)
  assert.equal(controller.onRingTrigger('touch', 4000), true)
})

test('a new status transition after prior sync opens a second ring task', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  assert.equal(controller.onRecordingStatus(2, 1000), true)
  controller.onRecordingStatus(1, 2000)
  assert.equal(controller.onRecordingStatus(2, 5000), true)
  assert.equal(controller.getState().tasks.length, 2)
})

test('two queued ring captures claim distinct files in their own time windows', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  controller.onRingTrigger('touch', 1000)
  controller.onRecordingStatus(1, 1400)
  controller.onRingTrigger('touch', 5000)
  controller.onRecordingStatus(1, 5300)
  const files = [
    { id: 'second', name: 'second.m4a', modifiedAt: 5500, durationMs: 4000, uri: 'file://second' },
    { id: 'first', name: 'first.m4a', modifiedAt: 1600, durationMs: 4000, uri: 'file://first' },
  ]
  assert.equal(controller.onSyncedFiles(files)?.id, 'first')
  assert.equal(controller.onSyncedFiles(files)?.id, 'second')
})

test('delayed transfers match each ring capture by the recording time in its filename', () => {
  const secondStart = Date.parse('2026-10-09T03:37:11.337Z')
  const thirdStart = Date.parse('2026-10-09T03:37:36.898Z')
  const fourthStart = Date.parse('2026-10-09T03:39:17.513Z')
  const controller = createVoiceAgentController({ now: () => Date.parse('2026-10-09T03:40:25Z') })
  controller.onRingTrigger('touch', secondStart)
  controller.onRecordingStatus(1, secondStart + 4000)
  controller.onRingTrigger('touch', thirdStart)
  controller.onRecordingStatus(1, thirdStart + 4000)
  controller.onRingTrigger('touch', fourthStart)
  controller.onRecordingStatus(1, fourthStart + 4000)
  const files = [
    { id: 'second', name: '2026_10_09_03_37_10.m4a', modifiedAt: Date.parse('2026-10-09T03:40:20Z'), durationMs: 4500, uri: 'file://second' },
    { id: 'third', name: '2026_10_09_03_37_35.m4a', modifiedAt: Date.parse('2026-10-09T03:40:22Z'), durationMs: 3800, uri: 'file://third' },
    { id: 'fourth', name: '2026_10_09_03_39_16.m4a', modifiedAt: Date.parse('2026-10-09T03:40:23Z'), durationMs: 3200, uri: 'file://fourth' },
  ]
  assert.equal(controller.onSyncedFiles(files)?.id, 'second')
  assert.equal(controller.getState().tasks[0].file?.id, 'second')
  assert.equal(controller.onSyncedFiles(files)?.id, 'third')
  assert.equal(controller.getState().tasks[1].file?.id, 'third')
  assert.equal(controller.onSyncedFiles(files)?.id, 'fourth')
  assert.equal(controller.getState().tasks[2].file?.id, 'fourth')
})

test('restored waiting tasks reclaim a delayed file previously assigned to the wrong capture', () => {
  const secondStart = Date.parse('2026-10-09T03:37:11.337Z')
  const thirdStart = Date.parse('2026-10-09T03:37:36.898Z')
  const fourthStart = Date.parse('2026-10-09T03:39:17.513Z')
  const secondFile = { id: 'second', name: '2026_10_09_03_37_10.m4a', modifiedAt: Date.parse('2026-10-09T03:40:20Z'), durationMs: 4500, uri: 'file://second' }
  const thirdFile = { id: 'third', name: '2026_10_09_03_37_35.m4a', modifiedAt: Date.parse('2026-10-09T03:40:22Z'), durationMs: 3800, uri: 'file://third' }
  const fourthFile = { id: 'fourth', name: '2026_10_09_03_39_16.m4a', modifiedAt: Date.parse('2026-10-09T03:40:23Z'), durationMs: 3200, uri: 'file://fourth' }
  const controller = createVoiceAgentController({ now: () => Date.parse('2026-10-09T03:43:00Z') })
  controller.restore([
    { id: 'ring-second', source: 'ring', startedAt: secondStart, endedAt: secondStart + 4000, status: 'syncing' },
    { id: 'ring-third', source: 'ring', startedAt: thirdStart, endedAt: thirdStart + 4000, status: 'syncing' },
    { id: 'ring-fourth', source: 'ring', startedAt: fourthStart, endedAt: fourthStart + 4000, status: 'completed', file: secondFile, prompt: 'wrong transcript', output: 'wrong answer' },
  ], ['second'])
  assert.equal(controller.onSyncedFiles([secondFile, thirdFile, fourthFile])?.id, 'second')
  assert.equal(controller.getState().tasks[0].file?.id, 'second')
  assert.equal(controller.onSyncedFiles([secondFile, thirdFile, fourthFile])?.id, 'third')
  assert.equal(controller.getState().tasks[1].file?.id, 'third')
  assert.equal(controller.onSyncedFiles([secondFile, thirdFile, fourthFile])?.id, 'fourth')
  assert.equal(controller.getState().tasks[2].file?.id, 'fourth')
  assert.notEqual(controller.getState().tasks[2].output, 'wrong answer')
})

test('model reasoning remains hidden while visible answer is shown', () => {
  assert.equal(visibleAnswer('<think>private reasoning</think>你好'), '你好')
  assert.equal(visibleAnswer('<think>not finished'), '')
})

test('an unmatched ring capture eventually reports failure without using an old file', () => {
  let now = 1000
  const controller = createVoiceAgentController({ now: () => now })
  controller.setKnownFiles(['old'])
  controller.onRingTrigger('touch', now)
  controller.onRecordingStatus(1, 1400)
  now = 400_000
  assert.equal(controller.onSyncedFiles([{ id: 'old', name: 'old.m4a', modifiedAt: 100, durationMs: 3000, uri: 'file://old' }]), undefined)
  assert.equal(controller.getState().tasks[0].status, 'failed')
  assert.equal(controller.isOwnedFile('old'), false)
})

test('image service only accepts a real returned image URL', async () => {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ output: 'Ready', imageUrl: 'https://example.com/image.png' }) }
  }
  const result = await generateVoiceAgentImage('画一张夜景', 'https://api.example.com', fetcher)
  assert.equal(result.imageUrl, 'https://example.com/image.png')
  assert.equal(calls[0].url, 'https://api.example.com/api/assistant/skill-refine')
  assert.equal(calls[0].body.skill, 'image')
  await assert.rejects(generateVoiceAgentImage('画一张夜景', 'https://api.example.com', async () => ({ ok: true, json: async () => ({ output: 'placeholder' }) })))
})

test('text chat does not steal an overlapping ring capture', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  controller.onRingTrigger('touch', 1000)
  controller.addText('你好')
  controller.onRecordingStatus(1, 4000)
  assert.equal(controller.getState().tasks[0].status, 'syncing')
  assert.equal(controller.getState().tasks[1].source, 'text')
})

test('a delayed duplicate touch after ring stop does not create a second capture', () => {
  const controller = createVoiceAgentController({ now: () => 1000 })
  controller.onRingTrigger('touch', 1000, 900)
  controller.onRecordingStatus(1, 4000)
  assert.equal(controller.onRingTrigger('touch', 4100, 900), false)
  assert.equal(controller.getState().tasks.length, 1)
})

test('a one-second ring file timestamp still matches its fresh capture, but known old IDs do not', () => {
  const controller = createVoiceAgentController({ now: () => 2000 })
  controller.setKnownFiles(['old'])
  controller.onRingTrigger('touch', 1999)
  controller.onRecordingStatus(1, 3000)
  assert.equal(controller.onSyncedFiles([
    { id: 'old', name: 'old.m4a', modifiedAt: 1900, durationMs: 2000, uri: 'file://old' },
    { id: 'fresh', name: 'fresh.m4a', modifiedAt: 1000, durationMs: 2000, uri: 'file://fresh' },
  ])?.id, 'fresh')
})

test('unfinished restored work becomes retryable instead of permanently loading', () => {
  const controller = createVoiceAgentController()
  controller.restore([{ id: 'ring-1', source: 'ring', startedAt: 1, status: 'transcribing', file: { id: 'audio', name: 'audio.m4a', modifiedAt: 1, durationMs: 1000, uri: 'file://audio' } }])
  assert.equal(controller.getState().tasks[0].status, 'failed')
  assert.equal(controller.isOwnedFile('audio'), true)
})

test('negated and informational taxi messages never open the ride route', () => {
  assert.equal(classifyPrompt('不要打车去虹桥机场'), 'chat')
  assert.equal(classifyPrompt('打车去虹桥机场多少钱？'), 'chat')
  assert.equal(classifyPrompt('帮我打车去虹桥机场'), 'ride')
})
