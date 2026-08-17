import Foundation

// RemoteConnection.kt FleetCookieStore의 iOS 대체. Android는 WebView CookieManager를 원격
// 쿠키의 유일한 저장소로 쓰지만, iOS 설계에서는 원격 오리진 쿠키(세션·페어링 크리덴셜)를
// WKWebView에 절대 넣지 않는다 — WebView는 로컬 게이트웨이 오리진만 보므로 원격 쿠키는
// 네이티브 프록시만 쓴다. 그래서 모듈 소유의 영속 쿠키 저장소를 둔다.
//
// 영속성 근거: Android CookieManager는 페어링 쿠키를 재시작 너머로 보존한다(README 독트린
// "pairing survives restarts on both ends"). 보호 수준도 Android SharedPreferences/CookieManager와
// 동등한 앱 프라이빗 저장소(UserDefaults)로 맞춘다. 스키마: {origin: {name: value}}.
//
// 모든 쓰기는 FleetCookiePolicy를 통과한 뒤에만 반영된다(fail-closed) — Android의
// applyAndAwait가 콜백 실패 시 연결을 실패시키는 것과 동형으로, 정책 위반은 던진다.
public final class FleetCookieJar {
  private let store: KeyValueStore
  private let key = "fleet-mobile-cookies"
  private let lock = NSLock()

  public init(store: KeyValueStore) {
    self.store = store
  }

  /// 프록시가 원격에 붙일 Cookie 헤더 — 정확한 콘솔 포트의 fleet 쿠키만.
  public func readRemote(_ origin: String, _ port: Int) throws -> String? {
    try FleetCookiePolicy.requestHeader(rawHeader(origin), port)
  }

  public func snapshot(_ origin: String, _ port: Int) throws -> FleetCookieSnapshot {
    try FleetCookiePolicy.snapshot(rawHeader(origin), port)
  }

  /// 실패한 후보 시도의 쿠키를 스냅샷으로 되돌린다(후보 전용 이름은 만료).
  public func restore(_ origin: String, _ port: Int, _ snapshot: FleetCookieSnapshot) throws {
    let headers = try FleetCookiePolicy.restoreHeaders(snapshot, rawHeader(origin), port)
    apply(origin, headers)
  }

  /// 원격 응답의 Set-Cookie를 정책 검증 후 반영한다. 위반은 던진다(fail-closed).
  public func applyRemote(_ origin: String, _ port: Int, _ setCookies: [String]) throws {
    let normalized = try FleetCookiePolicy.validateSetCookieHeaders(setCookies, port)
    apply(origin, normalized)
  }

  /// 콘솔을 잊을 때 그 오리진의 쿠키를 전부 비운다.
  public func clear(_ origin: String) {
    lock.lock(); defer { lock.unlock() }
    var all = readAll()
    all.removeValue(forKey: origin)
    writeAll(all)
  }

  // MARK: - Internals

  // "name=value; name2=value2" — FleetCookiePolicy.parse가 소비하는 형태.
  private func rawHeader(_ origin: String) -> String? {
    lock.lock(); defer { lock.unlock() }
    guard let cookies = readAll()[origin], !cookies.isEmpty else { return nil }
    return cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; ")
  }

  // 정규화된 Set-Cookie 헤더들("name=value[; Max-Age=N]; Secure; ...")을 반영한다.
  // Max-Age=0은 삭제, 그 외는 저장(세션/페어링 모두 영속 — Android CookieManager와 동형).
  private func apply(_ origin: String, _ normalizedHeaders: [String]) {
    lock.lock(); defer { lock.unlock() }
    var all = readAll()
    var cookies = all[origin] ?? [:]
    for header in normalizedHeaders {
      let parts = header.split(separator: ";", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      guard let first = parts.first else { continue }
      let pair = first.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
      guard pair.count == 2 else { continue }
      let maxAge = parts.dropFirst()
        .first { $0.lowercased().hasPrefix("max-age=") }?
        .split(separator: "=", maxSplits: 1).last.map(String.init)
      if maxAge == "0" {
        cookies.removeValue(forKey: pair[0])
      } else {
        cookies[pair[0]] = pair[1]
      }
    }
    if cookies.isEmpty { all.removeValue(forKey: origin) } else { all[origin] = cookies }
    writeAll(all)
  }

  private func readAll() -> [String: [String: String]] {
    guard
      let raw = store.string(forKey: key),
      let data = raw.data(using: .utf8),
      let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: [String: String]]
    else { return [:] }
    return parsed
  }

  private func writeAll(_ all: [String: [String: String]]) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: all),
      let json = String(data: data, encoding: .utf8)
    else { return }
    store.set(all.isEmpty ? nil : json, forKey: key)
  }
}
