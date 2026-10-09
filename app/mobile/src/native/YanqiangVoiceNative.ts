import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

type NativeFile = {
  name: string
  uri: string
  timestamp: number
  size: number
  rawFileTime?: number
}

type RecordingSummary = {
  supported: boolean
  code?: number
  message?: string
  function?: number
  fileCount: number
  totalBytes: number
  files: NativeFile[]
}

type VoiceRecordParamResult = {
  code: number
  message?: string
  data?: {
    volume: number
    bitrate: number
    lightBrightness: number
  }
}

type YanqiangVoiceNativeModule = {
  initSdk(): Promise<boolean>
  startScan(): Promise<boolean>
  stopScan(): void
  connect(macAddress: string): Promise<boolean>
  disconnect(): Promise<boolean>
  setTouchEventReporting(enabled: boolean): Promise<{ enabled: boolean; result: number }>
  voiceAgentDebugConfig(): Promise<{ enabled: boolean; siliconFlowApiKey: string; amapWebApiKey: string }>
  openAMapTaxiURI(uri: string): Promise<void>
  queryVoiceRecordingSummary(): Promise<RecordingSummary>
  syncVoiceRecordings(): Promise<{ files: NativeFile[] }>
  getVoiceRecordParam(): Promise<VoiceRecordParamResult>
  setVoiceRecordParam(
    bitrate: number,
    volume: number,
    lightBrightness: number,
  ): Promise<VoiceRecordParamResult>
}

const native = NativeModules.YanqiangVoiceModule as YanqiangVoiceNativeModule | undefined

export const YanqiangVoiceNative = {
  isAvailable: (Platform.OS === 'android' || Platform.OS === 'ios') && !!native,
  initSdk: () => requireNative().initSdk(),
  startScan: () => requireNative().startScan(),
  stopScan: () => requireNative().stopScan(),
  connect: (macAddress: string) => requireNative().connect(macAddress),
  disconnect: () => requireNative().disconnect(),
  setTouchEventReporting: (enabled: boolean) => requireNative().setTouchEventReporting(enabled),
  voiceAgentDebugConfig: () => requireNative().voiceAgentDebugConfig(),
  openAMapTaxiURI: (uri: string) => requireNative().openAMapTaxiURI(uri),
  queryVoiceRecordingSummary: () => requireNative().queryVoiceRecordingSummary(),
  syncVoiceRecordings: () => requireNative().syncVoiceRecordings(),
  getVoiceRecordParam: () => requireNative().getVoiceRecordParam(),
  setVoiceRecordParam: (bitrate: number, volume: number, lightBrightness: number) =>
    requireNative().setVoiceRecordParam(bitrate, volume, lightBrightness),
}

export const YanqiangVoiceEvents = native ? new NativeEventEmitter(native as any) : undefined

export const YanqiangVoiceEventNames = {
  scan: 'yanqiangVoiceScanEvent',
  connection: 'yanqiangVoiceConnectionChanged',
  status: 'yanqiangVoiceStatusUpdate',
  syncState: 'yanqiangVoiceSyncState',
  syncProgress: 'yanqiangVoiceSyncProgress',
  fileReady: 'yanqiangVoiceFileReady',
  error: 'yanqiangVoiceError',
  touch: 'yanqiangSmartTouchEvent',
} as const

function requireNative(): YanqiangVoiceNativeModule {
  if (!native) {
    throw new Error(`YanqiangVoiceModule is unavailable on ${Platform.OS} after native installation`)
  }
  return native
}

export type { NativeFile, RecordingSummary, VoiceRecordParamResult }
