#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <React/RCTBridgeModule.h>

@interface SpurSpeechTranscriptionModule : NSObject <RCTBridgeModule>
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *requests;
@end

@implementation SpurSpeechTranscriptionModule

RCT_EXPORT_MODULE(SpurSpeechTranscription)

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (instancetype)init
{
  self = [super init];
  if (self) _requests = [NSMutableDictionary dictionary];
  return self;
}

- (NSString *)authorizationName:(SFSpeechRecognizerAuthorizationStatus)status
{
  switch (status) {
    case SFSpeechRecognizerAuthorizationStatusAuthorized: return @"authorized";
    case SFSpeechRecognizerAuthorizationStatusDenied: return @"denied";
    case SFSpeechRecognizerAuthorizationStatusRestricted: return @"restricted";
    case SFSpeechRecognizerAuthorizationStatusNotDetermined: return @"undetermined";
  }
  return @"restricted";
}

RCT_REMAP_METHOD(requestAuthorization,
                 requestAuthorizationWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];
  if (status != SFSpeechRecognizerAuthorizationStatusNotDetermined) {
    resolve([self authorizationName:status]);
    return;
  }
  __weak typeof(self) weakSelf = self;
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) owner = weakSelf;
      if (owner) resolve([owner authorizationName:granted]);
      else reject(@"SPEECH_UNAVAILABLE", @"Speech permission request was interrupted", nil);
    });
  }];
}

- (void)finish:(NSString *)requestId text:(NSString *)text code:(NSString *)code message:(NSString *)message
{
  NSMutableDictionary *entry = self.requests[requestId];
  if (!entry) return;
  [self.requests removeObjectForKey:requestId];
  if (text.length > 0) {
    RCTPromiseResolveBlock resolve = entry[@"resolve"];
    resolve(text);
  } else {
    RCTPromiseRejectBlock reject = entry[@"reject"];
    reject(code ?: @"SPEECH_FAILED", message ?: @"Speech recognition failed", nil);
  }
}

- (void)start:(NSString *)requestId fileURL:(NSURL *)fileURL locale:(NSString *)locale
{
  if (!self.requests[requestId]) return;
  SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]];
  if (!recognizer || !recognizer.isAvailable || !recognizer.supportsOnDeviceRecognition) {
    [self finish:requestId text:nil code:@"SPEECH_ON_DEVICE_UNAVAILABLE" message:@"On-device speech recognition is unavailable" ];
    return;
  }

  SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:fileURL];
  request.requiresOnDeviceRecognition = YES;
  request.shouldReportPartialResults = NO;
  self.requests[requestId][@"recognizer"] = recognizer;
  __weak typeof(self) weakSelf = self;
  SFSpeechRecognitionTask *task = [recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      __strong typeof(weakSelf) owner = weakSelf;
      if (!owner || !owner.requests[requestId]) return;
      if (result.isFinal) {
        NSString *text = [result.bestTranscription.formattedString stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        [owner finish:requestId text:text code:@"SPEECH_EMPTY_TRANSCRIPT" message:@"No speech recognized on device"];
      } else if (error) {
        [owner finish:requestId text:nil code:@"SPEECH_FAILED" message:error.localizedDescription];
      }
    });
  }];
  if (self.requests[requestId]) self.requests[requestId][@"task"] = task;
  else [task cancel];
}

RCT_REMAP_METHOD(transcribe,
                 transcribe:(NSString *)uri
                 locale:(NSString *)locale
                 requestId:(NSString *)requestId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  NSURL *fileURL = [NSURL URLWithString:uri ?: @""];
  if (!fileURL.isFileURL || ![[NSFileManager defaultManager] fileExistsAtPath:fileURL.path] || requestId.length == 0) {
    reject(@"SPEECH_INVALID_FILE", @"Audio file is missing or invalid", nil);
    return;
  }
  if (self.requests[requestId]) {
    reject(@"SPEECH_DUPLICATE_REQUEST", @"Speech request ID already exists", nil);
    return;
  }
  self.requests[requestId] = [@{ @"resolve": [resolve copy], @"reject": [reject copy] } mutableCopy];
  SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];
  if (status == SFSpeechRecognizerAuthorizationStatusAuthorized) {
    [self start:requestId fileURL:fileURL locale:locale];
  } else if (status == SFSpeechRecognizerAuthorizationStatusNotDetermined) {
    __weak typeof(self) weakSelf = self;
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        __strong typeof(weakSelf) owner = weakSelf;
        if (!owner || !owner.requests[requestId]) return;
        if (granted == SFSpeechRecognizerAuthorizationStatusAuthorized) [owner start:requestId fileURL:fileURL locale:locale];
        else [owner finish:requestId text:nil code:@"SPEECH_PERMISSION_DENIED" message:@"Speech recognition permission denied"];
      });
    }];
  } else {
    [self finish:requestId text:nil code:@"SPEECH_PERMISSION_DENIED" message:@"Speech recognition permission denied"];
  }
}

RCT_EXPORT_METHOD(cancel:(NSString *)requestId)
{
  SFSpeechRecognitionTask *task = self.requests[requestId][@"task"];
  [task cancel];
  [self finish:requestId text:nil code:@"SPEECH_CANCELLED" message:@"Speech recognition cancelled"];
}

@end
