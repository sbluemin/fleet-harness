import Foundation

// 모바일 심리스 콘솔(브리지 v1.6, shared/m2-contract.md 2·3·5절과 개정 r1~r3). 페이지가 다른 페어링
// 콘솔에 대해 아는 것은 여기서 만드는 상태뿐이다: 셸이 만든 불투명 id, 표시 이름, 모노그램·톤, 거친
// 상태 단어, 그 콘솔의 최소 명부. origin·host·port·지문·쿠키는 이 타입들에 들어오지 않는다.

// MARK: - Roster summary (protocol/desktop/console-section.ts ConsoleRosterSummary와 동등)

public enum RosterRun: String, Equatable { case working, waiting, quiet }

public struct RosterLook: Equatable {
  public let base: Int
  public let tone: String?
}

public struct RosterCommander: Equatable {
  public let id: String
  public let title: String
  public let done: Int
  public let total: Int
  public let run: RosterRun
  public let look: RosterLook?
}

public struct RosterSection: Equatable {
  public let id: String
  public let name: String
  public let collapsed: Bool
}

public struct RosterCommodore: Equatable {
  public let id: String
  public let name: String
  public let look: RosterLook?
  public let run: RosterRun
  public let section: String?
  public var preview: String?
  public var commanders: [RosterCommander]?
  public var moreCommanders: Int?
}

public struct RosterSummary: Equatable {
  public var commodores: [RosterCommodore]
  public var more: Int
  public let sections: [RosterSection]?
  public let unsectionedCollapsed: Bool

  public static let maxCommodores = 40
  public static let maxCommanders = 8
  public static let maxSections = 100
  public static let previewMax = 160

  /// isConsoleRosterSummary의 Swift 판. 통과하면 허용된 필드만 투영한 값을 돌려준다 — 원격이 보낸
  /// 추가 속성은 페이지에 가지 않는다. 하나라도 어긋나면 nil(그 콘솔은 명부를 지원하지 않는 것으로 본다).
  public static func parse(_ value: Any?) -> RosterSummary? {
    guard let object = value as? [String: Any], let v = jsonNumber(object["v"]), v == 1 else { return nil }
    guard let list = object["commodores"] as? [Any], list.count <= maxCommodores else { return nil }
    var commodores: [RosterCommodore] = []
    for item in list {
      guard let commodore = parseCommodore(item) else { return nil }
      commodores.append(commodore)
    }
    guard let more = safeInteger(object["more"]), more >= 0 else { return nil }
    var sections: [RosterSection]?
    if object.keys.contains("sections") {
      guard let raw = object["sections"] as? [Any], raw.count <= maxSections else { return nil }
      var parsed: [RosterSection] = []
      for item in raw {
        guard let section = parseSection(item) else { return nil }
        parsed.append(section)
      }
      sections = parsed
    }
    var unsectionedCollapsed = false
    if object.keys.contains("unsectionedCollapsed") {
      guard isTrue(object["unsectionedCollapsed"]) else { return nil }
      unsectionedCollapsed = true
    }
    return RosterSummary(commodores: commodores, more: more, sections: sections, unsectionedCollapsed: unsectionedCollapsed)
  }

  private static func parseCommodore(_ value: Any) -> RosterCommodore? {
    guard let o = value as? [String: Any],
          let id = cleanText(o["id"], 128), let name = cleanText(o["name"], 120),
          let run = (o["run"] as? String).flatMap(RosterRun.init(rawValue:)) else { return nil }
    // look은 키가 있어야 한다(null 또는 유효한 외형).
    guard o.keys.contains("look") else { return nil }
    var look: RosterLook?
    if !(o["look"] is NSNull) {
      guard let parsed = parseLook(o["look"]) else { return nil }
      look = parsed
    }
    var preview: String?
    if o.keys.contains("preview") {
      guard let p = cleanText(o["preview"], previewMax) else { return nil }
      preview = p
    }
    var commanders: [RosterCommander]?
    if o.keys.contains("commanders") {
      guard let raw = o["commanders"] as? [Any], raw.count <= maxCommanders else { return nil }
      var parsed: [RosterCommander] = []
      for item in raw {
        guard let commander = parseCommander(item) else { return nil }
        parsed.append(commander)
      }
      commanders = parsed
    }
    var moreCommanders: Int?
    if o.keys.contains("moreCommanders") {
      guard let n = count(o["moreCommanders"]) else { return nil }
      moreCommanders = n
    }
    var section: String?
    if o.keys.contains("section") {
      guard let s = cleanText(o["section"], 128) else { return nil }
      section = s
    }
    return RosterCommodore(id: id, name: name, look: look, run: run, section: section, preview: preview, commanders: commanders, moreCommanders: moreCommanders)
  }

  private static func parseCommander(_ value: Any) -> RosterCommander? {
    guard let o = value as? [String: Any],
          let id = cleanText(o["id"], 128), let title = cleanText(o["title"], 120),
          let done = count(o["done"]), let total = count(o["total"]), done <= total,
          let run = (o["run"] as? String).flatMap(RosterRun.init(rawValue:)) else { return nil }
    var look: RosterLook?
    if o.keys.contains("look") && !(o["look"] is NSNull) {
      guard let parsed = parseLook(o["look"]) else { return nil }
      look = parsed
    }
    return RosterCommander(id: id, title: title, done: done, total: total, run: run, look: look)
  }

  private static func parseSection(_ value: Any) -> RosterSection? {
    guard let o = value as? [String: Any], let id = cleanText(o["id"], 128), let name = cleanText(o["name"], 80) else { return nil }
    if o.keys.contains("collapsed") {
      guard isTrue(o["collapsed"]) else { return nil }
      return RosterSection(id: id, name: name, collapsed: true)
    }
    return RosterSection(id: id, name: name, collapsed: false)
  }

  private static func parseLook(_ value: Any?) -> RosterLook? {
    guard let o = value as? [String: Any], let base = safeInteger(o["base"]), base >= 0, base < 10_000 else { return nil }
    if o["tone"] is NSNull { return RosterLook(base: base, tone: nil) }
    guard let tone = cleanText(o["tone"], 64) else { return nil }
    return RosterLook(base: base, tone: tone)
  }

  /// 페이지로 가는 JSON. 허용 필드만, 없는 선택 필드는 키째 뺀다.
  public var json: [String: Any] {
    var out: [String: Any] = ["v": 1, "commodores": commodores.map(\.json), "more": more]
    if let sections {
      out["sections"] = sections.map { s -> [String: Any] in
        var o: [String: Any] = ["id": s.id, "name": s.name]
        if s.collapsed { o["collapsed"] = true }
        return o
      }
    }
    if unsectionedCollapsed { out["unsectionedCollapsed"] = true }
    return out
  }
}

extension RosterLook {
  var json: [String: Any] { ["base": base, "tone": tone.map { $0 as Any } ?? NSNull()] }
}

extension RosterCommodore {
  var json: [String: Any] {
    var o: [String: Any] = ["id": id, "name": name, "look": look?.json ?? NSNull(), "run": run.rawValue]
    if let section { o["section"] = section }
    if let preview { o["preview"] = preview }
    if let commanders {
      o["commanders"] = commanders.map { c -> [String: Any] in
        var item: [String: Any] = ["id": c.id, "title": c.title, "done": c.done, "total": c.total, "run": c.run.rawValue]
        if let look = c.look { item["look"] = look.json }
        return item
      }
    }
    if let moreCommanders { o["moreCommanders"] = moreCommanders }
    return o
  }
}

// MARK: - JSON helpers (JS 검증기의 의미를 따른다)

/// cleanText(): 문자열, 1..max UTF-16 단위, C0·DEL 없음.
func cleanText(_ value: Any?, _ max: Int) -> String? {
  guard let text = value as? String, !text.isEmpty, text.utf16.count <= max else { return nil }
  if text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) { return nil }
  return text
}

private func isBoolean(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

private func isTrue(_ value: Any?) -> Bool {
  guard let n = value as? NSNumber, isBoolean(n) else { return false }
  return n.boolValue
}

/// 불리언이 아닌 유한한 JSON 수.
func jsonNumber(_ value: Any?) -> Double? {
  guard let n = value as? NSNumber, !isBoolean(n) else { return nil }
  let d = n.doubleValue
  return d.isFinite ? d : nil
}

/// Number.isSafeInteger.
private func safeInteger(_ value: Any?) -> Int? {
  guard let d = jsonNumber(value), d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { return nil }
  return Int(d)
}

private func count(_ value: Any?) -> Int? {
  guard let n = safeInteger(value), n >= 0, n <= 100_000 else { return nil }
  return n
}

// MARK: - State (셸 → 페이지)

public enum MobileConsoleStatus: String, Equatable { case ok, unsupported, unavailable, unpaired }

public struct MobileConsoleArrival: Equatable {
  public let commodore: String
  public let commander: String?
  public let scrollTop: Double?
  public init(commodore: String, commander: String?, scrollTop: Double?) {
    self.commodore = commodore; self.commander = commander; self.scrollTop = scrollTop
  }
}

public struct MobileConsoleEntry: Equatable {
  public let id: String
  public let label: String
  public let monogram: String
  public let tone: String
  public let active: Bool
  public let status: MobileConsoleStatus?
  public let at: Int64?
  public var roster: RosterSummary?
}

public struct MobileConsolesState: Equatable {
  public var consoles: [MobileConsoleEntry]
  public let arrival: MobileConsoleArrival?

  public static let maxConsoles = 16
  public static let maxFrame = 65_536

  public var json: [String: Any] {
    var arrivalJson: Any = NSNull()
    if let arrival {
      var a: [String: Any] = ["commodore": arrival.commodore]
      if let commander = arrival.commander { a["commander"] = commander }
      if let scrollTop = arrival.scrollTop { a["scrollTop"] = scrollTop }
      arrivalJson = a
    }
    return [
      "v": 1,
      "consoles": consoles.map { entry -> [String: Any] in
        [
          "id": entry.id, "label": entry.label, "monogram": entry.monogram, "tone": entry.tone,
          "active": entry.active,
          "status": entry.status.map { $0.rawValue as Any } ?? NSNull(),
          "at": entry.at.map { NSNumber(value: $0) as Any } ?? NSNull(),
          "roster": entry.roster.map { $0.json as Any } ?? NSNull(),
        ]
      },
      "arrival": arrivalJson,
    ]
  }

  public func encoded() -> Data {
    (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data("{}".utf8)
  }

  /// 65,536바이트(JSON UTF-8)에 들 때까지 데스크톱(console-section-controller fitRosters)과 같은 순서로
  /// 줄인다: 뒤 콘솔·뒤 사령관부터 미리보기 → 진행 목표 → 사령관. 그래도 넘치면 뒤 콘솔의 명부를 통째로 뺀다.
  /// 줄이는 단계열은 고정이고 단계마다 크기가 줄므로, 몇 단계가 필요한지는 이분 탐색으로 찾는다.
  public func fitted() -> MobileConsolesState {
    if encoded().count <= Self.maxFrame { return self }
    let steps = trimSteps()
    var low = 0, high = steps.count
    while low < high {
      let mid = (low + high) / 2
      if applying(steps.prefix(mid)).encoded().count <= Self.maxFrame { high = mid } else { low = mid + 1 }
    }
    return applying(steps.prefix(low))
  }

  private enum TrimStep { case preview(Int, Int), commander(Int, Int), commodore(Int), roster(Int) }

  private func trimSteps() -> [TrimStep] {
    var steps: [TrimStep] = []
    let indices = Array(consoles.indices.reversed())
    for c in indices {
      guard let roster = consoles[c].roster else { continue }
      for m in roster.commodores.indices.reversed() where roster.commodores[m].preview != nil { steps.append(.preview(c, m)) }
    }
    for c in indices {
      guard let roster = consoles[c].roster else { continue }
      for m in roster.commodores.indices.reversed() {
        for _ in 0..<(roster.commodores[m].commanders?.count ?? 0) { steps.append(.commander(c, m)) }
      }
    }
    for c in indices {
      guard let roster = consoles[c].roster else { continue }
      for _ in roster.commodores.indices { steps.append(.commodore(c)) }
    }
    for c in indices where consoles[c].roster != nil { steps.append(.roster(c)) }
    return steps
  }

  private func applying<S: Sequence>(_ steps: S) -> MobileConsolesState where S.Element == TrimStep {
    var next = self
    for step in steps {
      switch step {
      case .preview(let c, let m):
        next.consoles[c].roster?.commodores[m].preview = nil
      case .commander(let c, let m):
        guard var commodore = next.consoles[c].roster?.commodores[m], var list = commodore.commanders, !list.isEmpty else { continue }
        list.removeLast()
        commodore.commanders = list
        commodore.moreCommanders = (commodore.moreCommanders ?? 0) + 1
        next.consoles[c].roster?.commodores[m] = commodore
      case .commodore(let c):
        guard next.consoles[c].roster?.commodores.isEmpty == false else { continue }
        next.consoles[c].roster?.commodores.removeLast()
        next.consoles[c].roster?.more += 1
      case .roster(let c):
        next.consoles[c].roster = nil
      }
    }
    return next
  }
}

// MARK: - Page script

public enum MobileConsolesBridge {
  public static let global = "__fleetMobileConsoles"
  public static let event = "fleet-mobile-consoles"

  /// 문서 시작과 실시간 갱신이 같은 스크립트를 쓴다. 지정된 게이트웨이 오리진의 문서에서만 전역을 정의하고
  /// 이벤트를 보낸다. 값은 JSON 인코더를 거친 뒤 한 번 더 JavaScript 문자열로 인용된다.
  public static func script(_ state: MobileConsolesState, gatewayOrigin: String) -> String {
    let json = String(data: state.fitted().encoded(), encoding: .utf8) ?? "{}"
    let literal = quote(json)
    let origin = quote(gatewayOrigin)
    return "(() => { if (window.top !== window || location.origin !== \(origin)) return; const v = JSON.parse(\(literal)); "
      + "const freeze = (o) => { if (o && typeof o === \"object\") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; }; freeze(v); "
      + "Object.defineProperty(window, \"\(global)\", { value: v, configurable: true, enumerable: false, writable: false }); "
      + "window.dispatchEvent(new CustomEvent(\"\(event)\", { detail: v })); })();"
  }

  private static func quote(_ value: String) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
  }
}

// MARK: - Roster read classification (3절, r2)

public enum RosterOutcome: Equatable {
  case ok(RosterSummary)
  case unsupported
  case unavailable

  /// 404 = 명부 라우트가 없는 구 콘솔. 401/403도 unsupported다(개정 r5): 페어링만 실은 GET을 받지 않는 콘솔
  /// 버전도 401을 주므로 401만으로는 페어링 끊김과 구버전을 가를 수 없다. unpaired는 네이티브 자신의 연결 시도가
  /// remote_host_not_paired로 실패한 대상에만 붙는다. 2xx인데 명부 형식이 아니면 데스크톱처럼 unsupported.
  /// 그 밖(3xx는 호출자가 실패로 넘긴다)은 unavailable.
  public static func classify(code: Int, body: Data) -> RosterOutcome {
    switch code {
    case 200...299:
      guard let value = try? JSONSerialization.jsonObject(with: body), let summary = RosterSummary.parse(value) else { return .unsupported }
      return .ok(summary)
    case 401, 403, 404: return .unsupported
    default: return .unavailable
    }
  }
}

// MARK: - Hub: 명부 기억, 도착 위치, 전환 판정

/// FleetConsoleView가 메인 스레드에서만 부른다(조회 완료 콜백도 메인으로 돌아온 뒤에 record한다).
public final class MobileConsolesHub {
  public static let minInterval: TimeInterval = 10
  public static let arrivalTtl: TimeInterval = 30

  private struct Memory {
    var status: MobileConsoleStatus?
    var at: Int64?
    var roster: RosterSummary?
    var attemptedAt: Date?
  }

  private struct PendingArrival {
    let targetId: String
    let arrival: MobileConsoleArrival
    let expires: Date
  }

  private var memory: [String: Memory] = [:]
  private var inFlight = Set<String>()
  private var pending: PendingArrival?

  public init() {}

  // MARK: state

  /// 한 문서에 줄 상태. arrival은 `arrivalFor`가 그 문서의 대상 id일 때만 실린다(그 외 문서엔 null).
  public func state(records: [ConsoleRecord], activeOrigin: String?, arrivalFor documentTargetId: String?, now: Date) -> MobileConsolesState {
    let chosen = Self.visible(records, activeOrigin: activeOrigin)
    let consoles = chosen.map { record -> MobileConsoleEntry in
      let t = record.target
      let presentation = ConsolePresentation.of(label: t.label, origin: t.origin, hostname: t.hostname, port: t.port)
      let active = t.origin == activeOrigin
      let m = active ? nil : memory[record.id]
      return MobileConsoleEntry(
        id: record.id,
        label: presentation?.label ?? t.label,
        monogram: presentation?.monogram ?? "",
        tone: presentation?.tone ?? "crimson",
        active: active,
        status: m?.status,
        at: m?.at,
        roster: m?.roster)
    }
    var arrival: MobileConsoleArrival?
    if let documentTargetId, let pending, pending.targetId == documentTargetId, pending.expires > now { arrival = pending.arrival }
    return MobileConsolesState(consoles: consoles, arrival: arrival)
  }

  /// 저장 순서를 지키며 최대 16개. 활성 콘솔은 그 뒤에 있어도 반드시 들어간다.
  static func visible(_ records: [ConsoleRecord], activeOrigin: String?) -> [ConsoleRecord] {
    if records.count <= MobileConsolesState.maxConsoles { return records }
    var keep = Set(records.prefix(MobileConsolesState.maxConsoles).map(\.id))
    if let active = records.first(where: { $0.target.origin == activeOrigin }), !keep.contains(active.id) {
      if let last = records.prefix(MobileConsolesState.maxConsoles).last(where: { $0.target.origin != activeOrigin }) { keep.remove(last.id) }
      keep.insert(active.id)
    }
    return records.filter { keep.contains($0.id) }
  }

  // MARK: roster reads

  /// 지금 읽을 대상: 활성이 아니고, 진행 중이 아니며, 마지막 시도에서 10초가 지난 것. 호출 즉시 진행 중으로 표시된다.
  public func claimDue(records: [ConsoleRecord], activeOrigin: String?, now: Date) -> [ConsoleRecord] {
    let due = Self.visible(records, activeOrigin: activeOrigin).filter { record in
      guard record.target.origin != activeOrigin, !inFlight.contains(record.id) else { return false }
      guard let last = memory[record.id]?.attemptedAt else { return true }
      return now.timeIntervalSince(last) >= Self.minInterval
    }
    for record in due {
      inFlight.insert(record.id)
      memory[record.id, default: Memory()].attemptedAt = now
    }
    return due
  }

  /// 조회 결과를 기억에 반영한다. 페이지에 보일 값이 바뀌었으면 true.
  @discardableResult
  public func record(_ id: String, _ outcome: RosterOutcome, now: Date) -> Bool {
    inFlight.remove(id)
    var m = memory[id] ?? Memory()
    let before = (m.status, m.at, m.roster)
    switch outcome {
    case .ok(let summary):
      m.status = .ok; m.at = Int64(now.timeIntervalSince1970 * 1000); m.roster = summary
    case .unsupported:
      if m.status != .unpaired { m.status = .unsupported }
      m.at = nil; m.roster = nil
    case .unavailable:
      // 마지막 성공 목록을 남긴다. 페어링 끊김은 연결 실패가 정한 것이니 명부 읽기 실패로 덮지 않는다.
      if m.status != .unpaired { m.status = .unavailable }
    }
    m.attemptedAt = m.attemptedAt ?? now
    memory[id] = m
    return before.0 != m.status || before.1 != m.at || before.2 != m.roster
  }

  /// 네이티브 연결 시도가 실패한 대상의 상태(r2): 페어링 없음은 unpaired, 그 밖은 unavailable.
  @discardableResult
  public func recordConnectFailure(_ id: String, code: String) -> Bool {
    var m = memory[id] ?? Memory()
    let before = (m.status, m.roster)
    if code == "remote_host_not_paired" { m.status = .unpaired; m.roster = nil }
    else if m.status != .unpaired { m.status = .unavailable }
    memory[id] = m
    return before.0 != m.status || before.1 != m.roster
  }

  /// 연결에 성공한 대상은 다시 페어링된 것이다 — unpaired 표시를 지운다(다음 읽기가 새로 채운다).
  public func recordConnected(_ id: String) {
    guard var m = memory[id] else { return }
    if m.status == .unpaired { m.status = nil }
    m.attemptedAt = nil
    memory[id] = m
  }

  public func status(_ id: String) -> MobileConsoleStatus? { memory[id]?.status }

  public func forget(_ id: String) {
    memory.removeValue(forKey: id)
    inFlight.remove(id)
    if pending?.targetId == id { pending = nil }
  }

  // MARK: arrival

  public func setArrival(targetId: String, _ arrival: MobileConsoleArrival, now: Date) {
    pending = PendingArrival(targetId: targetId, arrival: arrival, expires: now.addingTimeInterval(Self.arrivalTtl))
  }

  /// 지울 것이 있었으면 true.
  @discardableResult
  public func clearArrival() -> Bool {
    defer { pending = nil }
    return pending != nil
  }

  public var arrivalTargetId: String? { pending?.targetId }

  /// TTL이 지난 도착 위치를 지운다. 지웠으면 true.
  @discardableResult
  public func expireArrival(now: Date) -> Bool {
    guard let pending, pending.expires <= now else { return false }
    self.pending = nil
    return true
  }

  // MARK: attempt failure

  public enum FailureReport: Equatable {
    /// 페이지가 시작한 전환이 보이는 콘솔 위에서 실패했다: 오류 화면 없이 switch-failed만, 활성 콘솔은 그대로.
    case switchFailed
    /// 그 밖의 실패: 현행 error 이벤트.
    case error
  }

  /// 연결 시도 실패의 판정(5절 4항, 개정 r2). 실패한 대상이 비활성 저장 대상이면 그 상태를 캐시에 남기고,
  /// 전환 시도였으면 도착 위치를 지운다. `changed`는 페이지에 보일 상태가 바뀌었는지다.
  public func attemptFailed(targetId: String?, code: String, seamless: Bool, activeVisible: Bool) -> (report: FailureReport, changed: Bool) {
    var changed = false
    if let targetId { changed = recordConnectFailure(targetId, code: code) }
    if seamless && clearArrival() { changed = true }
    return (seamless && activeVisible ? .switchFailed : .error, changed)
  }

  // MARK: switch

  public enum SwitchDecision: Equatable {
    /// 단계 로드 전환을 시작한다.
    case connect(ConsoleRecord)
    /// 페어링이 끊긴 대상: 전환하지 않고 RN 콘솔 시트를 연다(재페어링 경로).
    case openSheet(ConsoleRecord)
    case ignore
  }

  /// console은 알려진 비활성 id여야 한다. 활성 콘솔이나 모르는 id는 조용히 버린다.
  public func decide(consoleId: String, records: [ConsoleRecord], activeOrigin: String?) -> SwitchDecision {
    guard let record = records.first(where: { $0.id == consoleId }), record.target.origin != activeOrigin else { return .ignore }
    return memory[record.id]?.status == .unpaired ? .openSheet(record) : .connect(record)
  }
}
