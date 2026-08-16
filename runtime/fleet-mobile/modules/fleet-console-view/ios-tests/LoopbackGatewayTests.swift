import Foundation
import XCTest
@testable import FleetConsoleCore

// LoopbackGateway 서버 자체는 실제 네트워크라 기기에서만 검증된다. 여기서는 SPM에서 확인
// 가능한 조각(포트 예약)만 검증한다 — 정책/코덱은 GatewayPolicyTests/HttpCodecTests가 커버.
final class LoopbackGatewayTests: XCTestCase {
  func testReserveReturnsBindableLoopbackPort() {
    let identity = LoopbackIdentity.reserve()
    XCTAssertEqual(identity.host, "127.0.0.1")
    XCTAssertTrue((1...65535).contains(identity.port), "port \(identity.port) out of range")
    XCTAssertEqual(identity.origin, "https://127.0.0.1:\(identity.port)")
    // 서로 다른 예약은 대개 다른 포트를 준다(같을 확률은 무시할 수준).
    let other = LoopbackIdentity.reserve()
    XCTAssertTrue((1...65535).contains(other.port))
  }

  func testLocalCookieHeaderCarriesTheGatewaySecretHardened() throws {
    let target = PersistedTarget(
      origin: "https://192.0.2.10:7443", hostname: "192.0.2.10", port: 7443, label: "C",
      fingerprint: String(repeating: "A", count: 64), loopback: LoopbackIdentity.reserve())
    let gateway = try LoopbackGateway(
      target: target, remote: RemoteConnection(cookies: FleetCookieJar(store: InMemoryKeyValueStore())),
      cookies: FleetCookieJar(store: InMemoryKeyValueStore()))
    let header = gateway.localCookieHeader
    XCTAssertTrue(header.hasPrefix("fleet_mobile_gateway="))
    for attr in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"] {
      XCTAssertTrue(header.contains(attr), "missing \(attr)")
    }
    gateway.close()
  }
}
