import Foundation

// TargetStore.kt의 이식. 저장하는 것은 "어디로 갈지 + 어떤 인증서를 믿을지"뿐이고 크리덴셜은
// 절대 저장하지 않는다. deck은 원격 origin을 키로 하며, 동기 커밋으로 화면/로컬오리진/영속
// 메타데이터가 어긋나지 않게 한다.
//
// iOS 분기: Android는 타깃마다 랜덤 127.x.y.z를 쓰지만 iOS 기기는 127.0.0.1 외 루프백을
// 바인딩할 수 없으므로(EADDRNOTAVAIL) 루프백 host는 항상 127.0.0.1이고 격리는 랜덤 포트가
// 담당한다. 그래서 isValid의 "127.0.0.1 금지"를 "127.0.0.1 강제"로 뒤집는다. Android의
// target-v2 → v3 마이그레이션은 iOS에 이력이 없으므로 구현하지 않는다(v3만).

// SharedPreferences 대신 쓰는 키-값 저장소 추상화. 테스트는 인메모리, 프로덕션은 UserDefaults.
public protocol KeyValueStore: AnyObject {
  func string(forKey key: String) -> String?
  func set(_ value: String?, forKey key: String)
}

public final class InMemoryKeyValueStore: KeyValueStore {
  private var storage: [String: String] = [:]
  public init() {}
  public func string(forKey key: String) -> String? { storage[key] }
  public func set(_ value: String?, forKey key: String) {
    if let value { storage[key] = value } else { storage.removeValue(forKey: key) }
  }
}

public final class UserDefaultsKeyValueStore: KeyValueStore {
  private let defaults: UserDefaults
  // Android의 SharedPreferences("fleet-mobile-target")에 대응하는 앱 프라이빗 스코프.
  public init(suiteName: String = "fleet-mobile-target") {
    defaults = UserDefaults(suiteName: suiteName) ?? .standard
  }
  public func string(forKey key: String) -> String? { defaults.string(forKey: key) }
  public func set(_ value: String?, forKey key: String) {
    if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
  }
}

/// 저장된 대상 하나와 그 대상의 불투명 id. id는 설치마다 무작위 UUID이고 origin·host·port·지문에서
/// 유도하지 않는다 — 페이지가 아는 것은 이 id뿐이다(TRANSPORT_BLOCKERS.md).
public struct ConsoleRecord: Equatable {
  public let id: String
  public let target: PersistedTarget
}

public final class TargetStore {
  private let store: KeyValueStore
  private let newId: () -> String
  public init(store: KeyValueStore, newId: @escaping () -> String = { UUID().uuidString }) {
    self.store = store
    self.newId = newId
  }

  private static let key = "targets-v3"

  public func active() -> PersistedTarget? {
    let current = state()
    return current.records.first { $0.target.origin == current.active }?.target
  }

  public func list() -> [PersistedTarget] { state().records.map(\.target) }

  /// 저장 순서 그대로. 콘솔 시트와 페이지의 콘솔 머리글이 같은 순서를 쓴다.
  public func records() -> [ConsoleRecord] { state().records }

  public func find(_ origin: String) -> PersistedTarget? { state().records.first { $0.target.origin == origin }?.target }

  public func find(id: String) -> ConsoleRecord? { state().records.first { $0.id == id } }

  /// 동기 커밋으로 화면/로컬오리진/영속 메타데이터가 어긋나지 않게 한다. 이미 있는 대상은 제자리에서
  /// 바뀌고 id를 지킨다 — 전환할 때마다 순서가 움직이면 페이지의 콘솔 목록이 누를 때마다 재배열된다.
  @discardableResult
  public func upsert(_ target: PersistedTarget) -> Bool {
    guard Self.isValid(target) else { return false }
    let current = state()
    var records = current.records
    if let index = records.firstIndex(where: { $0.target.origin == target.origin }) {
      records[index] = ConsoleRecord(id: records[index].id, target: target)
    } else {
      records.append(ConsoleRecord(id: freshId(excluding: Set(records.map(\.id))), target: target))
    }
    return write(State(active: target.origin, records: records))
  }

  @discardableResult
  public func remove(_ origin: String) -> Bool {
    let current = state()
    let remaining = current.records.filter { $0.target.origin != origin }
    if remaining.count == current.records.count { return false }
    return write(State(active: current.active == origin ? nil : current.active, records: remaining))
  }

  public func identityFor(_ candidate: AccessTarget, live: PersistedTarget?, hasLiveGateway: Bool, fresh: () -> LoopbackIdentity) -> LoopbackIdentity {
    let stored = find(candidate.origin)
    let occupied = hasLiveGateway && live != nil && stored != nil && live!.loopback == stored!.loopback
    return Self.selectIdentity(candidate, stored, occupied, fresh)
  }

  /// 재개된 타깃은 라이브 게이트웨이가 이미 그 identity를 잡고 있지 않는 한 저장된 identity를 재사용한다.
  public func resumeIdentity(_ stored: PersistedTarget, live: PersistedTarget?, hasLiveGateway: Bool, fresh: () -> LoopbackIdentity) -> LoopbackIdentity {
    if hasLiveGateway, let live, live.loopback == stored.loopback { return fresh() }
    return stored.loopback
  }

  public static func selectIdentity(_ candidate: AccessTarget, _ active: PersistedTarget?, _ hasLiveActive: Bool, _ fresh: () -> LoopbackIdentity) -> LoopbackIdentity {
    let sameTarget = active != nil && active!.origin == candidate.origin && active!.fingerprint == candidate.fingerprint
    return (sameTarget && !hasLiveActive) ? active!.loopback : fresh()
  }

  // MARK: - State

  private struct State { let active: String?; let records: [ConsoleRecord] }

  private func state() -> State {
    guard let raw = store.string(forKey: Self.key) else { return State(active: nil, records: []) }
    guard let parsed = Self.readState(raw) else {
      store.set(nil, forKey: Self.key) // 손상 데이터는 삭제.
      return State(active: nil, records: [])
    }
    // id가 없는(이 필드 이전에 저장된) 대상과 형식이 어긋난 id는 새 무작위 id를 받고, 곧바로 저장해
    // 다음 읽기부터 같은 id가 나오게 한다.
    guard parsed.records.contains(where: { $0.id == nil }) else {
      return State(active: parsed.active, records: parsed.records.map { ConsoleRecord(id: $0.id!, target: $0.target) })
    }
    var taken = Set(parsed.records.compactMap(\.id))
    let records = parsed.records.map { entry -> ConsoleRecord in
      if let id = entry.id { return ConsoleRecord(id: id, target: entry.target) }
      let id = freshId(excluding: taken)
      taken.insert(id)
      return ConsoleRecord(id: id, target: entry.target)
    }
    let migrated = State(active: parsed.active, records: records)
    write(migrated)
    return migrated
  }

  private func freshId(excluding taken: Set<String>) -> String {
    while true {
      let id = newId()
      if Self.isValidId(id) && !taken.contains(id) { return id }
    }
  }

  /// 페이지 계약의 id 형식: 1~64자 [A-Za-z0-9-].
  static func isValidId(_ id: String) -> Bool {
    !id.isEmpty && id.utf8.count <= 64 && id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D }
  }

  private struct ParsedEntry { let id: String?; let target: PersistedTarget }
  private struct ParsedState { let active: String?; let records: [ParsedEntry] }

  private static func readState(_ raw: String) -> ParsedState? {
    guard
      let data = raw.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let array = object["targets"] as? [[String: Any]]
    else { return nil }
    var entries: [ParsedEntry] = []
    var ids = Set<String>()
    for item in array {
      guard let target = readTarget(item), isValid(target), !entries.contains(where: { $0.target.origin == target.origin }) else { continue }
      let stored = (item["id"] as? String).flatMap { isValidId($0) && !ids.contains($0) ? $0 : nil }
      if let stored { ids.insert(stored) }
      entries.append(ParsedEntry(id: stored, target: target))
    }
    let activeName = object["active"] as? String
    let active = (activeName != nil && entries.contains { $0.target.origin == activeName }) ? activeName : nil
    return ParsedState(active: active, records: entries)
  }

  private static func readTarget(_ value: [String: Any]) -> PersistedTarget? {
    guard
      let origin = value["origin"] as? String,
      let hostname = value["hostname"] as? String,
      let port = intOf(value["port"]),
      let label = value["label"] as? String,
      let fingerprint = value["fingerprint"] as? String,
      let localHost = value["localHost"] as? String,
      let localPort = intOf(value["localPort"])
    else { return nil }
    return PersistedTarget(
      origin: origin, hostname: hostname, port: port, label: label, fingerprint: fingerprint,
      loopback: LoopbackIdentity(host: localHost, port: localPort))
  }

  @discardableResult
  private func write(_ state: State) -> Bool {
    let targets: [[String: Any]] = state.records.map { record in
      let t = record.target
      return [
        "id": record.id,
        "origin": t.origin, "hostname": t.hostname, "port": t.port, "label": t.label,
        "fingerprint": t.fingerprint, "localHost": t.loopback.host, "localPort": t.loopback.port,
      ]
    }
    var object: [String: Any] = ["targets": targets]
    if let active = state.active { object["active"] = active }
    guard
      let data = try? JSONSerialization.data(withJSONObject: object),
      let json = String(data: data, encoding: .utf8)
    else { return false }
    store.set(json, forKey: Self.key)
    return true
  }

  static func isValid(_ target: PersistedTarget) -> Bool {
    guard let uri = LocationUri.parse(target.origin) else { return false }
    let port = uri.port == -1 ? 443 : uri.port
    let pathOk = uri.rawPath.isEmpty || uri.rawPath == "/"
    let hostOk = uri.host?.caseInsensitiveCompare(target.hostname) == .orderedSame
    return uri.scheme == "https" && uri.rawUserInfo == nil && uri.rawQuery == nil && uri.rawFragment == nil
      && pathOk && hostOk && port == target.port && (1...65535).contains(target.port)
      && matchesFull("^[0-9A-F]{64}$", target.fingerprint)
      && !target.label.trimmingCharacters(in: .whitespaces).isEmpty && target.label.utf16.count <= 48
      // iOS 강제: 루프백 host는 127.0.0.1(다른 루프백은 기기에서 바인딩 불가).
      && target.loopback.host == "127.0.0.1" && (1...65535).contains(target.loopback.port)
  }

  private static func intOf(_ value: Any?) -> Int? {
    if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.intValue }
    return nil
  }

  private static func matchesFull(_ pattern: String, _ input: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
    let range = NSRange(input.startIndex..<input.endIndex, in: input)
    guard let m = regex.firstMatch(in: input, options: [], range: range) else { return false }
    return m.range == range
  }
}
