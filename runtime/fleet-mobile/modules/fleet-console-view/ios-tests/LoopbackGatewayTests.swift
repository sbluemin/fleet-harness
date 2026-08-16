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

  // 위 테스트는 헤더만 본다. 정작 깨졌던 곳은 그 다음 단계였다: FleetConsoleView가
  // WKHTTPCookieStore에 넣을 쿠키를 속성 딕셔너리로 다시 조립하면서 HttpOnly와 SameSite를
  // 빠뜨렸고, 그래서 콘솔 JS가 document.cookie로 게이트웨이 시크릿을 읽을 수 있었다
  // (Android CookieManager 경로에는 없는 구멍). 이제 뷰는 이 헤더를 그대로 파싱하므로,
  // 파싱 결과가 실제로 하드닝돼 있는지를 여기서 잠근다.
  func testGatewayCookieParsesIntoAHardenedCookie() throws {
    let target = PersistedTarget(
      origin: "https://192.0.2.10:7443", hostname: "192.0.2.10", port: 7443, label: "C",
      fingerprint: String(repeating: "A", count: 64), loopback: LoopbackIdentity.reserve())
    let gateway = try LoopbackGateway(
      target: target, remote: RemoteConnection(cookies: FleetCookieJar(store: InMemoryKeyValueStore())),
      cookies: FleetCookieJar(store: InMemoryKeyValueStore()))
    defer { gateway.close() }

    let origin = try XCTUnwrap(URL(string: gateway.origin))
    let cookie = try XCTUnwrap(
      HTTPCookie.cookies(
        withResponseHeaderFields: ["Set-Cookie": gateway.localCookieHeader],
        for: origin
      ).first,
      "the gateway cookie header no longer parses — the WebView would load without the secret")

    XCTAssertEqual(cookie.name, LoopbackGateway.cookieName)
    XCTAssertEqual(cookie.value, gateway.secret)
    XCTAssertTrue(cookie.isHTTPOnly, "console JS could read the gateway secret from document.cookie")
    XCTAssertEqual(cookie.sameSitePolicy, .sameSiteStrict)
    XCTAssertTrue(cookie.isSecure)
    XCTAssertEqual(cookie.path, "/")
  }
}
