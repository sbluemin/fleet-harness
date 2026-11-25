import CoreGraphics
import AppKit
import Testing
@testable import FleetComputerUse

struct GuestInputTests {
  @Test func onlyTheBareVirtualMachineDisplayLeavesTheBackgroundPath() {
    #expect(GuestDisplay.receives(bundleId: "com.parallels.desktop.console", target: false, bareWindow: true))
    #expect(!GuestDisplay.receives(bundleId: "com.parallels.desktop.console", target: true, bareWindow: true))
    #expect(!GuestDisplay.receives(bundleId: "com.parallels.desktop.console", target: false, bareWindow: false))
    #expect(!GuestDisplay.receives(bundleId: "com.apple.TextEdit", target: false, bareWindow: true))
  }

  @Test func refusesTheWholeTextWhenOneCharacterHasNoGuestKey() {
    #expect(GuestKeys.events("Ab") != nil)
    #expect(GuestKeys.events("ab한") == nil)
  }

  @Test func mapsWindowPointsBelowTheToolbarToGuestPixels() {
    let window = CGSize(width: 1494, height: 1303), guest: (UInt32, UInt32) = (1494, 1265)
    #expect(ParallelsGuest.guestPoint(CGPoint(x: 880, y: 600), window: window, guest: guest) == CGPoint(x: 880, y: 562))
    #expect(ParallelsGuest.guestPoint(CGPoint(x: 700, y: 20), window: window, guest: guest) == nil)
  }
}

struct ParallelsSDKTrustTests {
  @Test func refusesAnSDKThatParallelsDidNotSign() throws {
    // 같은 이름의 가짜 프레임워크(서명 없음)와 Apple 서명 프레임워크는 열지 않는다.
    let fake = FileManager.default.temporaryDirectory.appendingPathComponent("fake-\(UUID().uuidString)/ParallelsVirtualizationSDK.framework")
    try FileManager.default.createDirectory(at: fake, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: fake.deletingLastPathComponent()) }
    try Data([0xCF, 0xFA, 0xED, 0xFE]).write(to: fake.appendingPathComponent("ParallelsVirtualizationSDK"))
    #expect(ParallelsGuest.trustedSDK(fake.path) == nil)
    #expect(ParallelsGuest.trustedSDK("/System/Library/Frameworks/AppKit.framework") == nil)
  }

  @Test(.enabled(if: FileManager.default.fileExists(atPath: "/Applications/Parallels Desktop.app")))
  func acceptsTheSDKShippedInsideParallelsDesktop() {
    let path = ParallelsGuest.trustedSDK("/Applications/Parallels Desktop.app/Contents/Frameworks/ParallelsVirtualizationSDK.framework")
    #expect(path?.hasSuffix("/ParallelsVirtualizationSDK") == true)
  }
}

struct ParallelsOwnerTrustTests {
  @Test func refusesAProcessThatOnlyClaimsTheParallelsBundleID() throws {
    // /bin/sleep 사본을 Parallels Desktop의 식별자로 임시(ad hoc) 서명해 실행한다. 식별자는 같아도 Parallels 팀 서명이 아니므로 거절한다.
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fake-parallels-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let binary = dir.appendingPathComponent("prl_client_app")
    try FileManager.default.copyItem(atPath: "/bin/sleep", toPath: binary.path)
    let sign = Process()
    sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    sign.arguments = ["--force", "--sign", "-", "--identifier", "com.parallels.desktop.console", binary.path]
    try sign.run(); sign.waitUntilExit()
    #expect(sign.terminationStatus == 0)
    let fake = Process()
    fake.executableURL = binary
    fake.arguments = ["30"]
    try fake.run()
    defer { fake.terminate() }
    #expect(ParallelsGuest.trustedOwner(fake.processIdentifier) == nil)
    #expect(ParallelsGuest.trustedOwner(getpid()) == nil)
  }

  @Test(.enabled(if: !NSRunningApplication.runningApplications(withBundleIdentifier: "com.parallels.desktop.console").isEmpty))
  func acceptsTheRunningParallelsDesktop() {
    let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.parallels.desktop.console")[0]
    #expect(ParallelsGuest.trustedOwner(app.processIdentifier)?.hasSuffix("/Parallels Desktop.app") == true)
  }
}
