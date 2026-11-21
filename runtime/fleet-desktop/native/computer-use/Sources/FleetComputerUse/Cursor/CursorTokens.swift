// AI 커서가 쓰는 Fleet 디자인 토큰. 값의 출처는 runtime/fleet-console/core/client/src/styles/theme.css 이며,
// 같은 이름을 주석에 달아 두어 토큰이 바뀔 때 여기만 따라 고치면 되도록 한다.
import AppKit

/// CSS `oklch(L% C h)`를 sRGB로 바꾼다. sRGB 밖이면 채도를 줄여 가장 가까운 색으로 맞춘다(CSS gamut mapping과 같은 방향).
struct OKLCH {
  var l: Double, c: Double, h: Double, alpha: Double = 1

  init(_ l: Double, _ c: Double, _ h: Double, alpha: Double = 1) {
    self.l = l; self.c = c; self.h = h; self.alpha = alpha
  }

  func with(l: Double? = nil, c: Double? = nil, alpha: Double? = nil) -> OKLCH {
    OKLCH(l ?? self.l, c ?? self.c, h, alpha: alpha ?? self.alpha)
  }

  private func linearRGB(chroma: Double) -> (Double, Double, Double) {
    let a = chroma * cos(h * .pi / 180), b = chroma * sin(h * .pi / 180)
    let l_ = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m_ = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s_ = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
    return (
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
    )
  }

  var cgColor: CGColor {
    var chroma = c
    var rgb = linearRGB(chroma: chroma)
    func inGamut(_ v: (Double, Double, Double)) -> Bool {
      let e = 0.0005
      return v.0 >= -e && v.0 <= 1 + e && v.1 >= -e && v.1 <= 1 + e && v.2 >= -e && v.2 <= 1 + e
    }
    var guardCount = 0
    while !inGamut(rgb) && chroma > 0 && guardCount < 60 {
      chroma = max(0, chroma - 0.004)
      rgb = linearRGB(chroma: chroma)
      guardCount += 1
    }
    func encode(_ v: Double) -> CGFloat {
      let x = min(1, max(0, v))
      return CGFloat(x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055)
    }
    return CGColor(srgbRed: encode(rgb.0), green: encode(rgb.1), blue: encode(rgb.2), alpha: CGFloat(alpha))
  }
}

enum CursorTokens {
  // MARK: 색
  /// `--agent-control-badge` oklch(57% 0.16 285) — 조작 허용 배지 전용 채널(에이전트 조작 표시색). 몸체 기본색.
  static let badge = OKLCH(0.57, 0.16, 285)
  /// 라이트 테마의 `--agent-control-badge` oklch(57% 0.24 285). sRGB 밖이라 맵핑되며, 몸체 아래쪽 한 단 진한 면으로 쓴다.
  static let badgeVivid = OKLCH(0.57, 0.24, 285)
  /// `--agent-control-badge-ink` oklch(100% 0 0) — 글자·테두리.
  static let badgeInk = OKLCH(1, 0, 285)
  /// 몸체 윗면. 같은 색상(285°)에서 밝기만 올린 면으로, 말랑한 볼륨을 만든다.
  static let badgeLift = OKLCH(0.68, 0.15, 285)
  /// 그림자·외곽 헤어라인. 같은 색상의 깊은 잉크라 밝은 창 위에서도 윤곽이 남는다(`--shadow-floating`의 어두운 그림자 톤을 보라 쪽으로 기울임).
  static let shadowInk = OKLCH(0.28, 0.12, 285)

  // MARK: 반경 (px = pt)
  /// `--radius-md` 10px: 몸체 둥근 부분의 반경, 오른쪽 클릭 고리의 모서리.
  static let radiusMD: CGFloat = 10
  /// `--radius-xs` 6px
  static let radiusXS: CGFloat = 6
  /// `--radius-pill` 999px: 배지는 높이의 절반으로 완전한 알약.

  // MARK: 움직임 — theme.css 그대로
  /// `--ease-spring` cubic-bezier(0.16, 1, 0.3, 1)
  static let easeSpring = CubicBezier(0.16, 1, 0.3, 1)
  /// `--ease-soft` cubic-bezier(0.2, 0.8, 0.2, 1)
  static let easeSoft = CubicBezier(0.2, 0.8, 0.2, 1)
  /// `--duration-fast` 140ms
  static let durationFast: Double = 0.140
  /// `--duration-base` 220ms
  static let durationBase: Double = 0.220
  /// `--duration-slow` 360ms
  static let durationSlow: Double = 0.360
  /// `--motion-tap` 80ms: 클릭 눌림
  static let motionTap: Double = 0.080

  // MARK: 파생 규칙
  /// 이동 시간: 거리 비례 180~520ms (`--duration-base`보다 짧게 시작해 `--duration-slow`를 넘어서까지).
  static func moveDuration(distance: CGFloat) -> Double {
    min(0.520, 0.180 + Double(distance) / 2650)
  }
}

/// CSS cubic-bezier(x1, y1, x2, y2) 이징. x(t)=입력 진행도를 풀어 y를 돌려준다.
struct CubicBezier {
  let x1: Double, y1: Double, x2: Double, y2: Double
  init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
    self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2
  }

  private func coord(_ t: Double, _ p1: Double, _ p2: Double) -> Double {
    let u = 1 - t
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
  }

  private func slopeX(_ t: Double) -> Double {
    let u = 1 - t
    return 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2)
  }

  func value(_ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    var t = x
    for _ in 0..<8 { // 뉴턴법
      let err = coord(t, x1, x2) - x
      if abs(err) < 1e-6 { return coord(t, y1, y2) }
      let d = slopeX(t)
      if abs(d) < 1e-6 { break }
      t -= err / d
    }
    var lo = 0.0, hi = 1.0
    t = x
    for _ in 0..<24 { // 이분법 보정
      let v = coord(t, x1, x2)
      if abs(v - x) < 1e-6 { break }
      if v < x { lo = t } else { hi = t }
      t = (lo + hi) / 2
    }
    return coord(t, y1, y2)
  }

  var timingFunction: CAMediaTimingFunction {
    CAMediaTimingFunction(controlPoints: Float(x1), Float(y1), Float(x2), Float(y2))
  }
}
