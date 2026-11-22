import Testing
@testable import FleetComputerUse

struct TypeKeyWindowTests {
  @Test func primesOnlyAnElectronWindowThatAnInactiveAppDoesNotReportAsFocused() {
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: false, appActive: false) == .prime)
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: true, appActive: false) == .ready)
    #expect(TypeKeyWindow.decide(engine: .chromium, reportsFocusedWindow: false, appActive: false) == .ready)
  }

  @Test func refusesInsteadOfMovingTheKeyWindowOfAnActiveApp() {
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: false, appActive: true) == .refuse)
  }
}
