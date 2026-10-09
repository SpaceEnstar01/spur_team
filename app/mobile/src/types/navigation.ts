export type RootStackParamList = {
  MainTabs: undefined;
  VoiceAgent: undefined;
  Device: undefined;
  ConnectLaptop: undefined;
  CloudOffice: undefined;
  Me: undefined;
  RecordingSummary: { id: string };
  Transcript: { id: string };
  YanqiangRecordingDebug: { macAddress: string };
  YanqiangButtonDebug: { macAddress: string };
  DeviceDetail: { deviceId?: string };
};

export type MainTabParamList = {
  Records: undefined;
  Assistant: undefined;
};
