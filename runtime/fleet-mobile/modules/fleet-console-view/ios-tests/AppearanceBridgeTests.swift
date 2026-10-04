import Foundation
import XCTest
@testable import FleetConsoleCore

// AppearanceBridgeTest.kt 이식. 페이지 → 셸 겉모습 통로는 보안 경계다: 커밋된 페이지 자신의
// 메시지만 통과한다.
final class AppearanceBridgeTests: XCTestCase {
  private let set = #"{"v":1,"type":"set","colorMode":"dark","fontScale":"large"}"#

  func testAcceptsOnlyTheCommittedMainFrameOfTheGatewayOrigin() {
    XCTAssertEqual(
      AppearanceBridge.accept(fromCommittedView: true, isMainFrame: true, fromGatewayOrigin: true, body: set),
      .set(Appearance(colorMode: .dark, fontScale: .large)))
    XCTAssertNil(AppearanceBridge.accept(fromCommittedView: false, isMainFrame: true, fromGatewayOrigin: true, body: set))
    XCTAssertNil(AppearanceBridge.accept(fromCommittedView: true, isMainFrame: false, fromGatewayOrigin: true, body: set))
    XCTAssertNil(AppearanceBridge.accept(fromCommittedView: true, isMainFrame: true, fromGatewayOrigin: false, body: set))
  }

  func testDropsEveryBodyOutsideTheWhitelistedShapes() {
    let rejected: [Any?] = [
      #"{"v":1,"type":"set","colorMode":"dark","fontScale":"large","extra":1}"#,
      #"{"v":1,"type":"set","colorMode":"dark"}"#,
      #"{"v":1,"type":"set","colorMode":"sepia","fontScale":"large"}"#,
      #"{"v":2,"type":"set","colorMode":"dark","fontScale":"large"}"#,
      #"{"v":true,"type":"set","colorMode":"dark","fontScale":"large"}"#,
      ##"{"v":1,"type":"chrome","top":"#000000","bottom":"bg"}"##,
      #"{"v":1,"type":"consoles","origin":"https://other.example"}"#,
      #"{"v":1,"type":"navigate","url":"https://other.example"}"#,
      #"{"v":1,"type":"set","colorMode":"dark","fontScale":"\#(String(repeating: "x", count: 240))"}"#,
      "not json",
      ["v": 1, "type": "consoles"],
      nil,
    ]
    for body in rejected {
      XCTAssertNil(AppearanceBridge.accept(fromCommittedView: true, isMainFrame: true, fromGatewayOrigin: true, body: body), "\(String(describing: body))")
    }
    XCTAssertEqual(AppearanceBridge.accept(fromCommittedView: true, isMainFrame: true, fromGatewayOrigin: true, body: #"{"v":1,"type":"consoles"}"#), .consoles)
  }

  func testQuotesTheConsoleLabelInsteadOfSplicingItIntoCode() throws {
    let label = "\"); alert(1); (\"</script>"
    let script = AppearanceBridge.script(.standard, systemDark: true, console: ConsolePresentation.of(label: label, origin: "https://fleet.example:7443"))
    XCTAssertFalse(script.contains(label))
    let start = try XCTUnwrap(script.range(of: "JSON.parse("))
    let end = try XCTUnwrap(script.range(of: "); if (v.console)"))
    let literal = String(script[start.upperBound..<end.lowerBound])
    let json = try JSONDecoder().decode(String.self, from: Data(literal.utf8))
    let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    XCTAssertEqual((value["console"] as? [String: Any])?["label"] as? String, label)
    XCTAssertEqual(value["systemScheme"] as? String, "dark")
  }
}
