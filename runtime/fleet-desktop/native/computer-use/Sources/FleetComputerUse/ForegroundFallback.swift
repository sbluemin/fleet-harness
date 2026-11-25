import AppKit
import ApplicationServices
import Carbon

/// 에이전트가 `foreground`로 명시할 때만 쓰는 전면 폴백. 백그라운드 입력을 버리는 창(가상 머신 게스트 화면 등)과 원격 패널(저장·열기 시트)용이다.
/// 대상 앱을 잠깐 앞으로 올리고 SkyLight `SLEventPostToPid`로 보낸 뒤 직전 앱으로 되돌린다. 실제 포인터는 옮기지 않는다.
/// 근거(44f8f9a9 실측): VM 창은 비활성 SL 클릭 0/10, 활성화 뒤 4/4(커서 불변). 시트는 패널 서비스 pid·내용 창으로 보낼 때만 활성화 뒤 성공.
/// 자동 재시도하지 않는다. 이미 눌린 입력을 다시 보내지 않도록 호출자가 결과를 보고 고른다.
struct ForegroundRoute: Equatable {
  let pid: pid_t
  let window: CGWindowID
  let frame: CGRect
}

enum Foreground {
  private typealias Post = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Void
  private typealias SetFront = @convention(c) (UnsafeRawPointer, CGWindowID, UInt32) -> Int32
  private typealias SetLocation = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
  private typealias MainConnection = @convention(c) () -> UInt32
  private typealias Owner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
  private typealias WindowNumber = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

  private static let loaded: Bool = { dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL) != nil }()
  private static func symbol<T>(_ name: String, _ type: T.Type) -> T? { _ = loaded; return loadSymbol(name, type) }
  private static let post = symbol("SLEventPostToPid", Post.self)
  private static let setFront = symbol("_SLPSSetFrontProcessWithOptions", SetFront.self)
  private static let setLocation = symbol("CGEventSetWindowLocation", SetLocation.self)
  private static let mainConnection = symbol("CGSMainConnectionID", MainConnection.self)
  private static let owner = symbol("SLSGetWindowOwner", Owner.self)
  private static let connectionPSN = symbol("SLSGetConnectionPSN", ConnectionPSN.self)
  private static let windowNumber = symbol("_AXUIElementGetWindow", WindowNumber.self)
  /// kCPSUserGenerated: 사람이 고른 것처럼 앞으로 올린다(yabai의 창 포커스와 같은 값).
  private static let userGenerated: UInt32 = 0x200

  static var available: Bool { post != nil && setFront != nil && setLocation != nil && mainConnection != nil && owner != nil && connectionPSN != nil }

  // MARK: 대상 경로

  /// 원격 뷰(시트의 저장 패널 등)는 다른 프로세스의 창이 그린다. 그 위치·포커스의 요소가 다른 프로세스 창에 있으면 그쪽으로 보낸다.
  static func route(_ win: WindowInfo, point: CGPoint?) -> ForegroundRoute {
    let own = ForegroundRoute(pid: win.key.pid, window: win.key.id, frame: win.frame)
    let app = AXReader.application(win.key.pid)
    var element: AXUIElement?
    if let point {
      let screen = win.screen(point)
      guard AXUIElementCopyElementAtPosition(app, Float(screen.x), Float(screen.y), &element) == .success else { return own }
      // 앱 단위 적중 검사는 시트(AXSheet)에서 멈추고 원격 패널 안으로 내려가지 않는다(eb7cf15c 실측). 점을 담은 자식으로 끝까지 내려간다.
      element = element.map { deepest($0, at: screen) }
    } else if let root = AXReader.window(win),
              let sheet = (AXReader.attribute(root, kAXChildrenAttribute) as? [AXUIElement])?.first(where: { AXReader.attribute($0, kAXRoleAttribute) as? String == "AXSheet" }),
              let frame = AXReader.frame(sheet) {
      // 시트가 열린 창의 키는 시트가 받는다. 앱의 포커스 요소는 원격 패널을 가리키지 않아(eb7cf15c 실측) 시트 내용 창을 찾는다.
      element = deepest(sheet, at: CGPoint(x: frame.midX, y: frame.midY))
    } else {
      element = asAX(AXReader.attribute(app, kAXFocusedUIElementAttribute))
    }
    var wid: CGWindowID = 0
    guard let element, let windowNumber, windowNumber(element, &wid) == .success, wid != 0, wid != win.key.id,
          // 패널 서비스의 내용 창은 화면 밖으로 보고되어 optionIncludingWindow에 나오지 않는다. 전체 목록에서 찾는다.
          let row = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [Object])?
            .first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == wid }),
          let pid = row[kCGWindowOwnerPID as String] as? pid_t,
          let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds) else { return own }
    return remote(own, owner: pid, window: wid, frame: frame)
  }

  private static func deepest(_ start: AXUIElement, at screen: CGPoint) -> AXUIElement {
    var current = start
    for _ in 0..<32 {
      let children = AXReader.attribute(current, kAXChildrenAttribute) as? [AXUIElement] ?? []
      guard let next = children.last(where: { AXReader.frame($0)?.contains(screen) == true }) else { break }
      current = next
    }
    return current
  }

  /// 같은 앱의 다른 창(겹친 창 등)으로는 돌리지 않는다. 다른 프로세스가 그린 원격 뷰일 때만 돌린다.
  static func remote(_ own: ForegroundRoute, owner: pid_t, window: CGWindowID, frame: CGRect) -> ForegroundRoute {
    owner == own.pid || owner <= 0 || frame.isEmpty ? own : ForegroundRoute(pid: owner, window: window, frame: frame)
  }

  // MARK: 사람 입력

  /// 사람이 키보드·마우스를 쓰는 중이면 그 입력이 대상 앱으로 샐 수 있다. 짧게 쉬는 틈을 기다리고, 없으면 보내지 않는다.
  static func waitForIdle(_ idle: Double = 0.4, within: Double = 2.0) async throws {
    let deadline = clockNow() + within
    while true {
      let since = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
      if since >= idle { return }
      guard clockNow() + (idle - since) < deadline else { throw HelperError("user_busy") }
      try await pause(Int(((idle - since) * 1000).rounded(.up)) + 10)
    }
  }

  // MARK: 활성화와 복원

  struct Session {
    let previous: NSRunningApplication?
    let previousWindow: CGWindowID?
    let switched: Bool
    let started: Double
  }

  private static func psn(forWindow wid: CGWindowID) -> [UInt32]? {
    guard let mainConnection, let owner, let connectionPSN else { return nil }
    var connection: UInt32 = 0
    var psn = [UInt32](repeating: 0, count: 2)
    guard owner(mainConnection(), wid, &connection) == 0, connection != 0,
          psn.withUnsafeMutableBytes({ connectionPSN(connection, $0.baseAddress!) }) == 0 else { return nil }
    return psn
  }

  private static func front(_ pid: pid_t, window wid: CGWindowID) -> Bool {
    guard let setFront, let psn = psn(forWindow: wid) else { return false }
    return psn.withUnsafeBytes { setFront($0.baseAddress!, wid, userGenerated) } == 0
  }

  static func frontWindow(of pid: pid_t) -> CGWindowID? {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Object] ?? []
    return rows.first { $0[kCGWindowOwnerPID as String] as? pid_t == pid && $0[kCGWindowLayer as String] as? Int == 0 }
      .flatMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
  }

  private static func waitFront(_ pid: pid_t, ms: Int) async -> Bool {
    let deadline = clockNow() + Double(ms) / 1000
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
      guard clockNow() < deadline else { return false }
      try? await pause(15)
    }
    return true
  }

  /// 대상 창을 앞으로 올린다. 이미 앞이면 아무것도 바꾸지 않는다.
  @MainActor static func activate(_ win: WindowInfo, keyboard: Bool, symbols: WindowSymbols) async throws -> Session {
    let previous = NSWorkspace.shared.frontmostApplication
    let started = clockNow()
    if previous?.processIdentifier == win.key.pid {
      return Session(previous: nil, previousWindow: nil, switched: false, started: started)
    }
    let session = Session(previous: previous, previousWindow: previous.flatMap { frontWindow(of: $0.processIdentifier) }, switched: true, started: started)
    // 가상 머신(eb7cf15c 실측): 앱 활성화(activate) 뒤에는 키가 첫 입력부터 닿았고(KT2 4/4, V5·V6·V8), SkyLight 전면 지정 뒤에는 키가
    // 하나도 닿지 않았다(KT 0/4). 왼쪽 클릭은 두 방식 모두 첫 클릭부터 정확했다(6/6). 입력 종류에 맞는 쪽을 먼저 쓰고, 안 되면 다른 쪽으로 올린다.
    let byActivate = { NSRunningApplication(processIdentifier: win.key.pid)?.activate(options: []) == true }
    let bySkyLight = { front(win.key.pid, window: win.key.id) }
    var fronted = false
    for raise in keyboard ? [byActivate, bySkyLight] : [bySkyLight, byActivate] where !fronted {
      if raise() { fronted = await waitFront(win.key.pid, ms: 400) }
    }
    guard fronted else {
      _ = await restore(session)
      throw HelperError("foreground_unavailable")
    }
    try? symbols.targetFocus(win)
    return session
  }

  /// 대상 앱이 아직 앞일 때만 직전 앱으로 되돌린다. 그사이 사람이 다른 앱으로 옮겼으면 그대로 둔다.
  @MainActor static func restore(_ session: Session) async -> Bool {
    guard session.switched, let previous = session.previous, !previous.isTerminated else { return true }
    let now = NSWorkspace.shared.frontmostApplication
    if now?.processIdentifier == previous.processIdentifier { return true }
    if let wid = session.previousWindow, front(previous.processIdentifier, window: wid) {
      if await waitFront(previous.processIdentifier, ms: 400) { return true }
    }
    _ = previous.activate(options: [])
    return await waitFront(previous.processIdentifier, ms: 400)
  }

  // MARK: 이벤트

  static func asciiKeys(_ text: String) -> [KeyStroke]? {
    var out: [KeyStroke] = []
    for char in text.replacingOccurrences(of: "\r\n", with: "\n") {
      guard let stroke = KeyStroke.ascii(char) else { return nil }
      out.append(stroke)
    }
    return out
  }

  private static func stamp(_ event: CGEvent, route: ForegroundRoute, local: CGPoint, phase: Int64, group: Int64) {
    let raw = Unmanaged.passUnretained(event).toOpaque()
    for (field, value) in [(0, phase), (3, 0), (7, 3), (40, Int64(route.pid)), (51, Int64(route.window)), (91, Int64(route.window)),
                           (92, Int64(route.window)), (58, group)] as [(UInt32, Int64)] {
      event.setIntegerValueField(CGEventField(rawValue: field)!, value: value)
    }
    setLocation?(raw, local)
  }

  private static func send(_ event: CGEvent, to pid: pid_t) {
    post?(pid, Unmanaged.passUnretained(event).toOpaque())
  }

  /// 왼쪽 클릭. 같은 자리로 이동 이벤트를 두 번 먼저 보낸다. 화면 밖 프라이머 클릭은 게스트에 실제 클릭으로 들어가므로(44f8f9a9 13a) 보내지 않는다.
  static func click(route: ForegroundRoute, screen: CGPoint, sent: () -> Void) async throws {
    let local = CGPoint(x: screen.x - route.frame.minX, y: screen.y - route.frame.minY)
    let group = Int64(clockNow() * 1000) & 0xffff_ffff
    // 출처 없이 만든다. HID 상태 출처의 클릭은 원격 시트 패널이 버렸다(eb7cf15c 실측). 가상 머신은 둘 다 받았다.
    func mouse(_ type: CGEventType, count: Int64, phase: Int64) throws -> CGEvent {
      guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: screen, mouseButton: .left) else {
        throw HelperError("internal", "event_creation_failed")
      }
      e.flags = []
      stamp(e, route: route, local: local, phase: phase, group: group)
      e.setIntegerValueField(.mouseEventClickState, value: count)
      return e
    }
    for _ in 0..<2 { send(try mouse(.mouseMoved, count: 0, phase: 2), to: route.pid); try await pause(60) }
    sent()
    send(try mouse(.leftMouseDown, count: 1, phase: 3), to: route.pid)
    try await pause(28)
    send(try mouse(.leftMouseUp, count: 1, phase: 3), to: route.pid)
  }

  /// 키는 HID 상태 출처로 만든다(가상 머신에서 실측한 조합).
  static func keys(_ strokes: [KeyStroke], route: ForegroundRoute, sent: () -> Void) async throws {
    let source = CGEventSource(stateID: .hidSystemState)
    sent()
    for (i, stroke) in strokes.enumerated() {
      for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: stroke.code, keyDown: down) else { throw HelperError("internal", "event_creation_failed") }
        e.flags = stroke.flags
        send(e, to: route.pid)
        try await pause(down ? 25 : (i + 1 < strokes.count ? 12 : 0))
      }
    }
  }
}
