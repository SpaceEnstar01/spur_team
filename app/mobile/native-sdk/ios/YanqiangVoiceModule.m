#import "YanqiangVoiceModule.h"

#import <RingSDK/RingSDK.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

#if DEBUG && __has_include("SpurVoiceAgentSecrets.h")
#import "SpurVoiceAgentSecrets.h"
#endif
#ifndef SPUR_SILICONFLOW_API_KEY
#define SPUR_SILICONFLOW_API_KEY @""
#endif
#ifndef SPUR_AMAP_WEB_API_KEY
#define SPUR_AMAP_WEB_API_KEY @""
#endif

#if __has_include(<YanqiangRingSDK/YanqiangRingSDK-Swift.h>)
#import <YanqiangRingSDK/YanqiangRingSDK-Swift.h>
#elif __has_include("YanqiangRingSDK-Swift.h")
#import "YanqiangRingSDK-Swift.h"
#endif

static const NSInteger kVoiceFileFunction = 1;
static const NSTimeInterval kRecordingSyncTimeoutSec = 180.0;
static const NSTimeInterval kStaleSyncLockSec = 15.0;
static NSString *const kRecordingDirName = @"voice-recordings";

@interface YanqiangVoiceModule ()
@property (nonatomic, strong) BTService *service;
@property (nonatomic, strong) BTAudioManager *audioManager;
@property (nonatomic, assign) BOOL configured;
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, assign) BOOL bleConnected;
@property (nonatomic, assign) BOOL authSucceeded;
@property (nonatomic, assign) BOOL touchReportingEnabled;
@property (nonatomic, assign) NSInteger currentWorkingState;
@property (nonatomic, assign) BOOL syncInProgress;
@property (nonatomic, assign) NSTimeInterval syncLastActivityAt;
@property (nonatomic, assign) NSInteger syncGeneration;
@property (nonatomic, assign) NSInteger pendingConversions;
@property (nonatomic, assign) BOOL syncFinishSeen;
@property (nonatomic, assign) BOOL syncResolved;
@property (nonatomic, copy) RCTPromiseResolveBlock syncResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock syncReject;
@property (nonatomic, strong) dispatch_block_t syncTimeoutBlock;
@property (nonatomic, strong) NSMutableSet<NSNumber *> *processedPackedTimes;
@property (nonatomic, strong) NSMutableSet<NSString *> *processedOpusPaths;
@property (nonatomic, strong) NSMutableSet<NSNumber *> *convertingPackedTimes;
@property (nonatomic, copy) NSString *activeMacAddress;
@property (nonatomic, strong) dispatch_block_t pendingScanEnd;
@property (nonatomic, strong) NSMutableDictionary<NSString *, CBPeripheral *> *knownPeripherals;
@end

@implementation YanqiangVoiceModule

RCT_EXPORT_MODULE(YanqiangVoiceModule)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _service = [BTService shared];
    _audioManager = [BTAudioManager sharedInstance];
    _knownPeripherals = [NSMutableDictionary dictionary];
    _processedPackedTimes = [NSMutableSet set];
    _processedOpusPaths = [NSMutableSet set];
    _convertingPackedTimes = [NSMutableSet set];
    _currentWorkingState = -1;
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[
    @"yanqiangVoiceScanEvent",
    @"yanqiangVoiceConnectionChanged",
    @"yanqiangVoiceStatusUpdate",
    @"yanqiangVoiceSyncState",
    @"yanqiangVoiceSyncProgress",
    @"yanqiangVoiceFileReady",
    @"yanqiangVoiceError",
    @"yanqiangSmartTouchEvent"
  ];
}

- (void)startObserving
{
  self.hasListeners = YES;
}

- (void)stopObserving
{
  self.hasListeners = NO;
}

- (void)emit:(NSString *)name body:(NSDictionary *)body
{
  // fileReady must reach JS even if listener count briefly drops (matches Android).
  if (self.hasListeners || [name isEqualToString:@"yanqiangVoiceFileReady"]) {
    [self sendEventWithName:name body:body ?: @{}];
  }
}

- (NSString *)stableAppIdentifier
{
  NSString *key = @"YanqiangRingSDKUniqueAppIdentifier";
  NSString *identifier = [[NSUserDefaults standardUserDefaults] stringForKey:key];
  if (identifier.length == 0) {
    identifier = [NSUUID UUID].UUIDString;
    [[NSUserDefaults standardUserDefaults] setObject:identifier forKey:key];
  }
  return identifier;
}

- (void)configureIfNeeded
{
  if (self.configured) {
    return;
  }
  self.configured = YES;
  [self.service setUniqueAppIDKey:[self stableAppIdentifier]];
  [self.service setLogEnable:YES];
  [self.service setAutoReconnectionEnabled:YES];
  [self configureAudioCallbacks];

  __weak typeof(self) touchSelf = self;
  [self.service.touchReq listeningTouchEvent:^(NSMutableArray<BTTouchEventModel *> *touchList) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(touchSelf) owner = touchSelf;
      if (!owner || !owner.touchReportingEnabled || !owner.authSucceeded) return;
      for (BTTouchEventModel *item in touchList) {
        if (item.touchEvent != 0x0103) continue;
        [owner emit:@"yanqiangSmartTouchEvent" body:@{
          @"event": @(item.touchEvent),
          @"timestamp": @((double)item.touchTime * 1000.0)
        }];
      }
    });
  }];

  __weak typeof(self) weakSelf = self;
  [self.service bleStatusUpdated:^(CBManagerState state) {
    __strong typeof(weakSelf) self = weakSelf;
    if (!self) return;
    if (state == CBManagerStatePoweredOff) {
      [self emit:@"yanqiangVoiceError" body:@{
        @"code": @"YANQIANG_BLUETOOTH_OFF",
        @"message": @"Bluetooth is turned off"
      }];
    }
  }];

  [self.service scanningDeviceUpdated:^(NSArray<Ring *> *rings) {
    __strong typeof(weakSelf) self = weakSelf;
    if (!self) return;
    for (Ring *ring in rings) {
      NSString *address = ring.macAddress.length > 0 ? ring.macAddress : ring.uuidString;
      if (address.length == 0) continue;
      NSLog(@"[YanqiangVoice] scan device name=%@ mac=%@ uuid=%@ rssi=%d",
            ring.name ?: @"",
            ring.macAddress ?: @"",
            ring.uuidString ?: @"",
            ring.rssi);
      [self emit:@"yanqiangVoiceScanEvent" body:@{
        @"type": @"device",
        @"name": ring.name ?: @"Ring",
        @"macAddress": address,
        @"address": ring.uuidString ?: address,
        @"rssi": @(ring.rssi),
        @"hasMac": @(ring.macAddress.length > 0)
      }];
    }
  }];

  [self.service ringStatusUpdated:^(BTDeviceStatus status) {
    __strong typeof(weakSelf) self = weakSelf;
    if (!self) return;
    [self handleRingStatus:status];
  }];
}

- (void)configureAudioCallbacks
{
  __weak typeof(self) weakSelf = self;
  self.audioManager.audioRecordStatusBlock = ^(AudioRecordStatus status, NSInteger time) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) self = weakSelf;
      if (!self) return;
      self.currentWorkingState = (NSInteger)status;
      NSLog(@"[YanqiangVoice] workingState=%ld remaining=%ld", (long)status, (long)time);
      [self emit:@"yanqiangVoiceStatusUpdate" body:@{
        @"function": @(kVoiceFileFunction),
        @"state": @(status),
        @"remainingTime": @(time),
        @"status": [self mapWorkingStatus:status]
      }];
    });
  };

  self.audioManager.logHandler = ^(NSString *message) {
    NSLog(@"[YanqiangVoice][BTAudio] %@", message ?: @"");
  };
}

- (NSString *)mapWorkingStatus:(AudioRecordStatus)status
{
  switch (status) {
    case AudioRecordStatusIdle: return @"idle";
    case AudioRecordStatusRecording: return @"recording";
    case AudioRecordStatusPaused: return @"paused";
    case AudioRecordStatusDataPending: return @"ready_to_sync";
    case AudioRecordStatusUploading: return @"syncing";
    default: return @"unknown";
  }
}

- (void)emitSystemConnectedDevices
{
  NSArray<CBPeripheral *> *peripherals = [self.service getSystemConnectedDevices];
  for (CBPeripheral *peripheral in peripherals) {
    NSString *identifier = peripheral.identifier.UUIDString;
    if (identifier.length == 0) continue;
    self.knownPeripherals[identifier] = peripheral;
    [self emit:@"yanqiangVoiceScanEvent" body:@{
      @"type": @"device",
      @"name": peripheral.name ?: @"Connected Ring",
      @"macAddress": identifier,
      @"address": identifier,
      @"rssi": @0,
      @"systemConnected": @YES
    }];
  }
}

- (NSString *)statusLabel:(BTDeviceStatus)status
{
  switch (status) {
    case BTDeviceStatusAuthCmdSendFail: return @"AuthCmdSendFail";
    case BTDeviceStatusDisconnected: return @"Disconnected";
    case BTDeviceStatusPairingRemoved: return @"PairingRemoved";
    case BTDeviceStatusOff: return @"Off";
    case BTDeviceStatusNoPair: return @"NoPair";
    case BTDeviceStatusConnecting: return @"Connecting";
    case BTDeviceStatusConnected: return @"BLEConnected";
    case BTDeviceStatusConnectFailed: return @"ConnectFailed";
    case BTDeviceStatusAuthRefused: return @"AuthRefused";
    case BTDeviceStatusAuthSuccess: return @"AuthSuccess";
    case BTDeviceStatusAuthBound: return @"AuthBound";
    case BTDeviceStatusAuthIllegal: return @"AuthIllegal";
    case BTDeviceStatusBoundOtherCharging: return @"BoundOtherCharging";
    case BTDeviceStatusBoundOtherNotCharging: return @"BoundOtherNotCharging";
    default: return @"Unknown";
  }
}

- (void)handleRingStatus:(BTDeviceStatus)status
{
  // Align with DreameRing iOS: RingSDK performs auth internally after bindDevice.
  // Do NOT call baseReq.authorize here — early authorize can hang at BLEConnected(-2).
  // Do NOT emit BLE status on yanqiangVoiceStatusUpdate — JS autoSync treats that as workingState.
  NSLog(@"[YanqiangVoice] ringStatus state=%ld (%@) mac=%@ ble=%d auth=%d",
        (long)status,
        [self statusLabel:status],
        self.activeMacAddress ?: @"",
        self.bleConnected,
        self.authSucceeded);

  if (status == BTDeviceStatusConnected) {
    self.bleConnected = YES;
    [self emit:@"yanqiangVoiceConnectionChanged" body:@{
      @"status": @"connecting",
      @"phase": @"ble_connected",
      @"state": @(status),
      @"label": [self statusLabel:status],
      @"macAddress": self.activeMacAddress ?: @""
    }];
    [self emitConnectedIfReady];
    return;
  }
  if (status == BTDeviceStatusAuthSuccess) {
    self.bleConnected = YES;
    self.authSucceeded = YES;
    [self emit:@"yanqiangVoiceConnectionChanged" body:@{
      @"status": @"connecting",
      @"phase": @"auth_success",
      @"state": @(status),
      @"label": [self statusLabel:status],
      @"macAddress": self.activeMacAddress ?: @""
    }];
    [self emitConnectedIfReady];
    return;
  }

  if (status == BTDeviceStatusConnecting) {
    self.bleConnected = NO;
    self.authSucceeded = NO;
    [self emit:@"yanqiangVoiceConnectionChanged" body:@{
      @"status": @"connecting",
      @"phase": @"connecting",
      @"state": @(status),
      @"label": [self statusLabel:status],
      @"macAddress": self.activeMacAddress ?: @""
    }];
    return;
  }

  self.bleConnected = NO;
  self.authSucceeded = NO;
  if (status == BTDeviceStatusDisconnected || status == BTDeviceStatusPairingRemoved || status == BTDeviceStatusOff) {
    [self emit:@"yanqiangVoiceConnectionChanged" body:@{
      @"status": @"disconnected",
      @"state": @(status),
      @"label": [self statusLabel:status],
      @"macAddress": self.activeMacAddress ?: @""
    }];
  } else {
    [self emit:@"yanqiangVoiceConnectionChanged" body:@{
      @"status": @"error",
      @"state": @(status),
      @"label": [self statusLabel:status],
      @"message": [NSString stringWithFormat:@"Ring connection failed (state=%ld %@)", (long)status, [self statusLabel:status]],
      @"macAddress": self.activeMacAddress ?: @""
    }];
  }
}

- (void)emitConnectedIfReady
{
  if (!self.bleConnected || !self.authSucceeded) {
    NSLog(@"[YanqiangVoice] not ready yet ble=%d auth=%d mac=%@",
          self.bleConnected, self.authSucceeded, self.activeMacAddress ?: @"");
    return;
  }
  BTDevice *device = [self.service getPairedDevice];
  NSString *mac = device.macAddress.length > 0 ? device.macAddress : self.activeMacAddress;
  self.activeMacAddress = mac;
  NSLog(@"[YanqiangVoice] vendorReady=YES name=%@ mac=%@", device.name ?: @"Ring", mac ?: @"");
  [self emit:@"yanqiangVoiceConnectionChanged" body:@{
    @"status": @"connected",
    @"vendorReady": @YES,
    @"name": device.name ?: @"Ring",
    @"macAddress": mac ?: @""
  }];
}

#pragma mark - Recording helpers

- (NSString *)recordingDir
{
  NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  NSString *dir = [docs stringByAppendingPathComponent:kRecordingDirName];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  return dir;
}

- (NSArray *)listLocalRecordingFiles
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *dir = [self recordingDir];
  NSArray<NSString *> *names = [fm contentsOfDirectoryAtPath:dir error:nil] ?: @[];
  NSMutableArray *files = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
  for (NSString *name in names) {
    NSString *lower = name.lowercaseString;
    if (![lower hasSuffix:@".ogg"] && ![lower hasSuffix:@".m4a"]) continue;
    NSString *path = [dir stringByAppendingPathComponent:name];
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    NSDate *modified = attrs[NSFileModificationDate] ?: [NSDate date];
    NSNumber *size = attrs[NSFileSize] ?: @0;
    [items addObject:@{
      @"name": name,
      @"uri": [NSURL fileURLWithPath:path].absoluteString ?: [@"file://" stringByAppendingString:path],
      @"timestamp": @((long long)(modified.timeIntervalSince1970 * 1000.0)),
      @"size": size,
      @"_sort": modified
    }];
  }
  [items sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    return [b[@"_sort"] compare:a[@"_sort"]];
  }];
  for (NSDictionary *item in items) {
    NSMutableDictionary *copy = [item mutableCopy];
    [copy removeObjectForKey:@"_sort"];
    [files addObject:copy];
  }
  return files;
}

- (NSString *)sanitizeFileName:(NSString *)name
{
  if (name.length == 0) return @"voice";
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
                             @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"];
  NSMutableString *out = [NSMutableString string];
  for (NSUInteger i = 0; i < name.length; i++) {
    unichar c = [name characterAtIndex:i];
    if ([allowed characterIsMember:c]) {
      [out appendFormat:@"%C", c];
    } else {
      [out appendString:@"_"];
    }
  }
  return out.length > 0 ? out : @"voice";
}

- (long long)normalizeFileTimestamp:(long long)rawFileTime
{
  if (rawFileTime >= 946684800000LL) return rawFileTime;
  if (rawFileTime >= 946684800LL && rawFileTime <= 4102444800LL) return rawFileTime * 1000LL;
  return (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);
}

- (NSDictionary *)copyOggToRecordings:(NSString *)oggPath packet:(BTAudioPacketModel *)packet
{
  NSFileManager *fm = [NSFileManager defaultManager];
  if (oggPath.length == 0 || ![fm fileExistsAtPath:oggPath]) {
    return nil;
  }
  long long rawTime = 0;
  if (packet != nil) {
    if (packet.utcTimestamp > 0) {
      rawTime = (long long)packet.utcTimestamp;
    } else if (packet.packedTime > 0) {
      rawTime = (long long)packet.packedTime;
    }
  }
  if (rawTime <= 0) {
    NSDictionary *srcAttrs = [fm attributesOfItemAtPath:oggPath error:nil];
    NSDate *modified = srcAttrs[NSFileModificationDate];
    if (modified != nil) {
      rawTime = (long long)(modified.timeIntervalSince1970 * 1000.0);
    }
  }
  long long timestamp = [self normalizeFileTimestamp:rawTime > 1000000000LL ? rawTime : (rawTime > 0 ? rawTime : 0)];
  if (rawTime <= 0) {
    timestamp = (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);
  }

  NSString *baseName = oggPath.lastPathComponent.length > 0
    ? oggPath.lastPathComponent
    : [NSString stringWithFormat:@"voice-%lld", rawTime > 0 ? rawTime : timestamp];
  baseName = [self sanitizeFileName:baseName];
  if (![baseName.lowercaseString hasSuffix:@".ogg"]) {
    baseName = [baseName stringByAppendingString:@".ogg"];
  }

  NSString *dest = [[self recordingDir] stringByAppendingPathComponent:baseName];
  NSError *error = nil;
  if ([fm fileExistsAtPath:dest]) {
    [fm removeItemAtPath:dest error:nil];
  }
  if (![fm copyItemAtPath:oggPath toPath:dest error:&error]) {
    NSLog(@"[YanqiangVoice] copy ogg failed: %@", error);
    return nil;
  }
  NSDictionary *attrs = @{ NSFileModificationDate: [NSDate dateWithTimeIntervalSince1970:timestamp / 1000.0] };
  [fm setAttributes:attrs ofItemAtPath:dest error:nil];
  NSDictionary *fileAttrs = [fm attributesOfItemAtPath:dest error:nil];
  return @{
    @"name": baseName,
    @"uri": [NSURL fileURLWithPath:dest].absoluteString ?: [@"file://" stringByAppendingString:dest],
    @"timestamp": @(timestamp),
    @"size": fileAttrs[NSFileSize] ?: @0,
    @"rawFileTime": @(rawTime)
  };
}

- (void)touchSyncActivity
{
  self.syncLastActivityAt = [NSDate date].timeIntervalSince1970;
}

- (void)clearSyncTimeout
{
  if (self.syncTimeoutBlock) {
    dispatch_block_cancel(self.syncTimeoutBlock);
    self.syncTimeoutBlock = nil;
  }
}

- (void)finishSyncIfReadyForGeneration:(NSInteger)generation
{
  if (generation != self.syncGeneration) return;
  if (!self.syncFinishSeen || self.pendingConversions != 0 || self.syncResolved) return;
  self.syncResolved = YES;
  [self clearSyncTimeout];
  self.syncInProgress = NO;
  self.syncLastActivityAt = 0;
  RCTPromiseResolveBlock resolve = self.syncResolve;
  self.syncResolve = nil;
  self.syncReject = nil;
  if (resolve) {
    resolve(@{ @"files": [self listLocalRecordingFiles] });
  }
}

- (void)failSyncWithCode:(NSString *)code message:(NSString *)message generation:(NSInteger)generation
{
  if (generation != self.syncGeneration || self.syncResolved) return;
  self.syncResolved = YES;
  [self clearSyncTimeout];
  self.syncInProgress = NO;
  self.syncLastActivityAt = 0;
  RCTPromiseRejectBlock reject = self.syncReject;
  self.syncResolve = nil;
  self.syncReject = nil;
  if (reject) {
    reject(code, message, nil);
  }
}

/// DreameRing path: scan Documents/Audio/*.opus → VoiceRecordingTranscoder → voice-recordings/*.m4a
- (NSString *)sdkAudioDirectory
{
  NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  return [docs stringByAppendingPathComponent:@"Audio"];
}

- (NSArray<NSString *> *)convertedRecordingBaseNames
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *dir = [self recordingDir];
  NSArray<NSString *> *names = [fm contentsOfDirectoryAtPath:dir error:nil] ?: @[];
  NSMutableArray<NSString *> *bases = [NSMutableArray array];
  for (NSString *name in names) {
    NSString *lower = name.lowercaseString;
    if (![lower hasSuffix:@".m4a"] && ![lower hasSuffix:@".ogg"]) continue;
    [bases addObject:name.stringByDeletingPathExtension];
  }
  return bases;
}

- (NSDictionary *)filePayloadForPath:(NSString *)path
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
  NSDate *modified = attrs[NSFileModificationDate] ?: [NSDate date];
  return @{
    @"name": path.lastPathComponent ?: @"recording.m4a",
    @"uri": [NSURL fileURLWithPath:path].absoluteString ?: [@"file://" stringByAppendingString:path],
    @"timestamp": @((long long)(modified.timeIntervalSince1970 * 1000.0)),
    @"size": attrs[NSFileSize] ?: @0
  };
}

/// After BLE transfer finishes: convert pending Documents/Audio/*.opus → playable M4A (DreameRing).
- (void)finalizeReceivedFilesForGeneration:(NSInteger)generation reason:(NSString *)reason
{
  if (generation != self.syncGeneration) return;
  NSLog(@"[YanqiangVoice] finalizeReceivedFiles reason=%@", reason ?: @"");

  NSString *audioDir = [self sdkAudioDirectory];
  NSArray<NSString *> *convertedBases = [self convertedRecordingBaseNames];
  NSArray<NSString *> *pendingOpusPaths = [YanqiangVoiceOpusBridge pendingOpusPathsInAudioDirectory:audioDir
                                                                                convertedBaseNames:convertedBases];
  NSLog(@"[YanqiangVoice] pending Opus count=%lu audioDir=%@",
        (unsigned long)pendingOpusPaths.count, audioDir);

  if (pendingOpusPaths.count == 0) {
    return;
  }

  NSString *recordingDir = [self recordingDir];
  self.pendingConversions += (NSInteger)pendingOpusPaths.count;
  NSInteger generationCapture = generation;
  __weak typeof(self) weakSelf = self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    for (NSString *opusPath in pendingOpusPaths) {
      NSString *base = opusPath.lastPathComponent.stringByDeletingPathExtension;
      NSString *m4aPath = [[recordingDir stringByAppendingPathComponent:base]
                           stringByAppendingPathExtension:@"m4a"];
      NSError *error = nil;
      BOOL ok = [YanqiangVoiceOpusBridge transcodeOpusFileAtPath:opusPath toM4APath:m4aPath error:&error];
      NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:opusPath error:nil];
      NSDate *mtime = attrs[NSFileModificationDate];
      if (ok && mtime != nil) {
        [[NSFileManager defaultManager] setAttributes:@{ NSFileModificationDate: mtime }
                                         ofItemAtPath:m4aPath
                                                error:nil];
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        __strong typeof(weakSelf) self = weakSelf;
        if (!self || generationCapture != self.syncGeneration) return;
        [self touchSyncActivity];
        if (ok) {
          NSDictionary *file = [self filePayloadForPath:m4aPath];
          NSLog(@"[YanqiangVoice] fileReady %@", file[@"name"]);
          [self emit:@"yanqiangVoiceFileReady" body:file];
        } else {
          NSLog(@"[YanqiangVoice] M4A transcode failed %@ err=%@",
                opusPath.lastPathComponent, error.localizedDescription ?: @"");
          [self emit:@"yanqiangVoiceError" body:@{
            @"message": error.localizedDescription ?: @"Opus to M4A failed",
            @"fileName": opusPath.lastPathComponent ?: @""
          }];
        }
        self.pendingConversions = MAX(0, self.pendingConversions - 1);
        [self finishSyncIfReadyForGeneration:generationCapture];
      });
    }
  });
}

- (void)handleSingleFileReceivedForGeneration:(NSInteger)generation
{
  // DreameRing does not convert on SingleSuccess; finalize after AllSuccess/Empty.
  if (generation != self.syncGeneration) return;
  NSLog(@"[YanqiangVoice] SingleSuccess noted — convert on transfer finish");
}

- (void)handleReceiveStatus:(BLEReceiveStatus)status generation:(NSInteger)generation
{
  if (generation != self.syncGeneration) return;
  [self touchSyncActivity];
  NSLog(@"[YanqiangVoice] receiveStatus=%ld %@", (long)status, [BTAudioManager descriptionForReceiveStatus:status]);

  if (status == BLEReceiveStatusStart || status == BLEReceiveStatusUploading) {
    [self emit:@"yanqiangVoiceSyncState" body:@{
      @"phase": @"start",
      @"code": @1,
      @"message": [BTAudioManager descriptionForReceiveStatus:status] ?: @"start"
    }];
    return;
  }

  if (status == BLEReceiveStatusSingleSuccess) {
    [self handleSingleFileReceivedForGeneration:generation];
    return;
  }

  // DreameRing: status 4/5 → scan Audio/*.opus → M4A
  if (status == BLEReceiveStatusAllSuccess || status == BLEReceiveStatusEnpty) {
    [self emit:@"yanqiangVoiceSyncState" body:@{
      @"phase": @"finish",
      @"code": @1,
      @"message": [BTAudioManager descriptionForReceiveStatus:status] ?: @"finish"
    }];
    [self finalizeReceivedFilesForGeneration:generation
                                      reason:(status == BLEReceiveStatusAllSuccess ? @"AllSuccess" : @"Empty")];
    self.syncFinishSeen = YES;
    [self finishSyncIfReadyForGeneration:generation];
    return;
  }

  if (status == BLEReceiveStatusFailed) {
    [self failSyncWithCode:@"YANQIANG_SYNC_RECORDING_FAILED"
                   message:@"Vendor voice file transfer failed"
                generation:generation];
  }
}

#pragma mark - RCT methods

RCT_REMAP_METHOD(initSdk,
                 initSdkWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    [self configureIfNeeded];
    resolve(@YES);
  } @catch (NSException *exception) {
    reject(@"YANQIANG_INIT_FAILED", exception.reason ?: @"RingSDK initialization failed", nil);
  }
}

RCT_REMAP_METHOD(startScan,
                 startScanWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self configureIfNeeded];
  if (self.service.isPermissionDenied) {
    reject(@"YANQIANG_BLUETOOTH_PERMISSION", @"Bluetooth permission is denied", nil);
    return;
  }

  [self emit:@"yanqiangVoiceScanEvent" body:@{ @"type": @"start" }];
  [self emitSystemConnectedDevices];
  [self.service startScan];
  resolve(@YES);

  if (self.pendingScanEnd) {
    dispatch_block_cancel(self.pendingScanEnd);
  }
  __weak typeof(self) weakSelf = self;
  dispatch_block_t endBlock = dispatch_block_create(0, ^{
    __strong typeof(weakSelf) self = weakSelf;
    if (!self) return;
    [self.service stopScan];
    [self emit:@"yanqiangVoiceScanEvent" body:@{ @"type": @"end" }];
  });
  self.pendingScanEnd = endBlock;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), dispatch_get_main_queue(), endBlock);
}

RCT_EXPORT_METHOD(stopScan)
{
  if (self.pendingScanEnd) {
    dispatch_block_cancel(self.pendingScanEnd);
    self.pendingScanEnd = nil;
  }
  [self.service stopScan];
  [self emit:@"yanqiangVoiceScanEvent" body:@{ @"type": @"end" }];
}

RCT_REMAP_METHOD(connect,
                 connect:(NSString *)macAddress
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self configureIfNeeded];
  if (macAddress.length == 0) {
    reject(@"YANQIANG_CONNECT_FAILED", @"Device address is empty", nil);
    return;
  }
  self.activeMacAddress = macAddress;
  self.bleConnected = NO;
  self.authSucceeded = NO;
  [self.service stopScan];
  CBPeripheral *peripheral = self.knownPeripherals[macAddress];
  if (peripheral != nil) {
    NSLog(@"[YanqiangVoice] connect via peripheral uuid=%@", macAddress);
    [self.service bindDeviceWithPeripheral:peripheral];
  } else {
    NSLog(@"[YanqiangVoice] connect via bindDevice mac=%@", macAddress);
    [self.service bindDevice:macAddress];
  }
  [self.service setAutoReconnectionEnabled:YES];
  resolve(@YES);
}

RCT_REMAP_METHOD(disconnect,
                 disconnectWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self.service setAutoReconnectionEnabled:NO];
  self.bleConnected = NO;
  self.authSucceeded = NO;
  if ([self.service respondsToSelector:@selector(disConnectDevice)]) {
    [self.service disConnectDevice];
  }
  [self emit:@"yanqiangVoiceConnectionChanged" body:@{
    @"status": @"disconnected",
    @"macAddress": self.activeMacAddress ?: @""
  }];
  resolve(@YES);
}

RCT_REMAP_METHOD(setTouchEventReporting,
                 setTouchEventReporting:(BOOL)enabled
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  self.touchReportingEnabled = enabled;
  resolve(@{ @"enabled": @(enabled), @"result": @(self.authSucceeded ? 1 : 0) });
}

RCT_REMAP_METHOD(voiceAgentDebugConfig,
                 voiceAgentDebugConfigWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
#if DEBUG
  NSString *siliconKey = SPUR_SILICONFLOW_API_KEY;
  NSString *amapKey = SPUR_AMAP_WEB_API_KEY;
  resolve(@{ @"enabled": @(siliconKey.length > 0 && amapKey.length > 0), @"siliconFlowApiKey": siliconKey, @"amapWebApiKey": amapKey });
#else
  resolve(@{ @"enabled": @NO, @"siliconFlowApiKey": @"", @"amapWebApiKey": @"" });
#endif
}

RCT_REMAP_METHOD(openAMapTaxiURI,
                 openAMapTaxiURI:(NSString *)uri
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
#if DEBUG
  if (uri.length == 0 || uri.length > 2048 || [uri rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
    reject(@"AMAP_INVALID_URI", @"Invalid taxi URI", nil); return;
  }
  NSURLComponents *parts = [NSURLComponents componentsWithString:uri];
  if (![parts.scheme.lowercaseString isEqualToString:@"amapuri"] ||
      ![parts.host.lowercaseString isEqualToString:@"drive"] ||
      ![parts.path isEqualToString:@"/takeTaxi"] ||
      parts.user || parts.password || parts.port || parts.fragment) {
    reject(@"AMAP_INVALID_URI", @"Invalid taxi URI", nil); return;
  }
  NSMutableDictionary<NSString *, NSString *> *values = [NSMutableDictionary dictionary];
  for (NSURLQueryItem *item in parts.queryItems ?: @[]) {
    if (values[item.name] != nil) { reject(@"AMAP_INVALID_URI", @"Duplicate taxi parameter", nil); return; }
    values[item.name] = item.value ?: @"";
  }
  NSString *lon = values[@"dlon"];
  NSString *lat = values[@"dlat"];
  NSString *destination = values[@"dname"];
  NSScanner *lonScanner = [NSScanner scannerWithString:lon ?: @""];
  NSScanner *latScanner = [NSScanner scannerWithString:lat ?: @""];
  double lonValue = 0, latValue = 0;
  if (!lon.length || !lat.length || !destination.length ||
      ![lonScanner scanDouble:&lonValue] || !lonScanner.isAtEnd ||
      ![latScanner scanDouble:&latValue] || !latScanner.isAtEnd ||
      lonValue < -180 || lonValue > 180 || latValue < -90 || latValue > 90 || !parts.URL) {
    reject(@"AMAP_INVALID_URI", @"Taxi destination is missing or invalid", nil); return;
  }
  [[UIApplication sharedApplication] openURL:parts.URL options:@{} completionHandler:^(BOOL success) {
    if (success) resolve(nil);
    else reject(@"AMAP_OPEN_FAILED", @"AMap could not open the taxi page", nil);
  }];
#else
  reject(@"AMAP_DEBUG_ONLY", @"Debug-only feature", nil);
#endif
}

RCT_REMAP_METHOD(queryVoiceRecordingSummary,
                 queryVoiceRecordingSummaryWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self configureIfNeeded];
  if (!self.authSucceeded) {
    reject(@"YANQIANG_QUERY_RECORDING_FAILED", @"Ring is not authenticated (vendorReady required)", nil);
    return;
  }
  __weak typeof(self) weakSelf = self;
  [self.audioManager queryDeviceStorageStatus:BLEFilesTypeRecord
                                   completion:^(BLEFilesType type, uint16_t fileCount, uint32_t totalSize) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) self = weakSelf;
      if (!self) return;
      NSLog(@"[YanqiangVoice] storage type=%ld count=%u bytes=%u", (long)type, fileCount, totalSize);
      resolve(@{
        @"code": @1,
        @"message": @"ok",
        @"supported": @YES,
        @"function": @(type),
        @"fileCount": @(fileCount),
        @"totalBytes": @(totalSize),
        @"files": [self listLocalRecordingFiles]
      });
    });
  }];
}

RCT_REMAP_METHOD(syncVoiceRecordings,
                 syncVoiceRecordingsWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self configureIfNeeded];
  if (!self.authSucceeded) {
    reject(@"YANQIANG_SYNC_RECORDING_FAILED", @"Ring is not authenticated (vendorReady required)", nil);
    return;
  }

  if (self.syncInProgress) {
    NSTimeInterval inactive = [NSDate date].timeIntervalSince1970 - self.syncLastActivityAt;
    if (self.syncLastActivityAt > 0 && inactive >= kStaleSyncLockSec) {
      NSLog(@"[YanqiangVoice] recovering stale sync lock inactive=%.0fs", inactive);
      [self failSyncWithCode:@"YANQIANG_SYNC_STALLED"
                     message:@"Ring transfer stopped making progress; retrying"
                  generation:self.syncGeneration];
    } else {
      reject(@"YANQIANG_RECORDING_SYNC_BUSY",
             [NSString stringWithFormat:@"Voice recording sync is already running (inactive %.0fms)", inactive * 1000.0],
             nil);
      return;
    }
  }

  // Allow idle(1) and data-pending(4); unknown(-1) before first status callback.
  if (self.currentWorkingState != -1 &&
      self.currentWorkingState != AudioRecordStatusIdle &&
      self.currentWorkingState != AudioRecordStatusDataPending) {
    reject(@"YANQIANG_DEVICE_NOT_READY_FOR_SYNC",
           [NSString stringWithFormat:@"Ring cannot sync in workingState=%ld. Wait for state=1 or state=4.",
            (long)self.currentWorkingState],
           nil);
    return;
  }

  self.syncInProgress = YES;
  [self touchSyncActivity];
  NSInteger generation = ++self.syncGeneration;
  self.pendingConversions = 0;
  self.syncFinishSeen = NO;
  self.syncResolved = NO;
  self.syncResolve = resolve;
  self.syncReject = reject;
  [self.processedPackedTimes removeAllObjects];
  [self.processedOpusPaths removeAllObjects];
  [self.convertingPackedTimes removeAllObjects];

  __weak typeof(self) weakSelf = self;
  self.audioManager.receiveFileCompletion = ^(BLEReceiveStatus status) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) self = weakSelf;
      if (!self) return;
      [self handleReceiveStatus:status generation:generation];
    });
  };

  self.audioManager.receiveFileProgressBlock =
      ^(BLEReceiveStatus status, NSInteger currentPacket, NSInteger totalPackets,
        NSInteger currentFileIndex, NSInteger totalFiles) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) self = weakSelf;
      if (!self || generation != self.syncGeneration) return;
      [self touchSyncActivity];
      NSInteger pct = totalPackets > 0 ? (currentPacket * 100 / totalPackets) : 0;
      [self emit:@"yanqiangVoiceSyncProgress" body:@{
        @"fileName": @"",
        @"fileTime": @0,
        @"progress": @(pct),
        @"currentFile": @(currentFileIndex),
        @"totalFiles": @(totalFiles)
      }];
    });
  };

  dispatch_block_t timeout = dispatch_block_create(0, ^{
    __strong typeof(weakSelf) self = weakSelf;
    if (!self) return;
    [self failSyncWithCode:@"YANQIANG_SYNC_TIMEOUT"
                   message:[NSString stringWithFormat:@"Voice recording sync timed out after %.0f seconds", kRecordingSyncTimeoutSec]
                generation:generation];
  });
  self.syncTimeoutBlock = timeout;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRecordingSyncTimeoutSec * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), timeout);

  [self.audioManager fetchLargeAudioFile:^(BOOL sendOk) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) self = weakSelf;
      if (!self) return;
      if (!sendOk) {
        [self failSyncWithCode:@"YANQIANG_SYNC_START_FAILED"
                       message:@"fetchLargeAudioFile send failed"
                    generation:generation];
        return;
      }
      NSLog(@"[YanqiangVoice] fetchLargeAudioFile request sent");
      [self emit:@"yanqiangVoiceSyncState" body:@{
        @"phase": @"start",
        @"code": @1,
        @"message": @"fetchLargeAudioFile sent"
      }];
    });
  }];
}

RCT_REMAP_METHOD(getVoiceRecordParam,
                 getVoiceRecordParamWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self configureIfNeeded];
  if (!self.authSucceeded) {
    reject(@"YANQIANG_GET_RECORD_PARAM_FAILED", @"Ring is not authenticated", nil);
    return;
  }
  BOOL started = [self.audioManager getCurrentRecordParamsWithCompletion:^(uint16_t bitrate, uint8_t volume, uint8_t light, NSArray<NSString *> *extraInfo) {
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(@{
        @"code": @1,
        @"message": @"ok",
        @"data": @{
          @"bitrate": @(bitrate),
          @"volume": @(volume),
          @"lightBrightness": @(light)
        }
      });
    });
  }];
  if (!started) {
    reject(@"YANQIANG_GET_RECORD_PARAM_FAILED", @"Failed to send getCurrentRecordParams", nil);
  }
}

RCT_REMAP_METHOD(setVoiceRecordParam,
                 setVoiceRecordParam:(nonnull NSNumber *)bitrate
                 volume:(nonnull NSNumber *)volume
                 lightBrightness:(nonnull NSNumber *)lightBrightness
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self configureIfNeeded];
  if (!self.authSucceeded) {
    reject(@"YANQIANG_SET_RECORD_PARAM_FAILED", @"Ring is not authenticated", nil);
    return;
  }
  BOOL started = [self.audioManager setRecordParamsWithBitrate:(uint16_t)bitrate.unsignedIntValue
                                                       volume:(uint8_t)volume.unsignedIntValue
                                                        light:(uint8_t)lightBrightness.unsignedIntValue
                                                   completion:^(BOOL success) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!success) {
        reject(@"YANQIANG_SET_RECORD_PARAM_FAILED", @"setRecordParams failed", nil);
        return;
      }
      resolve(@{
        @"code": @1,
        @"message": @"ok",
        @"data": @{
          @"bitrate": bitrate,
          @"volume": volume,
          @"lightBrightness": lightBrightness
        }
      });
    });
  }];
  if (!started) {
    reject(@"YANQIANG_SET_RECORD_PARAM_FAILED", @"Failed to send setRecordParams", nil);
  }
}

@end
