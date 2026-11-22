// swift-tools-version:5.9
// Fleet Computer Use helper — macOS 백그라운드 컴퓨터유즈 헬퍼(LSUIElement 앱 번들로 조립된다).
// 계약: 증거 디렉터리 spec/design-contract.md, spec/tool-spec-final.md
import PackageDescription

let package = Package(
  name: "FleetComputerUse",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "fleet-computer-use", targets: ["FleetComputerUse"])],
  targets: [
    .executableTarget(
      name: "FleetComputerUse",
      path: "Sources/FleetComputerUse",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("ApplicationServices"),
        .linkedFramework("ScreenCaptureKit"),
        .linkedFramework("Carbon"),
        .linkedFramework("CoreGraphics"),
        .linkedFramework("QuartzCore"),
      ]
    ),
    // 실제 TCC를 건드리지 않는 순수 로직 시험(swift test). 헬퍼 빌드(swift build -c release)에는 들어가지 않는다.
    .testTarget(name: "FleetComputerUseTests", dependencies: ["FleetComputerUse"], path: "Tests/FleetComputerUseTests"),
  ]
)
