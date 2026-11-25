import AppKit
import Carbon
import Darwin
import Security

/// 가상 머신 창의 게스트 화면. Parallels Desktop은 백그라운드 입력(postToPid·focus 레코드)을 게스트에 넘기지 않고 버린다
/// (18a642fb m1 실측: 게스트 페이지 pointerdown/keydown 기록기 0건, 일반 맥 앱 대조군은 백그라운드 정상).
/// 게스트 화면은 접근성 트리에 요소가 없어 적중 검사가 창 자체를 돌려주는 영역이다. 도구 막대 같은 Parallels 자체 요소는 그대로 백그라운드로 다룬다.
enum GuestDisplay {
  static let bundleIds: Set<String> = ["com.parallels.desktop.console"]

  /// 입력이 게스트 화면으로 가는가. bareWindow: 포인터는 적중 요소가 창 자체(또는 없음), 키·텍스트는 창 안에 편집 가능한 AX 포커스가 없음.
  static func receives(bundleId: String, target: Bool, bareWindow: Bool) -> Bool {
    bundleIds.contains(bundleId) && !target && bareWindow
  }
}

/// 게스트 키 입력. Parallels SDK의 키 코드는 X11 키코드(PC 스캔코드 + 8)이고, 누름 0·뗌 0x80이다(prlctl send-key-event와 같은 호출).
enum GuestKeys {
  static let press: UInt32 = 0, release: UInt32 = 0x80
  static let shift: UInt32 = 50
  private static let modifiers: [(CGEventFlags, UInt32)] = [(.maskControl, 37), (.maskShift, 50), (.maskAlternate, 64), (.maskCommand, 133)]
  private static let codes: [Int: UInt32] = [
    kVK_Return: 36, kVK_Tab: 23, kVK_Escape: 9, kVK_Delete: 22, kVK_ForwardDelete: 119, kVK_Space: 65,
    kVK_UpArrow: 111, kVK_DownArrow: 116, kVK_LeftArrow: 113, kVK_RightArrow: 114,
    kVK_Home: 110, kVK_End: 115, kVK_PageUp: 112, kVK_PageDown: 117,
    kVK_F1: 67, kVK_F2: 68, kVK_F3: 69, kVK_F4: 70, kVK_F5: 71, kVK_F6: 72, kVK_F7: 73, kVK_F8: 74, kVK_F9: 75, kVK_F10: 76, kVK_F11: 95, kVK_F12: 96,
    kVK_ANSI_Q: 24, kVK_ANSI_W: 25, kVK_ANSI_E: 26, kVK_ANSI_R: 27, kVK_ANSI_T: 28, kVK_ANSI_Y: 29, kVK_ANSI_U: 30, kVK_ANSI_I: 31,
    kVK_ANSI_O: 32, kVK_ANSI_P: 33, kVK_ANSI_A: 38, kVK_ANSI_S: 39, kVK_ANSI_D: 40, kVK_ANSI_F: 41, kVK_ANSI_G: 42, kVK_ANSI_H: 43,
    kVK_ANSI_J: 44, kVK_ANSI_K: 45, kVK_ANSI_L: 46, kVK_ANSI_Z: 52, kVK_ANSI_X: 53, kVK_ANSI_C: 54, kVK_ANSI_V: 55, kVK_ANSI_B: 56,
    kVK_ANSI_N: 57, kVK_ANSI_M: 58, kVK_ANSI_1: 10, kVK_ANSI_2: 11, kVK_ANSI_3: 12, kVK_ANSI_4: 13, kVK_ANSI_5: 14, kVK_ANSI_6: 15,
    kVK_ANSI_7: 16, kVK_ANSI_8: 17, kVK_ANSI_9: 18, kVK_ANSI_0: 19, kVK_ANSI_Minus: 20, kVK_ANSI_Equal: 21, kVK_ANSI_LeftBracket: 34,
    kVK_ANSI_RightBracket: 35, kVK_ANSI_Semicolon: 47, kVK_ANSI_Quote: 48, kVK_ANSI_Grave: 49, kVK_ANSI_Backslash: 51,
    kVK_ANSI_Comma: 59, kVK_ANSI_Period: 60, kVK_ANSI_Slash: 61,
  ]
  /// 미국 배열 기준 문자 → (키코드, Shift). 게스트의 입력 언어가 다르면 다른 문자가 들어갈 수 있다.
  private static let characters: [Character: (UInt32, Bool)] = {
    var map: [Character: (UInt32, Bool)] = [" ": (65, false), "\n": (36, false), "\t": (23, false)]
    let rows: [(String, String, [UInt32])] = [
      ("1234567890-=", "!@#$%^&*()_+", Array(10...21)), ("qwertyuiop[]", "QWERTYUIOP{}", Array(24...35)),
      ("asdfghjkl;'`", "ASDFGHJKL:\"~", Array(38...49)), ("\\zxcvbnm,./", "|ZXCVBNM<>?", Array(51...61)),
    ]
    for (plain, shifted, keys) in rows {
      for (i, c) in plain.enumerated() { map[c] = (keys[i], false) }
      for (i, c) in shifted.enumerated() { map[c] = (keys[i], true) }
    }
    return map
  }()

  /// (키코드, 누름/뗌) 순서. 대응이 없는 키면 nil.
  static func events(_ stroke: KeyStroke) -> [(UInt32, UInt32)]? {
    guard let code = codes[Int(stroke.code)] else { return nil }
    let mods = modifiers.filter { stroke.flags.contains($0.0) }.map(\.1)
    return mods.map { ($0, press) } + [(code, press), (code, release)] + mods.reversed().map { ($0, release) }
  }

  /// 글자 하나라도 대응이 없으면 아무것도 보내지 않도록 nil을 돌려준다.
  static func events(_ text: String) -> [(UInt32, UInt32)]? {
    var out: [(UInt32, UInt32)] = []
    for c in text.replacingOccurrences(of: "\r\n", with: "\n") {
      guard let (code, shifted) = characters[c] else { return nil }
      if shifted { out.append((shift, press)) }
      out += [(code, press), (code, release)]
      if shifted { out.append((shift, release)) }
    }
    return out
  }
}

/// Parallels Desktop이 함께 싣는 가상화 SDK로 가상 머신의 마우스·키보드 장치에 직접 입력한다. 호스트 포인터·키보드 포커스·전면 앱은
/// 건드리지 않는다(18a642fb m3 실측: 게스트 기록기에 pointerdown·keydown이 찍히고 호스트 포인터 좌표와 전면 앱은 그대로).
/// SDK는 대상 창을 소유한 Parallels Desktop 번들에서 런타임에 연다. 헬퍼는 그 SDK를 함께 배포하지 않는다.
@MainActor final class ParallelsGuest {
  typealias H = OpaquePointer?
  private typealias Init = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> Int32
  private typealias Logging = @convention(c) (Int32) -> Int32
  private typealias Create = @convention(c) (UnsafeMutablePointer<H>) -> Int32
  private typealias Login = @convention(c) (H, UnsafePointer<CChar>?, UInt16, UInt32) -> H
  private typealias Wait = @convention(c) (H, UInt32) -> Int32
  private typealias RetCode = @convention(c) (H, UnsafeMutablePointer<Int32>) -> Int32
  private typealias JobResult = @convention(c) (H, UnsafeMutablePointer<H>) -> Int32
  private typealias VmList = @convention(c) (H) -> H
  private typealias Count = @convention(c) (H, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias ByIndex = @convention(c) (H, UInt32, UnsafeMutablePointer<H>) -> Int32
  private typealias Name = @convention(c) (H, UnsafeMutablePointer<CChar>?, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias Connect = @convention(c) (H, UInt32) -> H
  private typealias Disconnect = @convention(c) (H) -> Int32
  private typealias ScreenSize = @convention(c) (H, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias SetPos = @convention(c) (H, Int32, Int32, Int32, UInt32) -> Int32
  private typealias Key = @convention(c) (H, UInt32, UInt32) -> Int32
  private typealias Free = @convention(c) (H) -> Int32

  private struct Symbols {
    let initEx: Init, logging: Logging?, create: Create, login: Login, wait: Wait, retCode: RetCode, result: JobResult
    let vmList: VmList, count: Count, byIndex: ByIndex, name: Name, connect: Connect, disconnect: Disconnect
    let screenSize: ScreenSize, setPos: SetPos, key: Key, free: Free
  }

  static let shared = ParallelsGuest()
  private var symbols: Symbols?
  private var server: H = nil

  struct Connection {
    fileprivate let vm: H
    let width: UInt32
    let height: UInt32
  }

  /// Parallels가 Developer ID로 서명한 SDK만 연다. 번들 ID는 아무 앱이나 자칭할 수 있고 헬퍼는 손쉬운 사용·화면 기록 권한을 가지며
  /// 릴리스 빌드는 라이브러리 검증을 끄므로, 서명을 확인하지 않으면 같은 번들 ID를 단 앱의 코드가 헬퍼 안에서 실행될 수 있다.
  /// 팀 식별자는 설치된 Parallels Desktop 27.1의 실제 서명에서 읽었다(Parallels International GmbH, 4C6364ACXT).
  nonisolated static func parallelsRequirement(_ identifier: String) -> String {
    "identifier \"\(identifier)\" and anchor apple generic"
      + " and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
      + " and certificate leaf[subject.OU] = \"4C6364ACXT\""
  }
  nonisolated static let sdkRequirement = parallelsRequirement("com.parallels.virtualization.sdk")
  nonisolated static let appRequirement = parallelsRequirement("com.parallels.desktop.console")

  /// 창을 소유한 실행 중 프로세스가 Parallels가 서명한 Parallels Desktop이면 그 코드가 실행된 번들 경로를 돌려준다.
  /// 디스크의 프레임워크만 검증하면 번들 ID를 자칭한 앱이 검증 뒤·dlopen 전에 파일을 바꿔치기할 수 있다. 실행 중인 서명을 먼저 확인하고,
  /// 그 코드의 번들(설치본은 root 소유)에서만 SDK를 찾는다(사령관 검수 의견, 18a642fb m4).
  nonisolated static func trustedOwner(_ pid: pid_t) -> String? {
    var code: SecCode?
    var requirement: SecRequirement?
    var staticCode: SecStaticCode?
    var url: CFURL?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary, [], &code) == errSecSuccess, let code,
          SecRequirementCreateWithString(appRequirement as CFString, [], &requirement) == errSecSuccess, let requirement,
          SecCodeCheckValidity(code, [], requirement) == errSecSuccess,
          SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopyPath(staticCode, [], &url) == errSecSuccess, let url else { return nil }
    return (url as URL).resolvingSymlinksInPath().path
  }

  /// 프레임워크 번들 전체(안에 든 dylib 포함)가 위 요구 조건을 만족하면 그 안의 실행 파일 실제 경로를 돌려준다.
  nonisolated static func trustedSDK(_ framework: String) -> String? {
    let url = URL(fileURLWithPath: framework).resolvingSymlinksInPath()
    var code: SecStaticCode?
    var requirement: SecRequirement?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
          SecRequirementCreateWithString(sdkRequirement as CFString, [], &requirement) == errSecSuccess, let requirement,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckNestedCode | kSecCSCheckAllArchitectures), requirement) == errSecSuccess
    else { return nil }
    let binary = url.appendingPathComponent("ParallelsVirtualizationSDK").resolvingSymlinksInPath().path
    // 심볼릭 링크가 검증한 번들 밖을 가리키면 열지 않는다.
    return binary.hasPrefix(url.path + "/") ? binary : nil
  }

  private func load(_ bundlePath: String) throws -> Symbols {
    if let symbols { return symbols }
    let framework = bundlePath + "/Contents/Frameworks/ParallelsVirtualizationSDK.framework"
    guard FileManager.default.fileExists(atPath: framework) else { throw HelperError("vm_unavailable", details: ["reason": "sdk_missing"]) }
    guard let path = Self.trustedSDK(framework) else { throw HelperError("vm_unavailable", details: ["reason": "sdk_untrusted"]) }
    guard let lib = dlopen(path, RTLD_NOW | RTLD_LOCAL) else { throw HelperError("vm_unavailable", details: ["reason": "sdk_missing"]) }
    func sym<T>(_ name: String, _: T.Type) throws -> T {
      guard let p = dlsym(lib, name) else { throw HelperError("vm_unavailable", details: ["reason": "sdk_missing"]) }
      return unsafeBitCast(p, to: T.self)
    }
    let loaded = Symbols(
      initEx: try sym("PrlApi_InitEx", Init.self), logging: try? sym("PrlApi_SwitchConsoleLogging", Logging.self),
      create: try sym("PrlSrv_Create", Create.self), login: try sym("PrlSrv_LoginLocal", Login.self),
      wait: try sym("PrlJob_Wait", Wait.self), retCode: try sym("PrlJob_GetRetCode", RetCode.self), result: try sym("PrlJob_GetResult", JobResult.self),
      vmList: try sym("PrlSrv_GetVmList", VmList.self), count: try sym("PrlResult_GetParamsCount", Count.self),
      byIndex: try sym("PrlResult_GetParamByIndex", ByIndex.self), name: try sym("PrlVmCfg_GetName", Name.self),
      connect: try sym("PrlDevDisplay_ConnectToVm", Connect.self), disconnect: try sym("PrlDevDisplay_DisconnectFromVm", Disconnect.self),
      screenSize: try sym("PrlDevDisplay_GetScreenSize", ScreenSize.self), setPos: try sym("PrlDevMouse_SetPos", SetPos.self),
      key: try sym("PrlDevKeyboard_SendKeyEventEx", Key.self), free: try sym("PrlHandle_Free", Free.self))
    // 헬퍼의 stdout은 프로토콜 채널이므로 SDK 콘솔 로그를 끈다(prlctl과 같은 순서).
    _ = loaded.logging?(0)
    guard loaded.initEx(0xb0000, 0, 0, 0) == 0 else { throw HelperError("vm_unavailable", details: ["reason": "sdk_init"]) }
    symbols = loaded
    return loaded
  }

  private func job(_ s: Symbols, _ job: H, ms: UInt32 = 5_000) throws -> H {
    var rc: Int32 = 0
    guard job != nil, s.wait(job, ms) == 0, s.retCode(job, &rc) == 0, rc == 0 else {
      _ = s.free(job)
      throw HelperError("vm_unavailable", details: ["reason": "sdk_call"])
    }
    return job
  }

  /// 창 제목과 이름이 같은 가상 머신 하나에 디스플레이 연결을 연다. 이름이 겹치거나 없으면 보내지 않는다.
  func connect(_ win: WindowInfo) throws -> Connection {
    guard let bundle = Self.trustedOwner(win.key.pid) else { throw HelperError("vm_unavailable", details: ["reason": "sdk_untrusted"]) }
    let s = try load(bundle)
    if server == nil {
      var created: H = nil
      guard s.create(&created) == 0 else { throw HelperError("vm_unavailable", details: ["reason": "sdk_call"]) }
      do { _ = s.free(try job(s, s.login(created, nil, 0, 0))) } catch { _ = s.free(created); throw error }
      server = created
    }
    let list: H
    do { list = try job(s, s.vmList(server)) } catch { _ = s.free(server); server = nil; throw error }
    defer { _ = s.free(list) }
    var result: H = nil
    guard s.result(list, &result) == 0 else { throw HelperError("vm_unavailable", details: ["reason": "sdk_call"]) }
    defer { _ = s.free(result) }
    var count: UInt32 = 0
    guard s.count(result, &count) == 0 else { throw HelperError("vm_unavailable", details: ["reason": "sdk_call"]) }
    var matches: [H] = []
    for i in 0..<count {
      var vm: H = nil
      guard s.byIndex(result, i, &vm) == 0 else { continue }
      var buffer = [CChar](repeating: 0, count: 512)
      var length = UInt32(buffer.count)
      if s.name(vm, &buffer, &length) == 0, String(cString: buffer) == win.title { matches.append(vm) } else { _ = s.free(vm) }
    }
    guard matches.count == 1, let vm = matches.first else {
      matches.forEach { _ = s.free($0) }
      throw HelperError("vm_unavailable", details: ["reason": matches.isEmpty ? "not_found" : "ambiguous"])
    }
    // prlctl send-key-event와 같은 디스플레이 연결 방식(0x40004).
    do { _ = s.free(try job(s, s.connect(vm, 0x40004))) } catch { _ = s.free(vm); throw error }
    // SDK가 채우는 화면 정보 구조체 크기를 알 수 없으므로(앞 네 칸: 폭·높이·비트·줄 길이) 넉넉히 잡는다. 작게 잡으면 힙이 깨졌다(18a642fb m3).
    var size = [UInt32](repeating: 0, count: 256)
    guard s.screenSize(vm, 0, &size) == 0, size[0] > 0, size[1] > 0 else {
      _ = s.disconnect(vm); _ = s.free(vm)
      throw HelperError("vm_unavailable", details: ["reason": "screen_size"])
    }
    return Connection(vm: vm, width: size[0], height: size[1])
  }

  func close(_ c: Connection) {
    guard let s = symbols else { return }
    _ = s.disconnect(c.vm); _ = s.free(c.vm)
  }

  /// 창 좌표(포인트) → 게스트 화면 픽셀. 창 내용 영역(도구 막대 아래) 밖이면 nil. 게스트 화면은 창 폭에 맞춰 그려지고 위쪽의 남는 높이는 도구 막대다(실측: 1494×1303 창, 게스트 1494×1265).
  nonisolated static func guestPoint(_ p: CGPoint, window: CGSize, guest: (UInt32, UInt32)) -> CGPoint? {
    let scale = Double(guest.0) / window.width
    let top = window.height - Double(guest.1) / scale
    let x = p.x * scale, y = (p.y - top) * scale
    guard top >= 0, x >= 0, y >= 0, x < Double(guest.0), y < Double(guest.1) else { return nil }
    return CGPoint(x: x.rounded(.down), y: y.rounded(.down))
  }

  func pointer(_ c: Connection, _ action: PointerAction, at p: CGPoint) async throws {
    guard let s = symbols else { return }
    // 거절할 동작은 첫 이벤트(포인터 이동) 전에 거절한다. 이동을 보낸 뒤의 거절은 not sent가 거짓이 된다.
    if case .scroll(let direction, _) = action, direction == .left || direction == .right {
      throw HelperError("vm_unsupported", details: ["reason": "horizontal_scroll"])
    }
    if case .drag = action { throw HelperError("drag_unsupported", details: ["settableSlider": false]) }
    let x = Int32(p.x), y = Int32(p.y)
    var first = true
    func set(_ buttons: UInt32, z: Int32 = 0, then ms: Int) async throws {
      // 첫 이벤트가 거절되면 아무것도 가지 않았다. 그 뒤의 실패는 일부가 이미 갔을 수 있다.
      guard s.setPos(c.vm, x, y, z, buttons) == 0 else {
        throw first ? HelperError("vm_unavailable", details: ["reason": "sdk_call"]) : HelperError("timeout", "vm_delivery_unknown", details: ["target": "vm"])
      }
      first = false
      try await pause(ms)
    }
    try await set(0, then: 30)
    switch action {
    case .click: try await set(1, then: 40); try await set(0, then: 0)
    case .rightClick: try await set(2, then: 40); try await set(0, then: 0)
    case .doubleClick: for _ in 0..<2 { try await set(1, then: 40); try await set(0, then: 40) }
    case .scroll(let direction, let pages):
      let notches = max(1, Int((pages * 5).rounded()))
      for _ in 0..<notches { try await set(0, z: direction == .down ? 1 : -1, then: 25) }
    case .drag: return
    }
  }

  func keys(_ c: Connection, _ events: [(UInt32, UInt32)], gapMs: Int) async throws {
    guard let s = symbols else { return }
    for (index, (code, event)) in events.enumerated() {
      guard s.key(c.vm, code, event) == 0 else {
        throw index == 0 ? HelperError("vm_unavailable", details: ["reason": "sdk_call"]) : HelperError("timeout", "vm_delivery_unknown", details: ["target": "vm"])
      }
      try await pause(gapMs)
    }
  }
}
