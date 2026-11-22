import Foundation
import Testing
@testable import FleetComputerUse

/// 시계를 손으로 움직이는 감시 루프 시험. 실제 TCC는 건드리지 않는다.
private final class Clock {
  var now = Date(timeIntervalSince1970: 0)
  func sleep(_ interval: TimeInterval) { now = now.addingTimeInterval(interval) }
}

@Test func asksForScreenRecordingOnceAccessibilityTurnsOn() {
  let clock = Clock()
  var checks = 0
  var requests = 0
  let requested = ScreenRecordingAfterAccessibility.waitThenRequest(
    deadline: clock.now.addingTimeInterval(300), interval: 1,
    trusted: { checks += 1; return checks >= 3 }, granted: { false },
    request: { requests += 1 }, sleep: clock.sleep, now: { clock.now })
  #expect(requested)
  #expect(requests == 1)
  #expect(checks == 3)
  #expect(clock.now == Date(timeIntervalSince1970: 3))
}

@Test func doesNotAskWhenAccessibilityStaysOffUntilTheDeadline() {
  let clock = Clock()
  var requests = 0
  let requested = ScreenRecordingAfterAccessibility.waitThenRequest(
    deadline: clock.now.addingTimeInterval(300), interval: 1,
    trusted: { false }, granted: { false },
    request: { requests += 1 }, sleep: clock.sleep, now: { clock.now })
  #expect(!requested)
  #expect(requests == 0)
  #expect(clock.now == Date(timeIntervalSince1970: 300))
}

@Test func doesNotAskWhenScreenRecordingIsAlreadyAllowed() {
  let clock = Clock()
  var requests = 0
  let requested = ScreenRecordingAfterAccessibility.waitThenRequest(
    deadline: clock.now.addingTimeInterval(300), interval: 1,
    trusted: { true }, granted: { true },
    request: { requests += 1 }, sleep: clock.sleep, now: { clock.now })
  #expect(!requested)
  #expect(requests == 0)
}

@Test func runsOneWatchPerHelper() {
  #expect(ScreenRecordingAfterAccessibility.begin())
  #expect(!ScreenRecordingAfterAccessibility.begin())
  ScreenRecordingAfterAccessibility.end()
  #expect(ScreenRecordingAfterAccessibility.begin())
  ScreenRecordingAfterAccessibility.end()
}
