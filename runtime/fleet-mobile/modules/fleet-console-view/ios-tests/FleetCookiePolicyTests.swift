import Foundation
import XCTest
@testable import FleetConsoleCore

// LoopbackGatewayTest.kt의 FleetCookiePolicy 케이스 이식.
final class FleetCookiePolicyTests: XCTestCase {
  func testCookieRollbackRestoresOldFleetCookiesAndExpiresCandidateOnlyNames() throws {
    let snapshot = try FleetCookiePolicy.snapshot(
      "fleet_console_pairing_7443=old-pair; fleet_console_session_7443=old-session; unrelated=x", 7443)
    let headers = try FleetCookiePolicy.restoreHeaders(
      snapshot,
      "fleet_console_pairing_7443=new-pair; fleet_console_session_7443=new-session; fleet_console_session_7444=candidate",
      7443)
    XCTAssertFalse(headers.contains { $0.hasPrefix("fleet_console_session_7444=") })
    XCTAssertTrue(headers.contains { $0.hasPrefix("fleet_console_pairing_7443=old-pair; Max-Age=31536000") })
    XCTAssertTrue(headers.contains { $0.hasPrefix("fleet_console_session_7443=old-session; Secure") })
    XCTAssertFalse(headers.contains { $0.hasPrefix("unrelated=") })
  }

  func testRemoteCookiesStayWithinTheExactHostAndConsolePort() throws {
    let mixed = "fleet_console_session_7443=right-session; fleet_console_pairing_7443=right-pair; "
      + "fleet_console_session_7444=other-session; unrelated=x"
    XCTAssertEqual(
      try FleetCookiePolicy.requestHeader(mixed, 7443),
      "fleet_console_session_7443=right-session; fleet_console_pairing_7443=right-pair")

    let accepted = try FleetCookiePolicy.validateSetCookieHeaders(
      [
        "fleet_console_session_7443=new-session; HttpOnly; SameSite=Strict; Path=/; Secure",
        "fleet_console_pairing_7443=new-pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
      ],
      7443)
    XCTAssertEqual(accepted.count, 2)

    // Domain 속성 거부.
    XCTAssertThrowsError(try FleetCookiePolicy.validateSetCookieHeaders(
      ["fleet_console_session_7443=poison; Domain=.example.test; HttpOnly; SameSite=Strict; Path=/; Secure"], 7443))
    // 다른 포트 이름 거부.
    XCTAssertThrowsError(try FleetCookiePolicy.validateSetCookieHeaders(
      ["fleet_console_session_7444=other; HttpOnly; SameSite=Strict; Path=/; Secure"], 7443))
    // session 쿠키의 Max-Age 거부.
    XCTAssertThrowsError(try FleetCookiePolicy.validateSetCookieHeaders(
      ["fleet_console_session_7443=value; Max-Age=60; HttpOnly; SameSite=Strict; Path=/; Secure"], 7443))
    // 값 없는 Max-Age 플래그 거부.
    XCTAssertThrowsError(try FleetCookiePolicy.validateSetCookieHeaders(
      ["fleet_console_pairing_7443=value; Max-Age; HttpOnly; SameSite=Strict; Path=/; Secure"], 7443))
  }
}
