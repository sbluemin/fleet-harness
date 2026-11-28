import Foundation
import XCTest
@testable import FleetConsoleCore

// TargetStoreTest.kt 이식(iOS 적응). Android는 루프백 host가 랜덤 127.x.y.z지만 iOS는
// 127.0.0.1 강제이므로 헬퍼의 loopback host를 127.0.0.1로 바꾼다. target-v2 마이그레이션은
// iOS에 이력이 없어 이식하지 않는다. selectIdentity/stableOrigin은 LoopbackGatewayTest에서 온다.
final class TargetStoreTests: XCTestCase {
  private func makeStore() -> (TargetStore, KeyValueStore) {
    let kv = InMemoryKeyValueStore()
    return (TargetStore(store: kv), kv)
  }

  private func target(_ origin: String, _ host: String, _ port: Int, label: String = "Console", fp: Character = "A") -> PersistedTarget {
    PersistedTarget(
      origin: origin, hostname: host, port: port, label: label,
      fingerprint: String(repeating: String(fp), count: 64),
      loopback: LoopbackIdentity(host: "127.0.0.1", port: 40000 + port % 1000))
  }

  func testUpsertKeysByOriginAndMakesTheTargetActive() {
    let kv = InMemoryKeyValueStore()
    var deck = TargetStore(store: kv)
    XCTAssertTrue(deck.upsert(target("https://one.example:1001", "one.example", 1001, label: "One")))
    XCTAssertTrue(deck.upsert(target("https://two.example:1002", "two.example", 1002, label: "Two")))
    XCTAssertEqual(deck.active()?.origin, "https://two.example:1002")
    XCTAssertEqual(deck.list().count, 2)

    XCTAssertTrue(deck.upsert(target("https://one.example:1001", "one.example", 1001, label: "One again", fp: "C")))
    XCTAssertEqual(deck.list().count, 2)
    XCTAssertEqual(deck.active()?.origin, "https://one.example:1001")
    XCTAssertEqual(deck.find("https://one.example:1001")?.fingerprint, String(repeating: "C", count: 64))
    _ = deck
  }

  func testEachTargetKeepsARandomOpaqueIdAndItsPlaceAcrossReconnects() throws {
    let kv = InMemoryKeyValueStore()
    var counter = 0
    let deck = TargetStore(store: kv) { counter += 1; return "id-\(counter)" }
    deck.upsert(target("https://one.example:1001", "one.example", 1001, label: "One"))
    deck.upsert(target("https://two.example:1002", "two.example", 1002, label: "Two"))
    // 다시 연결(commit)해도 순서와 id가 그대로다 — 전환마다 목록이 재배열되지 않는다.
    deck.upsert(target("https://one.example:1001", "one.example", 1001, label: "One again", fp: "C"))
    XCTAssertEqual(deck.records().map(\.id), ["id-1", "id-2"])
    XCTAssertEqual(deck.list().map(\.origin), ["https://one.example:1001", "https://two.example:1002"])
    XCTAssertEqual(deck.active()?.origin, "https://one.example:1001")
    XCTAssertEqual(deck.find(id: "id-2")?.target.origin, "https://two.example:1002")
    // id는 주소·지문에서 유도되지 않는다.
    let stored = try XCTUnwrap(kv.string(forKey: "targets-v3"))
    XCTAssertTrue(stored.contains("\"id\":\"id-1\""))
    // 지웠다가 다시 붙이면 새 id다.
    deck.remove("https://one.example:1001")
    deck.upsert(target("https://one.example:1001", "one.example", 1001, label: "One"))
    XCTAssertEqual(deck.records().map(\.id), ["id-2", "id-3"])
  }

  func testTargetsSavedBeforeIdsAreMigratedOnceToStableRandomIds() throws {
    let kv = InMemoryKeyValueStore()
    let legacy: [String: Any] = [
      "active": "https://one.example:1001",
      "targets": [
        ["origin": "https://one.example:1001", "hostname": "one.example", "port": 1001, "label": "One",
         "fingerprint": String(repeating: "A", count: 64), "localHost": "127.0.0.1", "localPort": 41001],
        ["id": "bad id!", "origin": "https://two.example:1002", "hostname": "two.example", "port": 1002, "label": "Two",
         "fingerprint": String(repeating: "B", count: 64), "localHost": "127.0.0.1", "localPort": 41002],
      ],
    ]
    kv.set(String(decoding: try JSONSerialization.data(withJSONObject: legacy), as: UTF8.self), forKey: "targets-v3")
    let first = TargetStore(store: kv).records()
    XCTAssertEqual(first.count, 2)
    XCTAssertTrue(first.allSatisfy { TargetStore.isValidId($0.id) && UUID(uuidString: $0.id) != nil })
    XCTAssertNotEqual(first[0].id, first[1].id)
    XCTAssertEqual(TargetStore(store: kv).records().map(\.id), first.map(\.id))
    XCTAssertEqual(TargetStore(store: kv).active()?.origin, "https://one.example:1001")
  }

  func testRemoveClearsActiveOnlyForTheRemovedOrigin() {
    let kv = InMemoryKeyValueStore()
    let deck = TargetStore(store: kv)
    deck.upsert(target("https://one.example:1001", "one.example", 1001))
    deck.upsert(target("https://two.example:1002", "two.example", 1002))

    XCTAssertTrue(deck.remove("https://two.example:1002"))
    XCTAssertNil(deck.active())
    XCTAssertEqual(deck.list().count, 1)
    XCTAssertFalse(deck.remove("https://two.example:1002"))

    deck.upsert(target("https://two.example:1002", "two.example", 1002))
    XCTAssertTrue(deck.remove("https://one.example:1001"))
    XCTAssertEqual(deck.active()?.origin, "https://two.example:1002")
  }

  func testStateSurvivesReconstructionAndInvalidEntriesAreDropped() throws {
    let kv = InMemoryKeyValueStore()
    TargetStore(store: kv).upsert(target("https://one.example:1001", "one.example", 1001))
    XCTAssertEqual(TargetStore(store: kv).active()?.origin, "https://one.example:1001")

    // fingerprint를 비-hex로 변조하면 재구성 시 유효성 검사에서 탈락해 deck이 빈다.
    let stored = try XCTUnwrap(kv.string(forKey: "targets-v3"))
    var obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [String: Any])
    var targets = try XCTUnwrap(obj["targets"] as? [[String: Any]])
    targets[0]["fingerprint"] = "not-hex"
    obj["targets"] = targets
    kv.set(String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self), forKey: "targets-v3")
    XCTAssertNil(TargetStore(store: kv).active())
    XCTAssertTrue(TargetStore(store: kv).list().isEmpty)

    // 파싱 불가한 쓰레기는 저장 키를 지운다.
    kv.set("garbage", forKey: "targets-v3")
    XCTAssertTrue(TargetStore(store: kv).list().isEmpty)
    XCTAssertNil(kv.string(forKey: "targets-v3"))
  }

  func testResumeIdentityReusesSavedIdentityUnlessTheLiveGatewayHoldsIt() {
    let kv = InMemoryKeyValueStore()
    let deck = TargetStore(store: kv)
    let stored = target("https://one.example:1001", "one.example", 1001)
    let other = target("https://two.example:1002", "two.example", 1002)
    let fresh = LoopbackIdentity(host: "127.0.0.1", port: 49999)

    XCTAssertEqual(deck.resumeIdentity(stored, live: nil, hasLiveGateway: false) { fresh }, stored.loopback)
    XCTAssertEqual(deck.resumeIdentity(stored, live: other, hasLiveGateway: true) { fresh }, stored.loopback)
    XCTAssertEqual(deck.resumeIdentity(stored, live: stored, hasLiveGateway: true) { fresh }, fresh)
  }

  // LoopbackGatewayTest.kt 이식.
  func testLiveSameTargetGetsFreshIdentityButColdRestartReusesPersistedIdentity() {
    let activeIdentity = LoopbackIdentity(host: "127.0.0.1", port: 43871)
    let active = PersistedTarget(
      origin: "https://fleet.example", hostname: "fleet.example", port: 443, label: "Fleet",
      fingerprint: String(repeating: "A", count: 64), loopback: activeIdentity)
    let candidate = AccessTarget(
      origin: "https://fleet.example", hostname: "fleet.example", port: 443, label: "Fleet",
      token: "token-token-token-1", fingerprint: String(repeating: "A", count: 64))
    let freshIdentity = LoopbackIdentity(host: "127.0.0.1", port: 43872)
    XCTAssertEqual(TargetStore.selectIdentity(candidate, active, false) { freshIdentity }, activeIdentity)
    XCTAssertEqual(TargetStore.selectIdentity(candidate, active, true) { freshIdentity }, freshIdentity)
  }

  func testStableLoopbackOriginsAreHostScopedAndHttps() {
    let restored = LoopbackIdentity(host: "127.0.0.1", port: 43871)
    let candidate = LoopbackIdentity(host: "127.0.0.1", port: 43872)
    XCTAssertEqual(restored.origin, "https://127.0.0.1:43871")
    XCTAssertNotEqual(restored, candidate)
  }
}
