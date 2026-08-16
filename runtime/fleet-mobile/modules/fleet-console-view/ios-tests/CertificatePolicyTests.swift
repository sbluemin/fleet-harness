import Foundation
import XCTest
@testable import FleetConsoleCore

// RemoteConnection.kt CertificatePolicy의 동작 검증. 로컬에서 만든 인증서로 핀 검증 경로를
// 확인한다(원격 DNS 인증서 경로는 기기에서 검증).
final class CertificatePolicyTests: XCTestCase {
  private func target(hostname: String, fingerprint: String) -> PersistedTarget {
    PersistedTarget(
      origin: "https://\(hostname):8443", hostname: hostname, port: 8443, label: "Console",
      fingerprint: fingerprint, loopback: LoopbackIdentity(host: "127.0.0.1", port: 40001))
  }

  func testVerifyLeafAcceptsMatchingHostAndPin() throws {
    let identity = try LocalTlsIdentity.create("127.0.0.1")
    let fp = CertificatePolicy.fingerprint(identity.certificate)
    XCTAssertNoThrow(try CertificatePolicy.verifyLeaf(identity.certificate, target(hostname: "127.0.0.1", fingerprint: fp)))
  }

  func testVerifyLeafRejectsPinMismatch() throws {
    let identity = try LocalTlsIdentity.create("127.0.0.1")
    XCTAssertThrowsError(
      try CertificatePolicy.verifyLeaf(identity.certificate, target(hostname: "127.0.0.1", fingerprint: String(repeating: "A", count: 64)))
    ) { XCTAssertEqual(($0 as? CertificateError)?.code, "certificate_pin_mismatch") }
  }

  func testVerifyLeafRejectsHostnameMismatch() throws {
    let identity = try LocalTlsIdentity.create("127.0.0.1")
    let fp = CertificatePolicy.fingerprint(identity.certificate)
    XCTAssertThrowsError(
      try CertificatePolicy.verifyLeaf(identity.certificate, target(hostname: "127.0.0.2", fingerprint: fp))
    ) { XCTAssertEqual(($0 as? CertificateError)?.code, "certificate_hostname_mismatch") }
  }

  func testVerifyLeafRejectsExpired() throws {
    // notBefore/notAfter가 과거가 되도록 이틀 전으로 생성 → 지금은 만료.
    let expired = try LocalTlsIdentity.create("127.0.0.1", now: Date(timeIntervalSinceNow: -48 * 3600))
    let fp = CertificatePolicy.fingerprint(expired.certificate)
    XCTAssertThrowsError(
      try CertificatePolicy.verifyLeaf(expired.certificate, target(hostname: "127.0.0.1", fingerprint: fp))
    ) { XCTAssertEqual(($0 as? CertificateError)?.code, "certificate_expired") }
  }

  func testFingerprintIs64UppercaseHex() throws {
    let identity = try LocalTlsIdentity.create("127.0.0.1")
    let fp = CertificatePolicy.fingerprint(identity.certificate)
    XCTAssertEqual(fp.count, 64)
    XCTAssertTrue(fp.allSatisfy { "0123456789ABCDEF".contains($0) })
  }

  func testIsIpLiteral() {
    XCTAssertTrue(CertificatePolicy.isIpLiteral("127.0.0.1"))
    XCTAssertTrue(CertificatePolicy.isIpLiteral("::1"))
    XCTAssertTrue(CertificatePolicy.isIpLiteral("fd00::1"))
    XCTAssertFalse(CertificatePolicy.isIpLiteral("fleet.example"))
    XCTAssertFalse(CertificatePolicy.isIpLiteral("256.1.1.1")) // 옥텟 > 255
    XCTAssertFalse(CertificatePolicy.isIpLiteral("1.2.3"))     // 3옥텟
  }
}
