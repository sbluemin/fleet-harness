import AppKit
import Darwin
import ApplicationServices
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct HelperError: Error {
  let code: String
  let message: String
  let details: Object?
  init(_ code: String, _ message: String = "", details: Object? = nil) {
    self.code = code
    self.message = message.isEmpty ? code : message
    self.details = details
  }

  static func unavailable(_ reason: String = "unknown", message: String = "") -> Self {
    Self("window_unavailable", message, details: ["reason": reason])
  }
}

typealias Object = [String: Any]

func frameJSON(_ r: CGRect) -> Object {
  ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height]
}

func jsonNumber(_ value: Any?) -> Double? {
  guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
  return n.doubleValue
}

func jsonBool(_ value: Any?) -> Bool? {
  guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
  return n.boolValue
}

func clockNow() -> Double { ProcessInfo.processInfo.systemUptime }
func millis(since start: Double) -> Int { Int((clockNow() - start) * 1_000) }
func pause(_ ms: Int) async throws { try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }

// LaunchServices에 등록되지 않은 직접 실행도 PID 재사용을 구별해야 한다.
func kernelLaunchDate(_ pid: pid_t) -> Date? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_start_tvsec > 0 else { return nil }
  return Date(timeIntervalSince1970: Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000)
}

struct WindowKey: Hashable {
  let pid: pid_t
  let id: CGWindowID
  let launched: Date?
}

enum Engine: String { case appkit, webkit, chromium, electron, catalyst }

struct WindowInfo {
  let key: WindowKey
  let app: String
  let bundleId: String
  let bundlePath: String
  var title: String
  let frame: CGRect
  let front: Bool
  let hidden: Bool
  var minimized: Bool
  let onCurrentSpace: Bool
  var engine: Engine
  var startedAtSource = "launchDate"
  /// WindowServer가 지금 화면에 그리는 창인가. 최소화·숨김 창과 다른 스페이스 창은 거짓이다.
  var onscreen = true
  /// 창의 스페이스가 활성 스페이스 중 하나인가. 화면에 없는 최소화·숨김 창도 참이다. onCurrentSpace(화면에 있는 창만 참)와 달리
  /// 목록 표시에는 쓰지 않고, 앞으로 올리지 않고 다룰 창을 가르는 데만 쓴다.
  var inActiveSpace = true

  /// 사람 화면에 보이는 창. 화면 좌표가 그대로 맞고 새 창 감지(전후 비교)의 기준이 된다.
  var visible: Bool { onscreen && onCurrentSpace && !hidden && !minimized && frame.width > 0 && frame.height > 0 }
  /// 읽기와 조작 대상이 되는 창: 현재 스페이스의 보이는 창과, 앞으로 올리지 않은 최소화·숨김 창(dbdbe742 실측).
  /// 다른 스페이스의 창은 앱의 AX 창 목록에 없어 읽거나 조작할 수 없다.
  var usable: Bool { (visible || (inActiveSpace && (minimized || hidden))) && frame.width > 0 && frame.height > 0 }
  var localFrame: CGRect { CGRect(origin: .zero, size: frame.size) }
  func screen(_ point: CGPoint) -> CGPoint { CGPoint(x: frame.minX + point.x, y: frame.minY + point.y) }
  func snapshotJSON() -> Object {
    ["pid": key.pid, "windowId": key.id, "processStartedAt": key.launched?.timeIntervalSince1970 ?? 0,
     "title": title, "frame": frameJSON(frame)]
  }
  func json() -> Object {
    snapshotJSON().merging(["app": app, "bundleId": bundleId, "bundlePath": bundlePath, "front": front,
                            "hidden": hidden, "minimized": minimized, "onCurrentSpace": onCurrentSpace, "engine": engine.rawValue,
                            "startedAtSource": startedAtSource]) { old, _ in old }
  }
}

@MainActor final class WindowCatalog {
  private struct ProcessInfo {
    let app: NSRunningApplication
    let kernelDate: Date?
    let started: Date?
    let source: String
    let engine: Engine
  }
  private var processes: [pid_t: ProcessInfo] = [:]
  private var knownWindows: [CGWindowID: WindowInfo] = [:]
  private var webWindows: Set<WindowKey> = []
  private let symbols: WindowSymbols

  init(symbols: WindowSymbols) { self.symbols = symbols }

  private func process(_ pid: pid_t) -> ProcessInfo? {
    let stamp = kernelLaunchDate(pid)
    if let cached = processes[pid], stamp != nil, stamp == cached.kernelDate { return cached }
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
    let launch = app.launchDate
    let record = ProcessInfo(app: app, kernelDate: stamp, started: launch ?? stamp,
                             source: launch == nil ? "kernel" : "launchDate", engine: detectEngine(app))
    processes[pid] = record
    return record
  }

  func launchDate(_ pid: pid_t) -> Date? { process(pid)?.started }
  func sawWebArea(_ key: WindowKey) { webWindows.insert(key) }
  func prune(to reported: Set<WindowKey>) -> Set<WindowKey> {
    var alive = reported
    processes = processes.filter { pid, process in
      if let known = process.kernelDate { return kernelLaunchDate(pid) == known }
      return !process.app.isTerminated
    }
    knownWindows = knownWindows.filter { _, win in
      if alive.contains(win.key) { return true }
      guard let process = processes[win.key.pid], process.started == win.key.launched else { return false }
      let reason = unavailableReason(win, app: process.app, missingFromCG: true)
      guard reason == "minimized" || reason == "hidden" || reason == "other_space" else { return false }
      alive.insert(win.key)
      return true
    }
    webWindows.formIntersection(alive)
    return alive
  }

  private func unavailableReason(_ window: WindowInfo, app: NSRunningApplication, missingFromCG: Bool) -> String {
    if app.isHidden { return "hidden" }
    if AXIsProcessTrusted(), let root = AXReader.window(window), AXReader.attribute(root, kAXMinimizedAttribute) as? Bool == true {
      return "minimized"
    }
    let active = symbols.activeSpaces()
    if let own = symbols.windowSpaces(window.key.id), !active.isEmpty, own.isDisjoint(with: active) { return "other_space" }
    return missingFromCG ? "closed" : "unknown"
  }

  private func decode(_ info: Object, front: pid_t?, activeSpaces: Set<UInt64>) -> WindowInfo? {
    guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid > 0, pid != getpid(),
          let id = info[kCGWindowNumber as String] as? CGWindowID, id != 0,
          info[kCGWindowLayer as String] as? Int == 0,
          let bounds = info[kCGWindowBounds as String] as? Object,
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), !frame.isEmpty,
          let process = process(pid),
          // WindowServer의 보조 표면과 바탕 화면을 일반 앱 창으로 노출하지 않는다.
          process.app.activationPolicy != .prohibited else { return nil }
    let app = process.app
    let key = WindowKey(pid: pid, id: id, launched: process.started)
    let engine = process.engine
    let onscreen = info[kCGWindowIsOnscreen as String] as? Bool == true
    let spaces = symbols.windowSpaces(id).map { activeSpaces.isEmpty || !$0.isDisjoint(with: activeSpaces) }
    let inSpace = !onscreen ? false : spaces ?? true
    let window = WindowInfo(key: key, app: app.localizedName ?? info[kCGWindowOwnerName as String] as? String ?? "",
                      bundleId: app.bundleIdentifier ?? "", bundlePath: app.bundleURL?.path ?? "",
                      title: info[kCGWindowName as String] as? String ?? "", frame: frame, front: front == pid,
                      hidden: app.isHidden, minimized: false, onCurrentSpace: inSpace,
                      engine: engine == .appkit && webWindows.contains(key) ? .webkit : engine, startedAtSource: process.source,
                      onscreen: onscreen, inActiveSpace: spaces ?? onscreen)
    knownWindows[id] = window
    return window
  }

  func all(pid: pid_t? = nil, describeWithAX: Bool = false, visibleOnly: Bool = false) -> [WindowInfo] {
    let options: CGWindowListOption = [visibleOnly ? .optionOnScreenOnly : .optionAll, .excludeDesktopElements]
    let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [Object] ?? []
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let spaces = symbols.activeSpaces()
    var axWindows: [pid_t: [AXUIElement]] = [:]
    return list.compactMap { item in
      if let pid, item[kCGWindowOwnerPID as String] as? pid_t != pid { return nil }
      guard var window = decode(item, front: front, activeSpaces: spaces) else { return nil }
      if visibleOnly {
        guard window.visible, (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0 else { return nil }
        return window
      }
      var hasAXWindow = false
      if describeWithAX && (!window.onCurrentSpace || window.title.isEmpty) {
        let pid = window.key.pid
        if axWindows[pid] == nil { axWindows[pid] = AXReader.windows(pid) }
        if let ax = AXReader.window(window, candidates: axWindows[pid]) {
          hasAXWindow = true
          if AXReader.attributeNames(ax)?.contains(kAXMinimizedAttribute) == true {
            window.minimized = AXReader.attribute(ax, kAXMinimizedAttribute) as? Bool == true
          }
          if window.title.isEmpty { window.title = AXReader.attribute(ax, kAXTitleAttribute) as? String ?? "" }
        }
      }
      // 현재 화면 밖의 빈 제목 보조 표면은 실제 AX 창일 때만 목록에 남긴다.
      if !window.onCurrentSpace && window.title.isEmpty && !hasAXWindow { return nil }
      return window
    }
  }

  /// 읽기·조작할 창을 다시 찾는다. 다른 스페이스의 창은 `allowOtherSpace`(화면 캡처만 하는 관찰)일 때만 돌려준다.
  func available(_ pid: pid_t, _ id: CGWindowID, allowOtherSpace: Bool = false) throws -> WindowInfo {
    let matches: (Object) -> Bool = {
      $0[kCGWindowNumber as String] as? CGWindowID == id && $0[kCGWindowOwnerPID as String] as? pid_t == pid
    }
    // 최소화·숨김 창은 optionIncludingWindow 조회에 나오지 않는다(dbdbe742 실측). 그때만 전체 목록에서 다시 찾는다.
    let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [Object])?.first(where: matches)
      ?? (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [Object])?.first(where: matches)
    guard let info else {
      guard let previous = knownWindows[id], previous.key.pid == pid, let process = process(pid), process.started == previous.key.launched else {
        throw HelperError.unavailable("closed")
      }
      throw HelperError.unavailable(unavailableReason(previous, app: process.app, missingFromCG: true))
    }
    guard var window = decode(info, front: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                              activeSpaces: symbols.activeSpaces()), let process = process(pid) else { throw HelperError.unavailable() }
    if !window.onscreen && AXIsProcessTrusted() {
      window.minimized = AXReader.window(window).flatMap { AXReader.attribute($0, kAXMinimizedAttribute) as? Bool } ?? false
    }
    if window.usable || (allowOtherSpace && !window.inActiveSpace && !window.frame.isEmpty) { return window }
    throw HelperError.unavailable(unavailableReason(window, app: process.app, missingFromCG: false))
  }

  static func installed(query: String) -> [Object] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let roots = [URL(fileURLWithPath: "/Applications"), URL(fileURLWithPath: "/System/Applications"),
                 URL(fileURLWithPath: "/System/Applications/Utilities"), URL(fileURLWithPath: "/Applications/Utilities"),
                 home.appendingPathComponent("Applications")]
    var seen: Set<String> = []
    var apps: [Object] = []
    for root in roots {
      guard let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
      for url in entries where url.pathExtension.lowercased() == "app" {
        guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { continue }
        let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? url.deletingPathExtension().lastPathComponent
        guard name.localizedCaseInsensitiveContains(query) || id.localizedCaseInsensitiveContains(query) || url.path.localizedCaseInsensitiveContains(query), seen.insert(url.path).inserted else { continue }
        apps.append(["name": name, "path": url.path, "bundleId": id])
      }
    }
    return apps.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
  }
}

private func detectEngine(_ app: NSRunningApplication) -> Engine {
  guard let url = app.bundleURL else { return .appkit }
  let fm = FileManager.default
  let frameworks = url.appendingPathComponent("Contents/Frameworks")
  let children = (try? fm.contentsOfDirectory(atPath: frameworks.path)) ?? []
  if children.contains("Electron Framework.framework") { return .electron }
  if children.contains(where: { $0.range(of: #"(Chrome|Chromium|Edge|Brave|Opera|Vivaldi|Arc).*Framework"#, options: .regularExpression) != nil }) { return .chromium }
  let helperFolders = [url.appendingPathComponent("Contents/Helpers")] + children.filter { $0.hasSuffix(".framework") }.map {
    frameworks.appendingPathComponent($0).appendingPathComponent("Versions/Current/Helpers")
  }
  if helperFolders.contains(where: {
    (try? fm.contentsOfDirectory(atPath: $0.path))?.contains(where: { $0.hasSuffix(" Helper (Renderer).app") }) == true
  }) { return .chromium }
  if Bundle(url: url)?.object(forInfoDictionaryKey: "UIDeviceFamily") != nil || app.executableURL.map(hasUIKitPlatform) == true { return .catalyst }
  return .appkit
}

// Mach-O의 로드 명령만 읽는다. 유니버설 바이너리는 현재 호스트에 해당하는 슬라이스를 우선한다.
private func hasUIKitPlatform(_ url: URL) -> Bool {
  guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
  func word(_ o: Int, big: Bool = false) -> UInt32? {
    guard o >= 0, data.count >= 4, o <= data.count - 4 else { return nil }
    let bytes = (0..<4).map { UInt32(data[o + $0]) }
    return big ? bytes.reduce(0) { ($0 << 8) | $1 } : bytes.reversed().reduce(0) { ($0 << 8) | $1 }
  }
  var base = 0
  let magic = word(0, big: true)
  if magic == 0xcafebabe || magic == 0xcafebabf {
    guard let count = word(4, big: true), (1...64).contains(count) else { return false }
    let stride = magic == 0xcafebabf ? 32 : 20
    #if arch(arm64)
    let preferred: UInt32 = 0x0100000c
    #else
    let preferred: UInt32 = 0x01000007
    #endif
    let entries = (0..<Int(count)).map { 8 + $0 * stride }
    let o = entries.first { word($0, big: true) == preferred } ?? 8
    guard let low = word(o + (stride == 32 ? 12 : 8), big: true), stride == 20 || word(o + 8, big: true) == 0 else { return false }
    base = Int(low)
  }
  guard let m = word(base), m == 0xfeedfacf || m == 0xfeedface,
        let count = word(base + 16), count <= 4096 else { return false }
  var o = base + (m == 0xfeedfacf ? 32 : 28)
  for _ in 0..<count {
    guard let command = word(o), let size = word(o + 4), size >= 8, Int(size) <= data.count - o else { return false }
    if command == 0x32, size >= 24, let platform = word(o + 8) { return platform == 2 || platform == 6 }
    o += Int(size)
  }
  return false
}

@MainActor func captureWindow(_ window: WindowInfo) async throws -> Object {
  guard CGPreflightScreenCaptureAccess() else { throw HelperPermissions().error }
  do {
    // 최소화·숨김·다른 스페이스 창은 화면 밖이라 onScreenWindowsOnly 목록에 없다. 그때만 전체를 열거한다(dbdbe742 실측: 실시간 내용이 잡힘).
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: window.onscreen)
    guard let match = content.windows.first(where: { $0.windowID == window.key.id && $0.owningApplication?.processID == window.key.pid }),
          match.frame == window.frame else { throw HelperError.unavailable() }
    let filter = SCContentFilter(desktopIndependentWindow: match)
    let width = max(1, Int(window.frame.width.rounded()))
    let height = max(1, Int(window.frame.height.rounded()))
    let image: CGImage
    if #available(macOS 26.0, *) {
      // 스트림 대신 오디오 설정이 없는 정지 화면 API를 사용한다.
      let configuration = SCScreenshotConfiguration()
      configuration.width = width
      configuration.height = height
      configuration.showsCursor = false
      configuration.ignoreShadows = true
      configuration.ignoreClipping = true
      configuration.includeChildWindows = false
      configuration.dynamicRange = .sdr
      let frame = try await SCScreenshotManager.captureScreenshot(contentFilter: filter, configuration: configuration)
      guard let sdr = frame.sdrImage else { throw HelperError("internal", "screenshot_image_missing") }
      image = sdr
    } else {
      let configuration = SCStreamConfiguration()
      configuration.width = width
      configuration.height = height
      configuration.capturesAudio = false
      if #available(macOS 15.0, *) { configuration.captureMicrophone = false }
      configuration.showsCursor = false
      configuration.ignoreShadowsSingleWindow = true
      configuration.ignoreGlobalClipSingleWindow = true
      image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw HelperError("internal") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("internal") }
    return ["mime": "image/png", "data": data.base64EncodedString(), "width": image.width, "height": image.height]
  } catch let e as HelperError { throw e }
  catch { throw HelperError.unavailable() }
}
