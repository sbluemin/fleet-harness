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
