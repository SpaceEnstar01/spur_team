import { AppState, DeviceEventEmitter, type AppStateStatus } from 'react-native'

import {
  YanqiangVoiceEventNames,
  YanqiangVoiceEvents,
  YanqiangVoiceNative
} from '@/native/YanqiangVoiceNative'
import { getRingUiSession } from '@/services/ringConnectionSession'
import { purgeReimportedDeletedAudio } from '@/services/localAudioLibrary'
import { shouldRetryStalledSync } from '@/services/autoSyncWatchdog'
import { consumeVoiceAgentSync } from '@/voice-agent/voiceAgentRuntime'

export const AUTO_SYNC_COMPLETE_EVENT = 'spur.autoSyncComplete'

const POLL_INTERVAL_MS = 18_000
const RECORDING_END_DELAY_MS = 900
const CONNECT_SYNC_DELAY_MS = 600
let started = false
let lastWorkingState: number | null = null
let syncInFlight = false
let syncLastActivityAt = 0
let syncRunId = 0
let connected = false
let appActive = true
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Keeps local recordings in sync while the app is open and the ring is connected:
 * - sync on connect
 * - sync when a recording ends
 * - periodic catch-up sync
 * Does not change native connect logic.
 */
export function startAutoSyncWatch() {
  if (started || !YanqiangVoiceEvents || !YanqiangVoiceNative.isAvailable) return
  started = true

  YanqiangVoiceEvents.addListener(YanqiangVoiceEventNames.connection, (event) => {
    const status = String(event?.status || '')
    if (status === 'connected') {
      connected = true
      console.log('[autoSync] connected → schedule sync')
      scheduleAutoSync(CONNECT_SYNC_DELAY_MS, 'connect')
      startPolling()
      return
    }
    if (status === 'disconnected' || status === 'error') {
      connected = false
      stopPolling()
      console.log('[autoSync] disconnected → pause polling')
    }
  })

  YanqiangVoiceEvents.addListener(YanqiangVoiceEventNames.status, (event) => {
    const next = Number(event?.state)
    if (!Number.isFinite(next)) return

    // Status updates only arrive while BLE is alive.
    if (!connected) {
      connected = true
      startPolling()
    }

    const wasRecording = lastWorkingState === 2 || lastWorkingState === 3
    const readyToSync = next === 4 || (wasRecording && next === 1)
    lastWorkingState = next

    if (!readyToSync) return
    console.log('[autoSync] recording-end state → schedule sync', { next, wasRecording })
    scheduleAutoSync(RECORDING_END_DELAY_MS, 'recording-end')
  })

  for (const name of [YanqiangVoiceEventNames.syncState, YanqiangVoiceEventNames.syncProgress]) {
    YanqiangVoiceEvents.addListener(name, () => {
      if (syncInFlight) syncLastActivityAt = Date.now()
    })
  }
  YanqiangVoiceEvents.addListener(YanqiangVoiceEventNames.fileReady, () => {
    if (syncInFlight) syncLastActivityAt = Date.now()
    // A converted file can be processed before the rest of the ring transfer finishes.
    void purgeReimportedDeletedAudio().then(consumeVoiceAgentSync).catch((error) =>
      console.warn('[autoSync] file-ready handoff failed', error))
  })

  AppState.addEventListener('change', onAppStateChange)

  // Restore from UI session if user already connected earlier in this process.
  const session = getRingUiSession()
  if (session.connectionState === 'connected') {
    connected = true
    scheduleAutoSync(CONNECT_SYNC_DELAY_MS, 'session-restore')
    startPolling()
  }
}

function onAppStateChange(state: AppStateStatus) {
  appActive = state === 'active'
  if (appActive && connected) {
    scheduleAutoSync(300, 'app-foreground')
    startPolling()
  } else {
    stopPolling()
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!connected || !appActive) return
    void runAutoSync('poll')
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function scheduleAutoSync(delayMs: number, reason: string) {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    void runAutoSync(reason)
  }, delayMs)
}

function unlockStaleSyncIfNeeded() {
  if (!shouldRetryStalledSync(syncInFlight, syncLastActivityAt, Date.now())) return
  console.warn('[autoSync] retrying stalled sync after 30s without transfer activity')
  syncInFlight = false
  syncLastActivityAt = 0
}

async function runAutoSync(reason: string) {
  unlockStaleSyncIfNeeded()
  if (syncInFlight) {
    console.log('[autoSync] skip (in flight)', reason)
    return
  }
  if (!YanqiangVoiceNative.isAvailable) return

  syncInFlight = true
  syncLastActivityAt = Date.now()
  const runId = ++syncRunId
  try {
    console.log('[autoSync] syncVoiceRecordings', reason)
    const result = await YanqiangVoiceNative.syncVoiceRecordings()
    await purgeReimportedDeletedAudio()
    await consumeVoiceAgentSync().catch((error) => console.warn('[autoSync] voice agent handoff failed', error))
    const count = result?.files?.length ?? 0
    console.log('[autoSync] success', reason, 'files=', count)
    DeviceEventEmitter.emit(AUTO_SYNC_COMPLETE_EVENT, { reason, count })
  } catch (error) {
    // Busy / not-ready are expected during recording; keep quiet-ish.
    console.warn('[autoSync] failed', reason, error)
    await purgeReimportedDeletedAudio().then(consumeVoiceAgentSync).catch((handoffError) =>
      console.warn('[autoSync] recovery handoff failed', handoffError))
  } finally {
    if (runId === syncRunId) {
      syncInFlight = false
      syncLastActivityAt = 0
    }
  }
}
