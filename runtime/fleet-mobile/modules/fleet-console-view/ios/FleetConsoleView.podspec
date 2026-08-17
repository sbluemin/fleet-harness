Pod::Spec.new do |s|
  s.name           = 'FleetConsoleView'
  # 버전은 android/build.gradle의 모듈 버전과 FleetConsoleView의 USER_AGENT_PRODUCT
  # (FleetMobile/0.1.0)를 거울처럼 따른다.
  s.version        = '0.1.0'
  s.summary        = 'Fleet Console native shell view'
  s.description    = 'Hardened WKWebView shell that pairs with and displays a Fleet Console over a local TLS loopback gateway.'
  s.author         = 'dotobokuri'
  s.homepage       = 'https://github.com/sbluemin/fleet-harness'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/sbluemin/fleet-harness.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ios/ 루트(ExpoModulesCore/WebKit 의존)와 ios/Core(순수 로직, SPM 테스트 대상)를 한
  # 파드 모듈로 컴파일한다 — 파일 사이 internal 접근이 그대로 성립한다.
  s.source_files = '**/*.swift'
end
