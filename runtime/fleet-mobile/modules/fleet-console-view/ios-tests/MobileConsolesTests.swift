import Foundation
import XCTest
@testable import FleetConsoleCore

// 모바일 심리스(브리지 v1.6)의 보안·상태 경계: 페이지로 가는 상태에는 허용 필드만, 크기 상한 안에서만,
// 도착 위치는 그 전환의 대상 문서에만 실리고, 명부 조회는 jar를 바꾸지 않으며, 실패한 전환은 활성 콘솔을
// 오류 화면으로 덮지 않는다.
final class MobileConsolesTests: XCTestCase {
  private let home = "https://home.example:7443"
  private let other = "https://other.example:7444"
  private let third = "https://third.example:7445"

  private func target(_ origin: String, _ host: String, _ port: Int, label: String) -> PersistedTarget {
    PersistedTarget(
      origin: origin, hostname: host, port: port, label: label,
      fingerprint: String(repeating: "A", count: 64),
      loopback: LoopbackIdentity(host: "127.0.0.1", port: 40000 + port % 1000))
  }

  private func deck() -> TargetStore {
    let store = TargetStore(store: InMemoryKeyValueStore())
    store.upsert(target(home, "home.example", 7443, label: "Home"))
    store.upsert(target(other, "other.example", 7444, label: "Other"))
    store.upsert(target(third, "third.example", 7445, label: "Third"))
    return store
  }

  private func summary(_ commodores: [[String: Any]], extra: [String: Any] = [:]) -> RosterSummary? {
    var object: [String: Any] = ["v": 1, "commodores": commodores, "more": 0]
    object.merge(extra) { $1 }
    return RosterSummary.parse(object)
  }

  private func commodore(_ id: String, preview: String? = nil, commanders: Int = 0) -> [String: Any] {
    var o: [String: Any] = ["id": id, "name": "Commodore \(id)", "look": ["base": 3, "tone": "teal"], "run": "working"]
    if let preview { o["preview"] = preview }
    if commanders > 0 {
      o["commanders"] = (0..<commanders).map { ["id": "\(id)-op\($0)", "title": String(repeating: "t", count: 100), "done": 1, "total": 2, "run": "quiet"] }
    }
    return o
  }

  private func json(_ state: MobileConsolesState) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: state.encoded()) as? [String: Any])
  }

  // MARK: roster projection

  func testRosterIsValidatedLikeTheDesktopContractAndOnlyAllowedFieldsReachThePage() throws {
    var raw = commodore("c1", preview: "last line", commanders: 1)
    raw["secret"] = "origin https://other.example:7444"
    var commander = (raw["commanders"] as! [[String: Any]])[0]
    commander["cookie"] = "fleet_console_pairing_7444=x"
    raw["commanders"] = [commander]
    let parsed = try XCTUnwrap(summary([raw], extra: ["address": "other.example:7444", "sections": [["id": "s", "name": "Work", "extra": 1]]]))
    let out = String(data: try JSONSerialization.data(withJSONObject: parsed.json), encoding: .utf8) ?? ""
    for leaked in ["secret", "cookie", "address", "extra", "other.example"] { XCTAssertFalse(out.contains(leaked), leaked) }
    XCTAssertTrue(out.contains("last line"))
    XCTAssertEqual(parsed.commodores.first?.commanders?.first?.id, "c1-op0")

    let rejected: [[String: Any]] = [
      ["v": 2, "commodores": [], "more": 0],
      ["v": 1, "commodores": [commodore("c")]],                                                 // more 없음
      ["v": 1, "commodores": [["id": "c", "name": "n", "run": "working"]], "more": 0],         // look 키 없음
      ["v": 1, "commodores": [["id": "c\n", "name": "n", "look": NSNull(), "run": "working"]], "more": 0],
      ["v": 1, "commodores": [["id": "c", "name": "n", "look": NSNull(), "run": "busy"]], "more": 0],
      ["v": 1, "commodores": [commodore("c", preview: String(repeating: "p", count: 161))], "more": 0],
      ["v": 1, "commodores": [commodore("c", commanders: 9)], "more": 0],
      ["v": 1, "commodores": (0..<41).map { commodore("c\($0)") }, "more": 0],
      ["v": 1, "commodores": [], "more": -1],
      ["v": 1, "commodores": [], "more": 0, "unsectionedCollapsed": false],
      ["v": true, "commodores": [], "more": 0],
    ]
    for value in rejected { XCTAssertNil(RosterSummary.parse(value), "\(value)") }
    var inverted = commodore("c", commanders: 1)
    var bad = (inverted["commanders"] as! [[String: Any]])[0]
    bad["done"] = 3
    inverted["commanders"] = [bad]
    XCTAssertNil(summary([inverted]))
  }

  // MARK: state serialization and frame cap

  func testStateCarriesOnlyOpaqueIdsAndLabelsAndStaysUnderTheFrameCap() throws {
    let store = deck()
    let hub = MobileConsolesHub()
    let records = store.records()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    // 큰 명부 둘: 미리보기와 진행 목표를 가득 채워 64 KiB를 넘긴다.
    let big = try XCTUnwrap(summary((0..<40).map { commodore("c\($0)", preview: String(repeating: "가", count: 160), commanders: 8) }))
    _ = hub.claimDue(records: records, activeOrigin: home, now: now)
    hub.record(records[1].id, .ok(big), now: now)
    hub.record(records[2].id, .ok(big), now: now)

    let state = hub.state(records: records, activeOrigin: home, arrivalFor: records[0].id, now: now)
    XCTAssertGreaterThan(state.encoded().count, MobileConsolesState.maxFrame)
    let fitted = state.fitted()
    XCTAssertLessThanOrEqual(fitted.encoded().count, MobileConsolesState.maxFrame)
    let script = MobileConsolesBridge.script(state, gatewayOrigin: "https://127.0.0.1:41000")
    XCTAssertLessThan(script.utf8.count, MobileConsolesState.maxFrame * 2)
    // 뒤 콘솔부터 줄인다: 앞 콘솔(Other)은 뒤 콘솔(Third)보다 많이 남는다.
    let otherKept = fitted.consoles[1].roster?.commodores.compactMap(\.preview).count ?? 0
    let thirdKept = fitted.consoles[2].roster?.commodores.compactMap(\.preview).count ?? 0
    XCTAssertGreaterThanOrEqual(otherKept, thirdKept)
    XCTAssertEqual(fitted.consoles[2].roster?.commodores.last?.preview, nil)

    let value = try json(fitted)
    let consoles = try XCTUnwrap(value["consoles"] as? [[String: Any]])
    XCTAssertEqual(consoles.map { $0["label"] as? String }, ["Home", "Other", "Third"])
    XCTAssertEqual(consoles.map { $0["id"] as? String }, records.map(\.id))
    XCTAssertEqual(consoles[0]["active"] as? Bool, true)
    XCTAssertTrue(consoles[0]["status"] is NSNull)
    XCTAssertTrue(consoles[0]["roster"] is NSNull)
    XCTAssertEqual(consoles[1]["status"] as? String, "ok")
    XCTAssertEqual(Set(consoles[1].keys), ["id", "label", "monogram", "tone", "active", "status", "at", "roster"])
    let text = String(data: fitted.encoded(), encoding: .utf8) ?? ""
    for leaked in ["home.example", "other.example", "7444", "AAAAAAAA", "127.0.0.1"] { XCTAssertFalse(text.contains(leaked), leaked) }
    XCTAssertFalse(script.contains("other.example"))
    XCTAssertTrue(script.contains("location.origin !== \"https://127.0.0.1:41000\""))
  }

  func testUnreadInactiveConsolesAreAllNullAndFailuresKeepTheLastGoodList() throws {
    let store = deck()
    let records = store.records()
    let hub = MobileConsolesHub()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var value = try json(hub.state(records: records, activeOrigin: home, arrivalFor: nil, now: now))
    var consoles = try XCTUnwrap(value["consoles"] as? [[String: Any]])
    XCTAssertTrue(consoles[1]["status"] is NSNull && consoles[1]["at"] is NSNull && consoles[1]["roster"] is NSNull)

    let roster = try XCTUnwrap(summary([commodore("c1")]))
    XCTAssertTrue(hub.record(records[1].id, .ok(roster), now: now))
    XCTAssertFalse(hub.record(records[1].id, .ok(roster), now: now))
    XCTAssertTrue(hub.record(records[1].id, .unavailable, now: now.addingTimeInterval(20)))
    XCTAssertTrue(hub.recordConnectFailure(records[2].id, code: "remote_host_not_paired"))
    // 그 뒤의 명부 읽기 실패나 401은 페어링 끊김 표시를 덮지 않는다.
    hub.record(records[2].id, .unsupported, now: now)
    value = try json(hub.state(records: records, activeOrigin: home, arrivalFor: nil, now: now))
    consoles = try XCTUnwrap(value["consoles"] as? [[String: Any]])
    XCTAssertEqual(consoles[1]["status"] as? String, "unavailable")
    XCTAssertEqual(((consoles[1]["roster"] as? [String: Any])?["commodores"] as? [Any])?.count, 1)
    XCTAssertEqual((consoles[1]["at"] as? NSNumber)?.int64Value, 1_800_000_000_000)
    XCTAssertEqual(consoles[2]["status"] as? String, "unpaired")
    XCTAssertTrue(consoles[2]["roster"] is NSNull)
  }

  func testReadsAreSpacedPerTargetAndSkipTheActiveConsole() {
    let records = deck().records()
    let hub = MobileConsolesHub()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    XCTAssertEqual(hub.claimDue(records: records, activeOrigin: home, now: now).map(\.target.origin), [other, third])
    XCTAssertTrue(hub.claimDue(records: records, activeOrigin: home, now: now.addingTimeInterval(30)).isEmpty, "in flight")
    hub.record(records[1].id, .unavailable, now: now.addingTimeInterval(1))
    XCTAssertTrue(hub.claimDue(records: records, activeOrigin: home, now: now.addingTimeInterval(5)).isEmpty)
    XCTAssertEqual(hub.claimDue(records: records, activeOrigin: home, now: now.addingTimeInterval(10)).map(\.target.origin), [other])
  }

  // MARK: arrival

  func testArrivalGoesOnlyToTheSwitchTargetsDocumentUntilClearedOrExpired() throws {
    let records = deck().records()
    let hub = MobileConsolesHub()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    hub.setArrival(targetId: records[1].id, MobileConsoleArrival(commodore: "c1", commander: "op1", scrollTop: 240), now: now)

    let arriving = try json(hub.state(records: records, activeOrigin: other, arrivalFor: records[1].id, now: now))
    let arrival = try XCTUnwrap(arriving["arrival"] as? [String: Any])
    XCTAssertEqual(arrival["commodore"] as? String, "c1")
    XCTAssertEqual(arrival["commander"] as? String, "op1")
    XCTAssertEqual((arrival["scrollTop"] as? NSNumber)?.doubleValue, 240)
    // 지금 보이는(떠나는) 콘솔의 문서와 다른 콘솔의 문서에는 실리지 않는다.
    XCTAssertTrue(try json(hub.state(records: records, activeOrigin: home, arrivalFor: records[0].id, now: now))["arrival"] is NSNull)
    XCTAssertTrue(try json(hub.state(records: records, activeOrigin: third, arrivalFor: records[2].id, now: now))["arrival"] is NSNull)
    // commit(또는 arrived) 뒤에는 같은 문서에도 다시 가지 않는다.
    XCTAssertTrue(hub.clearArrival())
    XCTAssertTrue(try json(hub.state(records: records, activeOrigin: other, arrivalFor: records[1].id, now: now))["arrival"] is NSNull)
    XCTAssertFalse(hub.clearArrival())

    hub.setArrival(targetId: records[1].id, MobileConsoleArrival(commodore: "c1", commander: nil, scrollTop: nil), now: now)
    XCTAssertFalse(hub.expireArrival(now: now.addingTimeInterval(29)))
    XCTAssertTrue(hub.expireArrival(now: now.addingTimeInterval(30)))
    XCTAssertTrue(try json(hub.state(records: records, activeOrigin: other, arrivalFor: records[1].id, now: now))["arrival"] is NSNull)
  }

  // MARK: switch decision and failure

  func testSwitchTargetsOnlyKnownInactiveConsolesAndUnpairedOpensTheSheet() {
    let records = deck().records()
    let hub = MobileConsolesHub()
    XCTAssertEqual(hub.decide(consoleId: records[1].id, records: records, activeOrigin: home, attemptInFlight: false), .connect(records[1]))
    XCTAssertEqual(hub.decide(consoleId: records[0].id, records: records, activeOrigin: home, attemptInFlight: false), .ignore)
    XCTAssertEqual(hub.decide(consoleId: "unknown", records: records, activeOrigin: home, attemptInFlight: false), .ignore)
    hub.recordConnectFailure(records[2].id, code: "remote_host_not_paired")
    XCTAssertEqual(hub.decide(consoleId: records[2].id, records: records, activeOrigin: home, attemptInFlight: false), .openSheet(records[2]))
  }

  func testASwitchDuringAnInFlightAttemptIsIgnoredAndSetsNoArrival() {
    let records = deck().records()
    let hub = MobileConsolesHub()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    // 알려진 비활성 콘솔이어도, 페어링이 끊긴 콘솔이어도 진행 중인 시도가 있으면 아무 결정도 내리지 않는다.
    XCTAssertEqual(hub.decide(consoleId: records[1].id, records: records, activeOrigin: home, attemptInFlight: true), .ignore)
    hub.recordConnectFailure(records[2].id, code: "remote_host_not_paired")
    XCTAssertEqual(hub.decide(consoleId: records[2].id, records: records, activeOrigin: home, attemptInFlight: true), .ignore)
    // 셸은 .connect일 때만 도착 위치를 세우므로, 무시된 switch 뒤에는 어느 문서에도 도착 위치가 없다.
    XCTAssertNil(hub.arrivalTargetId)
    XCTAssertNil(hub.state(records: records, activeOrigin: other, arrivalFor: records[1].id, now: now).arrival)
    // 시도가 끝나면 같은 switch가 다시 받아들여진다.
    XCTAssertEqual(hub.decide(consoleId: records[1].id, records: records, activeOrigin: home, attemptInFlight: false), .connect(records[1]))
  }

  func testAFailedSwitchOverAVisibleConsoleIsNotAnErrorScreenAndMarksTheTarget() throws {
    let records = deck().records()
    let hub = MobileConsolesHub()
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    hub.setArrival(targetId: records[1].id, MobileConsoleArrival(commodore: "c1", commander: nil, scrollTop: 10), now: now)

    let failed = hub.attemptFailed(targetId: records[1].id, code: "remote_link_unreachable", seamless: true, activeVisible: true)
    XCTAssertEqual(failed.report, .switchFailed)
    XCTAssertTrue(failed.changed)
    XCTAssertNil(hub.arrivalTargetId)
    XCTAssertEqual(hub.status(records[1].id), .unavailable)

    // 네이티브 자체 실패로 페어링이 끊긴 대상을 안다(개정 r2) — 그 뒤의 switch는 시트로 간다.
    XCTAssertEqual(hub.attemptFailed(targetId: records[2].id, code: "remote_host_not_paired", seamless: true, activeVisible: true).report, .switchFailed)
    XCTAssertEqual(hub.status(records[2].id), .unpaired)
    XCTAssertEqual(hub.decide(consoleId: records[2].id, records: records, activeOrigin: home, attemptInFlight: false), .openSheet(records[2]))
    // 연결에 성공하면 다시 페어링된 것이다.
    hub.recordConnected(records[2].id)
    XCTAssertEqual(hub.decide(consoleId: records[2].id, records: records, activeOrigin: home, attemptInFlight: false), .connect(records[2]))

    // 보이는 콘솔이 없거나 RN이 시작한 시도의 실패는 현행 오류 경로 그대로다.
    XCTAssertEqual(hub.attemptFailed(targetId: records[1].id, code: "remote_link_unreachable", seamless: true, activeVisible: false).report, .error)
    XCTAssertEqual(hub.attemptFailed(targetId: records[1].id, code: "remote_link_unreachable", seamless: false, activeVisible: true).report, .error)
  }

  // MARK: roster read path

  func testRosterReadSendsOnlyThePairingCookieAndNeverWritesTheJar() throws {
    let kv = InMemoryKeyValueStore()
    let jar = FleetCookieJar(store: kv)
    try jar.applyRemote(other, 7444, [
      "fleet_console_session_7444=sess; HttpOnly; SameSite=Strict; Path=/; Secure",
      "fleet_console_pairing_7444=pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    let before = kv.string(forKey: "fleet-mobile-cookies")
    let connection = RemoteConnection(cookies: jar)
    let body = #"{"v":1,"commodores":[{"id":"c1","name":"One","look":null,"run":"quiet","extra":1}],"more":0}"#
    let cases: [(String, RosterOutcome)] = [
      ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: fleet_console_session_7444=new; HttpOnly; SameSite=Strict; Path=/; Secure\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)",
       .ok(try XCTUnwrap(RosterSummary.parse(try JSONSerialization.jsonObject(with: Data(body.utf8)))))),
      // 401/403은 구버전과 페어링 끊김을 가를 수 없어 unsupported다(개정 r5).
      ("HTTP/1.1 401 Unauthorized\r\nSet-Cookie: fleet_console_pairing_7444=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/; Secure\r\nContent-Length: 0\r\n\r\n", .unsupported),
      ("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", .unsupported),
      ("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n", .unsupported),
      ("HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\nSet-Cookie: fleet_console_session_7444=moved; HttpOnly; SameSite=Strict; Path=/; Secure\r\nContent-Length: 0\r\n\r\n", .unavailable),
      ("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n", .unavailable),
      ("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", .unsupported),
    ]
    let t = target(other, "other.example", 7444, label: "Other")
    for (response, expected) in cases {
      let socket = DuplexFixture(response)
      XCTAssertEqual(try connection.rosterExchange(t, socket), expected, response)
      let request = socket.written
      XCTAssertTrue(request.hasPrefix("GET /api/v1/console-roster HTTP/1.1\r\n"))
      XCTAssertTrue(request.contains("\r\nHost: other.example:7444\r\n"))
      XCTAssertTrue(request.contains("\r\nCookie: fleet_console_pairing_7444=pair\r\n"))
      XCTAssertFalse(request.contains("fleet_console_session_7444"))
      XCTAssertTrue(request.contains("\r\nConnection: close\r\n"))
      XCTAssertEqual(kv.string(forKey: "fleet-mobile-cookies"), before, "the roster path must not touch the jar")
    }
    // 페어링 쿠키가 없으면 Cookie 헤더 자체가 없다.
    let empty = RemoteConnection(cookies: FleetCookieJar(store: InMemoryKeyValueStore()))
    let socket = DuplexFixture("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
    XCTAssertEqual(try empty.rosterExchange(t, socket), .unsupported)
    XCTAssertFalse(socket.written.contains("Cookie:"))
  }
}

private final class DuplexFixture: ByteInput, ByteOutput {
  private let input: ByteArrayInput
  private let output = ByteArrayOutput()
  init(_ response: String) { input = ByteArrayInput(response) }
  var written: String { output.utf8String }
  func read(_ maxLength: Int) throws -> [UInt8] { try input.read(maxLength) }
  func setReadTimeout(milliseconds: Int?) {}
  func write(_ bytes: [UInt8]) throws { try output.write(bytes) }
  func flush() throws {}
}
