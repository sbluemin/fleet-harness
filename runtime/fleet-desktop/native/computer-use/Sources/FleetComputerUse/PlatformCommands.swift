import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch

/// The one-shot platform ABI is independent of the input helper's hello,
/// self-check, and request queue. Dispatch only explicitly supported methods.
@MainActor enum PlatformCommands {
  private struct Request: Decodable { let version: Int; let method: String }
  private struct Params<T: Decodable>: Decodable { let params: T }
  private struct Identity: Decodable { let pid: pid_t; let windowId: CGWindowID; let processStartedAt: Double }
  private struct AppTarget: Decodable { let target: String }
  private struct OpenApp: Decodable { let app: String; let activate: Bool }
  private struct Settings: Decodable { let permissions: [String] }

  static func run() -> Int32 {
    signal(SIGPIPE, SIG_IGN)
    let pipe = PlatformPipe(interrupted: { false })
    let version = PlatformPipe.version
    let decoder = JSONDecoder()
    func fail(_ error: String) -> Int32 {
      _ = PlatformPipe.emit(["version": version, "ok": false, "error": error])
      return 1
    }
    guard let frame = pipe.readFrame(maxBytes: 65_536, until: PlatformPipe.deadline(after: 3)),
          let request = try? decoder.decode(Request.self, from: frame), request.version == version else { return fail("invalid_request") }
    func params<T: Decodable>(_ type: T.Type) -> T? { (try? decoder.decode(Params<T>.self, from: frame))?.params }
    let result: Object
    switch request.method {
    case "readPermissions":
      var values = HelperPermissions().json
      if let permissionHolder { values["holder"] = permissionHolder }
      result = values
    case "verifyWindowIdentity":
      guard let target = params(Identity.self), target.pid > 0, target.windowId > 0,
            target.processStartedAt.isFinite, target.processStartedAt > 0 else { return fail("invalid_params") }
      result = ["identity": verifyWindowIdentity(target)]
    case "resolveApp":
      guard let target = params(AppTarget.self) else { return fail("invalid_params") }
      result = resolveApp(target.target)
    case "openApp":
      guard let request = params(OpenApp.self) else { return fail("invalid_params") }
      result = openApp(request)
    case "openPrivacySettings":
      guard let request = params(Settings.self), !request.permissions.isEmpty,
            request.permissions.allSatisfy(HelperPermissions.names.contains) else { return fail("invalid_params") }
      let missing = Set(request.permissions)
      let pane = missing.count > 1 ? "Privacy" : missing.contains("accessibility") ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
      let requestResult = open(["x-apple.systempreferences:com.apple.preference.security?\(pane)"], seconds: 3)
      result = ["opened": requestResult.completed]
    default: return fail("unknown_method")
    }
    return PlatformPipe.emit(["version": version, "ok": true, "result": result]) ? 0 : 1
  }

  private static func verifyWindowIdentity(_ target: Identity) -> String {
    guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isHidden,
          app.launchDate?.timeIntervalSince1970 == target.processStartedAt else { return "mismatch" }
    guard let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [Object] else { return "unknown" }
    // A capture identity is not a WindowCatalog availability check: do not
    // apply any behavior-specific filters for Space, minimization, or title.
    return windows.contains {
      $0[kCGWindowOwnerPID as String] as? pid_t == target.pid &&
      $0[kCGWindowNumber as String] as? CGWindowID == target.windowId
    } ? "matches" : "mismatch"
  }

  private static func isCleanTarget(_ value: String) -> Bool {
    !value.isEmpty && value == value.trimmingCharacters(in: .whitespacesAndNewlines) &&
      !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
  }

  private static func canonicalApp(_ app: String) -> String? {
    guard isCleanTarget(app), app.hasPrefix("/"), app.hasSuffix(".app"),
          let resolved = realpath(app, nil) else { return nil }
    defer { free(resolved) }
    let path = String(cString: resolved)
    var directory: ObjCBool = false
    guard path.hasSuffix(".app"), FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue else { return nil }
    return path
  }

  private static func resolveApp(_ target: String) -> Object {
    guard isCleanTarget(target) else { return ["error": "exact_target_required"] }
    var selected = target
    if !target.hasPrefix("/") {
      guard target.range(of: #"^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$"#, options: .regularExpression) != nil else {
        return ["error": "exact_target_required"]
      }
      let installed = WindowCatalog.installed(query: target).compactMap { $0["bundleId"] as? String == target ? $0["path"] as? String : nil }
      let running = NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier == target && !$0.isTerminated ? $0.bundleURL?.path : nil }
      let candidates = Set(installed + running)
      guard candidates.count == 1, let only = candidates.first else { return ["error": "unambiguous_target_required"] }
      selected = only
    }
    guard let path = canonicalApp(selected) else { return ["error": "installed_target_required"] }
    return ["app": path]
  }

  private static func openApp(_ request: OpenApp) -> Object {
    // The resolved path is exact. A subsequent symlink swap must not retarget it.
    guard canonicalApp(request.app) == request.app else {
      return ["requestDispatched": false, "windowReady": false, "error": "computer_use_open_failed"]
    }
    let delivery = open((request.activate ? [] : ["-g"]) + ["-a", request.app], seconds: 5)
    let deadline = PlatformPipe.deadline(after: 5)
    var ready = false
    repeat {
      ready = appWindowReady(request.app, activate: request.activate)
      let now = DispatchTime.now()
      if ready || !delivery.completed || now >= deadline { break }
      // NSWorkspace and NSRunningApplication refresh only after a turn in a common mode.
      let interval = min(0.2, Double(deadline.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000_000)
      let wake = Timer(timeInterval: interval, repeats: false) { _ in }
      RunLoop.main.add(wake, forMode: .default)
      _ = CFRunLoopRunInMode(.defaultMode, interval, false)
      wake.invalidate()
    } while DispatchTime.now() < deadline
    var result: Object = ["requestDispatched": delivery.dispatched, "windowReady": ready]
    if !delivery.completed { result["error"] = "computer_use_open_failed" }
    return result
  }

  private static func open(_ arguments: [String], seconds: Int) -> (dispatched: Bool, completed: Bool) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in exited.signal() }
    do { try process.run() } catch { return (false, false) }
    if exited.wait(timeout: PlatformPipe.deadline(after: seconds)) == .timedOut {
      if process.isRunning { process.terminate() }
      return (true, false)
    }
    return (true, process.terminationStatus == 0)
  }

  private static func appWindowReady(_ path: String, activate: Bool) -> Bool {
    let workspace = NSWorkspace.shared
    let matches = workspace.runningApplications.filter { $0.bundleURL?.path == path }
    guard matches.count == 1, let app = matches.first, !app.isHidden,
          !activate || workspace.frontmostApplication?.processIdentifier == app.processIdentifier,
          AXIsProcessTrusted() else { return false }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 0.5)
    var windows: CFTypeRef?
    guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &windows) == .success,
          let rows = windows as? [AXUIElement] else { return false }
    let until = DispatchTime.now() + .milliseconds(500)
    for window in rows {
      if DispatchTime.now() >= until { break }
      AXUIElementSetMessagingTimeout(window, 0.5)
      var minimized: CFTypeRef?
      if AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized) == .success,
         minimized as? Bool == false { return true }
    }
    return false
  }
}
