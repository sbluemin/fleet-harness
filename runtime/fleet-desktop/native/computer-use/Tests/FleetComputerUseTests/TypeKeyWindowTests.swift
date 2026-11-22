import Testing
@testable import FleetComputerUse

struct TypeKeyWindowTests {
  @Test func primesOnlyAnElectronWindowThatAnInactiveAppDoesNotReportAsFocused() {
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: false, appActive: false) == .prime)
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: true, appActive: false) == .ready)
  }

  @Test func refusesInsteadOfMovingTheKeyWindowOfAnActiveApp() {
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: false, appActive: true) == .refuse)
    #expect(TypeKeyWindow.decide(engine: .electron, reportsFocusedWindow: true, appActive: true) == .ready)
  }

  @Test func leavesUnmeasuredEnginesUnchanged() {
    for engine in [Engine.chromium, .webkit, .appkit, .catalyst] {
      for reported in [false, true] {
        for active in [false, true] {
          #expect(TypeKeyWindow.decide(engine: engine, reportsFocusedWindow: reported, appActive: active) == .ready)
        }
      }
    }
  }
}
