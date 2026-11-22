import AppKit
import ApplicationServices
import Carbon
import Darwin

func loadSymbol<T>(_ name: String, _: T.Type) -> T? {
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
  return unsafeBitCast(symbol, to: T.self)
}

struct WindowSymbols {
  typealias SetLocation = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
  typealias PostRecord = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
  typealias MainConnection = @convention(c) () -> UInt32
  typealias Owner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
  typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
  typealias CopySpaces = @convention(c) (UInt32, Int32, CFArray) -> Unmanaged<CFArray>?
  typealias ActiveSpace = @convention(c) (UInt32) -> UInt64
  typealias DisplaySpaces = @convention(c) (UInt32) -> Unmanaged<CFArray>?

  let setLocation: SetLocation?
  private let postRecord: PostRecord?
  private let mainConnection: MainConnection?
  private let owner: Owner?
  private let connectionPSN: ConnectionPSN?
  private let copySpaces: CopySpaces?
  private let activeSpace: ActiveSpace?
  private let displaySpaces: DisplaySpaces?

  init(omitWindowLocation: Bool = false) {
    _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
    setLocation = omitWindowLocation ? nil : loadSymbol("CGEventSetWindowLocation", SetLocation.self)
    postRecord = loadSymbol("SLPSPostEventRecordTo", PostRecord.self)
    mainConnection = loadSymbol("CGSMainConnectionID", MainConnection.self)
    owner = loadSymbol("SLSGetWindowOwner", Owner.self)
    connectionPSN = loadSymbol("SLSGetConnectionPSN", ConnectionPSN.self)
    copySpaces = loadSymbol("SLSCopySpacesForWindows", CopySpaces.self)
    activeSpace = loadSymbol("SLSGetActiveSpace", ActiveSpace.self)
    displaySpaces = loadSymbol("SLSCopyManagedDisplaySpaces", DisplaySpaces.self)
  }

  var hasFocusRecord: Bool { postRecord != nil && mainConnection != nil && owner != nil && connectionPSN != nil }
  var json: Object { ["windowLocation": setLocation != nil, "focusRecord": hasFocusRecord] }

  func activeSpaces() -> Set<UInt64> {
    guard let cid = mainConnection?() else { return [] }
    let displays = displaySpaces?(cid)?.takeRetainedValue() as? [Object] ?? []
    let all = displays.compactMap { ($0["Current Space"] as? Object).flatMap { ($0["ManagedSpaceID"] as? NSNumber ?? $0["id64"] as? NSNumber)?.uint64Value } }
    if !all.isEmpty { return Set(all) }
    if let id = activeSpace?(cid), id != 0 { return [id] }
    return []
  }

  func windowSpaces(_ window: CGWindowID) -> Set<UInt64>? {
    guard let cid = mainConnection?(), let array = copySpaces?(cid, 0x7, [window] as CFArray)?.takeRetainedValue() as? [NSNumber], !array.isEmpty else { return nil }
    return Set(array.map(\.uint64Value))
  }

  func targetFocus(_ target: WindowInfo) throws {
    guard let postRecord, let mainConnection, let owner, let connectionPSN else { throw HelperError("self_check_failed", "focus_record_unavailable") }
    var connection: UInt32 = 0
    var psn = [UInt32](repeating: 0, count: 2)
    guard owner(mainConnection(), target.key.id, &connection) == 0, connection != 0,
          psn.withUnsafeMutableBytes({ connectionPSN(connection, $0.baseAddress!) }) == 0 else {
      throw HelperError.unavailable()
    }
    // 전면 PSN은 가져오지도 않는다. 대상 창을 소유한 PSN에 focus 레코드 하나만 보낸다.
    var record = [UInt8](repeating: 0, count: 0xF8)
    record[0x04] = 0xF8
    record[0x08] = 0x0D
    record[0x8A] = 0x01
    for i in 0..<4 { record[0x3C + i] = UInt8(truncatingIfNeeded: target.key.id >> (8 * i)) }
    guard psn.withUnsafeBytes({ p in record.withUnsafeBytes { postRecord(p.baseAddress!, $0.baseAddress!) } }) == 0 else {
      throw HelperError("timeout", "focus_delivery_unknown")
    }
  }
}

struct KeyStroke {
  let code: CGKeyCode
  let flags: CGEventFlags

  private static let named: [String: Int] = [
    "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape, "esc": kVK_Escape,
    "backspace": kVK_Delete, "delete": kVK_ForwardDelete, "forwarddelete": kVK_ForwardDelete,
    "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow, "right": kVK_RightArrow,
    "arrowup": kVK_UpArrow, "arrowdown": kVK_DownArrow, "arrowleft": kVK_LeftArrow, "arrowright": kVK_RightArrow,
    "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown, "space": kVK_Space,
    "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
    "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
  ]
  private static let characters: [Character: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
    "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
    "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
    "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
    "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
    "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5,
    "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9, "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal,
    "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket, "\\": kVK_ANSI_Backslash, ";": kVK_ANSI_Semicolon,
    "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash, "`": kVK_ANSI_Grave,
  ]

  init(_ spec: String) throws {
    let parts = spec.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    guard let key = parts.last, !key.isEmpty else { throw HelperError("invalid_key") }
    var flags: CGEventFlags = []
    for mod in parts.dropLast() {
      let flag: CGEventFlags
      switch mod {
      case "cmd", "command": flag = .maskCommand
      case "shift": flag = .maskShift
      case "ctrl", "control": flag = .maskControl
      case "alt", "option": flag = .maskAlternate
      default: throw HelperError("invalid_key")
      }
      guard !flags.contains(flag) else { throw HelperError("invalid_key") }
      flags.insert(flag)
    }
    if let named = Self.named[key] { code = CGKeyCode(named) }
    else if key.count == 1, let character = key.first {
      guard !flags.isEmpty else { throw HelperError("text_via_key") }
      guard let mapped = Self.characters[character] else { throw HelperError("invalid_key") }
      code = CGKeyCode(mapped)
    } else { throw HelperError("invalid_key") }
    self.flags = flags
  }

  var paste: Bool { code == CGKeyCode(kVK_ANSI_V) && flags == .maskCommand }
  var selectAll: Bool { code == CGKeyCode(kVK_ANSI_A) && flags == .maskCommand }
}

enum PointerAction { case click, doubleClick, rightClick, drag(CGPoint), scroll(AICursorPulse.Direction, Double) }

struct EventSequence {
  struct Step {
    let event: CGEvent
    let delayAfter: Int
  }
  let beforeFocusPrimer: [Step]
  let events: [Step]
  let needsFocus: Bool

  @MainActor func send(to win: WindowInfo, using symbols: WindowSymbols, revalidate: () throws -> Void) async throws {
    try Task.checkCancellation()
    try revalidate()
    if needsFocus {
      try symbols.targetFocus(win)
      try await pause(50)
    }
    for step in beforeFocusPrimer {
      step.event.postToPid(win.key.pid)
      if step.delayAfter > 0 { try await pause(step.delayAfter) }
    }
    // 프라이머 도중 창이 사라졌다면 실제 제스처/키 입력은 시작하지 않는다.
    try revalidate()
    for step in events {
      step.event.postToPid(win.key.pid)
      if step.delayAfter > 0 { try await pause(step.delayAfter) }
    }
  }
}

struct EventFactory {
  let symbols: WindowSymbols

  private func stamp(_ event: CGEvent, win: WindowInfo, point: CGPoint) throws {
    guard let setLocation = symbols.setLocation else { throw HelperError("self_check_failed", "window_location_unavailable") }
    event.setIntegerValueField(CGEventField(rawValue: 40)!, value: Int64(win.key.pid))
    for field: UInt32 in [51, 91, 92] { event.setIntegerValueField(CGEventField(rawValue: field)!, value: Int64(win.key.id)) }
    setLocation(Unmanaged.passUnretained(event).toOpaque(), point)
  }

  private func mouse(_ type: CGEventType, win: WindowInfo, point: CGPoint, count: Int64 = 0,
                     button: CGMouseButton = .left, offscreen: Bool = false, delay: Int = 0) throws -> EventSequence.Step {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: offscreen ? point : win.screen(point), mouseButton: button) else { throw HelperError("internal", "event_creation_failed") }
    event.flags = []
    event.setIntegerValueField(.mouseEventClickState, value: count)
    try stamp(event, win: win, point: point)
    return .init(event: event, delayAfter: delay)
  }

  private func focusPrimer(_ win: WindowInfo) throws -> [EventSequence.Step] {
    let off = CGPoint(x: -1, y: -1)
    return [try mouse(.leftMouseDown, win: win, point: off, count: 1, offscreen: true, delay: 1),
            try mouse(.leftMouseUp, win: win, point: off, count: 1, offscreen: true, delay: 100)]
  }

  func pointer(_ action: PointerAction, win: WindowInfo, point: CGPoint, focus: Bool) throws -> EventSequence {
    var primer = [try mouse(.mouseMoved, win: win, point: point, delay: 15)]
    if focus { primer += try focusPrimer(win) }
    var actual: [EventSequence.Step] = []
    switch action {
    case .click, .doubleClick, .rightClick:
      let isRight: Bool = { if case .rightClick = action { return true }; return false }()
      let count: Int64 = { if case .doubleClick = action { return 2 }; return 1 }()
      for index in 1...count {
        actual.append(try mouse(isRight ? .rightMouseDown : .leftMouseDown, win: win, point: point, count: index,
                                button: isRight ? .right : .left, delay: 28))
        actual.append(try mouse(isRight ? .rightMouseUp : .leftMouseUp, win: win, point: point, count: index,
                                button: isRight ? .right : .left, delay: index < count ? 28 : 0))
      }
    case .drag(let end):
      actual.append(try mouse(.leftMouseDown, win: win, point: point, count: 1, delay: 30))
      for i in 1...20 {
        let t = CGFloat(i) / 20
        let p = CGPoint(x: point.x + (end.x - point.x) * t, y: point.y + (end.y - point.y) * t)
        actual.append(try mouse(.leftMouseDragged, win: win, point: p, count: 1, delay: 16))
      }
      actual.append(try mouse(.leftMouseUp, win: win, point: end, count: 1))
    case .scroll(let direction, let pages):
      let distance = Int32(min(Double(Int32.max), max(1, (pages * win.frame.height * 0.8).rounded())))
      let vertical: Int32 = direction == .up ? distance : direction == .down ? -distance : 0
      let horizontal: Int32 = direction == .left ? distance : direction == .right ? -distance : 0
      guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: horizontal == 0 ? 1 : 2,
                            wheel1: vertical, wheel2: horizontal, wheel3: 0) else { throw HelperError("internal", "event_creation_failed") }
      e.flags = []
      e.location = win.screen(point)
      try stamp(e, win: win, point: point)
      actual.append(.init(event: e, delayAfter: 0))
    }
    return EventSequence(beforeFocusPrimer: primer, events: actual, needsFocus: focus)
  }

  /// 대상 창만 AppKit key로 만드는 프라이머. 대상 창을 소유한 PSN에 focus 레코드를 보낸 뒤, 화면·창 밖 좌표 (-1,-1)의 왼쪽 클릭
  /// 한 번을 창 번호·pid를 찍어 그 프로세스에만 보낸다(postToPid). 좌표가 콘텐츠 밖이라 페이지에는 아무 이벤트도 닿지 않는다.
  /// 포인터를 옮기지 않고, 앱을 활성화하지 않으며, HID·세션 탭에는 보내지 않는다(e7e293ee m3: 사람 상태 78행 불변).
  func windowPrimer(_ win: WindowInfo) throws -> EventSequence {
    EventSequence(beforeFocusPrimer: try focusPrimer(win), events: [], needsFocus: true)
  }

  func typing(_ text: String, focus: Bool) throws -> EventSequence {
    let count = text.count
    let delay = min(8, 350 / max(1, count))
    let actual = try text.flatMap { char -> [EventSequence.Step] in
      let unicode = Array(String(char).utf16)
      return try [true, false].map { down in
        let event = try keyboard(0, down: down, flags: [])
        event.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: unicode)
        return .init(event: event, delayAfter: delay)
      }
    }
    return EventSequence(beforeFocusPrimer: [], events: actual, needsFocus: focus)
  }

  private func keyboard(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) throws -> CGEvent {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { throw HelperError("internal", "event_creation_failed") }
    event.flags = flags
    return event
  }

  func key(_ stroke: KeyStroke, focus: Bool) throws -> EventSequence {
    let events = try [true, false].map { down in
      EventSequence.Step(event: try keyboard(stroke.code, down: down, flags: stroke.flags), delayAfter: down ? 20 : 0)
    }
    return .init(beforeFocusPrimer: [], events: events, needsFocus: focus)
  }
}
