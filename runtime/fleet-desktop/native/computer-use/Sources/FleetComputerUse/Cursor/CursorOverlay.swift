// AI 커서 구현. 클릭 통과 NSPanel 한 장을 대상 창 바로 위(일반 레벨)에 두고, 디스플레이 링크로 창 위치와 변형을 갱신한다.
// 불변: 활성화하지 않는다(orderFrontRegardless·activate 금지), 최상위 레벨 금지, canJoinAllSpaces 금지, 실제 포인터를 건드리지 않는다.
import AppKit
import QuartzCore

final class CursorPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  /// 화면 가장자리에서도 창을 밀어 넣지 않는다 — 끝점이 지정한 좌표에 정확히 있어야 한다.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

@MainActor final class FleetAICursor: AICursorControlling {
  let panel: CursorPanel
  private let art = CursorArt()
  private let hostView: NSView
  private var link: CADisplayLink?

  /// 현재 끝점(전역 CG 좌표). 이동 중에는 프레임마다 갱신된다.
  private(set) var tip = CGPoint(x: -1000, y: -1000)
  private var logicalVisible = false
  private var targetWindow: CGWindowID = 0
  private var currentScale: CGFloat = 0

  // 이동
  private struct Motion { var start: CGPoint; var end: CGPoint; var t0: CFTimeInterval; var duration: Double }
  private var motion: Motion?
  private var waiters: [CheckedContinuation<Void, Never>] = []
  // 도착 흔들림
  private var settleStart: CFTimeInterval?
  private var settleAmp: CGFloat = 0
  private var settleAxis: CGFloat = 0
  private let settleDuration = CursorTokens.durationSlow + 0.04
  private var lastTick: CFTimeInterval = 0
  private var lastTip = CGPoint.zero
  private var velocity = CGPoint.zero // y 위 좌표, pt/s

  // 시험·측정용 (프로토콜 밖)
  var timeScale: Double = 1 { didSet { art.root.speed = Float(1 / max(0.01, timeScale)) } }
  var frameObserver: ((_ timestamp: CFTimeInterval, _ tip: CGPoint, _ moving: Bool) -> Void)?
  private(set) var tickCount = 0
  private(set) var lastMoveReport: (distance: Double, planned: Double)?

  init() {
    let size = CursorArt.panelSize
    panel = CursorPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = .normal
    panel.collectionBehavior = [.ignoresCycle, .fullScreenAuxiliary] // canJoinAllSpaces 금지(다른 Space에 그려진 실측)
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.canHide = false
    panel.isFloatingPanel = false
    panel.worksWhenModal = false
    panel.animationBehavior = .none
    panel.isExcludedFromWindowsMenu = true
    hostView = NSView(frame: NSRect(origin: .zero, size: size))
    hostView.wantsLayer = true
    hostView.layer = art.root
    panel.contentView = hostView
    art.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    art.applyScale(NSScreen.main?.backingScaleFactor ?? 2)
  }

  /// 패널 창 위치와 콘텐츠 보정에서 거꾸로 계산한 끝점(전역 CG). 요청 좌표와 같은지 시험이 대조한다.
  var measuredTip: CGPoint {
    let primaryH = NSScreen.screens.first?.frame.height ?? 0
    return CGPoint(x: panel.frame.origin.x + art.content.position.x, y: primaryH - (panel.frame.origin.y + art.content.position.y))
  }
  var windowNumber: Int { panel.windowNumber }

  // MARK: AICursorControlling

  var isVisible: Bool { logicalVisible }

  func show(at point: CGPoint, above window: CGWindowID) {
    finishWaiters()
    motion = nil; settleStart = nil; velocity = .zero
    targetWindow = window
    let wasVisible = logicalVisible
    art.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    place(point)
    art.applyDeform(velocity: .zero, settle: 0, settleAxis: 0)
    orderAbove(window)
    logicalVisible = true
    if !wasVisible || panel.alphaValue < 1 { art.appear(animated: true) } else { art.startBreathing() }
    updateLink()
  }

  func move(to point: CGPoint, above window: CGWindowID) async {
    guard logicalVisible else {
      show(at: point, above: window)
      try? await Task.sleep(nanoseconds: UInt64(CursorTokens.durationBase * 1e9 * timeScale))
      return
    }
    targetWindow = window
    orderAbove(window)
    let from = tip
    let dist = hypot(point.x - from.x, point.y - from.y)
    guard dist >= 0.5 else { place(point); return }
    let planned = CursorTokens.moveDuration(distance: dist)
    lastMoveReport = (Double(dist), planned)
    settleStart = nil // 이어받기: 지금 위치·속도에서 새 목표로
    motion = Motion(start: from, end: point, t0: CACurrentMediaTime(), duration: planned * timeScale)
    updateLink()
    await withCheckedContinuation { waiters.append($0) }
  }

  func pulse(_ kind: AICursorPulse) async {
    guard logicalVisible else { return }
    let wait = art.pulse(kind)
    updateLink() // 눌림 등은 CA가 돌리므로 링크가 꼭 필요하진 않지만, 배지 따라오기 정리를 위해 한 번 깨운다
    try? await Task.sleep(nanoseconds: UInt64(wait * 1e9 * timeScale))
  }

  func reorder(above window: CGWindowID) {
    targetWindow = window
    guard logicalVisible else { return }
    orderAbove(window)
  }

  func hide(animated: Bool) {
    finishWaiters()
    motion = nil; settleStart = nil; velocity = .zero
    guard logicalVisible else { return }
    logicalVisible = false
    link?.isPaused = true
    art.resetState()
    art.disappear(animated: animated) { [weak self] in
      guard let self, !self.logicalVisible else { return } // 그 사이 다시 show되면 유지
      self.panel.orderOut(nil)
      self.link?.invalidate(); self.link = nil
    }
  }

  // MARK: 좌표·창

  /// 전역 CG 좌표(좌상단 원점) → Cocoa 좌표(좌하단 원점). 주 화면 높이 기준이라 다중 디스플레이에서도 같은 식이다.
  static func cocoaPoint(fromCG p: CGPoint) -> NSPoint {
    let primaryH = NSScreen.screens.first?.frame.height ?? 0
    return NSPoint(x: p.x, y: primaryH - p.y)
  }

  /// 점이 속한 화면(없으면 가장 가까운 화면)
  static func screen(containingCocoa p: NSPoint) -> NSScreen? {
    if let s = NSScreen.screens.first(where: { $0.frame.contains(p) }) { return s }
    return NSScreen.screens.min { a, b in dist2(a.frame, p) < dist2(b.frame, p) }
  }
  private static func dist2(_ r: NSRect, _ p: NSPoint) -> CGFloat {
    let dx = max(r.minX - p.x, 0, p.x - r.maxX), dy = max(r.minY - p.y, 0, p.y - r.maxY)
    return dx * dx + dy * dy
  }

  /// 끝점을 전역 좌표 p에 둔다. 창 원점은 정수 pt로 맞추고 나머지 소수 부분은 콘텐츠 레이어 위치로 보정한다.
  private func place(_ p: CGPoint) {
    tip = p
    let cocoa = Self.cocoaPoint(fromCG: p)
    if let screen = Self.screen(containingCocoa: cocoa), screen.backingScaleFactor != currentScale {
      currentScale = screen.backingScaleFactor
      art.applyScale(currentScale)
    }
    let size = CursorArt.panelSize
    let rawX = cocoa.x - CursorArt.tip.x
    let rawY = cocoa.y - (size.height - CursorArt.tip.y)
    let ox = floor(rawX), oy = floor(rawY)
    if panel.frame.origin.x != ox || panel.frame.origin.y != oy {
      panel.setFrameOrigin(NSPoint(x: ox, y: oy))
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    art.content.position = CGPoint(x: CursorArt.tip.x + (rawX - ox), y: size.height - CursorArt.tip.y + (rawY - oy))
    CATransaction.commit()
  }

  private func orderAbove(_ window: CGWindowID) {
    panel.level = .normal
    panel.order(.above, relativeTo: Int(window)) // 활성화 없이 대상 창 바로 위로
  }

  // MARK: 디스플레이 링크

  private func updateLink() {
    if link == nil {
      let l = hostView.displayLink(target: self, selector: #selector(tick(_:)))
      l.preferredFrameRateRange = CAFrameRateRange(minimum: 55, maximum: 120, preferred: 60)
      l.add(to: .main, forMode: .common)
      link = l
      lastTick = 0
    }
    if link?.isPaused == true { lastTick = 0; lastTip = tip }
    link?.isPaused = false
  }

  private func finishWaiters() {
    let w = waiters; waiters = []
    for c in w { c.resume() }
  }

  @objc private func tick(_ l: CADisplayLink) {
    let now = l.targetTimestamp
    let dt = lastTick == 0 ? 1.0 / 60 : max(1.0 / 240, min(0.1, now - lastTick))
    lastTick = now
    tickCount += 1
    var moving = false

    if let m = motion {
      let raw = (now - m.t0) / m.duration
      let eased = CursorTokens.easeSpring.value(max(0, min(1, raw)))
      let pos = CGPoint(x: m.start.x + (m.end.x - m.start.x) * eased, y: m.start.y + (m.end.y - m.start.y) * eased)
      let vx = Double(pos.x - lastTip.x) / dt, vy = -Double(pos.y - lastTip.y) / dt // y 위로
      let smooth = 0.55
      velocity = CGPoint(x: velocity.x * (1 - smooth) + vx * smooth, y: velocity.y * (1 - smooth) + vy * smooth)
      moving = true
      if raw >= 1 {
        place(m.end)
        motion = nil
        // 도착: 이동 방향 축으로 눌렸다가 통통 튀며 멈춘다. 가까운 이동일수록 약하게.
        let dist = hypot(m.end.x - m.start.x, m.end.y - m.start.y)
        settleAmp = -0.20 * min(1, dist / 140)
        settleAxis = atan2(-(m.end.y - m.start.y), m.end.x - m.start.x)
        settleStart = now
        velocity = .zero
        finishWaiters()
      } else {
        place(pos)
      }
    } else {
      velocity = .zero
    }
    lastTip = tip

    var settle: CGFloat = 0
    if let s = settleStart {
      let t = (now - s) / timeScaleSafe
      if t >= settleDuration { settleStart = nil }
      else {
        // 감쇠 진동: 눌림(-) → 늘어남(+) → 안착
        settle = settleAmp * CGFloat(exp(-t / 0.085) * cos(2 * .pi * t / 0.21))
      }
    }
    art.applyDeform(velocity: velocity, settle: settle, settleAxis: settleAxis)
    art.applyFollow(velocity: velocity, dt: CGFloat(dt))
    frameObserver?(l.timestamp, tip, moving || settleStart != nil)

    if motion == nil && settleStart == nil && abs(art.followResidual) < 0.02 {
      l.isPaused = true // 대기: 링크 정지 → 우리 프로세스 CPU 0
    }
  }

  private var timeScaleSafe: Double { max(0.01, timeScale) }
}

// 배지 따라오기가 가라앉았는지 (링크를 멈추는 조건)
extension CursorArt {
  var followResidual: CGFloat { followMagnitude }
}

// MARK: 기본 커서

@MainActor public func makeAICursor() -> AICursorControlling { FleetAICursor() }
