import AppKit
import CoreGraphics
import Darwin

/// The one-shot platform ABI is independent of the input helper's hello,
/// self-check, and request queue. Dispatch only explicitly supported methods.
@MainActor enum PlatformCommands {
  private struct Request: Decodable {
    let version: Int
    let method: String
  }

  private struct VerifyWindow: Decodable {
    let pid: pid_t
    let windowId: CGWindowID
    let processStartedAt: Double
  }

  private struct WindowRequest: Decodable {
    let params: VerifyWindow
  }

  static func run() -> Int32 {
    signal(SIGPIPE, SIG_IGN)
    let pipe = PlatformPipe(interrupted: { false })
    let version = PlatformPipe.version
    let decoder = JSONDecoder()
    guard let frame = pipe.readFrame(maxBytes: 65_536, until: PlatformPipe.deadline(after: 3)),
          let request = try? decoder.decode(Request.self, from: frame), request.version == version else {
      _ = PlatformPipe.emit(["version": version, "ok": false, "error": "invalid_request"])
      return 1
    }
    switch request.method {
    case "verifyWindowIdentity":
      guard let target = (try? decoder.decode(WindowRequest.self, from: frame))?.params,
            target.pid > 0, target.windowId > 0, target.processStartedAt.isFinite, target.processStartedAt > 0 else {
        _ = PlatformPipe.emit(["version": version, "ok": false, "error": "invalid_params"])
        return 1
      }
      let result = verifyWindowIdentity(target)
      return PlatformPipe.emit(["version": version, "ok": true, "result": ["identity": result]]) ? 0 : 1
    default:
      _ = PlatformPipe.emit(["version": version, "ok": false, "error": "unknown_method"])
      return 1
    }
  }

  private static func verifyWindowIdentity(_ target: VerifyWindow) -> String {
    guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isHidden,
          app.launchDate?.timeIntervalSince1970 == target.processStartedAt else { return "mismatch" }
    guard let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return "unknown" }
    // A capture identity is not a WindowCatalog availability check: do not
    // apply any behavior-specific filters for Space, minimization, or title.
    return windows.contains {
      $0[kCGWindowOwnerPID as String] as? pid_t == target.pid &&
      $0[kCGWindowNumber as String] as? CGWindowID == target.windowId
    } ? "matches" : "mismatch"
  }
}
