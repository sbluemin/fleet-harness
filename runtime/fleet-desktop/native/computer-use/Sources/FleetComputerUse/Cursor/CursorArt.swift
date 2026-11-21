// AI 커서의 모습: 말랑한 물방울 포인터 + 「Fleet」 알약 배지 + 물결/스크롤/드래그 표식.
// 모든 그림은 CALayer이고 애니메이션은 Core Animation이 렌더 서버에서 돌린다 → 대기 중 우리 프로세스의 CPU는 0이다.
// 패널 안에서 끝점은 항상 같은 자리(`CursorArt.tip`)에 있고, 패널 창이 움직여 끝점을 전역 좌표에 맞춘다.
import AppKit
import QuartzCore

@MainActor final class CursorArt {
  // 패널 크기와 끝점 위치(패널 좌상단 기준, y 아래). 물결 반경 40 + 그림자 여유를 담는다.
  static let panelSize = CGSize(width: 148, height: 116)
  static let tip = CGPoint(x: 52, y: 52)

  let root = CALayer()
  /// 끝점을 기준점으로 한 전체 콘텐츠(등장·퇴장 애니메이션, 소수점 이하 위치 보정).
  let content = CALayer()
  let pointer = CALayer()
  private let breath = CALayer()
  private let press = CALayer()
  private let wiggle = CALayer()
  private let badge = CALayer()
  private let badgeText = CATextLayer()
  private let dots = CALayer()
  private let scrollChip = CALayer()
  private let scrollChevron = CAShapeLayer()
  private let dragRing = CAShapeLayer()

  private(set) var typing = false
  private(set) var dragging = false
  var reduceMotion = false
  private var badgeLag = CGPoint.zero
  var followMagnitude: CGFloat { hypot(badgeLag.x, badgeLag.y) }

  // 토큰에서 만든 색
  private let cBadge = CursorTokens.badge.cgColor
  private let cVivid = CursorTokens.badgeVivid.cgColor
  private let cLift = CursorTokens.badgeLift.cgColor
  private let cInk = CursorTokens.badgeInk.cgColor
  private let cShadow = CursorTokens.shadowInk.cgColor

  /// 디자인 좌표(오른쪽 +, 아래 +, 끝점 원점) → 레이어 좌표(y 위)
  private static func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: -y) }

  // MARK: 구성

  init() {
    let size = Self.panelSize
    root.frame = CGRect(origin: .zero, size: size)
    let tipLayer = CGPoint(x: Self.tip.x, y: size.height - Self.tip.y)
    content.bounds = CGRect(origin: .zero, size: size)
    content.anchorPoint = CGPoint(x: tipLayer.x / size.width, y: tipLayer.y / size.height)
    content.position = tipLayer
    root.addSublayer(content)

    pointer.position = tipLayer
    content.addSublayer(pointer)
    pointer.addSublayer(breath)
    breath.addSublayer(press)
    press.addSublayer(wiggle)
    buildBody(into: wiggle)
    buildBadge(at: tipLayer)
    buildScrollChip(at: tipLayer)
    buildDragRing(at: tipLayer)
  }

  /// 물방울 몸체. 끝점이 정확히 (0,0)이고 둥근 부분의 반경이 `--radius-md`(10)이다.
  /// 축은 아래-오른쪽 30° 기울기(일반 포인터처럼 살짝 기운 자세). 끝점 쪽은 접선 사이를 2차 곡선으로 말랑하게 만든다.
  static func bodyPath() -> CGPath {
    let r = CursorTokens.radiusMD
    let dist: CGFloat = 25 // 가상 뾰족점 → 원 중심
    let axis = CGFloat.pi / 6 // 수직에서 30° (오른쪽으로)
    let u = CGPoint(x: sin(axis), y: cos(axis)) // 디자인 좌표(y 아래)의 축 방향
    let center = CGPoint(x: u.x * dist, y: u.y * dist)
    let alpha = asin(r / dist) // 접선 반각
    let tangentLen = sqrt(dist * dist - r * r)
    let trim: CGFloat = 8.5 // 끝점을 둥글게 깎는 길이
    func rot(_ v: CGPoint, _ a: CGFloat) -> CGPoint { CGPoint(x: v.x * cos(a) - v.y * sin(a), y: v.x * sin(a) + v.y * cos(a)) }
    // 가상 뾰족점 기준 접선점
    let t1 = rot(CGPoint(x: u.x * tangentLen, y: u.y * tangentLen), alpha)
    let t2 = rot(CGPoint(x: u.x * tangentLen, y: u.y * tangentLen), -alpha)
    let e1 = CGPoint(x: t1.x * trim / tangentLen, y: t1.y * trim / tangentLen)
    let e2 = CGPoint(x: t2.x * trim / tangentLen, y: t2.y * trim / tangentLen)
    // 곡선의 중점이 끝점이 되도록 전체를 평행이동(2차 곡선 중점 = (e1 + 2·0 + e2)/4)
    let apex = CGPoint(x: (e1.x + e2.x) / 4, y: (e1.y + e2.y) / 4)
    func s(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - apex.x, y: -(p.y - apex.y)) } // 레이어 좌표(y 위)로
    let path = CGMutablePath()
    path.move(to: s(e1))
    path.addQuadCurve(to: s(e2), control: s(.zero))
    // 큰 원호: t2 → 원을 돌아 → t1. 레이어 좌표(y 위)에서의 각도를 쓴다.
    let c = s(center)
    let p2 = s(CGPoint(x: t2.x, y: t2.y)), p1 = s(CGPoint(x: t1.x, y: t1.y))
    let a2 = atan2(p2.y - c.y, p2.x - c.x), a1 = atan2(p1.y - c.y, p1.x - c.x)
    // e2는 t2 위쪽(가상 뾰족점 쪽)에 있으므로 선분으로 t2까지 내려간 뒤 원호
    path.addLine(to: p2)
    func norm(_ a: CGFloat) -> CGFloat { var v = a.truncatingRemainder(dividingBy: 2 * .pi); if v < 0 { v += 2 * .pi }; return v }
    let af = atan2(-u.y, u.x) // 꼬리 반대쪽(먼 쪽) 방향, 레이어 좌표
    let ccwPassesFar = norm(af - a2) < norm(a1 - a2)
    path.addArc(center: c, radius: r, startAngle: a2, endAngle: a1, clockwise: !ccwPassesFar)
    path.addLine(to: s(e1))
    path.closeSubpath()
    return path
  }

  private func buildBody(into parent: CALayer) {
    let path = Self.bodyPath()
    let bbox = path.boundingBoxOfPath

    // 1) 외곽 헤어라인(밝은 창 위 윤곽)
    let halo = CAShapeLayer()
    halo.path = path
    halo.fillColor = nil
    halo.strokeColor = CursorTokens.shadowInk.with(alpha: 0.30).cgColor
    halo.lineWidth = 4.5
    halo.lineJoin = .round
    parent.addSublayer(halo)

    // 2) 흰 테두리 1.5pt + 부드러운 그림자(`--shadow-floating` 톤)
    let rim = CAShapeLayer()
    rim.path = path
    rim.fillColor = cInk
    rim.strokeColor = cInk
    rim.lineWidth = 3 // 바깥으로 1.5pt가 보인다
    rim.lineJoin = .round
    rim.shadowColor = cShadow
    rim.shadowOpacity = 0.38
    rim.shadowRadius = 6
    rim.shadowOffset = CGSize(width: 0, height: -4) // y 위 좌표: 아래로 4
    parent.addSublayer(rim)

    // 3) 그라데이션 몸체(위 밝음 → 아래 진함)
    let gradient = CAGradientLayer()
    gradient.frame = bbox
    gradient.colors = [cLift, cBadge, cVivid]
    gradient.locations = [0, 0.55, 1]
    gradient.startPoint = CGPoint(x: 0.3, y: 1) // 레이어 좌표 y 위: 위쪽이 1
    gradient.endPoint = CGPoint(x: 0.7, y: 0)
    let mask = CAShapeLayer()
    var shift = CGAffineTransform(translationX: -bbox.minX, y: -bbox.minY)
    mask.path = path.copy(using: &shift)
    mask.fillColor = .black
    gradient.mask = mask
    parent.addSublayer(gradient)

    // 4) 물방울 하이라이트
    let gloss = CAShapeLayer()
    let gc = CGPoint(x: bbox.midX - 1.5, y: bbox.minY + bbox.height * 0.64)
    let glossXf = CGAffineTransform(rotationAngle: .pi / 6).concatenating(CGAffineTransform(translationX: gc.x, y: gc.y))
    gloss.path = CGPath(ellipseIn: CGRect(x: -4.2, y: -2.6, width: 8.4, height: 5.2), transform: nil).copy(using: [glossXf])
    gloss.fillColor = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.34)
    parent.addSublayer(gloss)
  }

  private func buildBadge(at tipLayer: CGPoint) {
    let w: CGFloat = 40, h: CGFloat = 18
    badge.bounds = CGRect(x: 0, y: 0, width: w, height: h)
    badge.anchorPoint = CGPoint(x: 0, y: 1) // 좌상단 고정
    badge.position = CGPoint(x: tipLayer.x + 17, y: tipLayer.y - 27)
    badge.cornerRadius = h / 2 // `--radius-pill`
    badge.backgroundColor = cBadge
    badge.borderColor = cInk
    badge.borderWidth = 1.5
    badge.shadowColor = cShadow
    badge.shadowOpacity = 0.34
    badge.shadowRadius = 4
    badge.shadowOffset = CGSize(width: 0, height: -2)
    content.addSublayer(badge)

    badgeText.string = "Fleet"
    badgeText.font = NSFont.systemFont(ofSize: 10.5, weight: .bold)
    badgeText.fontSize = 10.5
    badgeText.foregroundColor = cInk
    badgeText.alignmentMode = .center
    badgeText.bounds = CGRect(x: 0, y: 0, width: 30, height: 13)
    badgeText.position = CGPoint(x: w / 2, y: h / 2 - 0.5)
    badge.addSublayer(badgeText)

    dots.bounds = CGRect(x: 0, y: 0, width: 14, height: 6)
    dots.position = CGPoint(x: w - 12, y: h / 2)
    dots.opacity = 0
    for i in 0..<3 {
      let d = CAShapeLayer()
      d.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: 3.4, height: 3.4), transform: nil)
      d.fillColor = cInk
      d.position = CGPoint(x: CGFloat(i) * 5.2 + 1.7, y: 3)
      d.bounds = CGRect(x: 0, y: 0, width: 3.4, height: 3.4)
      d.path = CGPath(ellipseIn: d.bounds, transform: nil)
      dots.addSublayer(d)
    }
    badge.addSublayer(dots)
  }

  private func buildScrollChip(at tipLayer: CGPoint) {
    let d: CGFloat = 24
    scrollChip.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    scrollChip.position = CGPoint(x: tipLayer.x - 24, y: tipLayer.y - 6)
    scrollChip.cornerRadius = d / 2
    scrollChip.backgroundColor = cBadge
    scrollChip.borderColor = cInk
    scrollChip.borderWidth = 1.5
    scrollChip.shadowColor = cShadow
    scrollChip.shadowOpacity = 0.3
    scrollChip.shadowRadius = 4
    scrollChip.shadowOffset = CGSize(width: 0, height: -2)
    scrollChip.opacity = 0
    let chev = CGMutablePath()
    chev.move(to: CGPoint(x: -4.5, y: -2.2))
    chev.addLine(to: CGPoint(x: 0, y: 2.4))
    chev.addLine(to: CGPoint(x: 4.5, y: -2.2))
    scrollChevron.path = chev
    scrollChevron.fillColor = nil
    scrollChevron.strokeColor = cInk
    scrollChevron.lineWidth = 2.4
    scrollChevron.lineCap = .round
    scrollChevron.lineJoin = .round
    scrollChevron.position = CGPoint(x: d / 2, y: d / 2)
    scrollChip.addSublayer(scrollChevron)
    content.addSublayer(scrollChip)
  }

  private func buildDragRing(at tipLayer: CGPoint) {
    dragRing.path = CGPath(ellipseIn: CGRect(x: -17, y: -17, width: 34, height: 34), transform: nil)
    dragRing.position = tipLayer
    dragRing.fillColor = CursorTokens.badge.with(alpha: 0.12).cgColor
    dragRing.strokeColor = cBadge
    dragRing.lineWidth = 2
    dragRing.lineDashPattern = [5, 4]
    dragRing.opacity = 0
    content.insertSublayer(dragRing, below: pointer)
  }

  // MARK: 화면 배율

  func applyScale(_ scale: CGFloat) {
    func walk(_ l: CALayer) {
      l.contentsScale = scale
      l.rasterizationScale = scale
      l.sublayers?.forEach(walk)
    }
    walk(root)
  }

  // MARK: 프레임마다 (디스플레이 링크)

  /// 이동 속도(y 위 좌표계, pt/s)와 도착 흔들림으로 squash & stretch를 만든다.
  func applyDeform(velocity: CGPoint, settle: CGFloat, settleAxis: CGFloat) {
    guard !reduceMotion else { pointer.setAffineTransform(.identity); return }
    let speed = hypot(velocity.x, velocity.y)
    let stretch = CGFloat(tanh(Double(speed) / 4200)) * 0.40 // 진행 방향으로 최대 +40%
    var along = 1 + stretch
    var theta = atan2(velocity.y, velocity.x)
    if speed < 30 { theta = settleAxis }
    along *= (1 + settle)
    let across = 1 / sqrt(max(0.3, along)) // 부피 보존
    let r1 = CGAffineTransform(rotationAngle: -theta)
    let s = CGAffineTransform(scaleX: along, y: across)
    let r2 = CGAffineTransform(rotationAngle: theta)
    let lean = -max(-0.2, min(0.2, velocity.x / 9000)) // 꼬리가 진행 반대쪽으로 끌린다
    let t = r1.concatenating(s).concatenating(r2).concatenating(CGAffineTransform(rotationAngle: lean))
    pointer.setAffineTransform(t)
  }

  /// 배지·스크롤 표식이 몸체보다 살짝 늦게 따라온다.
  func applyFollow(velocity: CGPoint, dt: CGFloat) {
    let k: CGFloat = reduceMotion ? 0 : 1
    let target = CGPoint(x: max(-9, min(9, -velocity.x * 0.012)) * k, y: max(-9, min(9, -velocity.y * 0.012)) * k)
    let a = min(1, dt * 16)
    badgeLag.x += (target.x - badgeLag.x) * a
    badgeLag.y += (target.y - badgeLag.y) * a
    let tipLayer = CGPoint(x: Self.tip.x, y: Self.panelSize.height - Self.tip.y)
    badge.position = CGPoint(x: tipLayer.x + 17 + badgeLag.x, y: tipLayer.y - 27 + badgeLag.y)
    scrollChip.position = CGPoint(x: tipLayer.x - 24 + badgeLag.x, y: tipLayer.y - 6 + badgeLag.y)
  }

  // MARK: 등장·퇴장·대기

  func appear(animated: Bool) {
    content.removeAllAnimations()
    content.opacity = 1
    guard animated else { startBreathing(); return }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0; fade.toValue = 1; fade.duration = CursorTokens.durationFast
    content.add(fade, forKey: "fade")
    if !reduceMotion {
      let pop = CASpringAnimation(keyPath: "transform.scale")
      pop.fromValue = 0.55; pop.toValue = 1
      pop.mass = 1; pop.stiffness = 420; pop.damping = 17; pop.initialVelocity = 0
      pop.duration = pop.settlingDuration
      content.add(pop, forKey: "pop")
    }
    startBreathing()
  }

  func disappear(animated: Bool, completion: @escaping @MainActor () -> Void) {
    stopBreathing()
    guard animated else { completion(); return }
    content.opacity = 0
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1; fade.toValue = 0; fade.duration = CursorTokens.durationBase
    fade.timingFunction = CursorTokens.easeSoft.timingFunction
    content.add(fade, forKey: "fade")
    if !reduceMotion {
      let shrink = CABasicAnimation(keyPath: "transform.scale")
      shrink.fromValue = 1; shrink.toValue = 0.7; shrink.duration = CursorTokens.durationBase
      shrink.timingFunction = CursorTokens.easeSoft.timingFunction
      content.add(shrink, forKey: "shrink")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + CursorTokens.durationBase) { completion() }
  }

  /// 대기 중 숨 쉬듯 미세한 크기 변화(±3%). 렌더 서버가 돌리므로 우리 CPU는 쓰지 않는다.
  func startBreathing() {
    guard !reduceMotion, breath.animation(forKey: "breath") == nil else { return }
    let a = CABasicAnimation(keyPath: "transform.scale")
    a.fromValue = 1.0; a.toValue = 1.035
    a.duration = 1.5
    a.autoreverses = true
    a.repeatCount = .infinity
    a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    breath.add(a, forKey: "breath")
  }

  func stopBreathing() { breath.removeAnimation(forKey: "breath") }

  /// 숨김 때 상태를 모두 초기화한다.
  func resetState() {
    setTyping(false, animated: false)
    if dragging { dragging = false; press.removeAllAnimations(); press.setAffineTransform(.identity); dragRing.removeAllAnimations(); dragRing.opacity = 0 }
    press.removeAllAnimations(); wiggle.removeAllAnimations(); scrollChip.removeAllAnimations()
    scrollChip.opacity = 0
    for l in content.sublayers ?? [] where l.name == "ripple" { l.removeFromSuperlayer() }
  }

  // MARK: 펄스

  private func pressKeyframes(downs: Int) -> CAKeyframeAnimation {
    // 눌림 80ms(`--motion-tap`) → 살짝 튀어 오르며 복원(`--duration-fast` 스프링 느낌)
    let tap = CursorTokens.motionTap, release = CursorTokens.durationBase
    var values: [Double] = [1], times: [Double] = [0], funcs: [CAMediaTimingFunction] = []
    var t = 0.0
    let cycle = tap + release
    let total = cycle * Double(downs) + (downs > 1 ? 0.0 : 0.0)
    for i in 0..<downs {
      values.append(0.80); times.append((t + tap) / total); funcs.append(CAMediaTimingFunction(name: .easeOut))
      values.append(i == downs - 1 ? 1.07 : 1.0); times.append((t + tap + release * 0.55) / total); funcs.append(CursorTokens.easeSpring.timingFunction)
      t += cycle
      if i == downs - 1 { values.append(1); times.append(1); funcs.append(CAMediaTimingFunction(name: .easeInEaseOut)) }
      else { values.append(1.0); times.append(t / total); funcs.append(CAMediaTimingFunction(name: .easeInEaseOut)) }
    }
    let a = CAKeyframeAnimation(keyPath: "transform.scale")
    a.values = values; a.keyTimes = times.map { NSNumber(value: $0) }; a.timingFunctions = funcs
    a.duration = total
    return a
  }

  /// 물결 고리. 왼쪽 클릭은 둥근 고리, 오른쪽 클릭은 둥근 사각 고리(`--radius-md`)라 한눈에 구분된다.
  private func spawnRipple(square: Bool, delay: Double = 0) {
    let tipLayer = CGPoint(x: Self.tip.x, y: Self.panelSize.height - Self.tip.y)
    let holder = CALayer()
    holder.name = "ripple"
    holder.position = tipLayer
    holder.opacity = 0
    func ring(color: CGColor, width: CGFloat, fill: CGColor?) -> CAShapeLayer {
      let s = CAShapeLayer()
      let r: CGFloat = 18
      let rect = CGRect(x: -r, y: -r, width: r * 2, height: r * 2)
      s.path = square ? CGPath(roundedRect: rect.insetBy(dx: 2, dy: 2), cornerWidth: CursorTokens.radiusMD * 0.9, cornerHeight: CursorTokens.radiusMD * 0.9, transform: nil)
                      : CGPath(ellipseIn: rect, transform: nil)
      s.fillColor = fill
      s.strokeColor = color
      s.lineWidth = width
      return s
    }
    holder.addSublayer(ring(color: cInk, width: 4.5, fill: nil))                     // 흰 바깥 고리: 어두운 창 위에서 보인다
    holder.addSublayer(ring(color: cBadge, width: 2.4, fill: CursorTokens.badge.with(alpha: 0.14).cgColor)) // 토큰색 고리
    content.insertSublayer(holder, below: pointer)
    let dur = square ? 0.62 : 0.52
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = square ? 0.35 : 0.3; grow.toValue = square ? 1.9 : 2.2
    grow.duration = dur; grow.timingFunction = CursorTokens.easeSpring.timingFunction
    if square {
      let spin = CABasicAnimation(keyPath: "transform.rotation.z")
      spin.fromValue = -0.5; spin.toValue = 0; spin.duration = dur; spin.timingFunction = CursorTokens.easeSpring.timingFunction
      holder.add(spin, forKey: "spin")
    }
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0.0, 1.0, 0.0]; fade.keyTimes = [0, 0.12, 1]; fade.duration = dur
    let group = CAAnimationGroup()
    group.animations = [grow, fade]; group.duration = dur; group.beginTime = holder.convertTime(CACurrentMediaTime(), from: nil) + delay + 0.0001
    group.fillMode = .backwards
    holder.add(group, forKey: "ripple")
    DispatchQueue.main.asyncAfter(deadline: .now() + delay + dur + 0.05) { holder.removeFromSuperlayer() }
  }

  /// 반환값: 호출자가 기다릴 만한 시간(초)
  func pulse(_ kind: AICursorPulse) -> Double {
    switch kind {
    case .click:
      press.add(pressKeyframes(downs: 1), forKey: "press")
      spawnRipple(square: false)
      return CursorTokens.motionTap + 0.03
    case .doubleClick:
      press.add(pressKeyframes(downs: 2), forKey: "press")
      spawnRipple(square: false)
      spawnRipple(square: false, delay: 0.17)
      return (CursorTokens.motionTap + 0.09) * 2
    case .rightClick:
      press.add(pressKeyframes(downs: 1), forKey: "press")
      let w = CAKeyframeAnimation(keyPath: "transform.rotation.z")
      w.values = [0, -0.26, 0.16, -0.06, 0]; w.keyTimes = [0, 0.22, 0.5, 0.78, 1]; w.duration = 0.42
      w.timingFunction = CursorTokens.easeSoft.timingFunction
      wiggle.add(w, forKey: "wiggle")
      spawnRipple(square: true)
      return CursorTokens.motionTap + 0.03
    case .typing(let on):
      setTyping(on, animated: true)
      return CursorTokens.durationFast
    case .scroll(let dir):
      scrollPulse(dir)
      return CursorTokens.durationSlow
    case .dragBegin:
      setDragging(true)
      return CursorTokens.durationFast
    case .dragEnd:
      setDragging(false)
      return CursorTokens.durationFast
    }
  }

  /// 타이핑 중: 배지가 늘어나며 「Fleet」 옆에 점 3개가 차례로 튄다.
  func setTyping(_ on: Bool, animated: Bool) {
    guard on != typing else { return }
    typing = on
    let newW: CGFloat = on ? 62 : 40
    let h: CGFloat = 18
    let oldBounds = badge.bounds
    badge.bounds = CGRect(x: 0, y: 0, width: newW, height: h)
    let textX: CGFloat = on ? 9 + 15 : newW / 2
    let oldText = badgeText.position
    badgeText.position = CGPoint(x: textX, y: h / 2 - 0.5)
    dots.position = CGPoint(x: newW - 14, y: h / 2)
    dots.opacity = on ? 1 : 0
    if animated {
      let spring = CASpringAnimation(keyPath: "bounds")
      spring.fromValue = NSValue(rect: oldBounds); spring.toValue = NSValue(rect: badge.bounds)
      spring.mass = 1; spring.stiffness = 360; spring.damping = 20; spring.duration = spring.settlingDuration
      badge.add(spring, forKey: "w")
      let mv = CASpringAnimation(keyPath: "position")
      mv.fromValue = NSValue(point: oldText); mv.toValue = NSValue(point: badgeText.position)
      mv.mass = 1; mv.stiffness = 360; mv.damping = 20; mv.duration = mv.settlingDuration
      badgeText.add(mv, forKey: "x")
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = on ? 0 : 1; fade.toValue = on ? 1 : 0; fade.duration = CursorTokens.durationFast
      dots.add(fade, forKey: "fade")
    }
    if on {
      for (i, d) in (dots.sublayers ?? []).enumerated() where !reduceMotion {
        let hop = CAKeyframeAnimation(keyPath: "transform.translation.y")
        hop.values = [0, 3.2, 0, 0]; hop.keyTimes = [0, 0.25, 0.5, 1]; hop.duration = 0.95
        hop.repeatCount = .infinity; hop.beginTime = d.convertTime(CACurrentMediaTime(), from: nil) + Double(i) * 0.14
        hop.timingFunction = CursorTokens.easeSoft.timingFunction
        hop.fillMode = .backwards
        d.add(hop, forKey: "hop")
        let blink = CAKeyframeAnimation(keyPath: "opacity")
        blink.values = [0.55, 1, 0.55, 0.55]; blink.keyTimes = [0, 0.25, 0.5, 1]; blink.duration = 0.95
        blink.repeatCount = .infinity; blink.beginTime = hop.beginTime; blink.fillMode = .backwards
        d.add(blink, forKey: "blink")
      }
    } else {
      dots.sublayers?.forEach { $0.removeAllAnimations() }
    }
  }

  private func scrollPulse(_ dir: AICursorPulse.Direction) {
    let angle: CGFloat, vec: CGPoint
    switch dir {
    case .up: angle = 0; vec = CGPoint(x: 0, y: 1)
    case .right: angle = -.pi / 2; vec = CGPoint(x: 1, y: 0)
    case .down: angle = .pi; vec = CGPoint(x: 0, y: -1)
    case .left: angle = .pi / 2; vec = CGPoint(x: -1, y: 0)
    }
    scrollChevron.setAffineTransform(CGAffineTransform(rotationAngle: angle))
    scrollChip.removeAllAnimations(); scrollChevron.removeAllAnimations()
    scrollChip.opacity = 0
    let dur = 0.62
    let vis = CAKeyframeAnimation(keyPath: "opacity")
    vis.values = [0, 1, 1, 0]; vis.keyTimes = [0, 0.15, 0.8, 1]; vis.duration = dur
    let pop = CAKeyframeAnimation(keyPath: "transform.scale")
    pop.values = [0.5, 1.08, 1, 0.9]; pop.keyTimes = [0, 0.3, 0.8, 1]; pop.duration = dur
    pop.timingFunction = CursorTokens.easeSpring.timingFunction
    let g = CAAnimationGroup(); g.animations = [vis, pop]; g.duration = dur
    scrollChip.add(g, forKey: "chip")
    // 쉐브론이 방향으로 두 번 흘러간다
    let slide = CAKeyframeAnimation(keyPath: "position")
    let c = CGPoint(x: 12, y: 12)
    let d: CGFloat = 4.5
    slide.values = [NSValue(point: CGPoint(x: c.x - vec.x * d, y: c.y - vec.y * d)), NSValue(point: CGPoint(x: c.x + vec.x * d, y: c.y + vec.y * d)),
                    NSValue(point: CGPoint(x: c.x - vec.x * d, y: c.y - vec.y * d)), NSValue(point: CGPoint(x: c.x + vec.x * d, y: c.y + vec.y * d))]
    slide.keyTimes = [0, 0.45, 0.5, 0.95]; slide.duration = dur
    slide.timingFunctions = [CursorTokens.easeSoft.timingFunction, CAMediaTimingFunction(name: .linear), CursorTokens.easeSoft.timingFunction]
    scrollChevron.add(slide, forKey: "slide")
    if !reduceMotion {
      let nudge = CAKeyframeAnimation(keyPath: "position")
      let tipLayer = CGPoint(x: Self.tip.x, y: Self.panelSize.height - Self.tip.y)
      _ = tipLayer
      let n = CAKeyframeAnimation(keyPath: "transform.translation.y")
      n.values = [0, vec.y * 2.5, 0]; n.keyTimes = [0, 0.4, 1]; n.duration = 0.3
      wiggle.add(n, forKey: "nudge")
      _ = nudge
    }
  }

  /// 드래그 중: 몸체가 쥔 듯 눌린 채 유지되고, 끝점 둘레에 점선 고리가 천천히 돈다.
  func setDragging(_ on: Bool) {
    guard on != dragging else { return }
    dragging = on
    press.removeAllAnimations()
    let from = (press.presentation()?.value(forKeyPath: "transform.scale") as? Double) ?? 1
    let target = on ? 0.88 : 1.0
    press.setAffineTransform(CGAffineTransform(scaleX: target, y: target))
    let s = CASpringAnimation(keyPath: "transform.scale")
    s.fromValue = from; s.toValue = target
    s.mass = 1; s.stiffness = 480; s.damping = on ? 22 : 13; s.duration = s.settlingDuration
    press.add(s, forKey: "grab")
    if on {
      dragRing.opacity = 1
      let spin = CABasicAnimation(keyPath: "transform.rotation.z")
      spin.fromValue = 0; spin.toValue = Double.pi * 2; spin.duration = 3.2; spin.repeatCount = .infinity
      if !reduceMotion { dragRing.add(spin, forKey: "spin") }
      let pop = CASpringAnimation(keyPath: "transform.scale")
      pop.fromValue = 0.4; pop.toValue = 1; pop.mass = 1; pop.stiffness = 380; pop.damping = 18; pop.duration = pop.settlingDuration
      dragRing.add(pop, forKey: "pop")
    } else {
      dragRing.opacity = 0
      dragRing.removeAnimation(forKey: "spin")
      let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 1; fade.toValue = 0; fade.duration = CursorTokens.durationFast
      dragRing.add(fade, forKey: "fade")
      spawnRipple(square: false)
    }
  }
}
