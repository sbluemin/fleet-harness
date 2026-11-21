// swift-tools-version:5.9
// Fleet Computer Use helper — macOS 백그라운드 컴퓨터유즈 헬퍼(LSUIElement 앱 번들로 조립된다).
// 계약: 증거 디렉터리 spec/design-contract.md, spec/tool-spec-final.md
import PackageDescription

let package = Package(
  name: "FleetComputerUse",
  platforms: [.macOS(.v14)],
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
  ]
)
