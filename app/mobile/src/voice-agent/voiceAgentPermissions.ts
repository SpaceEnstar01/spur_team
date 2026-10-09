import { Audio } from 'expo-av'
import { NativeModules, Platform } from 'react-native'

import { createHomeVoicePermissionPrimer } from './voicePermissionPrimer'

type SpeechAuthorization = { requestAuthorization(): Promise<string> }
const speech = NativeModules.SpurSpeechTranscription as SpeechAuthorization | undefined

const prime = createHomeVoicePermissionPrimer({
  getMicrophone: async () => (await Audio.getPermissionsAsync()).status,
  requestMicrophone: () => Audio.requestPermissionsAsync(),
  requestSpeech: () => speech!.requestAuthorization(),
})

export function primeVoiceAgentPermissionsOnHome(): Promise<void> {
  if (!__DEV__ || Platform.OS !== 'ios' || !speech?.requestAuthorization) return Promise.resolve()
  return prime()
}
