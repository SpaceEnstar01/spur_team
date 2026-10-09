import 'react-native-gesture-handler';

import { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppNavigator } from './src/navigation/AppNavigator';
import { startAutoSyncWatch } from './src/services/autoSyncRecordings';
import { ensureDemoContent } from './src/services/demoContent';
import { preparePlayback } from './src/services/localAudioLibrary';
import { colors } from './src/theme/colors';
import { setVoiceAgentNavigator, startVoiceAgentRuntime } from './src/voice-agent/voiceAgentRuntime';
import { voiceAgentNavigationRef } from './src/voice-agent/voiceAgentNavigation';

export default function App() {
  useEffect(() => {
    void preparePlayback().catch(() => undefined);
    void ensureDemoContent().catch(() => undefined);
    startAutoSyncWatch();
    void startVoiceAgentRuntime();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer ref={voiceAgentNavigationRef} onReady={() => setVoiceAgentNavigator(() => {
          if (voiceAgentNavigationRef.isReady() && voiceAgentNavigationRef.getCurrentRoute()?.name !== 'VoiceAgent') {
            voiceAgentNavigationRef.navigate('VoiceAgent');
          }
        })}>
          <StatusBar style="dark" backgroundColor={colors.background} />
          <AppNavigator />
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
