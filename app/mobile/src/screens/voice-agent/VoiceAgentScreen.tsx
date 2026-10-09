import { useEffect, useRef, useState } from 'react'
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Audio } from 'expo-av'
import { ArrowLeft, ArrowUp, Image as ImageIcon, MapPin, Mic, Moon, Sparkles, Square, Trash2 } from 'lucide-react-native'
import { useNavigation } from '@react-navigation/native'

import { transcribeVoiceAgentAudio } from '@/voice-agent/voiceAgentTranscription'
import { APP_LANGUAGE } from '@/locales'
import { cancelActiveVoiceAgentRequest, clearVoiceAgentHistory, retryVoiceAgentTask, submitVoiceAgentText, voiceAgentController } from '@/voice-agent/voiceAgentRuntime'
import type { AgentTask } from '@/voice-agent/VoiceAgentController'

const chinese = APP_LANGUAGE === 'zh'
const copy = chinese ? {
  title: '戒指智能体', subtitle: '灵感、问答与行动，一个地方完成', awake: '随时待命',
  suggestion: '试试这样说', image: '画一张城市夜景', taxi: '帮我打车去虹桥机场',
  question: '今天有什么好主意？', placeholder: '向戒指智能体提问…', listening: '正在录音，点击结束',
  waiting: '戒指正在录音，结束后自动处理', syncing: '正在等待戒指同步', processing: '正在思考…',
  retry: '重试', noSpeech: '没有识别到语音，请重试', permission: '请在系统设置中允许麦克风权限',
  clear: '清空历史', clearPrompt: '确定清空智能体对话吗？录音文件不会删除。', cancel: '取消',
} : {
  title: 'Ring AI', subtitle: 'Ideas, answers and actions, together', awake: 'Ready when you are',
  suggestion: 'TRY ASKING', image: 'Draw a city at dusk', taxi: '帮我打车去虹桥机场',
  question: 'What should I focus on today?', placeholder: 'Ask your Ring AI…', listening: 'Recording · Tap to finish',
  waiting: 'Recording on your ring', syncing: 'Waiting for ring sync', processing: 'Thinking…',
  retry: 'Retry', noSpeech: 'No speech recognized. Please try again.', permission: 'Please allow microphone access in Settings.',
  clear: 'Clear history', clearPrompt: 'Clear Ring AI conversations? Your audio files will stay.', cancel: 'Cancel',
}

function resultLabel(task: AgentTask) {
  if (task.status === 'recording') return copy.waiting
  if (task.status === 'syncing' || task.status === 'transcribing') return copy.syncing
  if (task.status === 'responding') return copy.processing
  return ''
}

export function VoiceAgentScreen() {
  const navigation = useNavigation()
  const [state, setState] = useState(voiceAgentController.getState())
  const [input, setInput] = useState('')
  const [recording, setRecording] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const recordingRef = useRef<Audio.Recording | null>(null)
  const voiceAbortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<ScrollView | null>(null)

  useEffect(() => voiceAgentController.subscribe(setState), [])
  useEffect(() => () => {
    cancelActiveVoiceAgentRequest()
    voiceAbortRef.current?.abort()
    if (recordingRef.current) void recordingRef.current.stopAndUnloadAsync().catch(() => undefined)
    void Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => undefined)
  }, [])

  async function send(text = input, source: 'text' | 'phone' = 'text') {
    const prompt = text.trim()
    if (!prompt) return
    setInput('')
    try { await submitVoiceAgentText(prompt, source) }
    catch (error) { Alert.alert(copy.title, error instanceof Error ? error.message : String(error)) }
  }

  async function toggleMic() {
    if (recognizing) return
    if (!recordingRef.current) {
      const permission = await Audio.requestPermissionsAsync()
      if (!permission.granted) { Alert.alert(copy.title, copy.permission); return }
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true })
        const created = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY)
        recordingRef.current = created.recording
        setRecording(true)
      } catch (error) { Alert.alert(copy.title, String(error)) }
      return
    }
    const current = recordingRef.current
    recordingRef.current = null
    setRecording(false)
    setRecognizing(true)
    const abort = new AbortController()
    voiceAbortRef.current = abort
    try {
      await current.stopAndUnloadAsync()
      const uri = current.getURI()
      if (!uri) throw new Error(copy.noSpeech)
      const intent = await transcribeVoiceAgentAudio({ uri, name: 'spur-ring-agent.m4a', signal: abort.signal })
      const text = intent.intent.trim() || intent.transcript.trim()
      if (!text) throw new Error(copy.noSpeech)
      await send(text, 'phone')
    } catch (error) { Alert.alert(copy.title, error instanceof Error ? error.message : String(error)) }
    finally {
      setRecognizing(false)
      if (voiceAbortRef.current === abort) voiceAbortRef.current = null
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => undefined)
    }
  }

  function confirmClear() {
    Alert.alert(copy.clear, copy.clearPrompt, [
      { text: copy.cancel, style: 'cancel' },
      { text: copy.clear, style: 'destructive', onPress: clearVoiceAgentHistory },
    ])
  }

  const tasks = state.tasks.slice(-30)
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} style={styles.iconCircle} accessibilityLabel="Back">
            <ArrowLeft size={21} color="#232831" />
          </Pressable>
          <View style={styles.headerCopy}><Text style={styles.headerTitle}>{copy.title}</Text><Text style={styles.headerSubtitle}>{copy.subtitle}</Text></View>
          <Pressable onPress={confirmClear} style={styles.iconCircle} accessibilityLabel={copy.clear}><Trash2 size={19} color="#6262aa" /></Pressable>
        </View>
        <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.content} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
          {tasks.length === 0 ? (
            <>
              <View style={styles.hero}><View style={styles.orb}><Moon size={45} color="#555a9c" /></View><Text style={styles.heroEyebrow}>{copy.awake.toUpperCase()}</Text><Text style={styles.heroTitle}>{copy.title}</Text><Text style={styles.heroText}>{copy.subtitle}</Text></View>
              <Text style={styles.sectionLabel}>{copy.suggestion}</Text>
              <View style={styles.chips}>
                <Suggestion icon={<ImageIcon size={17} color="#6762ad" />} label={copy.image} onPress={() => void send(copy.image)} />
                <Suggestion icon={<MapPin size={17} color="#6762ad" />} label={copy.taxi} onPress={() => void send(copy.taxi)} />
                <Suggestion icon={<Sparkles size={17} color="#6762ad" />} label={copy.question} onPress={() => void send(copy.question)} />
              </View>
            </>
          ) : tasks.map((task) => (
            <View key={task.id} style={styles.turn}>
              {task.prompt ? <View style={styles.promptBubble}><Text style={styles.promptText}>{task.prompt}</Text></View> : null}
              <View style={styles.responseCard}>
                <View style={styles.responseHeader}><View style={styles.smallOrb}><Sparkles size={16} color="#6262aa" /></View><Text style={styles.responseName}>{copy.title}</Text>{task.destination ? <MapPin size={16} color="#6262aa" /> : null}</View>
                {task.output ? <Text style={styles.responseText}>{task.output}</Text> : null}
                {task.imageUrl ? <Image source={{ uri: task.imageUrl }} style={styles.image} resizeMode="cover" /> : null}
                {task.status === 'failed' ? <>
                  <Text style={styles.errorText}>{task.error}</Text>
                  {task.prompt || task.file ? <Pressable style={styles.retryButton} onPress={() => {
                    void retryVoiceAgentTask(task).catch((error) => Alert.alert(copy.title, error instanceof Error ? error.message : String(error)))
                  }}><Text style={styles.retryText}>{copy.retry}</Text></Pressable> : null}
                </> : null}
                {resultLabel(task) ? <Text style={styles.pendingText}>{resultLabel(task)}</Text> : null}
              </View>
            </View>
          ))}
        </ScrollView>
        <View style={styles.composerWrap}>
          {recording ? <Text style={styles.micHint}>{copy.listening}</Text> : null}
          <View style={styles.composer}>
            <Pressable onPress={() => void toggleMic()} style={[styles.micButton, recording && styles.recording]} accessibilityLabel={recording ? 'Stop recording' : 'Record voice'}>
              {recording ? <Square size={18} color="#fff" fill="#fff" /> : <Mic size={21} color="#595e92" />}
            </Pressable>
            <TextInput style={styles.input} value={input} onChangeText={setInput} placeholder={recognizing ? copy.processing : copy.placeholder} placeholderTextColor="#9a9daa" multiline editable={!recognizing} onSubmitEditing={() => void send()} />
            <Pressable style={[styles.sendButton, !input.trim() && styles.sendDisabled]} onPress={() => void send()} disabled={!input.trim()} accessibilityLabel="Send">
              <ArrowUp size={20} color="#fff" />
            </Pressable>
          </View>
          <Text style={styles.footer}>SPUR RING · LING FLASH · DEBUG</Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function Suggestion({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => void }) {
  return <Pressable style={styles.suggestion} onPress={onPress}>{icon}<Text style={styles.suggestionText}>{label}</Text><ArrowUp size={15} color="#a4a5ba" style={{ transform: [{ rotate: '45deg' }] }} /></Pressable>
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, safe: { flex: 1, backgroundColor: '#f6f5f7' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  iconCircle: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#eceaf1' },
  headerCopy: { flex: 1 }, headerTitle: { fontSize: 17, fontWeight: '700', color: '#292936' }, headerSubtitle: { fontSize: 11, color: '#93939c', marginTop: 2 },
  content: { padding: 20, paddingBottom: 36, flexGrow: 1 },
  hero: { alignItems: 'center', paddingTop: 60, paddingBottom: 55 },
  orb: { width: 112, height: 112, borderRadius: 56, backgroundColor: '#e4e3f5', alignItems: 'center', justifyContent: 'center', marginBottom: 23, borderWidth: 8, borderColor: '#eeedf8' },
  heroEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 2, color: '#8989b1' }, heroTitle: { fontSize: 31, fontWeight: '700', color: '#252535', marginTop: 8 }, heroText: { fontSize: 14, color: '#8b8d99', marginTop: 8, textAlign: 'center' },
  sectionLabel: { fontSize: 11, fontWeight: '800', color: '#9999a4', letterSpacing: 1.3, marginBottom: 12 }, chips: { gap: 10 },
  suggestion: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 19, paddingHorizontal: 17, paddingVertical: 17, gap: 13, borderWidth: 1, borderColor: '#eeeef1' },
  suggestionText: { flex: 1, color: '#3d3d4b', fontWeight: '600', fontSize: 14 },
  turn: { marginBottom: 22 }, promptBubble: { alignSelf: 'flex-end', maxWidth: '86%', backgroundColor: '#e5e4f5', padding: 15, borderRadius: 19, borderBottomRightRadius: 5, marginBottom: 12 }, promptText: { color: '#393853', lineHeight: 21 },
  responseCard: { backgroundColor: '#fff', borderRadius: 23, padding: 17, borderWidth: 1, borderColor: '#ececf0' },
  responseHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }, smallOrb: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#eeeefa' }, responseName: { flex: 1, fontSize: 12, fontWeight: '700', color: '#717189' }, responseText: { fontSize: 15, color: '#30303b', lineHeight: 24 },
  image: { width: '100%', aspectRatio: 1, borderRadius: 15, marginTop: 12, backgroundColor: '#f1f1f3' }, pendingText: { color: '#9293a4', fontSize: 13, marginTop: 5 }, errorText: { color: '#b44355', lineHeight: 20 },
  retryButton: { alignSelf: 'flex-start', backgroundColor: '#ecebfa', paddingHorizontal: 13, paddingVertical: 7, borderRadius: 12, marginTop: 10 }, retryText: { color: '#57549b', fontWeight: '700' },
  composerWrap: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, backgroundColor: '#f6f5f7' }, composer: { minHeight: 58, borderRadius: 29, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e5ea', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 },
  micButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' }, recording: { backgroundColor: '#dc6174' },
  input: { flex: 1, minHeight: 42, maxHeight: 112, paddingVertical: 8, color: '#242630', fontSize: 15 }, sendButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#555889', alignItems: 'center', justifyContent: 'center' }, sendDisabled: { backgroundColor: '#c4c3cf' },
  micHint: { textAlign: 'center', color: '#ae5366', marginBottom: 6, fontSize: 12, fontWeight: '600' }, footer: { textAlign: 'center', fontSize: 9, color: '#b5b4be', letterSpacing: 1.2, paddingTop: 10 },
})
