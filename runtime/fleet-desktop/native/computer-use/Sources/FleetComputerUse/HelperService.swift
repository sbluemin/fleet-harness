import AppKit
import ApplicationServices

private enum ActionName: String {
  case click, doubleClick = "double_click", rightClick = "right_click", type, setValue = "set_value", key, scroll, drag, select, axAction = "ax_action"
}

private struct ActionRequest {
  let name: ActionName
  let ref: String?
  let point: CGPoint?
  let end: Object?
  let text: String?
  let stroke: KeyStroke?
  let direction: AICursorPulse.Direction?
  let pages: Double
  let axName: String?
  let requireEditableFocus: Bool

  init(_ p: Object) throws {
    guard let raw = p["action"] as? String, let action = ActionName(rawValue: raw) else { throw HelperError("invalid_params", "action") }
    let positioned: Set<ActionName> = [.click, .doubleClick, .rightClick, .scroll, .drag]
    var allowed: Set<String> = ["pid", "windowId", "processStartedAt", "expectedFrame", "action"]
    switch action {
    case .click, .doubleClick, .rightClick: allowed.formUnion(["ref", "x", "y"])
    case .scroll: allowed.formUnion(["ref", "x", "y", "direction", "pages"])
    case .drag: allowed.formUnion(["ref", "x", "y", "to"])
    case .type, .setValue, .select: allowed.formUnion(["ref", "text"])
    case .key: allowed.formUnion(["key", "ref", "requireEditableFocus", "text"])
    case .axAction: allowed.formUnion(["ref", "name"])
    }
    try validateKeys(p, allowed: allowed)
    let ref = try optionalRef(p["ref"])
    var point: CGPoint?
    if p["x"] != nil || p["y"] != nil {
      guard ref == nil, let x = jsonNumber(p["x"]), let y = jsonNumber(p["y"]) else { throw HelperError("invalid_params", "ref OR x and y") }
      point = CGPoint(x: x, y: y)
    }
    if positioned.contains(action) && ref == nil && point == nil { throw HelperError("invalid_params", "ref OR x and y required") }
    if [.setValue, .select, .axAction].contains(action) && ref == nil { throw HelperError("invalid_params", "ref required") }
    let text = try optionalString(p["text"], name: "text", max: 20_000)
    if [.type, .setValue, .select].contains(action) && text == nil { throw HelperError("invalid_params", "text required") }
    if [.type, .select].contains(action) && text?.isEmpty == true { throw HelperError("invalid_params", "text must not be empty") }
    let end = p["to"] as? Object
    if action == .drag && end == nil { throw HelperError("invalid_params", "to must be a ref or point object") }
    let axName = try optionalString(p["name"], name: "name", max: 80)
    if action == .axAction && axName?.isEmpty != false { throw HelperError("invalid_name") }
    var stroke: KeyStroke?
    if action == .key {
      guard let key = try optionalString(p["key"], name: "key", max: 60) else { throw HelperError("invalid_params", "key required") }
      stroke = try KeyStroke(key)
    }
    let requireEditableFocus = jsonBool(p["requireEditableFocus"]) ?? false
    if (p["requireEditableFocus"] != nil && jsonBool(p["requireEditableFocus"]) == nil) ||
       (action == .key && requireEditableFocus && stroke?.paste != true) {
      throw HelperError("invalid_params", "requireEditableFocus applies to cmd+v only")
    }
    // key의 text는 붙여넣기 검증용으로만 받는다(입력으로 보내지 않는다).
    if action == .key && text != nil && !requireEditableFocus { throw HelperError("invalid_params", "text applies to paste only") }
    var direction: AICursorPulse.Direction?
    if action == .scroll {
      switch p["direction"] as? String {
      case "up": direction = .up
      case "down": direction = .down
      case "left": direction = .left
      case "right": direction = .right
      default: throw HelperError("invalid_params", "direction must be up, down, left or right")
      }
    }
    var pages = 1.0
    if let raw = p["pages"] {
      guard let n = jsonNumber(raw), (0.1...10).contains(n) else { throw HelperError("invalid_params", "pages must be between 0.1 and 10") }
      pages = n
    }
    self.name = action; self.ref = ref; self.point = point; self.end = end; self.text = text; self.stroke = stroke
    self.direction = direction; self.pages = pages; self.axName = axName; self.requireEditableFocus = requireEditableFocus
  }
}

func validateKeys(_ p: Object, allowed: Set<String>) throws {
  if let key = p.keys.sorted().first(where: { !allowed.contains($0) }) { throw HelperError("invalid_params", "unexpected \(key)") }
}

func optionalString(_ raw: Any?, name: String, max: Int) throws -> String? {
  guard let raw else { return nil }
  guard let value = raw as? String, value.count <= max else { throw HelperError("invalid_params", name) }
  return value
}

private func refIsValid(_ ref: String) -> Bool {
  ref.first == "e" && !ref.dropFirst().isEmpty && ref.dropFirst().utf8.allSatisfy { (48...57).contains($0) }
}

func optionalRef(_ raw: Any?) throws -> String? {
  guard let ref = try optionalString(raw, name: "ref", max: 24) else { return nil }
  guard refIsValid(ref) else { throw HelperError("invalid_params", "ref") }
  return ref
}

func boundedInt(_ raw: Any?, name: String, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
  guard let raw else { return fallback }
  guard let n = jsonNumber(raw), n.rounded(.towardZero) == n, n >= Double(range.lowerBound), n <= Double(range.upperBound) else {
    throw HelperError("invalid_params", name)
  }
  return Int(n)
}

private func expectedFrame(_ p: Object) throws -> CGRect? {
  guard let raw = p["expectedFrame"] else { return nil }
  guard let f = raw as? Object, let x = jsonNumber(f["x"]), let y = jsonNumber(f["y"]), let w = jsonNumber(f["w"]),
        let h = jsonNumber(f["h"]), w > 0, h > 0 else { throw HelperError("invalid_params", "expectedFrame") }
  return CGRect(x: x, y: y, width: w, height: h)
}

// JSONSerialization과 호스트가 epoch 초를 Double로 왕복할 때의 반올림만 허용한다.
private func matchesStart(_ actual: Date?, _ requested: Double) -> Bool {
  actual.map { abs($0.timeIntervalSince1970 - requested) < 0.000_001 } ?? false
}

private func windowAddress(_ p: Object) throws -> (pid_t, CGWindowID, Double?) {
  guard p["pid"] != nil, p["windowId"] != nil else { throw HelperError("invalid_params", "pid and windowId required") }
  let pid = try boundedInt(p["pid"], name: "pid", default: 0, range: 1...Int(Int32.max))
  let id = try boundedInt(p["windowId"], name: "windowId", default: 0, range: 1...Int(UInt32.max))
  let started = jsonNumber(p["processStartedAt"])
  if p["processStartedAt"] != nil && started == nil { throw HelperError("invalid_params", "processStartedAt") }
  return (pid_t(pid), CGWindowID(id), started)
}

private enum Verification {
  case contains(AXUIElement, String)
  case value(AXUIElement, Any)
  case selection(AXUIElement, String, CFRange)
  /// 붙여넣기: 같은 문자열이 붙여넣기 전보다 늘었을 때만 참이다. 이미 있던 문자열만으로는 삽입을 구별할 수 없다.
  case pasted(AXUIElement, String, Int)
  /// Command+A: 비어 있지 않은 현재 값 전체(UTF-16 길이)가 선택돼 있을 때만 참이다.
  case selectsAll(AXUIElement)

  /// 값이나 선택 범위를 읽을 수 없으면 변화 없음으로 단정하지 않는다.
  func unreadable(in win: WindowInfo, root: AXUIElement?) -> Bool {
    guard case .selectsAll(let el) = self else { return false }
    return !AXReader.belongs(el, win, root: root) || AXReader.attribute(el, kAXValueAttribute) as? String == nil || AXReader.selectedRange(el) == nil
  }

  func check(in win: WindowInfo, root: AXUIElement?) -> String? {
    switch self {
    case .contains(let el, let text):
      guard AXReader.belongs(el, win, root: root), (AXReader.attribute(el, kAXValueAttribute) as? String)?.contains(text) == true else { return nil }
      return "value_contains_text"
    case .value(let el, let expected):
      guard AXReader.belongs(el, win, root: root), jsonEqual(axJSONValue(AXReader.attribute(el, kAXValueAttribute)), expected) else { return nil }
      return "value_equals"
    case .selection(let el, let expected, let wantedRange):
      guard AXReader.belongs(el, win, root: root), let raw = AXReader.attribute(el, kAXSelectedTextRangeAttribute),
            CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
      var range = CFRange()
      guard AXValueGetValue(raw as! AXValue, .cfRange, &range), range.location == wantedRange.location, range.length == wantedRange.length,
            (AXReader.attribute(el, kAXSelectedTextAttribute) as? String) == expected else { return nil }
      return "selection_matches"
    case .pasted(let el, let text, let prior):
      guard AXReader.belongs(el, win, root: root), let value = AXReader.attribute(el, kAXValueAttribute) as? String,
            occurrences(of: text, in: value) > prior else { return nil }
      return "value_contains_text"
    case .selectsAll(let el):
      guard AXReader.belongs(el, win, root: root), let value = AXReader.attribute(el, kAXValueAttribute) as? String,
            let range = AXReader.selectedRange(el) else { return nil }
      let length = (value as NSString).length
      guard length > 0, range.location == 0, range.length == length else { return nil }
      return "selection_covers_all"
    }
  }
}

private func occurrences(of text: String, in value: String) -> Int {
  guard !text.isEmpty else { return 0 }
  let haystack = value as NSString
  var count = 0, from = 0
  while from < haystack.length {
    let found = haystack.range(of: text, options: [], range: NSRange(location: from, length: haystack.length - from))
    guard found.location != NSNotFound else { break }
    count += 1; from = found.location + found.length
  }
  return count
}

/// Chromium·Electron은 창이 AppKit 안에서 key가 아니면 Command 단축키를 버린다(RenderWidgetHostViewCocoa
/// performKeyEquivalent와 CommandDispatcher redispatchKeyEvent의 key 검사). AppKit 네이티브 입력칸도 key 창이 없으면
/// Edit 메뉴 키 등가가 처리되지 않고, key가 아닌 창의 첫 클릭은 창을 key로 만드는 데만 쓰여 대상이 first responder가 되지
/// 않는다(451f7d30 m3: ⌘V가 이전 first responder인 다른 칸에 들어감). 대상 입력칸에 대상 전용 클릭(화면 밖 프라이머 포함)을
/// 한 번 보내면 앱 활성화·실제 포인터 이동 없이 창이 key가 되고 대상이 first responder가 된다. 클릭이 옮긴 선택 범위는
/// 단축키 전에 AX로 되돌리고 확인한다.
private struct KeyWindowPrimer {
  let element: AXUIElement
  let range: AXValue
  let click: EventSequence
}

/// type 앞에서 대상 창이 key여야 하는지 정한다. Electron은 대상 창이 앱의 AXFocusedWindow가 아니면(한 번도 key가 아니었던 창)
/// AXFocused가 확인돼도 입력 문자를 버린다(e7e293ee m3: 재시도만 넣으면 'sent; changes:'). AppKit은 그런 창(닫았다 다시 연 창)에서
/// 입력칸 포커스 확인부터 실패한다(dbdbe742 실측). 다른 엔진은 실측하지 않아 그대로 둔다.
enum TypeKeyWindow: Equatable {
  /// 그대로 입력한다.
  case ready
  /// 비활성 앱의 key가 아닌 창: 대상 클릭 없는 창 프라이머(`EventFactory.windowPrimer`)로 창을 key로 만들고, 확인한 뒤 입력한다.
  case prime
  /// 사람이 쓰는 활성 앱의 key가 아닌 창: 프라이머가 그 앱의 key 창(사람의 키 입력 도착지)을 바꾸므로 보내기 전에 거절한다.
  case refuse

  static func decide(engine: Engine, reportsFocusedWindow: Bool, appActive: Bool) -> Self {
    guard [.electron, .appkit].contains(engine), !reportsFocusedWindow else { return .ready }
    return appActive ? .refuse : .prime
  }
}

private struct Expectation {
  let raw: Object
  let ref: String?
  let role: String?
  let label: String?
  let exists: Bool

  init(_ raw: Object) throws {
    try validateKeys(raw, allowed: ["ref", "role", "label", "exists", "value", "valueContains", "enabled", "selected", "focused"])
    let ref = try optionalRef(raw["ref"])
    let role = try optionalString(raw["role"], name: "role", max: 40)
    let label = try optionalString(raw["label"], name: "label", max: 200)
    guard ref != nil || role?.isEmpty == false || label?.isEmpty == false else { throw HelperError("invalid_params", "verify needs ref or role/label") }
    for key in ["exists", "enabled", "selected", "focused"] where raw[key] != nil && jsonBool(raw[key]) == nil {
      throw HelperError("invalid_params", key)
    }
    _ = try optionalString(raw["value"], name: "value", max: 2_000)
    _ = try optionalString(raw["valueContains"], name: "valueContains", max: 2_000)
    self.raw = raw; self.ref = ref; self.role = role; self.label = label; self.exists = jsonBool(raw["exists"]) ?? true
  }

  // actual.reason은 관측할 수 없는 상태이고 actual.field는 관측된 불일치다.
  func mismatch(tree: AXTree, resolve: (String) throws -> AXNode) -> Object? {
    let node: AXNode
    if tree.root == nil { return ["reason": "incomplete"] }
    if let ref {
      guard let found = try? resolve(ref) else { return ["reason": "stale_element"] }
      node = found
    } else {
      let matches = tree.nodes.filter { (role == nil || $0.role.caseInsensitiveCompare(role!) == .orderedSame) && (label == nil || $0.label == label) }
      if matches.count > 1 { return ["reason": "ambiguous"] }
      if !tree.complete { return ["reason": "incomplete"] }
      guard let found = matches.first else { return exists ? ["field": "exists", "value": false] : nil }
      node = found
    }
    if !exists { return ["field": "exists", "value": true] }
    if let value = raw["value"] as? String, valueText(node.value) != value { return ["field": "value", "value": valueText(node.value) as Any? ?? NSNull()] }
    if let contains = raw["valueContains"] as? String, valueText(node.value)?.contains(contains) != true {
      return ["field": "valueContains", "value": valueText(node.value) as Any? ?? NSNull()]
    }
    if let focused = jsonBool(raw["focused"]), focused != node.focused { return ["field": "focused", "value": node.focused as Any? ?? NSNull()] }
    if let enabled = jsonBool(raw["enabled"]), enabled != node.enabled { return ["field": "enabled", "value": node.enabled as Any? ?? NSNull()] }
    if let selected = jsonBool(raw["selected"]), selected != node.selected { return ["field": "selected", "value": node.selected as Any? ?? NSNull()] }
    return nil
  }
}

@MainActor final class HelperService {
  private enum Fault: String { case selfCheck = "self_check", symbols }

  let symbols: WindowSymbols
  private let catalog: WindowCatalog
  private let fault: Fault?
  private let ax = AXSession()
  private var cursor: AICursorControlling?
  private var cursorKey: WindowKey?
  private var hoverTask: Task<Void, Never>?
  private var check: Object = ["ok": false, "reason": "not_ready", "ms": 0]
  private let activation = ActivationGuard()

  init() {
    let fault = ProcessInfo.processInfo.environment["FLEET_COMPUTER_USE_FAULT"].flatMap(Fault.init(rawValue:))
    let symbols = WindowSymbols(omitWindowLocation: fault == .symbols)
    self.fault = fault
    self.symbols = symbols
    self.catalog = WindowCatalog(symbols: symbols)
    // 앱 실행이 끝나기(NSApp.run) 전에 걸어야 실행 직후의 활성화도 되돌린다.
    activation.start()
  }

  func initialize() async -> Object {
    if fault == .selfCheck {
      check = ["ok": false, "reason": "fault_injected_self_check", "ms": 0, "retryable": false]
    } else {
      check = await runSelfCheck()
    }
    return check
  }

  /// 일시 사유(사람의 포인터·앱 전환, 헬퍼 자신의 일시 활성화)로 실패한 점검은 짧게 다시 돈다. 그래도 실패하면 결과를 남기고,
  /// 호출자가 다음 입력 전에 `recheck`로 다시 묻게 한다(dbdbe742: 시작 점검 실패가 헬퍼 수명 내내 입력을 막았다).
  private func runSelfCheck() async -> Object {
    var result: Object = [:]
    for attempt in 1...SelfCheckPolicy.attempts {
      result = await selfCheck(symbols: symbols, permissions: HelperPermissions())
      result["attempts"] = attempt
      guard SelfCheckPolicy.retryable(result), attempt < SelfCheckPolicy.attempts else { break }
      try? await pause(SelfCheckPolicy.retryDelayMs)
    }
    result["retryable"] = SelfCheckPolicy.retryable(result)
    return result
  }

  private func recheck() async -> Object {
    guard fault != .selfCheck, check["ok"] as? Bool != true, SelfCheckPolicy.retryable(check) else { return check }
    check = await runSelfCheck()
    return check
  }

  func handle(method: String, params p: Object, record: DispatchRecord) async throws -> Object {
    switch method {
    case "hello":
      try validateKeys(p, allowed: [])
      let os = ProcessInfo.processInfo.operatingSystemVersion
      let version = "\(os.majorVersion).\(os.minorVersion)" + (os.patchVersion == 0 ? "" : ".\(os.patchVersion)")
      var hello: Object = ["protocol": 1, "helperVersion": 1, "os": version, "permissions": HelperPermissions().json, "symbols": symbols.json, "selfCheck": check]
      if let permissionHolder { hello["permissionHolder"] = permissionHolder }
      if permissionHolderHostsConsole { hello["permissionHolderHostsSession"] = true }
      return hello
    case "requestPermissions":
      try validateKeys(p, allowed: ["permissions"])
      guard let wanted = p["permissions"] as? [String], !wanted.isEmpty, wanted.allSatisfy(HelperPermissions.names.contains) else {
        throw HelperError("invalid_params", "permissions")
      }
      let result = HelperPermissions.request(Set(wanted))
      return ["requested": result.requested, "deferred": result.deferred, "permissions": HelperPermissions().json]
    case "windows":
      try validateKeys(p, allowed: ["query"])
      let query = try optionalString(p["query"], name: "query", max: 300)
      let windows = catalog.all(describeWithAX: AXIsProcessTrusted())
      prune(windows)
      let filtered = windows.filter { w in
        guard let q = query, !q.isEmpty else { return true }
        return [w.title, w.app, w.bundleId, w.bundlePath].contains { $0.localizedCaseInsensitiveContains(q) }
      }
      var result: Object = ["windows": filtered.map { $0.json() }]
      if let query, !query.isEmpty { result["installed"] = WindowCatalog.installed(query: query) }
      return result
    case "snapshot": return try await snapshot(p)
    case "act":
      // 장애를 주입한 경우 대상 조회나 입력 준비에도 들어가지 않는다.
      if fault != nil { throw HelperError("self_check_failed", check["reason"] as? String ?? "") }
      return try await act(p, record: record)
    case "focus": return try await focus(p)
    case "recheck":
      try validateKeys(p, allowed: [])
      return await recheck()
    case "verify": return try await verify(p)
    case "cursor":
      try validateKeys(p, allowed: ["op"])
      guard p["op"] as? String == "hide" else { throw HelperError("invalid_params", "op must be hide") }
      hideCursor(animated: true)
      return [:]
    case "shutdown":
      try validateKeys(p, allowed: [])
      hideCursor(animated: false)
      return [:]
    default: throw HelperError("invalid_params", "unknown method")
    }
  }

  func hideCursor(animated: Bool) {
    hoverTask?.cancel(); hoverTask = nil
    cursorKey = nil
    cursor?.hide(animated: animated)
  }

  private func prune(_ windows: [WindowInfo]) {
    let keys = Set(windows.map(\.key))
    ax.prune(to: catalog.prune(to: keys))
  }

  private func startCursor(_ point: CGPoint?, in win: WindowInfo) async {
    hoverTask?.cancel(); hoverTask = nil
    if let key = cursorKey, key != win.key {
      cursor?.hide(animated: false)
      cursorKey = nil
    }
    guard let point else { return }
    if cursor == nil { cursor = makeAICursor() }
    if cursor?.isVisible == true { await cursor?.move(to: win.screen(point), above: win.key.id) }
    else { cursor?.show(at: win.screen(point), above: win.key.id) }
    cursorKey = win.key
  }

  private func idleCursor() {
    guard let key = cursorKey else { return }
    hoverTask?.cancel()
    hoverTask = Task { @MainActor [weak self] in
      let start = clockNow()
      while !Task.isCancelled, millis(since: start) < 4_000 {
        try? await pause(160)
        guard !Task.isCancelled, let self else { return }
        guard (try? self.catalog.available(key.pid, key.id))?.key == key else {
          self.hideCursor(animated: false); return
        }
        self.cursor?.reorder(above: key.id)
      }
      if !Task.isCancelled { self?.hideCursor(animated: true) }
    }
  }

  private func window(_ pid: pid_t, _ id: CGWindowID, started: Double? = nil, allowOtherSpace: Bool = false) throws -> WindowInfo {
    do {
      if let started, !matchesStart(catalog.launchDate(pid), started) {
        throw HelperError.unavailable("closed")
      }
      let found = try catalog.available(pid, id, allowOtherSpace: allowOtherSpace)
      if let started, !matchesStart(found.key.launched, started) { throw HelperError.unavailable("closed") }
      return found
    }
    catch {
      hideCursor(animated: false)
      prune(catalog.all())
      throw error
    }
  }

  private func read(_ win: inout WindowInfo, budgetMs: Int = 250) -> AXTree {
    let tree = ax.read(win, budgetMs: budgetMs)
    if let title = tree.windowTitle, win.title.isEmpty { win.title = title }
    if tree.web && win.engine == .appkit { win.engine = .webkit; catalog.sawWebArea(win.key) }
    return tree
  }

  private func readPrepared(_ win: inout WindowInfo) async throws -> AXTree {
    let start = clockNow()
    var tree = read(&win)
    let webEngine = [.chromium, .electron, .webkit].contains(win.engine)
    let firstEnablement = !tree.hasWebContents && ax.attemptWebAccessibility(win)
    if firstEnablement {
      try await pause(500)
      tree = read(&win)
    }
    // Chromium/Electron의 보조 기술 전환은 엔진 내부에서 약 2초 디바운스된다.
    // WebKit의 첫 자식 조회도 원격 AX 트리가 준비되기 전에는 내용 그룹만 반환할 수 있다.
    let deadline = firstEnablement ? 2_500 : 1_000
    let shouldRetry = webEngine || (tree.hasEmptyContentGroup(in: win.localFrame) && ax.canProbeWeb(win.key))
    if shouldRetry && !tree.hasWebContents && AXIsProcessTrusted() {
      while !tree.hasWebContents && millis(since: start) < deadline - 50 {
        try await pause(65)
        let remaining = deadline - millis(since: start)
        if remaining <= 0 { break }
        tree = read(&win, budgetMs: min(250, remaining))
      }
    }
    if (webEngine || tree.hasEmptyContentGroup(in: win.localFrame)) && !tree.hasWebContents {
      return AXTree(root: tree.root, nodes: tree.nodes, complete: false, windowTitle: tree.windowTitle)
    }
    return tree
  }

  private func snapshot(_ p: Object) async throws -> Object {
    try validateKeys(p, allowed: ["pid", "windowId", "processStartedAt", "find", "expand", "limit", "valueLimit", "image"])
    let (pid, id, started) = try windowAddress(p)
    let find = try optionalString(p["find"], name: "find", max: 500).flatMap { $0.isEmpty ? nil : $0 }
    let expand = try optionalRef(p["expand"])
    let limit = try boundedInt(p["limit"], name: "limit", default: 200, range: 1...4_000)
    let valueLimit = try boundedInt(p["valueLimit"], name: "valueLimit", default: 80, range: 0...20_000)
    if p["image"] != nil && jsonBool(p["image"]) == nil { throw HelperError("invalid_params", "image") }
    let image = jsonBool(p["image"]) == true
    // 다른 스페이스의 창은 앱의 AX 창 목록에 없어 읽을 수 없고, 화면 캡처만 된다(dbdbe742 실측). 이미지를 청할 때만 보기 전용으로 돌려준다.
    var win = try window(pid, id, started: started, allowOtherSpace: image)
    let viewOnly = !win.onCurrentSpace
    // 손쉬운 사용이 없으면 AX 트리가 오류 없이 비어 버려 부족이 클릭 단계에서야 드러난다. 여기서 함께 알린다.
    let permissions = HelperPermissions()
    guard permissions.allowed else { throw permissions.error }
    let tree = viewOnly ? AXTree(root: nil, nodes: [], complete: false, windowTitle: nil) : try await readPrepared(&win)
    let expanded = try expand.map { try ax.resolve($0, tree: tree, window: win) }
    let output = tree.snapshot(find: find, expand: expanded, limit: limit, valueLimit: valueLimit)
    var result: Object = ["window": win.snapshotJSON(), "elements": output.elements, "omitted": output.omitted,
                          "complete": tree.complete && find == nil && output.omitted == 0 && !output.hasOutside]
    if output.rootOutside > 0 { result["omittedOutside"] = output.rootOutside }
    if viewOnly { result["viewOnly"] = true }
    if image {
      do { result["image"] = try await captureWindow(win) }
      catch { hideCursor(animated: false); throw error }
    }
    try Task.checkCancellation()
    let fresh = try window(pid, id, started: started, allowOtherSpace: image)
    guard fresh.key == win.key, fresh.frame == win.frame else { throw HelperError.unavailable() }
    ax.publish(output.shown.values, for: win.key)
    return result
  }

  private func verify(_ p: Object) async throws -> Object {
    try validateKeys(p, allowed: ["pid", "windowId", "processStartedAt", "expect", "timeoutMs"])
    let (pid, id, started) = try windowAddress(p)
    guard let raw = p["expect"] as? [Object], (1...8).contains(raw.count) else { throw HelperError("invalid_params", "expect must contain 1 to 8 conditions") }
    let expect = try raw.map(Expectation.init)
    let timeout = try boundedInt(p["timeoutMs"], name: "timeoutMs", default: 0, range: 0...10_000)
    let permissions = HelperPermissions()
    guard permissions.allowed else { throw permissions.error }
    let start = clockNow()
    func result(index: Int, actual: Object) -> Object {
      var result: Object = ["index": index, "expected": expect[index].raw, "waitedMs": millis(since: start)]
      if let reason = actual["reason"] { result["status"] = "unknown"; result["reason"] = reason }
      else { result["status"] = "unsatisfied"; result["actual"] = actual }
      return result
    }
    while true {
      try Task.checkCancellation()
      var win: WindowInfo
      do { win = try window(pid, id, started: started) }
      catch let error as HelperError {
        if let started, !matchesStart(catalog.launchDate(pid), started) { throw error }
        return result(index: 0, actual: ["reason": "window_unavailable"])
      }
      let tree = try await readPrepared(&win)
      var mismatch: (Int, Object)?
      for (i, condition) in expect.enumerated() {
        if let actual = condition.mismatch(tree: tree, resolve: { try self.ax.resolve($0, tree: tree, window: win) }) {
          mismatch = (i, actual); break
        }
      }
      guard let (index, actual) = mismatch else { return ["status": "satisfied", "waitedMs": millis(since: start)] }
      if actual["reason"] as? String == "stale_element" || millis(since: start) >= timeout { return result(index: index, actual: actual) }
      try await pause(min(80, max(1, timeout - millis(since: start))))
    }
  }

  private func localPoint(node: AXNode?, explicit: CGPoint?, in win: WindowInfo) throws -> CGPoint {
    let point: CGPoint
    if let explicit { point = explicit }
    else if let frame = node?.frame {
      let visible = frame.intersection(win.localFrame)
      guard !visible.isNull, !visible.isEmpty else { throw HelperError.unavailable(message: "element_outside_window") }
      point = CGPoint(x: visible.midX, y: visible.midY)
    } else { throw HelperError("invalid_params", "target has no position") }
    guard win.localFrame.contains(point) else { throw HelperError("invalid_params", "position outside window") }
    return point
  }

  private func engine(for node: AXNode?, at point: CGPoint?, tree: AXTree, win: WindowInfo) -> Engine {
    guard win.engine == .webkit || win.engine == .appkit else { return win.engine }
    if let node { return node.web ? .webkit : .appkit }
    guard let point else { return win.engine }
    if tree.nodes.contains(where: { $0.role == "AXWebArea" && $0.frame?.contains(point) != false }) { return .webkit }
    return .appkit
  }

  private func targetFocused(_ node: AXNode, in win: WindowInfo, root: AXUIElement?) -> Bool {
    if let focused = AXReader.focused(win, root: root) {
      if CFEqual(focused, node.el) { return true }
      let containerRoles = [kAXApplicationRole, kAXWindowRole, kAXGroupRole, kAXScrollAreaRole, "AXWebArea"]
      guard let role = AXReader.attribute(focused, kAXRoleAttribute) as? String,
            containerRoles.contains(role), !AXReader.editable(focused, role: role) else { return false }
    }
    // 원격 웹 콘텐츠와 UIKit은 앱 루트에 포커스 자식을 반환하지 않기도 한다.
    // 정확한 자식의 AXFocused와 같은 대상 창이 모두 확인될 때만 이를 보완한다.
    let remoteWeb = node.web && [.electron, .webkit].contains(win.engine)
    return (remoteWeb || win.engine == .catalyst) && AXReader.attribute(node.el, kAXFocusedAttribute) as? Bool == true &&
      AXReader.focusedWindow(win, root: root)
  }

  private func focusTarget(_ node: AXNode, in win: WindowInfo, root: AXUIElement?, mayFocus: Bool) throws -> AXUIElement {
    guard AXReader.belongs(node.el, win, root: root), AXReader.attribute(node.el, kAXEnabledAttribute) as? Bool != false else {
      throw HelperError("no_editable_focus", "target_focus_unconfirmed")
    }
    if targetFocused(node, in: win, root: root) { return node.el }
    if mayFocus, AXReader.settable(node.el, kAXFocusedAttribute) { _ = AXReader.set(node.el, kAXFocusedAttribute, kCFBooleanTrue) }
    // setter의 반환값이 아니라 대상이 실제로 포커스됐는지 확인한다.
    guard targetFocused(node, in: win, root: root) else { throw HelperError("no_editable_focus", "target_focus_unconfirmed") }
    return node.el
  }

  /// 단축키로 끝나는 호출(paste 앞의 focus, 대상 지정 key)과 Chromium·Electron의 type에서 쓴다. Chromium·Electron은 AXFocused 설정이 렌더러를 거쳐
  /// 수십 ms 뒤에야 대상 AXFocused·앱 AXFocusedUIElement에 보여서(451f7d30 m2 실측 11~27ms), 설정 직후 한 번만 보면
  /// 포커스 없는 입력칸을 늘 거절했다. 확인 조건은 그대로 두고 같은 확인을 짧게 다시 한다.
  private func settleTargetFocus(_ node: AXNode, in win: WindowInfo, root: AXUIElement?) async throws -> AXUIElement {
    do { return try focusTarget(node, in: win, root: root, mayFocus: true) }
    catch let error as HelperError where error.code == "no_editable_focus" {
      guard AXReader.belongs(node.el, win, root: root), AXReader.attribute(node.el, kAXEnabledAttribute) as? Bool != false,
            AXReader.settable(node.el, kAXFocusedAttribute) else { throw error }
      let deadline = clockNow() + 0.3
      repeat {
        try await pause(20)
        if targetFocused(node, in: win, root: root) { return node.el }
      } while clockNow() < deadline
      throw error
    }
  }

  /// 창 프라이머 뒤 앱이 대상 창을 AXFocusedWindow로 보고하는지 짧게 다시 확인한다.
  private func settleReportedKeyWindow(_ win: WindowInfo, root: AXUIElement?) async throws -> Bool {
    let deadline = clockNow() + 0.3
    while !AXReader.reportsFocusedWindow(win, root: root) {
      guard clockNow() < deadline else { return false }
      try await pause(20)
    }
    return true
  }

  private func settleEditableFocus(_ node: AXNode?, in win: WindowInfo, root: AXUIElement?) async throws -> AXUIElement {
    if let node, AXReader.editable(node.el, role: node.role) { _ = try await settleTargetFocus(node, in: win, root: root) }
    return try focusEditable(node, in: win, root: root, mayFocus: false)
  }

  private func focusEditable(_ node: AXNode?, in win: WindowInfo, root: AXUIElement?, mayFocus: Bool) throws -> AXUIElement {
    let candidate: AXUIElement?
    if let node {
      guard AXReader.editable(node.el, role: node.role) else { throw HelperError("no_editable_focus") }
      candidate = try focusTarget(node, in: win, root: root, mayFocus: mayFocus)
    } else { candidate = AXReader.focused(win, root: root) }
    guard let focused = candidate, let role = AXReader.attribute(focused, kAXRoleAttribute) as? String,
          AXReader.editable(focused, role: role), AXReader.attribute(focused, kAXEnabledAttribute) as? Bool != false else {
      throw HelperError("no_editable_focus")
    }
    return focused
  }

  private func focus(_ p: Object) async throws -> Object {
    try validateKeys(p, allowed: ["pid", "windowId", "processStartedAt", "ref"])
    let (pid, id, started) = try windowAddress(p)
    var win = try window(pid, id, started: started)
    // 붙여넣기 앞의 포커스다. 화면에 없는 창에는 이어지는 단축키가 닿지 않으므로 포커스도 옮기지 않는다.
    if !win.onscreen { throw HelperError("needs_visible_window", details: ["reason": win.minimized ? "minimized" : win.hidden ? "hidden" : "offscreen"]) }
    let permissions = HelperPermissions()
    guard permissions.allowed else { throw permissions.error }
    let tree = read(&win)
    let node = try optionalRef(p["ref"]).map { try ax.resolve($0, tree: tree, window: win) }
    try Task.checkCancellation()
    let current = try window(pid, id, started: started)
    guard current.key == win.key else { throw HelperError.unavailable("closed") }
    guard let focused = try? await settleEditableFocus(node, in: win, root: tree.root) else { return ["editable": false] }
    var result: Object = ["editable": true]
    if let node { result["focusedRef"] = node.ref }
    else if let ref = tree.nodes.first(where: { CFEqual($0.el, focused) })?.ref,
            (try? ax.resolve(ref, tree: tree, window: win)) != nil { result["focusedRef"] = ref }
    if let role = AXReader.attribute(focused, kAXRoleAttribute) as? String { result["role"] = role }
    return result
  }

  private func act(_ p: Object, record: DispatchRecord) async throws -> Object {
    let actionStart = clockNow()
    let request = try ActionRequest(p)
    let requiredFrame = try expectedFrame(p)
    let (pid, id, started) = try windowAddress(p)
    var win = try window(pid, id, started: started)
    let permissions = HelperPermissions()
    guard permissions.allowed else { throw permissions.error }
    guard check["ok"] as? Bool == true else { throw HelperError("self_check_failed", check["reason"] as? String ?? "") }
    guard win.key.launched != nil else { throw HelperError.unavailable() }
    // 최소화·숨김 창은 앞으로 올리지 않고 요소 동작·값 설정·스크롤만 보낸다. 입력칸 포커스를 확인할 수 없어 타이핑·키·드래그는
    // 보내기 전에 거절한다(dbdbe742 실측: type은 no_editable_focus, set_value·AXPress·스크롤 이벤트는 반영).
    let notVisible = HelperError("needs_visible_window", details: ["reason": win.minimized ? "minimized" : win.hidden ? "hidden" : "offscreen"])
    if !win.onscreen, [.type, .key, .drag].contains(request.name) { throw notVisible }
    let before = try await readPrepared(&win)
    let node = try request.ref.map { try ax.resolve($0, tree: before, window: win) }
    let beforeWindows = catalog.all(pid: pid, visibleOnly: true)
    let factory = EventFactory(symbols: symbols)
    var point: CGPoint?
    var end: CGPoint?
    var endNode: AXNode?
    var pulse: AICursorPulse?
    var verification: Verification?
    var axAction: String?
    var axSet: (AXUIElement, String, CFTypeRef)?
    var sequence: EventSequence?
    var notes: [String] = []
    var typingElement: AXUIElement?
    var requiresKeyWindow = false
    var needsTargetFocus = false
    var primer: KeyWindowPrimer?
    var windowPrimer: EventSequence?

    func revalidate() throws {
      try Task.checkCancellation()
      let current = try window(pid, id, started: started)
      guard current.key == win.key else { throw HelperError.unavailable("closed") }
      if let requiredFrame {
        let a = current.frame, b = requiredFrame
        guard [a.minX - b.minX, a.minY - b.minY, a.width - b.width, a.height - b.height].allSatisfy({ abs($0) < 1 }) else {
          throw HelperError("coordinates_need_image")
        }
      }
      if requiredFrame == nil && current.frame != win.frame { throw HelperError.unavailable() }
      if let root = before.root, (AXReader.attribute(root, kAXMinimizedAttribute) as? Bool == true) != win.minimized {
        throw HelperError.unavailable(win.minimized ? "unknown" : "minimized")
      }
      for node in [node, endNode].compactMap({ $0 }) {
        guard AXReader.matchesLive(node.identity, in: win, root: before.root) else {
          throw HelperError("stale_element")
        }
      }
      if let typingElement {
        let currentFocus = try focusEditable(node, in: win, root: before.root, mayFocus: false)
        guard CFEqual(currentFocus, typingElement) else { throw HelperError("no_editable_focus") }
      }
      if needsTargetFocus, let node { _ = try focusTarget(node, in: win, root: before.root, mayFocus: false) }
      if requiresKeyWindow, !AXReader.focusedWindow(win, root: before.root) { throw HelperError.unavailable(message: "target_not_key_window") }
    }

    func clickSequence(_ action: PointerAction, at point: CGPoint) throws -> EventSequence {
      let detected = engine(for: node, at: point, tree: before, win: win)
      let hit = node?.el ?? (detected == .appkit ? AXReader.hit(win, point) : nil)
      let hitRole = hit.flatMap { AXReader.attribute($0, kAXRoleAttribute) as? String }
      let hitActions = node?.actions ?? hit.map(AXReader.actions) ?? []
      let custom = !hitActions.contains(kAXPressAction) && (hitRole == nil || ["AXGroup", "AXUnknown", "AXLayoutArea", "AXWindow"].contains(hitRole!))
      return try factory.pointer(action, win: win, point: point, focus: detected == .webkit || detected == .electron || (detected == .appkit && custom))
    }

    // 적중 검사가 대상(또는 그 자손)일 때만 클릭한다. 다른 요소에 맞으면 프라이머 없이 지금 동작을 유지한다.
    func keyWindowPrimer(for el: AXUIElement) -> KeyWindowPrimer? {
      guard AXReader.settable(el, kAXSelectedTextRangeAttribute), let raw = AXReader.attribute(el, kAXSelectedTextRangeAttribute),
            CFGetTypeID(raw) == AXValueGetTypeID(), let frame = AXReader.frame(el) else { return nil }
      let visible = frame.offsetBy(dx: -win.frame.minX, dy: -win.frame.minY).intersection(win.localFrame)
      guard !visible.isNull, !visible.isEmpty else { return nil }
      let center = CGPoint(x: visible.midX, y: visible.midY)
      // 새로 뜬(아직 key가 아닌) 창에서는 focus 레코드와 화면 밖 프라이머를 앞세운 클릭만 실측으로 확인됐다(m3 E1a·R1).
      guard let hit = AXReader.hit(win, center), AXReader.within(hit, el),
            let click = try? factory.pointer(.click, win: win, point: center, focus: true) else { return nil }
      return KeyWindowPrimer(element: el, range: raw as! AXValue, click: click)
    }

    switch request.name {
    case .click, .doubleClick, .rightClick:
      switch request.name {
      case .click:
        if node?.actions.contains(kAXPressAction) == true { axAction = kAXPressAction }
        pulse = .click
      case .rightClick:
        if node?.actions.contains(kAXShowMenuAction) == true { axAction = kAXShowMenuAction }
        pulse = .rightClick
      default: pulse = .doubleClick
      }
      if axAction == nil {
        let p = try localPoint(node: node, explicit: request.point, in: win)
        point = p
        let action: PointerAction = request.name == .click ? .click : request.name == .rightClick ? .rightClick : .doubleClick
        sequence = try clickSequence(action, at: p)
      } else { point = try? localPoint(node: node, explicit: nil, in: win) }
    case .scroll:
      let p = try localPoint(node: node, explicit: request.point, in: win)
      let direction = request.direction!
      point = p; pulse = .scroll(direction)
      sequence = try factory.pointer(.scroll(direction, request.pages), win: win, point: p, focus: false)
    case .drag:
      if [.chromium, .electron, .catalyst].contains(win.engine) {
        let slider = (node?.role == kAXSliderRole && node?.settable == true) || request.point.map { p in
          guard let hit = AXReader.hit(win, p) else { return false }
          return AXReader.attribute(hit, kAXRoleAttribute) as? String == kAXSliderRole && AXReader.settable(hit, kAXValueAttribute)
        } == true
        throw HelperError("drag_unsupported", details: ["settableSlider": slider])
      }
      let p = try localPoint(node: node, explicit: request.point, in: win)
      let target = request.end!
      let destination: CGPoint
      if let ref = try optionalRef(target["ref"]) {
        try validateKeys(target, allowed: ["ref"])
        let to = try ax.resolve(ref, tree: before, window: win)
        endNode = to
        destination = try localPoint(node: to, explicit: nil, in: win)
      } else {
        try validateKeys(target, allowed: ["x", "y"])
        guard let x = jsonNumber(target["x"]), let y = jsonNumber(target["y"]) else { throw HelperError("invalid_params", "to must be ref or x,y") }
        destination = try localPoint(node: nil, explicit: CGPoint(x: x, y: y), in: win)
      }
      point = p; end = destination
      sequence = try factory.pointer(.drag(destination), win: win, point: p, focus: engine(for: node, at: p, tree: before, win: win) == .webkit)
    case .type:
      let text = request.text!
      try revalidate()
      // 비활성 AppKit 앱이 대상 창을 포커스 창으로 보고하지 않으면(창을 닫았다 다시 연 경우 등) 입력칸 포커스를 확인할 수 없다
      // (dbdbe742 실측: target_focus_unconfirmed). 포커스 확인 전에 창 프라이머로 창을 key로 만든다. 프라이머는 화면 밖 좌표의
      // 클릭과 focus 레코드뿐이라 창 내용에 닿지 않는다.
      if win.engine == .appkit,
         TypeKeyWindow.decide(engine: .appkit, reportsFocusedWindow: AXReader.reportsFocusedWindow(win, root: before.root),
                              appActive: NSRunningApplication(processIdentifier: pid)?.isActive == true) == .prime {
        try await factory.windowPrimer(win).send(to: win, using: symbols, revalidate: revalidate)
        guard try await settleReportedKeyWindow(win, root: before.root) else { throw HelperError("no_editable_focus", "key_window_unconfirmed") }
        notes.append("key_window_primed")
      }
      // Chromium·Electron은 AXFocused 설정이 늦게 보이므로(451f7d30 m2) 단축키처럼 같은 확인을 짧게 다시 한다.
      // 다른 엔진은 type에서 실측하지 않아 즉시 확인을 유지한다.
      let target = [.chromium, .electron].contains(win.engine)
        ? try await settleEditableFocus(node, in: win, root: before.root)
        : try focusEditable(node, in: win, root: before.root, mayFocus: true)
      let detected = engine(for: node ?? before.nodes.first { CFEqual($0.el, target) }, at: nil, tree: before, win: win)
      let web = detected == .webkit || (detected == .appkit && AXReader.insideWebArea(target))
      sequence = try factory.typing(text, focus: web || detected == .electron)
      typingElement = target
      verification = .contains(target, text)
      point = try? localPoint(node: node ?? before.nodes.first { CFEqual($0.el, target) }, explicit: nil, in: win)
      switch TypeKeyWindow.decide(engine: detected, reportsFocusedWindow: AXReader.reportsFocusedWindow(win, root: before.root),
                                  appActive: NSRunningApplication(processIdentifier: pid)?.isActive == true) {
      case .ready: break
      case .prime: windowPrimer = try factory.windowPrimer(win)
      case .refuse: throw HelperError("no_editable_focus", "target_not_key_window")
      }
    case .key:
      let stroke = request.stroke!
      let focus = stroke.flags.contains(.maskCommand) && win.engine != .catalyst
      sequence = try factory.key(stroke, focus: focus)
      requiresKeyWindow = !focus
      var editable: AXUIElement?
      if request.requireEditableFocus {
        let target = try focusEditable(node, in: win, root: before.root, mayFocus: false)
        typingElement = target; editable = target
        point = try? localPoint(node: node ?? before.nodes.first { CFEqual($0.el, target) }, explicit: nil, in: win)
        if let text = request.text, !text.isEmpty, let value = AXReader.attribute(target, kAXValueAttribute) as? String {
          verification = .pasted(target, text, occurrences(of: text, in: value))
        }
      } else if let node {
        try revalidate()
        let focused = try await settleTargetFocus(node, in: win, root: before.root)
        needsTargetFocus = true
        point = try? localPoint(node: node, explicit: nil, in: win)
        if AXReader.editable(focused, role: node.role) { editable = focused }
      } else if let focused = AXReader.focused(win, root: before.root), let role = AXReader.attribute(focused, kAXRoleAttribute) as? String,
                AXReader.editable(focused, role: role) {
        editable = focused
      }
      if stroke.selectAll, let editable { verification = .selectsAll(editable) }
      // 앱이 활성이고 대상 창이 그 앱의 포커스 창이면 이미 AppKit key 창이라 클릭이 필요 없다. 비활성 앱에서는
      // AXFocusedWindow가 대상 창이어도 단축키가 버려졌으므로(b3c7139e m3 E2a, Chrome) key 여부를 믿지 않는다.
      let alreadyKey = NSRunningApplication(processIdentifier: pid)?.isActive == true && AXReader.focusedWindow(win, root: before.root)
      // AppKit은 네이티브 입력칸만 실측했다(451f7d30 m3). 앱 안의 웹 콘텐츠(WebKit)는 바꾸지 않는다.
      if focus, !alreadyKey, let editable,
         [.chromium, .electron].contains(win.engine) || (win.engine == .appkit && !AXReader.insideWebArea(editable)) {
        primer = keyWindowPrimer(for: editable)
      }
    case .setValue:
      guard let node, AXReader.settable(node.el, kAXValueAttribute) else { throw HelperError("not_settable") }
      let text = request.text!
      if let current = node.value as? NSNumber, CFGetTypeID(current) != CFBooleanGetTypeID() {
        guard let number = Double(text), number.isFinite else { throw HelperError("invalid_params", "numeric value required") }
        let converted = NSNumber(value: number)
        axSet = (node.el, kAXValueAttribute, converted)
        verification = .value(node.el, converted)
      } else {
        axSet = (node.el, kAXValueAttribute, text as CFString)
        verification = .value(node.el, text)
      }
      notes.append("ax_value_set")
      point = try? localPoint(node: node, explicit: nil, in: win)
    case .select:
      guard let node, AXReader.settable(node.el, kAXSelectedTextRangeAttribute) else { throw HelperError("not_settable") }
      guard let value = AXReader.attribute(node.el, kAXValueAttribute) as? String else { throw HelperError("text_not_found") }
      let text = request.text!
      let range = (value as NSString).range(of: text)
      guard range.location != NSNotFound else { throw HelperError("text_not_found") }
      var cfRange = CFRange(location: range.location, length: range.length)
      guard let axRange = AXValueCreate(.cfRange, &cfRange) else { throw HelperError("internal") }
      axSet = (node.el, kAXSelectedTextRangeAttribute, axRange)
      verification = .selection(node.el, text, cfRange)
      point = try? localPoint(node: node, explicit: nil, in: win)
    case .axAction:
      guard let node, let name = request.axName, ax.offered(name, for: node.ref, in: win.key), node.actions.contains(name) else {
        throw HelperError("invalid_name")
      }
      axAction = name
      point = try? localPoint(node: node, explicit: nil, in: win)
    }

    if sequence?.needsFocus == true && !symbols.hasFocusRecord { throw HelperError("self_check_failed", "focus_record_unavailable") }
    // 화면 밖 창에는 focus 레코드가 필요한 이벤트를 보내지 않는다. 창을 key로 만드는 레코드가 최소화·숨김 창에 무엇을 하는지 실측하지 않았다.
    if !win.onscreen, sequence?.needsFocus == true { throw notVisible }
    try revalidate()
    defer { idleCursor() }
    // 화면 밖 창의 원래 자리에 AI 커서를 띄우면 사람 화면의 엉뚱한 곳을 가리킨다.
    if win.onscreen { await startCursor(point, in: win) } else { hideCursor(animated: false) }
    try revalidate()
    var via = "ax"
    if let name = axAction, let node {
      let rc = AXUIElementPerformAction(node.el, name as CFString)
      if rc != .success {
        if (rc == .actionUnsupported || rc == .attributeUnsupported), [.click, .rightClick].contains(request.name), let point {
          sequence = try clickSequence(request.name == .rightClick ? .rightClick : .click, at: point)
          if !win.onscreen, sequence?.needsFocus == true { throw notVisible }
        } else { throw failedAX(rc, defaultCode: "invalid_name") }
      }
    }
    if let (element, attribute, value) = axSet {
      let rc = AXReader.set(element, attribute, value)
      guard rc == .success else { throw failedAX(rc, defaultCode: "not_settable") }
    }
    if let sequence {
      if sequence.needsFocus { via = "event+focus"; notes.append("focus_record_used") }
      else { via = "event" }
      if request.name == .type || typingElement != nil { await cursor?.pulse(.typing(true)) }
      if end != nil { await cursor?.pulse(.dragBegin) }
      let destination = end
      let dragging = destination.map { target in Task { @MainActor in
        await self.cursor?.move(to: win.screen(target), above: win.key.id)
      } }
      var clicked = false
      do {
        if let windowPrimer {
          try await windowPrimer.send(to: win, using: symbols, revalidate: revalidate)
          // 프라이머는 페이지에 닿지 않으므로, 창이 key가 된 것을 확인하지 못하면 입력 전에 거절해도 보낸 입력이 없다.
          guard try await settleReportedKeyWindow(win, root: before.root) else { throw HelperError("no_editable_focus", "key_window_unconfirmed") }
        }
        if let primer {
          try await primer.click.send(to: win, using: symbols, revalidate: revalidate)
          clicked = true
          notes.append("key_window_click")
          record.confirmed(via: via, notes: notes)
          try await pause(150)
          _ = AXReader.set(primer.element, kAXSelectedTextRangeAttribute, primer.range)
          try await pause(50)
          guard let restored = AXReader.selectedRange(primer.element), let wanted = AXReader.range(primer.range),
                restored.location == wanted.location, restored.length == wanted.length else {
            throw HelperError("timeout", "selection_restore_unconfirmed")
          }
        }
        try await sequence.send(to: win, using: symbols, revalidate: revalidate)
      } catch {
        dragging?.cancel()
        hideCursor(animated: false)
        // 클릭은 이미 페이지에 갔으므로 "보내지 않음"으로 바꾸지 않는다.
        if clicked, (error as? HelperError)?.code != "timeout" { throw HelperError("timeout", "key_window_click_sent") }
        // 프라이머 전송 중의 HelperError(재검증 실패)는 실제 클릭 이벤트 전에만 난다(EventSequence.send).
        // 그 밖의 오류(취소 등)는 클릭이 반쯤 나간 뒤일 수 있으므로 전송 불명으로 올린다.
        if primer != nil, !(error is HelperError) { throw HelperError("timeout", "key_window_click_unknown") }
        throw error
      }
      record.confirmed(via: via, notes: notes)
      if request.name == .type || typingElement != nil { await cursor?.pulse(.typing(false)) }
      if let dragging { await dragging.value; await cursor?.pulse(.dragEnd) }
    }
    record.confirmed(via: via, notes: notes)
    // 피드백 모션은 관측 주기와 병행한다. 전송은 이미 끝났고 이후에는 관측만 한다.
    let feedback = pulse.map { kind in Task { @MainActor in await self.cursor?.pulse(kind) } }
    defer { feedback?.cancel() }
    return try await observe(win, before: before, windows: beforeWindows, via: via, notes: notes, verification: verification, actionStart: actionStart)
  }

  private func failedAX(_ code: AXError, defaultCode: String) -> HelperError {
    // CannotComplete는 IPC 타임아웃일 수도 있으므로 입력이 안 나갔다고 단정하거나 재전송하지 않는다.
    if code == .cannotComplete || code == .failure { return HelperError("timeout", "ax_delivery_unknown") }
    if code == .invalidUIElement { return HelperError("stale_element") }
    if code == .apiDisabled {
      let permissions = HelperPermissions()
      return permissions.allowed ? HelperError("permission_required", details: ["missing": ["accessibility"]]) : permissions.error
    }
    return HelperError(defaultCode)
  }

  private func observe(_ win: WindowInfo, before: AXTree, windows: [WindowInfo], via: String, notes: [String], verification: Verification?, actionStart: Double) async throws -> Object {
    let start = clockNow()
    let maxObservation = min(1_500, max(1, 1_950 - millis(since: actionStart)))
    let old = Dictionary(uniqueKeysWithValues: before.nodes.filter(\.visible).map { ($0.ref, $0) })
    let oldWindows = Dictionary(uniqueKeysWithValues: windows.map { ($0.key, $0) })
    var result: Object = ["sent": true, "via": via, "observation": "unobservable", "changes": [], "notes": notes]
    var reportedNodes: [AXNode] = []
    defer { ax.publish(reportedNodes, for: win.key) }
    while true {
      try await pause(min(80, max(1, maxObservation - millis(since: start))))
      let currentWindows = catalog.all(pid: win.key.pid, visibleOnly: true)
      let currentKeys = Set(currentWindows.map(\.key))
      var windowsChanged = currentWindows.filter { oldWindows[$0.key] == nil }.map { ["op": "+", "window": $0.json()] as Object }
      windowsChanged += windows.filter { window in
        guard !currentKeys.contains(window.key) else { return false }
        do { return try catalog.available(window.key.pid, window.key.id).key != window.key }
        catch let error as HelperError { return error.details?["reason"] as? String == "closed" }
        catch { return false }
      }.map { ["op": "-", "window": $0.json()] as Object }
      if !windowsChanged.isEmpty { result["windowsChanged"] = windowsChanged; result["observation"] = "changes" }
      guard var fresh = try? window(win.key.pid, win.key.id), fresh.key == win.key else { return result }
      let tree = read(&fresh, budgetMs: max(20, min(180, maxObservation - millis(since: start))))
      let current = Dictionary(uniqueKeysWithValues: tree.nodes.filter(\.visible).map { ($0.ref, $0) })
      var changes: [Object] = []
      for node in tree.nodes where node.visible {
        if let prior = old[node.ref] {
          if node.changed(from: prior) || node.frame != prior.frame { changes.append(["op": "~", "element": node.json(valueLimit: 80)]) }
        } else if before.complete { changes.append(["op": "+", "element": node.json(valueLimit: 80)]) }
      }
      if tree.complete {
        for node in before.nodes where node.visible && current[node.ref] == nil {
          changes.append(["op": "-", "element": node.json(valueLimit: 80)])
        }
      }
      if !changes.isEmpty {
        let shown = Array(changes.prefix(30))
        result["changes"] = shown
        reportedNodes = shown.compactMap { change in
          guard change["op"] as? String != "-", let element = change["element"] as? Object, let ref = element["ref"] as? String else { return nil }
          return current[ref]
        }
        result["changesMore"] = changes.count > 30 ? changes.count - 30 : nil
      }
      if !changes.isEmpty || !windowsChanged.isEmpty { result["observation"] = "changes" }
      else if result["observation"] as? String != "changes", tree.observable, before.observable, tree.complete, before.complete {
        result["observation"] = "none"
      }
      if let fact = verification?.check(in: fresh, root: tree.root) { result["verified"] = fact; return result }
      if verification == nil && (!changes.isEmpty || !windowsChanged.isEmpty || !tree.observable) { return result }
      if millis(since: start) >= maxObservation {
        if maxObservation < 1_500, result["observation"] as? String == "none" { result["observation"] = "timeout" }
        if result["observation"] as? String == "none", verification?.unreadable(in: fresh, root: tree.root) == true { result["observation"] = "unobservable" }
        return result
      }
    }
  }
}
