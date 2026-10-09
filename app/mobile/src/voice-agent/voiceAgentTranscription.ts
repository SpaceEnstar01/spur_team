import { NativeModules, Platform } from 'react-native'

import { captureVoiceIntent } from '@/services/assistantSkillApi'
import { transcribeWithLocalFallback } from './transcriptionPolicy'

type SpurSpeechTranscription = {
  transcribe(uri: string, locale: string, requestId: string): Promise<string>
  cancel(requestId: string): void
}

const speech = NativeModules.SpurSpeechTranscription as SpurSpeechTranscription | undefined

export function transcribeVoiceAgentAudio(input: { uri: string; name: string; signal?: AbortSignal }) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const startedAt = Date.now()
  return transcribeWithLocalFallback({
    local: Platform.OS === 'ios' && speech ? () => speech.transcribe(input.uri, 'zh-CN', requestId) : undefined,
    cancelLocal: () => speech?.cancel(requestId),
    cloud: async () => {
      const cloudStartedAt = Date.now()
      const result = await captureVoiceIntent(input)
      console.info('[voiceAgent] cloud transcription ms=', Date.now() - cloudStartedAt)
      return result
    },
    signal: input.signal,
    localTimeoutMs: 5_000,
    onLocalFailure: (error) => console.info('[voiceAgent] local speech unavailable after ms=', Date.now() - startedAt, String(error)),
  }).then((result) => {
    console.info('[voiceAgent] transcription total ms=', Date.now() - startedAt)
    return result
  })
}
