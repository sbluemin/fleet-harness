import Testing
@testable import FleetComputerUse

struct InputRouteTests {
  @Test func takesThePersonsForegroundOnlyForAGuestDisplayTheCallerAllowed() throws {
    #expect(try InputRoute.decide(guest: true, foreground: true) == .foreground)
    #expect(try InputRoute.decide(guest: false, foreground: false) == .background)
    #expect(throws: (any Error).self) { try InputRoute.decide(guest: false, foreground: true) }
  }

  @Test func refusesGuestInputThatTheBackgroundPathWouldSilentlyDrop() {
    do { _ = try InputRoute.decide(guest: true, foreground: false); Issue.record("expected needs_foreground") }
    catch { #expect((error as? HelperError)?.code == "needs_foreground") }
  }

  @Test func onlyTheBareVirtualMachineDisplayIsAGuest() {
    #expect(GuestDisplay.receives(bundleId: "com.parallels.desktop.console", target: false, bareWindow: true))
    #expect(!GuestDisplay.receives(bundleId: "com.parallels.desktop.console", target: true, bareWindow: true))
    #expect(!GuestDisplay.receives(bundleId: "com.parallels.desktop.console", target: false, bareWindow: false))
    #expect(!GuestDisplay.receives(bundleId: "com.apple.TextEdit", target: false, bareWindow: true))
  }
}
