import Foundation
import XCTest
@testable import FleetConsoleCore

// RemoteConnectionTest.kt 이식 + requireExpectedAuthority/mappedTlsFailure 순수 로직 검증.
// 소켓 경로(핸드셰이크·검증 블록)는 기기에서만 검증된다.
final class RemoteConnectionTests: XCTestCase {
  func testRetryAfterAcceptsOnlyBoundedDeltaSeconds() {
    XCTAssertEqual(RetryAfterHeader.seconds("60"), 60)
    XCTAssertEqual(RetryAfterHeader.seconds(" 120 "), 120)
    XCTAssertEqual(RetryAfterHeader.seconds("0"), 0)
    XCTAssertEqual(RetryAfterHeader.seconds("86400"), 86_400)
    XCTAssertNil(RetryAfterHeader.seconds("86401"))
    XCTAssertNil(RetryAfterHeader.seconds("-1"))
    XCTAssertNil(RetryAfterHeader.seconds("1.5"))
    XCTAssertNil(RetryAfterHeader.seconds("Wed, 21 Oct 2015 07:28:00 GMT"))
    XCTAssertNil(RetryAfterHeader.seconds(nil))
  }

  func testConnectionFailureCarriesOptionalRetryAfter() {
    XCTAssertEqual(ConnectionFailure("remote_link_throttled", retryAfterSeconds: 60).retryAfterSeconds, 60)
    XCTAssertNil(ConnectionFailure("remote_link_rejected").retryAfterSeconds)
  }

  private func target(_ origin: String, _ host: String, _ port: Int) -> PersistedTarget {
    PersistedTarget(
      origin: origin, hostname: host, port: port, label: "Console",
      fingerprint: String(repeating: "A", count: 64),
      loopback: LoopbackIdentity(host: "127.0.0.1", port: 40001))
  }

  func testRequireExpectedAuthorityAcceptsTheTargetsOwnUrls() throws {
    let t = target("https://fleet.example:7443", "fleet.example", 7443)
    XCTAssertNoThrow(try RemoteConnection.requireExpectedAuthority(t, t.joinUrl))
    XCTAssertNoThrow(try RemoteConnection.requireExpectedAuthority(t, t.readinessUrl))
    // 443 생략 오리진.
    let d = target("https://fleet.example", "fleet.example", 443)
    XCTAssertNoThrow(try RemoteConnection.requireExpectedAuthority(d, d.joinUrl))
    // IPv6 브래킷 오리진.
    let v6 = target("https://[fd00::1]:4310", "fd00::1", 4310)
    XCTAssertNoThrow(try RemoteConnection.requireExpectedAuthority(v6, v6.readinessUrl))
  }

  func testRequireExpectedAuthorityRejectsForeignAuthority() {
    let t = target("https://fleet.example:7443", "fleet.example", 7443)
    for bad in [
      "https://other.example:7443/api/v1/join",  // 다른 호스트
      "https://fleet.example:7444/api/v1/join",  // 다른 포트
      "http://fleet.example:7443/api/v1/join",   // http
      "https://user@fleet.example:7443/api/v1/join", // userInfo
      "https://fleet.example:7443/api/v1/join#f",    // fragment
    ] {
      XCTAssertThrowsError(try RemoteConnection.requireExpectedAuthority(t, bad), bad) {
        XCTAssertTrue(["remote_link_host_mismatch", "remote_link_unverified"].contains(($0 as? ConnectionFailure)?.code ?? ""), bad)
      }
    }
    // origin 문자열 자체가 기대 렌더링과 다른 타깃도 거부(예: 443인데 :443 표기).
    let odd = target("https://fleet.example:443", "fleet.example", 443)
    XCTAssertThrowsError(try RemoteConnection.requireExpectedAuthority(odd, "https://fleet.example/api/v1/join"))
  }

  func testMappedTlsFailureDistinguishesPinFromGenericTls() {
    XCTAssertEqual(RemoteConnection.mappedTlsFailure(CertificateError("certificate_pin_mismatch")).code, "remote_link_fingerprint_mismatch")
    for code in ["certificate_hostname_mismatch", "certificate_expired", "certificate_not_yet_valid", "certificate_not_leaf", "missing_leaf_certificate"] {
      XCTAssertEqual(RemoteConnection.mappedTlsFailure(CertificateError(code)).code, "remote_link_unverified", code)
    }
    XCTAssertEqual(RemoteConnection.mappedTlsFailure(HttpCodecError("eof")).code, "remote_link_unreachable")
  }
}
