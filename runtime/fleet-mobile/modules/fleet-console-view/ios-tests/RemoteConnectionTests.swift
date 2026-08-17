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

  func testReadBodyKeepsFixedAtTheDeclaredCap() throws {
    let cap = RemoteConnection.maxResponseBodyBytes
    let exact = [UInt8](repeating: 0x61, count: cap)
    let body = try RemoteConnection.readBody(
      CountingByteInput(exact),
      HttpResponse(statusLine: "HTTP/1.1 200 OK", code: 200, headers: Headers(), bodyKind: .fixed(length: Int64(cap))))
    XCTAssertEqual(body.count, cap)

    let oversize = CountingByteInput([UInt8](repeating: 0x61, count: cap + 16))
    XCTAssertThrowsError(try RemoteConnection.readBody(
      oversize,
      HttpResponse(statusLine: "HTTP/1.1 200 OK", code: 200, headers: Headers(), bodyKind: .fixed(length: Int64(cap + 1))))) { error in
      XCTAssertEqual((error as? ConnectionFailure)?.code, "remote_host_unavailable")
    }
    // Content-Length가 캡을 넘으면 바디를 읽기 전에 거절한다.
    XCTAssertEqual(oversize.consumed, 0)
  }

  func testReadBodyAbortsChunkedAtCapWithoutBufferingTheRest() {
    let cap = RemoteConnection.maxResponseBodyBytes
    let payload = [UInt8](repeating: 0x62, count: cap + (256 * 1024))
    let input = CountingByteInput(Self.chunked(payload))
    XCTAssertThrowsError(try RemoteConnection.readBody(
      input,
      HttpResponse(statusLine: "HTTP/1.1 200 OK", code: 200, headers: Headers(), bodyKind: .chunked))) { error in
      XCTAssertEqual((error as? ConnectionFailure)?.code, "remote_host_unavailable")
    }
    XCTAssertGreaterThan(input.consumed, cap)
    XCTAssertLessThan(input.consumed, payload.count, "chunked가 캡을 넘긴 뒤에도 나머지를 다 읽으면 안 된다")
  }

  func testReadBodyAbortsUntilCloseAtCapWithoutBufferingTheRest() {
    let cap = RemoteConnection.maxResponseBodyBytes
    let payload = [UInt8](repeating: 0x63, count: cap + (256 * 1024))
    let input = CountingByteInput(payload)
    XCTAssertThrowsError(try RemoteConnection.readBody(
      input,
      HttpResponse(statusLine: "HTTP/1.1 200 OK", code: 200, headers: Headers(), bodyKind: .untilClose))) { error in
      XCTAssertEqual((error as? ConnectionFailure)?.code, "remote_host_unavailable")
    }
    XCTAssertGreaterThan(input.consumed, cap)
    XCTAssertLessThan(input.consumed, payload.count, "untilClose가 캡을 넘긴 뒤에도 나머지를 다 읽으면 안 된다")
  }

  func testBoundedByteSinkThrowsOnTheWriteThatCrossesTheCap() throws {
    let sink = BoundedByteSink(maxBytes: 8)
    try sink.write([1, 2, 3, 4])
    XCTAssertThrowsError(try sink.write([5, 6, 7, 8, 9])) { error in
      XCTAssertEqual((error as? ConnectionFailure)?.code, "remote_host_unavailable")
    }
    XCTAssertEqual(sink.bytes, [1, 2, 3, 4])
  }

  private static func chunked(_ payload: [UInt8]) -> [UInt8] {
    Array("\(String(payload.count, radix: 16))\r\n".utf8) + payload + Array("\r\n0\r\n\r\n".utf8)
  }
}

// 소비 바이트를 세어, 캡 초과 시 나머지를 버퍼링하지 않았음을 증명한다.
private final class CountingByteInput: ByteInput {
  private let bytes: [UInt8]
  private var offset = 0
  private(set) var consumed = 0

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  func read(_ maxLength: Int) throws -> [UInt8] {
    if offset >= bytes.count || maxLength <= 0 { return [] }
    let end = min(offset + maxLength, bytes.count)
    let slice = Array(bytes[offset..<end])
    offset = end
    consumed += slice.count
    return slice
  }

  func setReadTimeout(milliseconds: Int?) {}
}
