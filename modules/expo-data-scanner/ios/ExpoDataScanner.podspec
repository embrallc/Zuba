Pod::Spec.new do |s|
  s.name           = 'ExpoDataScanner'
  s.version        = '1.0.0'
  s.summary        = 'VisionKit DataScanner (live text + barcode/QR) for Zanbi'
  s.description    = 'Wraps DataScannerViewController as an Expo native view.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.1' }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'VisionKit', 'Vision'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
