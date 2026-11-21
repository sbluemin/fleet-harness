import AppKit
import ApplicationServices

struct HelperPermissions {
  let accessibility = AXIsProcessTrusted()
  let screenRecording = CGPreflightScreenCaptureAccess()
  var missing: [String] { [("accessibility", accessibility), ("screenRecording", screenRecording)].compactMap { $0.1 ? nil : $0.0 } }
  var allowed: Bool { missing.isEmpty }
  var error: HelperError { HelperError("permission_required", details: ["missing": missing]) }
  var json: Object { ["accessibility": accessibility, "screenRecording": screenRecording] }
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
  let point = CGPoint(x: 9, y: 12)
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
