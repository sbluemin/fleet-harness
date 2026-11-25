import AppKit
import ApplicationServices

/// 가상 머신 창의 게스트 화면. Parallels Desktop은 백그라운드 입력(postToPid·focus 레코드)을 게스트에 넘기지 않고 버린다.
/// 키·텍스트는 Parallels가 활성 앱일 때만, 마우스는 실제 HID 포인터로 온 이벤트만 게스트에 닿았다
/// (18a642fb m1 실측: 게스트 페이지 pointerdown/keydown 기록기, 일반 맥 앱 대조군은 백그라운드 정상).
/// 게스트 화면은 접근성 트리에 요소가 없어 적중 검사가 창 자체를 돌려주는 영역이다. 도구 막대 같은 Parallels 자체 요소는 그대로 백그라운드로 다룬다.
enum GuestDisplay {
  static let bundleIds: Set<String> = ["com.parallels.desktop.console"]

  /// 입력이 게스트 화면으로 가는가. bareWindow: 포인터는 적중 요소가 창 자체(또는 없음), 키·텍스트는 창 안에 편집 가능한 AX 포커스가 없음.
  static func receives(bundleId: String, target: Bool, bareWindow: Bool) -> Bool {
    bundleIds.contains(bundleId) && !target && bareWindow
  }
}

/// 백그라운드 경로로는 닿지 않는 입력을 보낸 것처럼 보고하지 않는다. 전면 전달은 사람의 전면 앱과 포인터를 가져가므로
/// 호출자가 foreground로 명시했을 때만 쓴다.
enum InputRoute: Equatable {
  case background
  case foreground

  static func decide(guest: Bool, foreground: Bool) throws -> Self {
    switch (guest, foreground) {
    case (false, false): return .background
    case (true, true): return .foreground
    case (true, false): throw HelperError("needs_foreground")
    case (false, true): throw HelperError("invalid_params", "foreground applies only to a virtual machine display")
    }
  }
}

/// 게스트 화면 전면 전달. 앱을 활성화하고 대상 창이 그 점의 맨 위 창인지 확인한 뒤, 포인터는 HID 탭(실제 커서)으로,
/// 키·텍스트는 그 프로세스에만(postToPid) 보낸다. 포인터는 보낸 뒤 원래 자리로 돌려놓고, 전면 앱은 되돌리지 않는다.
@MainActor struct ForegroundDelivery {
  let win: WindowInfo
  let root: AXUIElement?

  /// 활성화를 확인하지 못하면 입력을 보내지 않는다. 사람의 다른 창이 그 점을 덮고 있으면 HID 클릭이 그 창에 가므로 거절한다.
  func bringToFront(point: CGPoint?) async throws {
    guard let app = NSRunningApplication(processIdentifier: win.key.pid), !app.isTerminated else { throw HelperError.unavailable("closed") }
    if let root { AXUIElementPerformAction(root, kAXRaiseAction as CFString) }
    _ = app.activate(options: [])
    var fallback = false
    for attempt in 0..<20 {
      if ready(app, point: point) { return }
      // 협조형 활성화가 거절되면 LaunchServices로 한 번 더 앞으로 올린다(computer_open activate와 같은 경로).
      if attempt == 6, !fallback, !app.isActive, let url = app.bundleURL {
        fallback = true
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
      }
      try await pause(50)
    }
    throw HelperError("foreground_unconfirmed", details: ["reason": app.isActive ? "covered" : "not_active"])
  }

  private func ready(_ app: NSRunningApplication, point: CGPoint?) -> Bool {
    guard app.isActive else { return false }
    guard let point else { return AXReader.focusedWindow(win, root: root) }
    return Self.topWindow(at: win.screen(point)) == win.key.id
  }

  /// 그 화면 점에서 맨 위에 그려진 창. 헬퍼 자신의 창(AI 커서)과 투명한 창은 건너뛴다.
  static func topWindow(at screen: CGPoint) -> CGWindowID? {
    let own = getpid()
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Object] ?? []
    for row in rows {
      guard row[kCGWindowOwnerPID as String] as? pid_t != own, (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let bounds = row[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds), rect.contains(screen) else { continue }
      return (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }
    return nil
  }

  func pointerEvents(_ action: PointerAction, at point: CGPoint) throws -> [EventSequence.Step] {
    let screen = win.screen(point)
    func mouse(_ type: CGEventType, count: Int64 = 0, button: CGMouseButton = .left, delay: Int = 0) throws -> EventSequence.Step {
      guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: screen, mouseButton: button) else {
        throw HelperError("internal", "event_creation_failed")
      }
      event.flags = []
      event.setIntegerValueField(.mouseEventClickState, value: count)
      return .init(event: event, delayAfter: delay, hid: true)
    }
    var steps = [try mouse(.mouseMoved, delay: 30)]
    switch action {
    case .click, .doubleClick, .rightClick:
      let right: Bool = { if case .rightClick = action { return true }; return false }()
      let count: Int64 = { if case .doubleClick = action { return 2 }; return 1 }()
      for index in 1...count {
        steps.append(try mouse(right ? .rightMouseDown : .leftMouseDown, count: index, button: right ? .right : .left, delay: 40))
        steps.append(try mouse(right ? .rightMouseUp : .leftMouseUp, count: index, button: right ? .right : .left, delay: index < count ? 40 : 0))
      }
    case .scroll(let direction, let pages):
      let distance = Int32(min(Double(Int32.max), max(1, (pages * win.frame.height * 0.8).rounded())))
      let vertical: Int32 = direction == .up ? distance : direction == .down ? -distance : 0
      let horizontal: Int32 = direction == .left ? distance : direction == .right ? -distance : 0
      guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: horizontal == 0 ? 1 : 2,
                                wheel1: vertical, wheel2: horizontal, wheel3: 0) else { throw HelperError("internal", "event_creation_failed") }
      event.flags = []
      event.location = screen
      steps.append(.init(event: event, delayAfter: 0, hid: true))
    case .drag:
      throw HelperError("drag_unsupported", details: ["settableSlider": false])
    }
    return steps
  }
}
