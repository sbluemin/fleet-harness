import Foundation
import XCTest
@testable import FleetConsoleCore

// LoopbackGatewayTest.kt의 GatewayPolicy 관련 케이스 이식.
final class GatewayPolicyTests: XCTestCase {
  func testRewritesHostOriginRefererAndRemoteCookie() {
    let rewritten = GatewayPolicy.rewriteRequestHeaders(
      Headers([
        Header(name: "Host", value: "127.0.0.1:4312"),
        Header(name: "Origin", value: "http://127.0.0.1:4312"),
        Header(name: "Referer", value: "http://127.0.0.1:4312/console/"),
        Header(name: "Cookie", value: "fleet_mobile_gateway=secret"),
        Header(name: "Connection", value: "keep-alive"),
      ]),
      "http://127.0.0.1:4312",
      "https://fleet.example:7443",
      "fleet.example:7443",
      "fleet_pairing=remote",
      false)
    XCTAssertEqual(rewritten.first("Host"), "fleet.example:7443")
    XCTAssertEqual(rewritten.first("Origin"), "https://fleet.example:7443")
    XCTAssertEqual(rewritten.first("Referer"), "https://fleet.example:7443/console/")
    XCTAssertEqual(rewritten.first("Cookie"), "fleet_pairing=remote")
    XCTAssertNil(rewritten.first("Keep-Alive"))
  }

  func testStripsSetCookieAndRewritesOnlyAllowedLocations() throws {
    let rewritten = try GatewayPolicy.rewriteResponseHeaders(
      Headers([
        Header(name: "Set-Cookie", value: "remote=secret"),
        Header(name: "Location", value: "https://fleet.example:7443/console/?x=1"),
        Header(name: "Content-Type", value: "text/html"),
      ]),
      "https://fleet.example:7443",
      "http://127.0.0.1:4312",
      false)
    XCTAssertTrue(rewritten.values("Set-Cookie").isEmpty)
    XCTAssertEqual(rewritten.first("Location"), "http://127.0.0.1:4312/console/?x=1")
    XCTAssertThrowsError(try GatewayPolicy.rewriteLocation(
      "https://foreign.example/", "https://fleet.example:7443", "http://127.0.0.1:4312"))
  }

  func testRewritesCspToExactLocalConnectBoundary() {
    let value = GatewayPolicy.rewriteCsp(
      "default-src 'self'; connect-src 'self' ws: wss: https://api.github.com; script-src 'self'; report-uri /csp",
      "https://127.77.23.91:43871")
    XCTAssertTrue(value.contains("script-src 'self'"))
    XCTAssertTrue(value.contains("connect-src 'self' https://127.77.23.91:43871 wss://127.77.23.91:43871"))
    XCTAssertFalse(value.contains("api.github.com"))
    XCTAssertFalse(value.contains("report-uri"))
  }

  func testValidatesWebSocketAcceptAndPreservesNegotiationHeaders() throws {
    let headers = Headers([
      Header(name: "Connection", value: "Upgrade"),
      Header(name: "Upgrade", value: "websocket"),
      Header(name: "Sec-WebSocket-Accept", value: "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
      Header(name: "Sec-WebSocket-Protocol", value: "fleet"),
      Header(name: "Sec-WebSocket-Extensions", value: "permessage-deflate"),
    ])
    XCTAssertTrue(GatewayPolicy.validWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==", headers))
    let rewritten = try GatewayPolicy.rewriteResponseHeaders(
      headers, "https://fleet.example", "https://127.77.23.91:43871", true)
    XCTAssertEqual(rewritten.first("Sec-WebSocket-Protocol"), "fleet")
    XCTAssertEqual(rewritten.first("Sec-WebSocket-Extensions"), "permessage-deflate")
  }

  func testRewriteLocationPassesRootRelativeThrough() throws {
    let loc = try GatewayPolicy.rewriteLocation("/console/?x=1", "https://fleet.example:7443", "http://127.0.0.1:4312")
    XCTAssertEqual(loc, "http://127.0.0.1:4312/console/?x=1")
  }
}
