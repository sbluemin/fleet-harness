import XCTest
@testable import FleetConsoleCore

// AccessLinkTest.kt의 이식. 포지티브/네거티브 벡터는 콘솔의 공유 프로토콜 벡터
// (runtime/fleet-console/access-protocol/vectors.json)를 그대로 소비한다 — 포크 금지.
final class AccessLinkTests: XCTestCase {
  private lazy var vectors: [String: Any] = {
    let url = Self.protocolVectorsURL()
    guard
      let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      XCTFail("could not load \(url.path)")
      return [:]
    }
    return object
  }()

  func testParsesEveryConsoleProtocolVectorWithoutDrift() throws {
    let positives = try XCTUnwrap(vectors["positive"] as? [[String: Any]])
    XCTAssertFalse(positives.isEmpty)
    for vector in positives {
      let name = vector["name"] as? String ?? "?"
      let expected = try XCTUnwrap(vector["parsed"] as? [String: Any], name)
      let link = try XCTUnwrap(vector["link"] as? String, name)
      let parsed = try AccessLink.parse(link)

      XCTAssertEqual(parsed.origin, expected["origin"] as? String, name)
      XCTAssertEqual(parsed.hostname, expected["hostname"] as? String, name)
      XCTAssertEqual(parsed.port, expected["port"] as? Int, name)
      XCTAssertEqual(parsed.label, expected["label"] as? String, name)
      XCTAssertEqual(parsed.consoleUrl, expected["consoleUrl"] as? String, name)
      XCTAssertEqual(parsed.joinUrl, expected["joinUrl"] as? String, name)
      XCTAssertEqual(parsed.token, expected["token"] as? String, name)
      XCTAssertEqual(parsed.fingerprint, expected["fingerprint"] as? String, name)
    }
  }

  func testRejectsEveryConsoleProtocolNegativeVectorWithoutDrift() throws {
    let negatives = try XCTUnwrap(vectors["negative"] as? [[String: Any]])
    XCTAssertFalse(negatives.isEmpty)
    for vector in negatives {
      let name = vector["name"] as? String ?? "?"
      let link = try XCTUnwrap(vector["link"] as? String, name)
      XCTAssertThrowsError(try AccessLink.parse(link), name) { error in
        XCTAssertEqual((error as? AccessLinkError)?.message, "pairing_target_invalid", name)
      }
    }
  }

  func testDurableTargetNeverCarriesTheCredential() throws {
    let positives = try XCTUnwrap(vectors["positive"] as? [[String: Any]])
    let firstLink = try XCTUnwrap(positives.first?["link"] as? String)
    let parsed = try AccessLink.parse(firstLink)
    let durable = parsed.withoutCredential(LoopbackIdentity(host: "127.77.23.91", port: 43871))

    XCTAssertFalse(String(describing: durable).contains(parsed.token))
    XCTAssertEqual(durable.fingerprint, parsed.fingerprint)
  }

  func testRejectsInputAboveTheNativeInboxLimit() {
    let prefix = "fleet://join?code="
    let oversized = prefix + String(repeating: "A", count: FleetLinkInbox.maxInputLength - prefix.count + 1)
    XCTAssertThrowsError(try AccessLink.parse(oversized)) { error in
      XCTAssertEqual((error as? AccessLinkError)?.message, "pairing_target_invalid")
    }
  }

  // AccessLinkTest.kt의 walk-up 탐색을 이식한다. swift test의 작업 디렉터리에 기대지 않고
  // 이 테스트 파일 위치(#filePath)를 기준으로 조상들을 훑어 공유 벡터를 찾는다.
  static func protocolVectorsURL() -> URL {
    let relative = "runtime/fleet-console/access-protocol/vectors.json"
    var current = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let fm = FileManager.default
    for _ in 0..<20 {
      let direct = current.appendingPathComponent(relative)
      if fm.fileExists(atPath: direct.path) { return direct }
      let sibling = current.appendingPathComponent("../fleet-console/access-protocol/vectors.json").standardizedFileURL
      if fm.fileExists(atPath: sibling.path) { return sibling }
      current.deleteLastPathComponent()
    }
    return URL(fileURLWithPath: relative)
  }
}
