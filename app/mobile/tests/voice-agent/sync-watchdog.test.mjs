import test from 'node:test'
import assert from 'node:assert/strict'

test('a stalled ring transfer can retry, but an active transfer keeps its lock', async () => {
  const { shouldRetryStalledSync } = await import('../../src/services/autoSyncWatchdog.ts')
  assert.equal(shouldRetryStalledSync(true, 1000, 30_999), false)
  assert.equal(shouldRetryStalledSync(true, 1000, 31_000), true)
  assert.equal(shouldRetryStalledSync(true, 25_000, 31_000), false)
  assert.equal(shouldRetryStalledSync(false, 1000, 31_000), false)
})
