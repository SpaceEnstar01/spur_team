import { AppState, DeviceEventEmitter, Platform } from 'react-native'
import * as FileSystem from 'expo-file-system'

import { YanqiangVoiceEvents, YanqiangVoiceEventNames, YanqiangVoiceNative } from '@/native/YanqiangVoiceNative'
import { listLocalAudioFiles } from '@/services/localAudioLibrary'
import { transcribeVoiceAgentAudio } from './voiceAgentTranscription'
import { AUDIO_AGENT_BASE_URL } from '@/config/api'
import { createVoiceAgentController, type AgentFile, type AgentTask } from './VoiceAgentController'
import { classifyPrompt, extractRideRoute } from './voiceAgentPolicy'
import { createTaxiURI } from './VoiceAgentAMapClient'
import { startLingReply } from './VoiceAgentAIClient'
import { generateVoiceAgentImage } from './VoiceAgentImageService'

export const voiceAgentController = createVoiceAgentController()
export const VOICE_AGENT_READY_EVENT = 'spur.voiceAgentReady'
const HISTORY = `${FileSystem.documentDirectory}spur-voice-agent-history.json`
let config: { enabled: boolean; siliconFlowApiKey: string; amapWebApiKey: string } | null = null
let started = false
let navigate: (() => void) | null = null
let pendingNavigation = false
let busy = false
let activeRequest: { cancel: () => void } | null = null
let activeAbort: AbortController | null = null
let requestQueue = Promise.resolve()
let requestGeneration = 0

export function setVoiceAgentNavigator(callback: () => void) {
  navigate = callback
  if (pendingNavigation) { pendingNavigation = false; callback() }
}

export function isVoiceAgentDebugEnabled() { return __DEV__ && !!config?.enabled }
export function isVoiceAgentOwnedFile(id: string) { return voiceAgentController.isOwnedFile(id) }

function openPage() {
  if (AppState.currentState !== 'active') return
  if (navigate) navigate()
  else pendingNavigation = true
}

async function persist() {
  const tasks = voiceAgentController.getState().tasks.slice(-40)
  await FileSystem.writeAsStringAsync(HISTORY, JSON.stringify({ tasks, owned: voiceAgentController.ownedFileIds() })).catch(() => undefined)
}

export function clearVoiceAgentHistory() { voiceAgentController.clearHistory() }
export function cancelActiveVoiceAgentRequest() {
  requestGeneration += 1
  activeRequest?.cancel()
  activeAbort?.abort()
}

function requireCurrent(generation: number, signal?: AbortSignal) {
  if (generation !== requestGeneration || signal?.aborted || AppState.currentState !== 'active') {
    throw new Error('Request cancelled')
  }
}

export async function startVoiceAgentRuntime() {
  if (started || !__DEV__ || Platform.OS !== 'ios' || !YanqiangVoiceEvents || !YanqiangVoiceNative.isAvailable) return
  started = true
  try {
    config = await YanqiangVoiceNative.voiceAgentDebugConfig()
    if (!config.enabled) return
    DeviceEventEmitter.emit(VOICE_AGENT_READY_EVENT)
    const saved = await FileSystem.readAsStringAsync(HISTORY).then(JSON.parse).catch(() => null)
    if (Array.isArray(saved)) voiceAgentController.restore(saved)
    else if (saved && Array.isArray(saved.tasks)) voiceAgentController.restore(saved.tasks, Array.isArray(saved.owned) ? saved.owned : [])
    voiceAgentController.setKnownFiles((await listLocalAudioFiles()).map((file) => file.id))
    voiceAgentController.subscribe(() => { void persist() })
    YanqiangVoiceEvents.addListener(YanqiangVoiceEventNames.touch, (event) => {
      if (Number(event?.event) !== 0x0103 || AppState.currentState !== 'active') return
      const receivedAt = Date.now()
      const timestamp = Number(event?.timestamp)
      const validTimestamp = Number.isFinite(timestamp) && timestamp > 0 && Math.abs(receivedAt - timestamp) < 30_000
      if (voiceAgentController.onRingTrigger('touch', validTimestamp ? timestamp : receivedAt, validTimestamp ? timestamp : undefined)) openPage()
    })
    YanqiangVoiceEvents.addListener(YanqiangVoiceEventNames.status, (event) => {
      const state = Number(event?.state)
      const foreground = AppState.currentState === 'active'
      if (!foreground && state !== 1 && state !== 4) return
      if (voiceAgentController.onRecordingStatus(state, Date.now()) && foreground) openPage()
    })
    YanqiangVoiceEvents.addListener(YanqiangVoiceEventNames.connection, (event) => {
      if (event?.status === 'connected') void YanqiangVoiceNative.setTouchEventReporting(true)
    })
    await YanqiangVoiceNative.setTouchEventReporting(true)
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') cancelActiveVoiceAgentRequest()
    })
    // Recover recordings already converted locally, even if the ring is no longer connected.
    void consumeVoiceAgentSync().catch((error) => console.warn('[voiceAgent] local recovery failed', error))
  } catch (error) {
    console.warn('[voiceAgent] Debug setup unavailable', error)
    started = false
  }
}

export async function consumeVoiceAgentSync() {
  if (!isVoiceAgentDebugEnabled()) return
  const files = await listLocalAudioFiles()
  let claimed: AgentFile | undefined
  while ((claimed = voiceAgentController.onSyncedFiles(files as AgentFile[]))) {
    const task = voiceAgentController.getState().tasks.find((item) => item.file?.id === claimed?.id)
    if (!task) continue
    const file = claimed
    const generation = requestGeneration
    const next = requestQueue.then(async () => {
      const controller = new AbortController()
      try {
        requireCurrent(generation)
        activeAbort = controller
        const result = await transcribeVoiceAgentAudio({ uri: file.uri, name: file.name, signal: controller.signal })
        requireCurrent(generation, controller.signal)
        const prompt = result.intent.trim() || result.transcript.trim()
        if (!prompt) throw new Error('No speech was recognized')
        voiceAgentController.update(task.id, { prompt, status: 'responding' })
        await runAgentTask(task.id, prompt, generation)
      } catch (error) {
        voiceAgentController.update(task.id, { status: 'failed', error: String(error) })
      } finally {
        if (activeAbort === controller) activeAbort = null
      }
    })
    requestQueue = next.catch(() => undefined)
  }
  voiceAgentController.setKnownFiles(files.map((file) => file.id))
}

export async function submitVoiceAgentText(prompt: string, source: 'text' | 'phone' = 'text') {
  if (!isVoiceAgentDebugEnabled()) throw new Error('Voice agent is available in iOS Debug only')
  if (!prompt.trim()) return
  const task = voiceAgentController.addText(prompt.trim(), source)
  await enqueueAgentTask(task.id, prompt.trim(), requestGeneration)
}

export async function retryVoiceAgentTask(task: AgentTask) {
  if (!task.prompt && task.file) {
    voiceAgentController.update(task.id, { status: 'transcribing', error: undefined })
    const generation = requestGeneration
    const next = requestQueue.then(async () => {
      const controller = new AbortController()
      try {
        requireCurrent(generation)
        activeAbort = controller
        const result = await transcribeVoiceAgentAudio({ uri: task.file!.uri, name: task.file!.name, signal: controller.signal })
        requireCurrent(generation, controller.signal)
        const prompt = result.intent.trim() || result.transcript.trim()
        if (!prompt) throw new Error('No speech was recognized')
        voiceAgentController.update(task.id, { prompt, status: 'responding' })
        await runAgentTask(task.id, prompt, generation)
      } catch (error) {
        voiceAgentController.update(task.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (activeAbort === controller) activeAbort = null
      }
    })
    requestQueue = next.catch(() => undefined)
    await next
    return
  }
  if (!task.prompt) throw new Error('No recognized prompt to retry')
  voiceAgentController.update(task.id, { status: 'responding', error: undefined })
  await enqueueAgentTask(task.id, task.prompt, requestGeneration)
}

function enqueueAgentTask(id: string, prompt: string, generation: number) {
  const next = requestQueue.then(() => runAgentTask(id, prompt, generation))
  requestQueue = next.catch(() => undefined)
  return next
}

async function runAgentTask(id: string, prompt: string, generation: number) {
  if (busy) { voiceAgentController.update(id, { status: 'failed', error: 'Another request is in progress. Tap retry.' }); return }
  busy = true
  const controller = new AbortController()
  activeAbort = controller
  const timeout = setTimeout(() => controller.abort(), 90_000)
  try {
    requireCurrent(generation, controller.signal)
    const kind = classifyPrompt(prompt)
    if (kind === 'ride') {
      const route = extractRideRoute(prompt)
      if (!route) throw new Error('Please tell me the pickup and destination clearly.')
      const uri = await createTaxiURI(route, config?.amapWebApiKey || '', fetch, controller.signal)
      requireCurrent(generation, controller.signal)
      await YanqiangVoiceNative.openAMapTaxiURI(uri)
      voiceAgentController.update(id, { status: 'completed', destination: route.destination, output: `AMap opened with ${route.origin ? `pickup: ${route.origin} and ` : ''}destination: ${route.destination}. Please confirm the ride in AMap.` })
    } else if (kind === 'image') {
      const result = await generateVoiceAgentImage(prompt, AUDIO_AGENT_BASE_URL, fetch, controller.signal)
      requireCurrent(generation, controller.signal)
      voiceAgentController.update(id, { status: 'completed', imageUrl: result.imageUrl, output: result.output })
    } else {
      const history = voiceAgentController.getState().tasks.filter((task) => task.id !== id && task.status === 'completed' && task.prompt && task.output).slice(-5).flatMap((task) => [
        { role: 'user' as const, content: task.prompt || '' },
        { role: 'assistant' as const, content: task.output || '' },
      ])
      const request = startLingReply({ prompt, key: config?.siliconFlowApiKey || '', history, onChunk: (output) => voiceAgentController.update(id, { output }) })
      activeRequest = request
      const output = await request.promise
      requireCurrent(generation, controller.signal)
      voiceAgentController.update(id, { status: 'completed', output })
    }
  } catch (error) {
    voiceAgentController.update(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
  } finally {
    clearTimeout(timeout)
    activeRequest = null
    activeAbort = null
    busy = false
  }
}
