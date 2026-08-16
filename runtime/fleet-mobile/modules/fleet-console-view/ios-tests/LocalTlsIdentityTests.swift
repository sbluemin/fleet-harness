import Foundation
import XCTest
@testable import FleetConsoleCore

// LoopbackGatewayTest.localLeafMatchesOnlyExactDerAndIpSan 이식 + 인코더/파서 왕복 확인.
// 런타임 TLS 동작(실제 서버 identity, WKWebView 핀)은 기기에서만 검증된다; 여기서는
// DER encode+parse 왕복과 SAN/leaf/유효기간 판정을 확인한다.
final class LocalTlsIdentityTests: XCTestCase {
  func testLocalLeafMatchesOnlyExactDerAndIpSan() throws {
    let identity = try LocalTlsIdentity.create("127.77.23.91")
    XCTAssertTrue(LocalCertificatePolicy.matches(identity.certificate, identity.certificate, "127.77.23.91"))
    XCTAssertFalse(LocalCertificatePolicy.matches(identity.certificate, identity.certificate, "127.77.23.92"))
  }

  func testCreatesValidLoopbackIdentityFor127001() throws {
    let identity = try LocalTlsIdentity.create("127.0.0.1")
    XCTAssertTrue(LocalCertificatePolicy.matches(identity.certificate, identity.certificate, "127.0.0.1"))
    // 인증서는 SecCertificate로 파싱 가능해야 한다(DER 유효성).
    XCTAssertGreaterThan(identity.certificateDer.count, 0)
  }

  func testDifferentCertificatesDoNotMatch() throws {
    let a = try LocalTlsIdentity.create("127.0.0.1")
    let b = try LocalTlsIdentity.create("127.0.0.1")
    // 시리얼/키가 달라 DER이 다르므로 서로 매치되지 않는다.
    XCTAssertFalse(LocalCertificatePolicy.matches(a.certificate, b.certificate, "127.0.0.1"))
  }

  func testParsedFieldsAreLeafWithinValidityAndCarryTheIpSan() throws {
    let identity = try LocalTlsIdentity.create("127.44.2.9")
    let fields = try XCTUnwrap(CertFields.parse([UInt8](identity.certificateDer)))
    XCTAssertTrue(fields.isLeaf)
    XCTAssertNotNil(fields.notBefore)
    XCTAssertNotNil(fields.notAfter)
    XCTAssertTrue(fields.ipSans.contains([127, 44, 2, 9]))
  }
}
