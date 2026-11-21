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

  func resolve(_ ref: String, latest: [String: AXNode]) throws -> AXNode {
    guard let old = latest[ref], let current = nodes.first(where: { $0.ref == ref }), current.identity == old.identity else {
      throw HelperError("stale_element")
    }
    return current
  }

  func snapshot(find: String?, expand: String?, limit: Int, valueLimit: Int) -> (elements: [Object], shown: [String: AXNode], omitted: Int, rootOutside: Int, hasOutside: Bool) {
    var include: Set<Int> = []
    for (i, node) in nodes.enumerated() where node.visible {
      if let find, ![node.role, node.label, valueText(node.value)].compactMap({ $0 }).contains(where: { $0.localizedCaseInsensitiveContains(find) }) { continue }
      var index: Int? = i
      while let j = index, include.insert(j).inserted { index = nodes[j].parentIndex }
    }
    if let expand, let i = nodes.firstIndex(where: { $0.ref == expand }) {
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
    var shown: [String: AXNode] = [:]
    let items = ordered.prefix(limit).map { i in
      let node = nodes[i]
      shown[node.ref] = node
      return node.json(valueLimit: node.ref == expand ? 20_000 : valueLimit, moreOutside: outside[i] ?? 0)
    }
    return (items, shown, max(0, ordered.count - limit), rootOutside, rootOutside != 0 || !outside.isEmpty)
  }
}

@MainActor final class AXSession {
  private var counter: UInt64 = 0
  private var identities: [WindowKey: [AXIdentity: String]] = [:]
  private(set) var latest: [WindowKey: [String: AXNode]] = [:]

  func publish(_ nodes: [String: AXNode], for key: WindowKey) { latest[key] = nodes }

  func prune(to alive: Set<WindowKey>) {
    identities = identities.filter { alive.contains($0.key) }
    latest = latest.filter { alive.contains($0.key) }
  }

  func read(_ win: WindowInfo, budgetMs: Int = 250) -> AXTree {
    guard AXIsProcessTrusted(), let root = AXReader.window(win),
          AXReader.attribute(root, kAXMinimizedAttribute) as? Bool != true else {
      return AXTree(root: nil, nodes: [], complete: false, windowTitle: nil)
    }
    let start = clockNow()
    let attrs = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXChildrenAttribute,
                 kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute, kAXEnabledAttribute, kAXSelectedAttribute,
                 "AXPlaceholderValue", "AXTitleUIElement"]
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
      let a = AXReader.members(el, attrs)
      if a.incomplete { complete = false }
      guard let role = a.values[kAXRoleAttribute] as? String else { complete = false; return }
      let isWeb = web || role == "AXWebArea"
      let frame = AXReader.frame(position: a.values[kAXPositionAttribute], size: a.values[kAXSizeAttribute])?
        .offsetBy(dx: -win.frame.minX, dy: -win.frame.minY)
      let visible = frame.map { !$0.isEmpty && clip.intersects($0) } ?? true
      let actions = AXReader.actions(el).filter { $0 != kAXRaiseAction }
      let value = axJSONValue(a.values[kAXValueAttribute])
      let label = ([a.values[kAXTitleAttribute], a.values[kAXDescriptionAttribute], a.values["AXPlaceholderValue"]]
        .compactMap { $0 as? String }.first { !$0.isEmpty }) ?? asAX(a.values["AXTitleUIElement"]).flatMap {
          AXReader.attribute($0, kAXValueAttribute) as? String ?? AXReader.attribute($0, kAXTitleAttribute) as? String
        }
      let settable = value != nil && AXReader.settable(el, kAXValueAttribute)
      let editable = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXWebArea"].contains(role) && AXReader.editable(el, role: role)
      let ref: String
      if let existing = old[identity] { ref = existing } else { counter += 1; ref = "e\(counter)" }
      next[identity] = ref
      let index = nodes.count
      nodes.append(AXNode(ref: ref, identity: identity, parentIndex: parentIndex, depth: depth, role: role, label: label,
                          value: value, actions: actions, settable: settable, editable: editable,
                          focused: a.values[kAXFocusedAttribute] as? Bool, enabled: a.values[kAXEnabledAttribute] as? Bool,
                          selected: a.values[kAXSelectedAttribute] as? Bool, frame: frame, visible: visible, web: isWeb))
      let nextClip: CGRect
      if role == kAXScrollAreaRole, let frame { nextClip = clip.intersection(frame) } else { nextClip = clip }
      for child in (a.values[kAXChildrenAttribute] as? [AXUIElement] ?? []) {
        if nodes.count >= 4_000 || millis(since: start) >= budgetMs { complete = false; break }
        walk(child, parent: el, parentIndex: index, depth: depth + 1, clip: nextClip, web: isWeb)
      }
    }
    for child in (top.values[kAXChildrenAttribute] as? [AXUIElement] ?? []) {
      if nodes.count >= 4_000 || millis(since: start) >= budgetMs { complete = false; break }
      walk(child, parent: root, parentIndex: nil, depth: 0, clip: win.localFrame, web: false)
    }
    if complete { identities[win.key] = next }
    else { old.merge(next) { _, new in new }; identities[win.key] = old }
    return AXTree(root: root, nodes: nodes, complete: complete, windowTitle: title)
  }
}
