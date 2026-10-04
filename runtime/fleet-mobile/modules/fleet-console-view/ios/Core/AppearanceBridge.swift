import Foundation

// AppearanceBridge.kt의 iOS 대응 (shared/bridge-contract.md v1.1).
// 페이지 → 셸 메시지 통로는 readiness 다음의 두 번째 문이다. 표시 선호만 나르며, readiness와
// 같은 조건 — 커밋된 뷰, main frame, 정확한 로컬 게이트웨이 오리진, 화이트리스트 모양 하나와
// 정확히 같은 본문 — 일 때만 열린다. 어긋나면 연결을 실패시키지 않고 조용히 버린다.

public enum ColorMode: String, Equatable { case system, dark, light }
public enum FontScale: String, Equatable { case small, `default`, large }

public struct Appearance: Equatable {
  public let colorMode: ColorMode
  public let fontScale: FontScale
  public init(colorMode: ColorMode, fontScale: FontScale) { self.colorMode = colorMode; self.fontScale = fontScale }
  public static let standard = Appearance(colorMode: .system, fontScale: .default)
  public func dark(systemDark: Bool) -> Bool {
    switch colorMode {
    case .system: return systemDark
    case .dark: return true
    case .light: return false
    }
  }
}

/// 페이지가 알아도 되는 것은 지금 붙은 이 Console 하나의 표시값뿐이다.
public struct ConsolePresentation: Equatable {
  public let label: String
  public let monogram: String
  public let tone: String
  public let address: String
  private static let tones = ["crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose"]

  /// 셸의 toneFor/monogramFor(shell/palette.ts)와 같은 선택 — 두 곳이 같은 정체성을 그린다.
  public static func of(label rawLabel: String, origin: String, hostname: String, port: Int) -> ConsolePresentation? {
    let scalars = Array(rawLabel.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.prefix(64))
    guard let first = scalars.first else { return nil }
    var label = String.UnicodeScalarView()
    label.append(contentsOf: scalars)
    var hash: UInt32 = 0x811c9dc5
    for unit in origin.utf16 {
      hash ^= UInt32(unit)
      hash = hash &* 0x01000193
    }
    // 지금 Console 자신의 주소(목록이 보여 주는 그대로)만 — 다른 Console의 것은 넣지 않는다.
    let host = hostname.contains(":") ? "[\(hostname)]" : hostname
    return ConsolePresentation(
      label: String(label),
      monogram: String(Character(first)).uppercased(),
      tone: tones[Int(hash % UInt32(tones.count))],
      address: String("\(host):\(port)".prefix(128)))
  }
}

public enum AppearanceMessage: Equatable {
  case set(Appearance)
  case chrome(top: String, bottom: String)
  case consoles
}

public enum AppearanceBridge {
  public static let messageObject = "fleetAppearance"
  private static let maxBody = 256
  private static let chromeTop: Set<String> = ["bg", "bg-deep"]
  private static let chromeBottom: Set<String> = ["bg", "bg-deep", "surface"]

  /// 게이트 전체. 인자 하나하나가 호출자가 도착한 메시지에서 잰 조건이다.
  public static func accept(fromCommittedView: Bool, isMainFrame: Bool, fromGatewayOrigin: Bool, body: Any?) -> AppearanceMessage? {
    guard fromCommittedView, isMainFrame, fromGatewayOrigin else { return nil }
    guard let text = body as? String, text.utf16.count <= maxBody, let data = text.data(using: .utf8),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    // JSON의 true도 NSNumber 1로 읽히므로 불리언과 소수는 따로 거른다.
    guard let version = json["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
          !CFNumberIsFloatType(version), version.intValue == 1 else { return nil }
    let keys = Set(json.keys)
    switch json["type"] as? String {
    case "set":
      guard keys == ["v", "type", "colorMode", "fontScale"],
            let colorMode = (json["colorMode"] as? String).flatMap(ColorMode.init(rawValue:)),
            let fontScale = (json["fontScale"] as? String).flatMap(FontScale.init(rawValue:)) else { return nil }
      return .set(Appearance(colorMode: colorMode, fontScale: fontScale))
    case "chrome":
      guard keys == ["v", "type", "top", "bottom"],
            let top = json["top"] as? String, chromeTop.contains(top),
            let bottom = json["bottom"] as? String, chromeBottom.contains(bottom) else { return nil }
      return .chrome(top: top, bottom: bottom)
    case "consoles":
      return keys == ["v", "type"] ? .consoles : nil
    default:
      return nil
    }
  }

  /// 문서 시작과 실시간 갱신이 같은 스크립트를 쓴다. 값은 JSON 인코더를 거친 뒤 한 번 더
  /// JavaScript 문자열로 인용된다 — 코드에 이어 붙이는 값은 없다.
  public static func script(_ appearance: Appearance, systemDark: Bool, console: ConsolePresentation?) -> String {
    var value: [String: Any] = [
      "v": 1,
      "colorMode": appearance.colorMode.rawValue,
      "systemScheme": systemDark ? "dark" : "light",
      "fontScale": appearance.fontScale.rawValue,
    ]
    if let console {
      value["console"] = ["label": console.label, "monogram": console.monogram, "tone": console.tone, "address": console.address]
    }
    let json = (try? JSONSerialization.data(withJSONObject: value)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    let literal = (try? JSONEncoder().encode(json)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"{}\""
    return "(() => { const v = JSON.parse(\(literal)); if (v.console) Object.freeze(v.console); Object.freeze(v); "
      + "Object.defineProperty(window, \"__fleetMobileAppearance\", { value: v, configurable: true, enumerable: false, writable: false }); "
      + "window.dispatchEvent(new CustomEvent(\"fleet-mobile-appearance\", { detail: v })); })();"
  }
}

public final class AppearanceStore {
  private let store: KeyValueStore
  public init(store: KeyValueStore) { self.store = store }

  public func load() -> Appearance {
    Appearance(
      colorMode: store.string(forKey: "colorMode").flatMap(ColorMode.init(rawValue:)) ?? .system,
      fontScale: store.string(forKey: "fontScale").flatMap(FontScale.init(rawValue:)) ?? .default)
  }

  public func save(_ appearance: Appearance) {
    store.set(appearance.colorMode.rawValue, forKey: "colorMode")
    store.set(appearance.fontScale.rawValue, forKey: "fontScale")
  }
}
