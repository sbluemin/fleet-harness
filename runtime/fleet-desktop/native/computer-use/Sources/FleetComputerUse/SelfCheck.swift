import AppKit
import ApplicationServices

/// TCC는 이 헬퍼가 아니라 헬퍼를 띄운 앱(책임 프로세스)의 이름으로 권한을 판정한다. 설치본은 Fleet Console,
/// pnpm dev는 Fleet Console Dev, 터미널에서 띄운 Console은 그 터미널이다. 안내가 그 이름을 가리키도록 읽어 둔다.
/// 비공개 함수라 없거나 앱이 아니면 nil이고, 그때 안내는 이름 없이 나간다.
private let permissionHolderApp: (pid: pid_t, name: String)? = {
  typealias Responsible = @convention(c) (pid_t) -> pid_t
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
  let pid = unsafeBitCast(symbol, to: Responsible.self)(getpid())
  guard pid > 0, let name = NSRunningApplication(processIdentifier: pid)?.localizedName, !name.isEmpty else { return nil }
  return (pid, name)
}()
let permissionHolder = permissionHolderApp?.name

/// 판정 대상 앱이 이 헬퍼를 띄운 Console의 조상인지. 그렇다면 화면 기록을 켠 뒤 macOS가 권하는 "종료 후 다시 열기"가
/// 그 Console과 지금 세션을 함께 끝낸다. 부모를 따라 올라가 확인하고, 확인하지 못하면 false다.
let permissionHolderHostsConsole: Bool = {
  guard let holder = permissionHolderApp?.pid else { return false }
  var pid = getppid()
  for _ in 0..<32 {
    if pid == holder { return true }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard pid > 1, sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return false }
    pid = info.kp_eproc.e_ppid
  }
  return false
}()

struct HelperPermissions {
  static let names = ["accessibility", "screenRecording"]
  let accessibility = AXIsProcessTrusted()
  let screenRecording = CGPreflightScreenCaptureAccess()
  var missing: [String] { [("accessibility", accessibility), ("screenRecording", screenRecording)].compactMap { $0.1 ? nil : $0.0 } }
  var allowed: Bool { missing.isEmpty }
  /// 어느 경로에서 막혀도 빠진 권한을 전부 함께 알린다. 하나씩 알리면 사람이 허용과 재시도를 여러 번 오가게 된다.
  var error: HelperError {
    var details: Object = ["missing": missing]
    if let permissionHolder { details["holder"] = permissionHolder }
    if permissionHolderHostsConsole { details["holderHostsSession"] = true }
    return HelperError("permission_required", details: details)
  }
  var json: Object { ["accessibility": accessibility, "screenRecording": screenRecording] }

  /// 빠진 권한을 macOS 요청 창으로 묻는다. 창과 시스템 설정 목록에는 판정 대상 앱이 올라가므로 사람이 + 로 추가하지 않아도 된다.
  /// 팀 ID로 서명한 앱에서는 화면 기록도 이 요청으로 "화면 기록" 창이 뜨고 목록에 오른다(macOS 26.5 실측). adhoc 서명 앱에서는
  /// 창도 목록 등록도 없었으므로 안내가 + 추가를 함께 말한다. tccd의 "does not allow prompting" 기록은 창이 떠도 남는다.
  /// 손쉬운 사용이 아직 없으면 화면 기록은 지금 묻지 않고 손쉬운 사용이 켜지는 즉시 묻는다(`deferred`). 손쉬운 사용 창이 떠 있는
  /// 동안의 화면 기록 요청은 창도 목록 등록도 없이 사라졌기 때문이다(실측). 허용은 사람이 하고, 결과는 다음 hello에서 읽는다.
  static func request(_ wanted: Set<String>) -> (requested: [String], deferred: [String]) {
    let now = HelperPermissions()
    var requested: [String] = []
    var deferred: [String] = []
    if wanted.contains("accessibility") && !now.accessibility {
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
      requested.append("accessibility")
    }
    if wanted.contains("screenRecording") && !now.screenRecording {
      if now.accessibility {
        _ = CGRequestScreenCaptureAccess()
        requested.append("screenRecording")
      } else {
        ScreenRecordingAfterAccessibility.schedule()
        deferred.append("screenRecording")
      }
    }
    return (requested, deferred)
  }
}

/// 손쉬운 사용이 켜지면 곧바로 화면 기록을 묻는 감시. 헬퍼마다 하나만 돌고, Console의 요청 간격(5분)이 지나거나 헬퍼가
/// 내려가면 함께 끝난다. 사람이 손쉬운 사용을 거부하면 화면 기록은 묻지 않는다. Console은 미룬 요청을 기록하지 않으므로
/// 다음 호출에서 같은 감시를 다시 건다.
enum ScreenRecordingAfterAccessibility {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var watching = false

  static func schedule(timeout: TimeInterval = 300, interval: TimeInterval = 1) {
    lock.lock()
    defer { lock.unlock() }
    guard !watching else { return }
    watching = true
    DispatchQueue.global(qos: .utility).async {
      defer { lock.lock(); watching = false; lock.unlock() }
      let deadline = Date().addingTimeInterval(timeout)
      while Date() < deadline {
        Thread.sleep(forTimeInterval: interval)
        guard AXIsProcessTrusted() else { continue }
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        return
      }
    }
  }
}

private final class ProbePanel: NSPanel {
  override var canBecomeMain: Bool { false }
  override var canBecomeKey: Bool { false }
}

private final class ProbeView: NSView {
  override var isFlipped: Bool { true }
  var mousePoint: CGPoint?
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { mousePoint = convert(event.locationInWindow, from: nil) }
}

@MainActor func selfCheck(symbols: WindowSymbols, permissions: HelperPermissions) async -> Object {
  let start = clockNow()
  func report(_ reason: String? = nil) -> Object {
    var result: Object = ["ok": reason == nil, "ms": millis(since: start)]
    if let reason { result["reason"] = reason }
    return result
  }
  guard symbols.setLocation != nil else { return report("window_location_unavailable") }
  guard permissions.allowed else { return report("permission_required") }
  // AX IPC가 응답하지 않는 앱에 발목 잡히지 않도록 프로세스 기본 한도도 설정한다.
  AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.18)
  guard let screen = NSScreen.screens.first, let pointer = CGEvent(source: nil)?.location else { return report("no_display") }
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
  let panel = ProbePanel(contentRect: NSRect(x: screen.visibleFrame.minX + 8, y: screen.visibleFrame.minY + 8, width: 24, height: 24),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  panel.isReleasedWhenClosed = false
  panel.hidesOnDeactivate = false
  panel.hasShadow = false
  panel.alphaValue = 0.03
  panel.collectionBehavior = [.ignoresCycle]
  let view = ProbeView(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
  panel.contentView = view
  panel.orderBack(nil)
  defer { panel.close() }
  let id = CGWindowID(panel.windowNumber)
  // 중앙을 피해야 축이 뒤집혀도 좌표가 우연히 일치하지 않는다.
  let point = CGPoint(x: 9, y: 7)
  do {
    try await pause(16)
    guard let row = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [Object])?.first,
          let bounds = row[kCGWindowBounds as String] as? Object,
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return report("probe_window_unavailable") }
    let window = WindowInfo(key: WindowKey(pid: getpid(), id: id, launched: nil), app: "", bundleId: "", bundlePath: "", title: "",
                            frame: frame, front: false, hidden: false, minimized: false, onCurrentSpace: true, engine: .appkit)
    let event = try EventFactory(symbols: symbols).pointer(.click, win: window, point: point, focus: false)
    try await event.send(to: window, using: symbols, revalidate: {})
    while view.mousePoint == nil, millis(since: start) < 500 { try await pause(10) }
    guard front == NSWorkspace.shared.frontmostApplication?.processIdentifier,
          CGEvent(source: nil)?.location == pointer else { return report("front_or_pointer_changed") }
    guard let actual = view.mousePoint else { return report("probe_click_not_received") }
    guard abs(actual.x - point.x) <= 0.5, abs(actual.y - point.y) <= 0.5 else { return report("probe_coordinate_mismatch") }
    return report()
  } catch { return report("probe_failed") }
}
