import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, DeviceEventEmitter, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import { Bot, ChevronRight, FileAudio, LoaderCircle, Pause, Play, RefreshCw, Sparkles, Trash2 } from 'lucide-react-native';
import { isVoiceAgentDebugEnabled, VOICE_AGENT_READY_EVENT } from '@/voice-agent/voiceAgentRuntime';
import { primeVoiceAgentPermissionsOnHome } from '@/voice-agent/voiceAgentPermissions';

import { AppScreen } from '@/components/AppScreen';
import { HomeLeadingActions } from '@/components/HomeLeadingActions';
import { LoadingState } from '@/components/LoadingState';
import {
  clearLocalAudioFiles,
  deleteLocalAudioFile,
  listLocalAudioFiles,
  preparePlayback,
  type LocalAudioFile
} from '@/services/localAudioLibrary';
import {
  deleteRecordingAnalysis,
  listRecordingAnalyses,
  processLocalRecording,
  type LocalRecordingAnalysis
} from '@/services/localRecordingAnalysis';
import { AUTO_SYNC_COMPLETE_EVENT } from '@/services/autoSyncRecordings';
import {
  DEMO_BADGE_COLOR,
  DEMO_BADGE_LABEL,
  ensureDemoContent,
  isDemoAudioName
} from '@/services/demoContent';
import { titleFromMeetingNotes } from '@/utils/meetingNotesTitle';
import { colors } from '@/theme/colors';
import { t, APP_LANGUAGE } from '@/locales';

export function RecordingListScreen() {
  const navigation = useNavigation<any>();
  const [files, setFiles] = useState<LocalAudioFile[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, LocalRecordingAnalysis>>({});
  const [loading, setLoading] = useState(true);
  const [voiceAgentReady, setVoiceAgentReady] = useState(isVoiceAgentDebugEnabled());
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      await ensureDemoContent().catch(() => undefined);
      const [all, savedAnalyses] = await Promise.all([listLocalAudioFiles(), listRecordingAnalyses()]);
      setFiles(all.filter((file) => file.category === 'recording'));
      setAnalyses(savedAnalyses);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void refresh();
    return () => {
      const sound = soundRef.current;
      soundRef.current = null;
      if (sound) void sound.unloadAsync();
    };
  }, [refresh]));

  useEffect(() => {
    const ready = DeviceEventEmitter.addListener(VOICE_AGENT_READY_EVENT, () => setVoiceAgentReady(true));
    return () => ready.remove();
  }, []);

  useFocusEffect(useCallback(() => {
    if (!voiceAgentReady) return;
    const timer = setTimeout(() => {
      void primeVoiceAgentPermissionsOnHome().catch((error) => console.warn('[voiceAgent] permission preflight failed', error));
    }, 350);
    return () => clearTimeout(timer);
  }, [voiceAgentReady]));

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(AUTO_SYNC_COMPLETE_EVENT, () => {
      void refresh({ silent: true });
    });
    return () => sub.remove();
  }, [refresh]);

  async function togglePlayback(file: LocalAudioFile) {
    try {
      await preparePlayback();
      if (soundRef.current && playingUri === file.uri) {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded && status.isPlaying) await soundRef.current.pauseAsync();
        else await soundRef.current.playAsync();
        return;
      }
      if (soundRef.current) await soundRef.current.unloadAsync();
      const created = await Audio.Sound.createAsync({ uri: file.uri }, { shouldPlay: true }, onPlaybackStatus);
      soundRef.current = created.sound;
      setPlayingUri(file.uri);
    } catch (error) {
      Alert.alert(t.recordings.play, error instanceof Error ? error.message : String(error));
    }
  }

  function onPlaybackStatus(status: AVPlaybackStatus) {
    if (!status.isLoaded) return;
    setIsPlaying(status.isPlaying);
    if (status.didJustFinish) {
      setPlayingUri(null);
      setIsPlaying(false);
    }
  }

  async function stopPlayback() {
    const sound = soundRef.current;
    soundRef.current = null;
    setPlayingUri(null);
    setIsPlaying(false);
    if (sound) await sound.unloadAsync().catch(() => undefined);
  }

  async function removeFile(file: LocalAudioFile) {
    if (playingUri === file.uri) await stopPlayback();
    await deleteLocalAudioFile(file.uri);
    await deleteRecordingAnalysis(file.id);
    await refresh();
  }

  async function clearAllFiles() {
    await stopPlayback();
    await clearLocalAudioFiles();
    await refresh();
  }

  async function transcribe(file: LocalAudioFile) {
    const processing: LocalRecordingAnalysis = {
      id: file.id,
      fileUri: file.uri,
      fileName: file.name,
      durationMs: file.durationMs,
      size: file.size,
      modifiedAt: file.modifiedAt,
      status: 'processing',
      updatedAt: Date.now()
    };
    setAnalyses((current) => ({ ...current, [file.id]: processing }));

    try {
      const result = await processLocalRecording(file);
      setAnalyses((current) => ({ ...current, [file.id]: result }));
    } catch (error) {
      setAnalyses((current) => ({
        ...current,
        [file.id]: {
          ...processing,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now()
        }
      }));
    }
  }

  function confirmDelete(file: LocalAudioFile) {
    Alert.alert(t.recordings.deleteTitle, t.recordings.deleteMessage, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete, style: 'destructive', onPress: () => void removeFile(file)
      }
    ]);
  }

  function confirmClear() {
    Alert.alert(t.recordings.clearTitle, t.recordings.clearMessage, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.deleteAll, style: 'destructive', onPress: () => void clearAllFiles()
      }
    ]);
  }

  return (
    <AppScreen tone="plain" bottomInset={96}>
      <View style={styles.header}>
        <HomeLeadingActions />
        <View style={styles.flex} />
        {voiceAgentReady ? (
          <Pressable style={styles.iconButton} accessibilityLabel="Open Ring AI" onPress={() => navigation.navigate('VoiceAgent')}>
            <Bot color={colors.text} size={19} />
          </Pressable>
        ) : null}
        <Pressable style={styles.iconButton} onPress={() => void refresh()}>
          <RefreshCw color={colors.text} size={18} />
        </Pressable>
      </View>

      {!loading && files.some((file) => isDemoAudioName(file.name)) ? (
        <View style={styles.reviewBanner}>
          <Text style={styles.reviewBannerText}>{t.recordings.sampleReviewHint}</Text>
        </View>
      ) : null}

      {loading ? <LoadingState label={t.recordings.reading} /> : files.length === 0 ? (
        <View style={styles.emptyCard}>
          <FileAudio color={colors.text} size={30} />
          <Text style={styles.emptyTitle}>{t.recordings.emptyTitle}</Text>
          <Text style={styles.emptyText}>{t.recordings.emptyText}</Text>
        </View>
      ) : (
        <View style={styles.list}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t.recordings.recent}</Text>
            <Text style={styles.count}>{files.length}</Text>
            <Pressable
              style={styles.clearIconButton}
              onPress={confirmClear}
              disabled={files.length === 0}
              hitSlop={8}
            >
              <Trash2 color={files.length === 0 ? colors.textTertiary : colors.danger} size={16} />
            </Pressable>
          </View>
          {files.map((file) => {
            const active = playingUri === file.uri;
            const analysis = analyses[file.id];
            const completed = analysis?.status === 'completed';
            const processing = analysis?.status === 'processing';
            const isDemo = isDemoAudioName(file.name);
            return (
              <View style={styles.card} key={file.id}>
                <Pressable style={styles.cardMain} disabled={!completed} onPress={() => navigation.navigate('RecordingSummary', { id: file.id })}>
                  <View style={styles.fileIcon}><FileAudio color={colors.text} size={21} /></View>
                  <View style={styles.flex}>
                    <View style={styles.titleRow}>
                      <Text style={styles.fileName} numberOfLines={1}>{recordingTitle(file, analysis)}</Text>
                      {isDemo ? <Text style={styles.demoBadge}>{DEMO_BADGE_LABEL}</Text> : null}
                    </View>
                    <Text style={styles.meta}>{recordingDate(file)} · {formatDuration(file.durationMs)} · {formatBytes(file.size)}</Text>
                    <Text style={[styles.state, analysis?.status === 'failed' && styles.errorState]}>{statusLabel(analysis)}</Text>
                  </View>
                  {completed && <ChevronRight color={colors.textTertiary} size={18} />}
                </Pressable>
                {analysis?.status === 'failed' && !!analysis.error && <Text style={styles.errorText} numberOfLines={2}>{analysis.error}</Text>}
                <View style={styles.actions}>
                  <Pressable style={styles.playAction} onPress={() => void togglePlayback(file)}>
                    {active && isPlaying ? <Pause color={colors.text} size={17} /> : <Play color={colors.text} size={17} />}
                    <Text style={styles.playActionText}>{active && isPlaying ? t.recordings.pause : t.recordings.play}</Text>
                  </Pressable>
                  <Pressable style={[styles.transcribeButton, processing && styles.disabled]} disabled={processing} onPress={() => void transcribe(file)}>
                    {processing ? <LoaderCircle color="#fff" size={16} /> : <Sparkles color="#fff" size={16} />}
                    <Text style={styles.transcribeText}>{processing ? t.recordings.processing : completed ? t.recordings.reprocess : t.recordings.transcribeAction}</Text>
                  </Pressable>
                  <Pressable style={styles.deleteButton} onPress={() => confirmDelete(file)}><Trash2 color={colors.danger} size={17} /></Pressable>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </AppScreen>
  );
}

function recordingTitle(file: LocalAudioFile, analysis?: LocalRecordingAnalysis) {
  if (analysis?.status === 'completed') {
    const title = titleFromMeetingNotes(analysis.meetingNotes, 48);
    if (title) return title;
  }
  return recordingDate(file);
}

function statusLabel(analysis?: LocalRecordingAnalysis) {
  if (!analysis) return t.recordings.pendingSummary;
  if (analysis.status === 'processing') return t.recordings.processing;
  if (analysis.status === 'completed') return t.recordings.completed;
  if (analysis.status === 'failed') return t.recordings.failed;
  return t.recordings.pendingSummary;
}

function formatDuration(ms: number) {
  if (!ms) return t.recordings.unknownDuration;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function recordingDate(file: LocalAudioFile) {
  const match = file.name.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\D|$)/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  if (!file.modifiedAt) return t.recordings.unknownTime;
  const date = new Date(file.modifiedAt);
  const parts = new Intl.DateTimeFormat(APP_LANGUAGE === 'en' ? 'en-CA' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 18 },
  reviewBanner: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#f5f7f9',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 14
  },
  reviewBannerText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18
  },
  clearIconButton: { padding: 4, marginLeft: 4 },
  iconButton: { padding: 10, borderRadius: 13, backgroundColor: '#f3f3f3', borderWidth: 1, borderColor: colors.border },
  emptyCard: { alignItems: 'center', backgroundColor: colors.card, borderRadius: 22, padding: 28, gap: 8, borderWidth: 1, borderColor: colors.border },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  emptyText: { color: colors.textSecondary, textAlign: 'center', fontSize: 13, lineHeight: 20 },
  list: { gap: 11 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 2, gap: 8 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  count: { color: colors.textSecondary, fontSize: 15, fontWeight: '700' },
  card: { backgroundColor: colors.card, borderRadius: 18, padding: 13, borderWidth: 1, borderColor: colors.border },
  cardMain: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fileIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f3f3f3', borderWidth: 1, borderColor: colors.border },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileName: { color: colors.text, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  demoBadge: {
    color: '#fff',
    backgroundColor: DEMO_BADGE_COLOR,
    overflow: 'hidden',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6
  },
  meta: { color: colors.textSecondary, fontSize: 11, marginTop: 4 },
  state: { color: colors.textSecondary, fontSize: 11, fontWeight: '700', marginTop: 4 },
  errorState: { color: colors.danger },
  errorText: { color: colors.danger, fontSize: 10, lineHeight: 15, marginTop: 9 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  playAction: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 13, borderRadius: 12, backgroundColor: '#f3f3f3', borderWidth: 1, borderColor: colors.border },
  playActionText: { color: colors.text, fontSize: 12, fontWeight: '800' },
  transcribeButton: { minHeight: 40, flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, backgroundColor: colors.text },
  transcribeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  disabled: { opacity: 0.55 },
  deleteButton: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff1f1' }
});
