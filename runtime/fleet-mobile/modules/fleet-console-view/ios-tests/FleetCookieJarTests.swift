import Foundation
import XCTest
@testable import FleetConsoleCore

// FleetCookieJar(네이티브 원격 쿠키 저장소)의 저장/스코프/롤백/삭제 동작 검증.
final class FleetCookieJarTests: XCTestCase {
  private let origin = "https://fleet.example:7443"

  private func makeJar() -> (FleetCookieJar, KeyValueStore) {
    let kv = InMemoryKeyValueStore()
    return (FleetCookieJar(store: kv), kv)
  }

  func testApplyRemoteThenReadBackScopedHeader() throws {
    let (jar, _) = makeJar()
    try jar.applyRemote(origin, 7443, [
      "fleet_console_session_7443=sess; HttpOnly; SameSite=Strict; Path=/; Secure",
      "fleet_console_pairing_7443=pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    let header = try XCTUnwrap(jar.readRemote(origin, 7443))
    XCTAssertTrue(header.contains("fleet_console_session_7443=sess"))
    XCTAssertTrue(header.contains("fleet_console_pairing_7443=pair"))
    // 다른 포트로는 아무것도 안 나간다.
    XCTAssertNil(try jar.readRemote(origin, 7444))
  }

  func testPolicyViolationThrowsAndStoresNothing() {
    let (jar, kv) = makeJar()
    XCTAssertThrowsError(try jar.applyRemote(origin, 7443, [
      "fleet_console_session_7443=poison; Domain=.example.test; HttpOnly; SameSite=Strict; Path=/; Secure",
    ]))
    XCTAssertNil(kv.string(forKey: "fleet-mobile-cookies"))
  }

  func testSnapshotRestoreRollsBackCandidateCookies() throws {
    let (jar, _) = makeJar()
    try jar.applyRemote(origin, 7443, [
      "fleet_console_session_7443=old-session; HttpOnly; SameSite=Strict; Path=/; Secure",
      "fleet_console_pairing_7443=old-pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    let snapshot = try jar.snapshot(origin, 7443)

    // 후보 시도가 쿠키를 덮어썼다가 실패했다.
    try jar.applyRemote(origin, 7443, [
      "fleet_console_session_7443=new-session; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    try jar.restore(origin, 7443, snapshot)

    let header = try XCTUnwrap(jar.readRemote(origin, 7443))
    XCTAssertTrue(header.contains("fleet_console_session_7443=old-session"))
    XCTAssertTrue(header.contains("fleet_console_pairing_7443=old-pair"))
  }

  func testMaxAgeZeroDeletesAndClearRemovesOrigin() throws {
    let (jar, kv) = makeJar()
    try jar.applyRemote(origin, 7443, [
      "fleet_console_pairing_7443=pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    try jar.applyRemote(origin, 7443, [
      "fleet_console_pairing_7443=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    XCTAssertNil(try jar.readRemote(origin, 7443))

    try jar.applyRemote(origin, 7443, [
      "fleet_console_session_7443=s; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    jar.clear(origin)
    XCTAssertNil(try jar.readRemote(origin, 7443))
    XCTAssertNil(kv.string(forKey: "fleet-mobile-cookies"))
  }

  func testPersistsAcrossJarInstances() throws {
    let kv = InMemoryKeyValueStore()
    try FleetCookieJar(store: kv).applyRemote(origin, 7443, [
      "fleet_console_pairing_7443=pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
    ])
    // 새 인스턴스(=프로세스 재시작 동형)에서도 페어링 쿠키가 살아 있다.
    let header = try XCTUnwrap(try FleetCookieJar(store: kv).readRemote(origin, 7443))
    XCTAssertTrue(header.contains("fleet_console_pairing_7443=pair"))
  }
}
