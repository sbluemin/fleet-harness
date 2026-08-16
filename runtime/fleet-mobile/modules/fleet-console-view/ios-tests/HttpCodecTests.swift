import Foundation
import XCTest
@testable import FleetConsoleCore

// LoopbackGatewayTest.kt의 HttpCodec/코덱 관련 케이스 이식.
final class HttpCodecTests: XCTestCase {
  func testRequiresExactHostAndGatewayCookie() throws {
    let request = try HttpCodec.readRequest(ByteArrayInput(
      "GET /console/ HTTP/1.1\r\nHost: 127.0.0.1:4312\r\nCookie: a=b; fleet_mobile_gateway=secret\r\n\r\n"))
    XCTAssertEqual(request.host, "127.0.0.1:4312")
    XCTAssertTrue(request.hasCookie("fleet_mobile_gateway", "secret"))
    XCTAssertFalse(request.hasCookie("fleet_mobile_gateway", "other"))
  }

  func testRejectsConflictingFraming() {
    XCTAssertThrowsError(try HttpCodec.readRequest(ByteArrayInput(
      "POST /api HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n")))
  }

  func testStreamsChunkedSseWithoutBufferingWholeBody() throws {
    let input = ByteArrayInput("4\r\ndata\r\n1\r\n\n\r\n0\r\n\r\n")
    let output = ByteArrayOutput()
    try HttpCodec.copyChunked(input, output, decode: true, flushEach: true)
    XCTAssertEqual(output.utf8String, "data\n")
    XCTAssertGreaterThanOrEqual(output.flushes, 2)
  }

  func testPreservesWebSocketPathTicketAndUpgradeContract() throws {
    let request = try HttpCodec.readRequest(ByteArrayInput(
      "GET /api/v1/socket?ticket=once HTTP/1.1\r\n"
        + "Host: 127.0.0.1:4312\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
        + "Sec-WebSocket-Key: abc\r\nCookie: fleet_mobile_gateway=secret\r\n\r\n"))
    XCTAssertEqual(request.target, "/api/v1/socket?ticket=once")
    XCTAssertTrue(request.isWebSocketUpgrade)
    let rewritten = GatewayPolicy.rewriteRequestHeaders(
      request.headers, "http://127.0.0.1:4312", "https://fleet.example", "fleet.example", "remote=session", true)
    XCTAssertEqual(rewritten.first("Connection"), "Upgrade")
    XCTAssertEqual(rewritten.first("Upgrade"), "websocket")
    XCTAssertEqual(rewritten.first("Sec-WebSocket-Key"), "abc")
  }

  func testHeadResponseDoesNotWaitForRepresentationBody() throws {
    let response = try HttpCodec.readResponse(
      ByteArrayInput("HTTP/1.1 200 OK\r\nContent-Length: 9000\r\n\r\n"), requestMethod: "HEAD")
    XCTAssertEqual(response.bodyKind, .none)
  }

  func testRawRelayDoesNotParseWebSocketFrames() throws {
    let bytes: [UInt8] = [0x82, 0x7f, 0, 1, 2, 3, 4, 5]
    let output = ByteArrayOutput()
    try HttpCodec.copyUntilEof(ByteArrayInput(bytes), output, true)
    XCTAssertEqual(output.bytes, bytes)
  }

  func testClosedClientDuringErrorResponseDoesNotEscape() {
    // 반드시 던지는 출력에 써도 예외가 탈출하지 않아야 한다.
    GatewayErrorResponse.write(ThrowingOutput(), code: 400, reason: "Bad request")
  }

  func testCopyExactlyThrowsOnEarlyEof() {
    XCTAssertThrowsError(try HttpCodec.copyExactly(ByteArrayInput("ab"), ByteArrayOutput(), length: 5))
  }
}
