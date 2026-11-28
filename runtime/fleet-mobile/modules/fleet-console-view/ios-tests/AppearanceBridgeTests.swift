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
      #"{"v":1,"type":"edge","on":true,"extra":1}"#,
      #"{"v":1,"type":"edge"}"#,
      #"{"v":1,"type":"edge","on":false}"#,
      #"{"v":1,"type":"edge","on":1}"#,
      #"{"v":1,"type":"edge","on":"true"}"#,
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
    XCTAssertEqual(AppearanceBridge.accept(fromCommittedView: true, isMainFrame: true, fromGatewayOrigin: true, body: #"{"v":1,"type":"edge","on":true}"#), .edge)
    XCTAssertNil(AppearanceBridge.accept(fromCommittedView: false, isMainFrame: true, fromGatewayOrigin: true, body: #"{"v":1,"type":"edge","on":true}"#))
  }

  func testAcceptsTheSeamlessShapesKeyForKey() {
    let accept = { (body: String) in AppearanceBridge.accept(fromCommittedView: true, isMainFrame: true, fromGatewayOrigin: true, body: body) }
    let id = "0F8E3A52-1C2B-4C11-9E3F-0123456789AB"
    XCTAssertEqual(accept(#"{"v":1,"type":"roster"}"#), .roster)
    XCTAssertEqual(accept(#"{"v":1,"type":"arrived"}"#), .arrived)
    XCTAssertEqual(accept(#"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1"}"#),
                   .switchConsole(console: id, commodore: "c1", commander: nil, scrollTop: nil))
    let longest = String(repeating: "가", count: 128)
    XCTAssertEqual(accept(#"{"v":1,"type":"switch","console":"\#(id)","commodore":"\#(longest)","commander":"\#(longest)","scrollTop":100000}"#),
                   .switchConsole(console: id, commodore: longest, commander: longest, scrollTop: 100_000))
    let rejected = [
      #"{"v":1,"type":"roster","console":"\#(id)"}"#,
      #"{"v":1,"type":"arrived","commodore":"c1"}"#,
      #"{"v":1,"type":"switch","console":"\#(id)"}"#,
      #"{"v":1,"type":"switch","commodore":"c1"}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","origin":"https://other.example"}"#,
      #"{"v":1,"type":"switch","console":"https://other.example","commodore":"c1"}"#,
      #"{"v":1,"type":"switch","console":"\#(String(repeating: "a", count: 65))","commodore":"c1"}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":""}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c\u0007"}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"\#(String(repeating: "c", count: 129))"}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","commander":null}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","scrollTop":null}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","scrollTop":-1}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","scrollTop":100001}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","scrollTop":true}"#,
      #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1","scrollTop":"10"}"#,
    ]
    for body in rejected { XCTAssertNil(accept(body), body) }
    XCTAssertNil(AppearanceBridge.accept(fromCommittedView: false, isMainFrame: true, fromGatewayOrigin: true, body: #"{"v":1,"type":"switch","console":"\#(id)","commodore":"c1"}"#))
  }

  /// 구 페이지는 모르는 키와 이벤트를 읽지 않는다 — 새 셸의 문서 시작 값은 v1~v1.5 키를 그대로 두고 능력 표지만 더한다.
  func testTheSeamlessMarkerIsAdditiveToTheExistingDocumentStartValue() throws {
    let value = try parsed(AppearanceBridge.script(.standard, systemDark: false, console: ConsolePresentation.of(label: "Fleet", origin: "https://fleet.example", hostname: "fleet.example", port: 443), appVersion: "1.0.0"))
    XCTAssertEqual(Set(value.keys), ["v", "colorMode", "systemScheme", "fontScale", "console", "app", "chrome", "insets", "consoles"])
    XCTAssertEqual(value["v"] as? Int, 1)
    XCTAssertEqual(Set((value["console"] as? [String: Any])?.keys ?? [:].keys), ["label", "monogram", "tone", "address"])
    let consoles = try XCTUnwrap(value["consoles"] as? [String: Any])
    XCTAssertEqual(Set(consoles.keys), ["roster", "seamless"])
    for key in ["roster", "seamless"] {
      let flag = try XCTUnwrap(consoles[key] as? NSNumber)
      XCTAssertEqual(CFGetTypeID(flag), CFBooleanGetTypeID())
      XCTAssertTrue(flag.boolValue)
    }
  }

  func testQuotesTheConsoleLabelInsteadOfSplicingItIntoCode() throws {
    let label = "\"); alert(1); (\"</script>"
    let script = AppearanceBridge.script(.standard, systemDark: true, console: ConsolePresentation.of(label: label, origin: "https://fleet.example:7443", hostname: "fleet.example", port: 7443), appVersion: "0.3.3", insets: AppearanceInsets(top: 47, right: 0, bottom: 34.5, left: 8))
    XCTAssertFalse(script.contains(label))
    let value = try parsed(script)
    XCTAssertEqual((value["console"] as? [String: Any])?["label"] as? String, label)
    XCTAssertEqual((value["console"] as? [String: Any])?["address"] as? String, "fleet.example:7443")
    XCTAssertEqual(value["systemScheme"] as? String, "dark")
    XCTAssertEqual((value["app"] as? [String: Any])?["version"] as? String, "0.3.3")
    let chrome = try XCTUnwrap(value["chrome"] as? [String: Any])
    XCTAssertEqual((chrome["scrim"] as? NSNumber)?.boolValue, true)
    XCTAssertEqual(CFGetTypeID(try XCTUnwrap(chrome["scrim"] as? NSNumber)), CFBooleanGetTypeID())
    XCTAssertEqual((chrome["edge"] as? NSNumber)?.boolValue, true)
    XCTAssertEqual(CFGetTypeID(try XCTUnwrap(chrome["edge"] as? NSNumber)), CFBooleanGetTypeID())
    let insets = try XCTUnwrap(value["insets"] as? [String: Any])
    XCTAssertEqual((insets["top"] as? NSNumber)?.doubleValue, 47)
    XCTAssertEqual((insets["right"] as? NSNumber)?.doubleValue, 0)
    XCTAssertEqual((insets["bottom"] as? NSNumber)?.doubleValue, 34.5)
    XCTAssertEqual((insets["left"] as? NSNumber)?.doubleValue, 8)
    let clamped = try XCTUnwrap(parsed(AppearanceBridge.script(.standard, systemDark: false, console: nil, insets: AppearanceInsets(top: .nan, right: -1, bottom: .infinity, left: 0)))["insets"] as? [String: Any])
    XCTAssertEqual((clamped["top"] as? NSNumber)?.doubleValue, 0)
    XCTAssertEqual((clamped["right"] as? NSNumber)?.doubleValue, 0)
    XCTAssertEqual((clamped["bottom"] as? NSNumber)?.doubleValue, 0)
    XCTAssertEqual((clamped["left"] as? NSNumber)?.doubleValue, 0)
  }

  private func parsed(_ script: String) throws -> [String: Any] {
    let start = try XCTUnwrap(script.range(of: "JSON.parse("))
    let end = try XCTUnwrap(script.range(of: "); if (v.console)"))
    let literal = String(script[start.upperBound..<end.lowerBound])
    let json = try JSONDecoder().decode(String.self, from: Data(literal.utf8))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }
}
