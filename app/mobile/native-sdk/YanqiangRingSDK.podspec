Pod::Spec.new do |s|
  s.name = 'YanqiangRingSDK'
  s.version = '1.0.0'
  s.summary = 'Yanqiang RingSDK bridge for Recording Ring'
  s.homepage = 'https://example.invalid/recording-ring'
  s.license = { :type => 'Proprietary', :text => 'Vendor SDK - internal use only' }
  s.author = { 'Recording Ring' => 'dev@localhost' }
  s.source = { :path => '.' }
  s.platform = :ios, '15.1'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.public_header_files = 'ios/**/*.h'

  # Prefer XCFrameworks (device + simulator stub). Fall back to device-only .framework
  # if xcframeworks have not been generated yet.
  if File.directory?(File.join(__dir__, 'RingSDK.xcframework')) &&
     File.directory?(File.join(__dir__, 'AB_FOTA.xcframework'))
    s.vendored_frameworks = 'RingSDK.xcframework', 'AB_FOTA.xcframework'
  else
    s.vendored_frameworks = 'RingSDK.framework', 'AB_FOTA.framework'
  end

  s.frameworks = 'Foundation', 'CoreBluetooth', 'CoreServices', 'ExternalAccessory', 'QuartzCore', 'UIKit', 'AVFoundation', 'AudioToolbox', 'Speech'
  s.libraries = 'c++', 'sqlite3', 'z'
  s.dependency 'React-Core'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_ENABLE_MODULES' => 'YES',
    # Real bridge imports device-only RingSDK headers; use simulator stub instead.
    'EXCLUDED_SOURCE_FILE_NAMES[sdk=iphonesimulator*]' => 'YanqiangVoiceModule.m',
    'EXCLUDED_SOURCE_FILE_NAMES[sdk=iphoneos*]' => 'YanqiangVoiceModuleSimulatorStub.m',
    # Apple Silicon: skip x86_64 sim slice (RingSDK Swift header has no x86_64 path).
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }
  s.user_target_xcconfig = {
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }
end
