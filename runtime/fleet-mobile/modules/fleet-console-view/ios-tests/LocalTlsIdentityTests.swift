import Foundation
import Security
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

  // 게이트웨이가 NWListener에 넘길 identity가 키체인 없이 만들어지는지 — 키를 키체인에
  // 저장하던 이전 구현이 엔타이틀먼트 없는 빌드에서 -34018로 죽던 바로 그 지점이다.
  // identity가 들고 있는 인증서/키가 실제로 우리가 만든 그 쌍인지까지 확인한다.
  func testSecIdentityPairsTheKeyWithoutTouchingTheKeychain() throws {
    let identity = try LocalTlsIdentity.create("127.0.0.1")
    let secIdentity = try identity.secIdentity()

    var certificate: SecCertificate?
    XCTAssertEqual(SecIdentityCopyCertificate(secIdentity, &certificate), errSecSuccess)
    let paired = try XCTUnwrap(certificate)
    XCTAssertEqual(SecCertificateCopyData(paired) as Data, identity.certificateDer)

    var key: SecKey?
    XCTAssertEqual(SecIdentityCopyPrivateKey(secIdentity, &key), errSecSuccess)
    XCTAssertNotNil(key)
  }
}
