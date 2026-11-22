import AppKit
import ApplicationServices

func asAX(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func axJSONValue(_ value: CFTypeRef?) -> Any? {
  guard let value else { return nil }
  if let s = value as? String { return s }
  if let n = value as? NSNumber, n.doubleValue.isFinite { return n }
  if let e = asAX(value) { return AXReader.attribute(e, kAXTitleAttribute) as? String }
  return nil
}

func valueText(_ value: Any?) -> String? {
  if let s = value as? String { return s }
  if let n = value as? NSNumber { return n.stringValue }
  return nil
}

func jsonEqual(_ a: Any?, _ b: Any?) -> Bool {
  if a == nil || b == nil { return a == nil && b == nil }
  return (a as? NSObject)?.isEqual(b as? NSObject) == true
}

struct AXIdentity: Hashable {
  let element: AXUIElement
  let parent: AXUIElement
  static func == (lhs: AXIdentity, rhs: AXIdentity) -> Bool {
    CFEqual(lhs.element, rhs.element) && CFEqual(lhs.parent, rhs.parent)
  }
  func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)); hasher.combine(CFHash(parent)) }
}

enum AXReader {
  private typealias WindowNumberFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  private static let windowNumber: WindowNumberFn? = loadSymbol("_AXUIElementGetWindow", WindowNumberFn.self)

  static func application(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.18)
    return app
  }

  static func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
  }

  static func attributeNames(_ el: AXUIElement) -> [String]? {
    var names: CFArray?
    return AXUIElementCopyAttributeNames(el, &names) == .success ? names as? [String] : nil
  }

  static func settable(_ el: AXUIElement, _ name: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, name as CFString, &settable) == .success && settable.boolValue
  }

  static func set(_ el: AXUIElement, _ name: String, _ value: CFTypeRef) -> AXError {
    AXUIElementSetAttributeValue(el, name as CFString, value)
  }

  static func actions(_ el: AXUIElement) -> [String] {
    var actions: CFArray?
    return AXUIElementCopyActionNames(el, &actions) == .success ? (actions as? [String] ?? []) : []
  }

  static func members(_ el: AXUIElement, _ names: [String]) -> (values: [String: CFTypeRef], incomplete: Bool) {
    var result: CFArray?
    let code = AXUIElementCopyMultipleAttributeValues(el, names as CFArray, [], &result)
    guard code == .success, let values = result as? [CFTypeRef], values.count == names.count else { return ([:], true) }
    var output: [String: CFTypeRef] = [:]
    var incomplete = false
    for (name, value) in zip(names, values) {
      if CFGetTypeID(value) == CFNullGetTypeID() { continue }
      if CFGetTypeID(value) == AXValueGetTypeID() {
        let ax = value as! AXValue
        if AXValueGetType(ax) == .axError {
          var error = AXError.failure
          if AXValueGetValue(ax, .axError, &error), error != .attributeUnsupported, error != .noValue { incomplete = true }
          continue
        }
      }
      output[name] = value
    }
    return (output, incomplete)
  }

  // 원격 웹 프로세스가 아직 붙지 않았으면 bulk 응답의 AXChildren이 비어 있을 수 있다.
  static func children(_ el: AXUIElement, role: String, batched: CFTypeRef?) -> [AXUIElement] {
    let children = batched as? [AXUIElement] ?? []
    let containers = [kAXWindowRole, kAXGroupRole, kAXScrollAreaRole, kAXSplitGroupRole, "AXWebArea"]
    if !children.isEmpty || !containers.contains(role) { return children }
    return attribute(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
  }

  static let nodeAttributes = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXChildrenAttribute,
                               kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute, kAXEnabledAttribute, kAXSelectedAttribute,
                               "AXPlaceholderValue", "AXTitleUIElement"]

  static func node(_ identity: AXIdentity, ref: String, attributes a: [String: CFTypeRef], win: WindowInfo,
                   parentIndex: Int?, depth: Int, clip: CGRect, inWeb: Bool) -> AXNode? {
    let el = identity.element
    guard let role = a[kAXRoleAttribute] as? String else { return nil }
    let frame = self.frame(position: a[kAXPositionAttribute], size: a[kAXSizeAttribute])?.offsetBy(dx: -win.frame.minX, dy: -win.frame.minY)
    let value = axJSONValue(a[kAXValueAttribute])
    let label = [a[kAXTitleAttribute], a[kAXDescriptionAttribute], a["AXPlaceholderValue"]]
      .compactMap { $0 as? String }.first { !$0.isEmpty } ?? asAX(a["AXTitleUIElement"]).flatMap {
        attribute($0, kAXValueAttribute) as? String ?? attribute($0, kAXTitleAttribute) as? String
      }
    let settable = value != nil && self.settable(el, kAXValueAttribute)
    let editable = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXWebArea"].contains(role) && self.editable(el, role: role)
    return AXNode(ref: ref, identity: identity, parentIndex: parentIndex, depth: depth, role: role, label: label,
                  value: value, actions: actions(el).filter { $0 != kAXRaiseAction }, settable: settable, editable: editable,
                  focused: a[kAXFocusedAttribute] as? Bool, enabled: a[kAXEnabledAttribute] as? Bool,
                  selected: a[kAXSelectedAttribute] as? Bool, frame: frame,
                  visible: frame.map { !$0.isEmpty && clip.intersects($0) } ?? true, web: inWeb || role == "AXWebArea")
  }

  static func matchesLive(_ identity: AXIdentity, in win: WindowInfo, root: AXUIElement?) -> Bool {
    belongs(identity.element, win, root: root) &&
      asAX(attribute(identity.element, kAXParentAttribute)).map { CFEqual($0, identity.parent) } == true
  }

  static func frame(position: CFTypeRef?, size: CFTypeRef?) -> CGRect? {
    guard let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s),
          p.x.isFinite, p.y.isFinite, s.width.isFinite, s.height.isFinite, s.width >= 0, s.height >= 0 else { return nil }
    return CGRect(origin: p, size: s)
  }

  static func frame(_ el: AXUIElement) -> CGRect? {
    let a = members(el, [kAXPositionAttribute, kAXSizeAttribute]).values
    return frame(position: a[kAXPositionAttribute], size: a[kAXSizeAttribute])
  }

  static func windows(_ pid: pid_t) -> [AXUIElement] { attribute(application(pid), kAXWindowsAttribute) as? [AXUIElement] ?? [] }

  static func window(_ win: WindowInfo, candidates: [AXUIElement]? = nil) -> AXUIElement? {
    let windows = candidates ?? self.windows(win.key.pid)
    var fallback: [AXUIElement] = []
    for el in windows {
      var id: CGWindowID = 0
      if let get = windowNumber, get(el, &id) == .success, id != 0 {
        if id == win.key.id { return el }
      } else if frame(el) == win.frame,
                win.title.isEmpty || (attribute(el, kAXTitleAttribute) as? String) == win.title {
        fallback.append(el)
      }
    }
    return fallback.count == 1 ? fallback[0] : nil
  }

  static func hit(_ win: WindowInfo, _ point: CGPoint) -> AXUIElement? {
    let screen = win.screen(point)
    var el: AXUIElement?
    let r = AXUIElementCopyElementAtPosition(application(win.key.pid), Float(screen.x), Float(screen.y), &el)
    return r == .success && el.map { belongs($0, win) } == true ? el : nil
  }

  static func within(_ el: AXUIElement, _ ancestor: AXUIElement) -> Bool {
    var current: AXUIElement? = el
    for _ in 0..<32 {
      guard let node = current else { return false }
      if CFEqual(node, ancestor) { return true }
      current = asAX(attribute(node, kAXParentAttribute))
    }
    return false
  }

  static func range(_ value: CFTypeRef?) -> CFRange? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
  }

  static func selectedRange(_ el: AXUIElement) -> CFRange? { range(attribute(el, kAXSelectedTextRangeAttribute)) }

  static func belongs(_ el: AXUIElement, _ win: WindowInfo, root: AXUIElement? = nil) -> Bool {
    var pid: pid_t = 0
    guard AXUIElementGetPid(el, &pid) == .success, pid == win.key.pid else { return false }
    var wid: CGWindowID = 0
    if let get = windowNumber, get(el, &wid) == .success, wid != 0 { return wid == win.key.id }
    guard let root = root ?? window(win) else { return false }
    if let parentWindow = asAX(attribute(el, kAXWindowAttribute)) { return CFEqual(root, parentWindow) }
    var current: AXUIElement? = el
    for _ in 0..<64 {
      guard let node = current else { return false }
      if CFEqual(node, root) { return true }
      current = asAX(attribute(node, kAXParentAttribute))
    }
    return false
  }

  static func focused(_ win: WindowInfo, root: AXUIElement? = nil) -> AXUIElement? {
    guard let el = asAX(attribute(application(win.key.pid), kAXFocusedUIElementAttribute)), belongs(el, win, root: root) else { return nil }
    return el
  }

  static func focusedWindow(_ win: WindowInfo, root: AXUIElement? = nil) -> Bool {
    let app = application(win.key.pid)
    if let el = asAX(attribute(app, kAXFocusedWindowAttribute)) { return belongs(el, win, root: root) }
    // 창을 확실히 하나만 식별할 수 있는 앱에서는 명시적 AXFocusedWindow가 없어도 안전하다.
    let candidates = windows(win.key.pid)
    return candidates.count == 1 && window(win, candidates: candidates) != nil
  }

  static func insideWebArea(_ el: AXUIElement) -> Bool {
    var current: AXUIElement? = el
    for _ in 0..<32 {
      guard let node = current, let role = attribute(node, kAXRoleAttribute) as? String else { return false }
      if role == "AXWebArea" { return true }
      if role == kAXWindowRole || role == kAXApplicationRole { return false }
      current = asAX(attribute(node, kAXParentAttribute))
    }
    return false
  }

  static func editable(_ el: AXUIElement, role: String) -> Bool {
    switch role {
    case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox":
      if settable(el, kAXValueAttribute) || settable(el, kAXSelectedTextAttribute) { return true }
    default:
      if settable(el, kAXSelectedTextAttribute) { return true }
    }
    if let ancestor = asAX(attribute(el, "AXEditableAncestor")) {
      return CFEqual(el, ancestor) || settable(ancestor, kAXSelectedTextAttribute)
    }
    return false
  }
}

struct AXNode {
  let ref: String
  let identity: AXIdentity
  let parentIndex: Int?
  let depth: Int
  let role: String
  let label: String?
  let value: Any?
  let actions: [String]
  let settable: Bool
  let editable: Bool
  let focused: Bool?
  let enabled: Bool?
  let selected: Bool?
  let frame: CGRect?
  let visible: Bool
  let web: Bool

  var el: AXUIElement { identity.element }

  func json(valueLimit: Int, moreOutside: Int = 0) -> Object {
    var result: Object = ["ref": ref, "depth": depth, "role": role, "settable": settable, "editable": editable]
    if moreOutside > 0 { result["moreOutside"] = moreOutside }
    if let label { result["label"] = label }
    if let value = value as? String {
      let prefix = value.prefix(valueLimit)
      result["value"] = String(prefix)
      if prefix.endIndex != value.endIndex { result["valueMore"] = value.distance(from: prefix.endIndex, to: value.endIndex) }
    } else if let value { result["value"] = value }
    if !actions.isEmpty { result["actions"] = actions }
    if let focused { result["focused"] = focused }
    if let enabled { result["enabled"] = enabled }
    if let selected { result["selected"] = selected }
    if let frame { result["frame"] = frameJSON(frame) }
    return result
  }

  func changed(from other: AXNode) -> Bool {
    role != other.role || label != other.label || !jsonEqual(value, other.value) || actions != other.actions ||
      settable != other.settable || editable != other.editable || focused != other.focused || enabled != other.enabled || selected != other.selected
  }
}

struct AXTree {
  let root: AXUIElement?
  let nodes: [AXNode]
  let complete: Bool
  let windowTitle: String?
  var observable: Bool { nodes.contains { $0.visible && ($0.value != nil || $0.label != nil || $0.editable || !$0.actions.isEmpty) } }
  var web: Bool { nodes.contains(where: \.web) }

  var hasWebContents: Bool { nodes.contains { $0.web && $0.role != "AXWebArea" } }

  func hasEmptyContentGroup(in frame: CGRect) -> Bool {
    let parents = Set(nodes.compactMap(\.parentIndex))
    return nodes.enumerated().contains { index, node in
      guard node.role == kAXGroupRole, let rect = node.frame, node.visible, !parents.contains(index) else { return false }
      return rect.width >= frame.width * 0.75 && rect.height >= frame.height * 0.75
    }
  }

  func snapshot(find: String?, expand: AXNode?, limit: Int, valueLimit: Int) -> (elements: [Object], shown: [String: AXNode], omitted: Int, rootOutside: Int, hasOutside: Bool) {
    var include: Set<Int> = []
    for (i, node) in nodes.enumerated() where node.visible {
      if let find, ![node.role, node.label, valueText(node.value)].compactMap({ $0 }).contains(where: { $0.localizedCaseInsensitiveContains(find) }) { continue }
      var index: Int? = i
      while let j = index, include.insert(j).inserted { index = nodes[j].parentIndex }
    }
    let expandIndex = expand.flatMap { wanted in nodes.firstIndex { $0.ref == wanted.ref } }
    if let i = expandIndex {
      var index: Int? = i
      while let j = index, include.insert(j).inserted { index = nodes[j].parentIndex }
    }
    var outside: [Int: Int] = [:]
    var rootOutside = 0
    for (i, node) in nodes.enumerated() where !node.visible && !include.contains(i) {
      if let parent = node.parentIndex {
        if include.contains(parent) { outside[parent, default: 0] += 1 }
      } else if find == nil { rootOutside += 1 }
    }
    let ordered = include.sorted()
    let first = Array(ordered.prefix(limit - (expand != nil && expandIndex == nil ? 1 : 0)))
    var selected = first
    if let expandIndex, !selected.contains(expandIndex) { selected[selected.count - 1] = expandIndex }
    var shown: [String: AXNode] = [:]
    var items = selected.map { i in
      let node = nodes[i]
      shown[node.ref] = node
      return node.json(valueLimit: node.ref == expand?.ref ? 20_000 : valueLimit, moreOutside: outside[i] ?? 0)
    }
    if let expand, expandIndex == nil {
      items.append(expand.json(valueLimit: 20_000))
      shown[expand.ref] = expand
    }
    return (items, shown, max(0, ordered.count - selected.count), rootOutside, rootOutside != 0 || !outside.isEmpty)
  }
}

@MainActor final class AXSession {
  private struct Exposure {
    let identity: AXIdentity
    var actions: Set<String>
  }

  private var counter: UInt64 = 0
  private var identities: [WindowKey: [AXIdentity: String]] = [:]
  private var exposed: [WindowKey: [String: Exposure]] = [:]
  private var webEnabledAt: [pid_t: Date] = [:]
  private var probedWeb: Set<WindowKey> = []

  func publish(_ nodes: some Sequence<AXNode>, for key: WindowKey) {
    for node in nodes {
      if exposed[key]?[node.ref] != nil {
        exposed[key]?[node.ref]?.actions.formUnion(node.actions)
      } else {
        exposed[key, default: [:]][node.ref] = Exposure(identity: node.identity, actions: Set(node.actions))
      }
    }
  }

  func offered(_ name: String, for ref: String, in key: WindowKey) -> Bool {
    exposed[key]?[ref]?.actions.contains(name) == true
  }

  func resolve(_ ref: String, tree: AXTree, window win: WindowInfo) throws -> AXNode {
    guard let prior = exposed[win.key]?[ref], let root = tree.root else { throw HelperError("stale_element") }
    if let current = tree.nodes.first(where: { $0.ref == ref && $0.identity == prior.identity }), AXReader.belongs(current.el, win, root: root) {
      return current
    }
    // 스냅숏에서 보이지 않아도 실제 부모의 현재 자식으로 남아 있으면 같은 핸들이다.
    let el = prior.identity.element
    guard AXReader.matchesLive(prior.identity, in: win, root: root),
          let siblings = AXReader.attribute(prior.identity.parent, kAXChildrenAttribute) as? [AXUIElement],
          siblings.contains(where: { CFEqual(el, $0) }),
          let current = AXReader.node(prior.identity, ref: ref, attributes: AXReader.members(el, AXReader.nodeAttributes).values,
                                      win: win, parentIndex: nil, depth: 0, clip: win.localFrame,
                                      inWeb: AXReader.insideWebArea(el)) else { throw HelperError("stale_element") }
    return current
  }

  func canProbeWeb(_ key: WindowKey) -> Bool { probedWeb.insert(key).inserted }

  // Chromium의 렌더러 트리는 대상 앱에 보조 기술을 알리기 전까지 비어 있을 수 있다.
  func attemptWebAccessibility(_ win: WindowInfo) -> Bool {
    let pid = win.key.pid
    guard (win.engine == .chromium || win.engine == .electron), AXIsProcessTrusted(),
          let kernel = kernelLaunchDate(pid), webEnabledAt[pid] != kernel else { return false }
    webEnabledAt[pid] = kernel
    let app = AXReader.application(pid)
    let manual = AXReader.set(app, "AXManualAccessibility", kCFBooleanTrue)
    if manual == .attributeUnsupported {
      // Chrome은 상위 AX setter가 NotImplemented를 돌려줘도 내부 전환은 예약할 수 있다.
      _ = AXReader.set(app, "AXEnhancedUserInterface", kCFBooleanTrue)
    }
    return true
  }

  func prune(to alive: Set<WindowKey>) {
    identities = identities.filter { alive.contains($0.key) }
    exposed = exposed.filter { alive.contains($0.key) }
    probedWeb.formIntersection(alive)
    webEnabledAt = webEnabledAt.filter { kernelLaunchDate($0.key) == $0.value }
  }

  func read(_ win: WindowInfo, budgetMs: Int = 250) -> AXTree {
    guard AXIsProcessTrusted(), let root = AXReader.window(win),
          AXReader.attribute(root, kAXMinimizedAttribute) as? Bool != true else {
      return AXTree(root: nil, nodes: [], complete: false, windowTitle: nil)
    }
    let start = clockNow()
    var old = identities[win.key] ?? [:]
    var next: [AXIdentity: String] = [:]
    var visited: Set<AXIdentity> = []
    var nodes: [AXNode] = []
    var complete = true
    // 창 자체는 별도 window 메타데이터이고, 앱의 컨트롤만 요소 목록에 둔다.
    let top = AXReader.members(root, [kAXChildrenAttribute, kAXTitleAttribute])
    complete = !top.incomplete
    let title = top.values[kAXTitleAttribute] as? String
    func walk(_ el: AXUIElement, parent: AXUIElement, parentIndex: Int?, depth: Int, clip: CGRect, web: Bool) {
      guard depth < 64, nodes.count < 4_000, millis(since: start) < budgetMs else { complete = false; return }
      let identity = AXIdentity(element: el, parent: parent)
      guard visited.insert(identity).inserted else { return }
      let a = AXReader.members(el, AXReader.nodeAttributes)
      if a.incomplete { complete = false }
      let ref: String
      if let existing = old[identity] { ref = existing } else { counter += 1; ref = "e\(counter)" }
      guard let node = AXReader.node(identity, ref: ref, attributes: a.values, win: win, parentIndex: parentIndex,
                                    depth: depth, clip: clip, inWeb: web) else { complete = false; return }
      next[identity] = ref
      let index = nodes.count
      nodes.append(node)
      let nextClip: CGRect
      if node.role == kAXScrollAreaRole, let frame = node.frame { nextClip = clip.intersection(frame) } else { nextClip = clip }
      for child in AXReader.children(el, role: node.role, batched: a.values[kAXChildrenAttribute]) {
        if nodes.count >= 4_000 || millis(since: start) >= budgetMs { complete = false; break }
        walk(child, parent: el, parentIndex: index, depth: depth + 1, clip: nextClip, web: node.web)
      }
    }
    for child in AXReader.children(root, role: kAXWindowRole, batched: top.values[kAXChildrenAttribute]) {
      if nodes.count >= 4_000 || millis(since: start) >= budgetMs { complete = false; break }
      walk(child, parent: root, parentIndex: nil, depth: 0, clip: win.localFrame, web: false)
    }
    if complete {
      // 발급한 핸들은 누락된 한 번의 읽기 때문에 새 ID를 받지 않는다.
      let issued = exposed[win.key] ?? [:]
      old = old.filter { issued[$0.value] != nil }
    }
    old.merge(next) { _, new in new }
    identities[win.key] = old
    return AXTree(root: root, nodes: nodes, complete: complete, windowTitle: title)
  }
}
