import Foundation
import XCTest
@testable import FleetConsoleCore

// FleetLinkActivityTest.kt의 인박스 계약 부분을 이식한다: isCandidate는 정확·경계이고,
// offer/consume은 원샷이다.
final class FleetLinkInboxTests: XCTestCase {
  override func setUp() {
    super.setUp()
    FleetLinkInbox.resetForTesting()
  }

  func testIsCandidateIsExactAndBounded() {
    XCTAssertTrue(FleetLinkInbox.isCandidate("fleet://join?code=abc"))
    // 대문자 스킴/호스트는 후보가 아니다(파서와 달리 대소문자 구분).
    XCTAssertFalse(FleetLinkInbox.isCandidate("FLEET://JOIN?CODE=abc"))
    // 다른 액션.
    XCTAssertFalse(FleetLinkInbox.isCandidate("fleet://pair?code=abc"))
    // 선행 공백.
    XCTAssertFalse(FleetLinkInbox.isCandidate(" fleet://join?code=abc"))
    // 4096 초과.
    let oversized = "fleet://join?code=" + String(repeating: "a", count: FleetLinkInbox.maxInputLength)
    XCTAssertFalse(FleetLinkInbox.isCandidate(oversized))
    XCTAssertFalse(FleetLinkInbox.isCandidate(nil))
  }

  func testOfferConsumeIsOneShot() {
    FleetLinkInbox.offer("fleet://join?code=abc")
    XCTAssertEqual(FleetLinkInbox.consume(), "fleet://join?code=abc")
    XCTAssertNil(FleetLinkInbox.consume())
  }

  func testOfferIgnoresNonCandidate() {
    FleetLinkInbox.offer("fleet://pair?code=abc")
    XCTAssertNil(FleetLinkInbox.consume())
  }

  func testAttachDeliversPendingOnce() {
    var delivered: [String] = []
    let receiver = FleetLinkReceiver { delivered.append($0) }
    FleetLinkInbox.offer("fleet://join?code=abc")
    XCTAssertTrue(FleetLinkInbox.attach(receiver))
    XCTAssertEqual(delivered, ["fleet://join?code=abc"])
    // 소비되었으므로 재전달 없음.
    XCTAssertNil(FleetLinkInbox.consume())
    FleetLinkInbox.detach(receiver)
  }

  func testAttachReturnsFalseWhenNoPendingLink() {
    var delivered: [String] = []
    let receiver = FleetLinkReceiver { delivered.append($0) }
    XCTAssertFalse(FleetLinkInbox.attach(receiver))
    XCTAssertTrue(delivered.isEmpty)
    FleetLinkInbox.detach(receiver)
  }

  func testAttachOneShotDoesNotRedeliverAfterDetach() {
    var first: [String] = []
    let a = FleetLinkReceiver { first.append($0) }
    FleetLinkInbox.offer("fleet://join?code=abc")
    XCTAssertTrue(FleetLinkInbox.attach(a))
    FleetLinkInbox.detach(a)

    var second: [String] = []
    let b = FleetLinkReceiver { second.append($0) }
    XCTAssertFalse(FleetLinkInbox.attach(b))
    XCTAssertEqual(first, ["fleet://join?code=abc"])
    XCTAssertTrue(second.isEmpty)
    FleetLinkInbox.detach(b)
  }

  func testDetachOnlyClearsMatchingReceiver() {
    let a = FleetLinkReceiver { _ in }
    let b = FleetLinkReceiver { _ in }
    FleetLinkInbox.attach(a)
    // 다른 인스턴스로 detach하면 해제되지 않는다.
    FleetLinkInbox.detach(b)
    var delivered: [String] = []
    let observer = FleetLinkReceiver { delivered.append($0) }
    _ = observer
    FleetLinkInbox.offer("fleet://join?code=xyz")
    // a가 여전히 붙어 있으므로 offer가 a로 배수된다(관찰은 못 하지만 consume이 비어야 함).
    XCTAssertNil(FleetLinkInbox.consume())
    FleetLinkInbox.detach(a)
  }
}
