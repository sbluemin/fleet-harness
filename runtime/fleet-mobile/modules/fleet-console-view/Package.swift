// swift-tools-version: 5.9
// 순수 로직(ios/Core)의 SPM 패키지. 배포 산출물이 아니라 검증 레일이다: 개발 호스트에
// Swift 툴체인이 없으므로 macOS 러너의 `swift test`가 Robolectric 스위트의 iOS 대응을
// 돌린다. 앱 바이너리는 CocoaPods(FleetConsoleView.podspec)로만 빌드된다.
// UIKit/WebKit/ExpoModulesCore에 기대는 파일은 ios/ 루트에 있고 이 패키지에 들어오지 않는다.
import PackageDescription

let package = Package(
  name: "FleetConsoleCore",
  platforms: [.iOS(.v15), .macOS(.v13)],
  targets: [
    .target(name: "FleetConsoleCore", path: "ios/Core"),
    .testTarget(name: "FleetConsoleCoreTests", dependencies: ["FleetConsoleCore"], path: "ios-tests"),
  ]
)
