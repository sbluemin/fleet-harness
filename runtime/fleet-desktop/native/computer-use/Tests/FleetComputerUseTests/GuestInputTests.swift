import CoreGraphics
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
