// 디버그 빌드 전용(main.swift `--cursor-demo`). 릴리스 헬퍼에는 컴파일되지 않는다.
#if DEBUG
// `fleet-computer-use --cursor-demo [--out-dir DIR] [--target-app PATH] [--person-app PATH] [--no-capture]`
// AI 커서 독립 시험. 시험 대상 창(Fleet Spike Target)과 사람 대역 창(Fleet Spike Person)을 직접 exec해 띄우고,
// 여러 지점 이동 → 각 pulse → 대상 창 위 정렬 → 사람 창에 가려진 지점 → 다크/라이트 배경 → hide 순서로 보인 뒤
// 불변 조건과 프레임 측정을 JSON으로 출력한다. 시험 앱은 끝에 모두 종료한다.
import AppKit
import CoreGraphics
import ImageIO

enum CursorDemo {
  @MainActor static func run(arguments: [String]) {
    let options = DemoOptions(arguments)
    Task { @MainActor in
      let code = await DemoRunner(options).run()
      fflush(stdout)
      exit(code)
    }
  }
}

struct DemoOptions {
  var outDir = NSTemporaryDirectory() + "fleet-cursor-demo"
  var targetApp = ""
  var personApp = ""
  var capture = true
  init(_ args: [String]) {
    var i = 0
    while i < args.count {
      switch args[i] {
      case "--out-dir": i += 1; if i < args.count { outDir = args[i] }
      case "--target-app": i += 1; if i < args.count { targetApp = args[i] }
      case "--person-app": i += 1; if i < args.count { personApp = args[i] }
      case "--no-capture": capture = false
      default: break
      }
      i += 1
    }
  }
}

private struct WinInfo { let id: Int; let pid: Int32; let bounds: CGRect }

@MainActor private final class DemoRunner {
  let o: DemoOptions
  let cursor = FleetAICursor()
  var result: [String: Any] = [:]
  var checks: [String: Bool] = [:]
  var scenes: [[String: Any]] = []
  var shots: [String] = []
  var procs: [Process] = []
  var backdrops: [NSWindow] = []

  // 프레임·불변 측정
  var intervals: [Double] = []
  var lastMovingTs: Double?
  var pointerSet = Set<String>()
  var pointerSamples = 0
  var helperActiveSeen = false
  var frontPids = Set<Int32>()
  var frameCount = 0

  init(_ o: DemoOptions) { self.o = o }

  // MARK: 도구

  func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
  func pointerKey() -> String { let p = pointer(); return "\(p.x),\(p.y)" }
  func frontPid() -> Int32 { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1 }
  func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
  func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
  func hit(_ cg: CGPoint) -> Int { NSWindow.windowNumber(at: FleetAICursor.cocoaPoint(fromCG: cg), belowWindowWithWindowNumber: 0) }

  func windows() -> [WinInfo] { // 앞 → 뒤 순서
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { d in
      guard let n = d[kCGWindowNumber as String] as? Int, let pid = d[kCGWindowOwnerPID as String] as? Int32,
            let b = d[kCGWindowBounds as String] as? [String: Any],
            let x = b["X"] as? Double, let y = b["Y"] as? Double, let w = b["Width"] as? Double, let h = b["Height"] as? Double else { return nil }
      return WinInfo(id: n, pid: pid, bounds: CGRect(x: x, y: y, width: w, height: h))
    }
  }

  func launch(_ app: String, exe: String, args: [String]) -> Process? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: app + "/Contents/MacOS/" + exe)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    do { try p.run(); procs.append(p); return p } catch { log("launch failed: \(error)"); return nil }
  }

  func waitWindow(pid: Int32, minWidth: CGFloat = 400) async -> WinInfo? {
    for _ in 0..<60 {
      if let w = windows().first(where: { $0.pid == pid && $0.bounds.width >= minWidth }) { return w }
      await sleep(0.15)
    }
    return nil
  }

  func shell(_ exe: String, _ args: [String]) async {
    let p = Process(); p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      p.terminationHandler = { _ in c.resume() }
      do { try p.run() } catch { c.resume() }
    }
  }

  func capture(_ name: String, _ rect: CGRect) async -> String? {
    guard o.capture else { return nil }
    let path = o.outDir + "/" + name + ".png"
    await shell("/usr/sbin/screencapture", ["-x", "-R", "\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", path])
    if FileManager.default.fileExists(atPath: path) { shots.append(name + ".png"); return path }
    return nil
  }

  func zoomRect(_ tip: CGPoint) -> CGRect { CGRect(x: tip.x - 60, y: tip.y - 56, width: 190, height: 150) }

  func rgba(_ path: String) -> (Int, Int, [UInt8])? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    let w = img.width, h = img.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (w, h, buf)
  }

  func diffPixels(_ a: String, _ b: String) -> Int? {
    guard let x = rgba(a), let y = rgba(b), x.0 == y.0, x.1 == y.1 else { return nil }
    var n = 0
    for i in stride(from: 0, to: x.2.count, by: 4) {
      let d = abs(Int(x.2[i]) - Int(y.2[i])) + abs(Int(x.2[i + 1]) - Int(y.2[i + 1])) + abs(Int(x.2[i + 2]) - Int(y.2[i + 2]))
      if d > 12 { n += 1 }
    }
    return n
  }

  func makeBackdrop(dark: Bool, at origin: CGPoint, size: CGSize) -> NSWindow {
    let primaryH = NSScreen.screens.first!.frame.height
    let frame = NSRect(x: origin.x, y: primaryH - origin.y - size.height, width: size.width, height: size.height)
    let w = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.level = .normal
    w.hasShadow = false
    w.backgroundColor = .clear
    let v = NSView(frame: NSRect(origin: .zero, size: size))
    v.wantsLayer = true
    // Fleet 토큰: 다크 = --ink-deep oklch(16.5% 0.016 245) / --surface-panel oklch(21.8% 0 0), 라이트 = --ink-deep oklch(95.5% 0 0) / --surface-panel oklch(100% 0 0)
    let base = dark ? OKLCH(0.165, 0.016, 245) : OKLCH(0.955, 0, 0)
    let card = dark ? OKLCH(0.218, 0, 0) : OKLCH(1, 0, 0)
    let text = dark ? OKLCH(0.94, 0.008, 90) : OKLCH(0.22, 0, 0)
    v.layer?.backgroundColor = base.cgColor
    v.layer?.cornerRadius = 16
    for i in 0..<3 {
      let c = CALayer()
      c.frame = CGRect(x: 20, y: 20 + CGFloat(i) * 78, width: size.width - 40, height: 64)
      c.backgroundColor = card.cgColor; c.cornerRadius = CursorTokens.radiusMD
      c.borderColor = (dark ? OKLCH(1, 0, 0, alpha: 0.12) : OKLCH(0.38, 0, 0, alpha: 0.18)).cgColor; c.borderWidth = 1
      v.layer?.addSublayer(c)
    }
    let label = NSTextField(labelWithString: dark ? "Fleet · 다크 배경" : "Fleet · 라이트 배경")
    label.textColor = NSColor(cgColor: text.cgColor); label.font = .systemFont(ofSize: 14, weight: .semibold)
    label.frame = NSRect(x: 30, y: size.height - 52, width: 240, height: 20)
    v.addSubview(label)
    w.contentView = v
    w.orderFrontRegardless()
    backdrops.append(w)
    return w
  }

  // MARK: 장면 도우미

  var tipGeometryErrors: [Double] = []

  func record(_ name: String, to p: CGPoint, expectHit: Int?, extra: [String: Any] = [:]) {
    let m = cursor.measuredTip
    let err = hypot(Double(m.x - p.x), Double(m.y - p.y))
    tipGeometryErrors.append(err)
    let cursorNo = cursor.windowNumber
    let hits: [(String, Int)] = [("tip", hit(p)), ("body", hit(CGPoint(x: p.x + 10, y: p.y + 18))), ("badge", hit(CGPoint(x: p.x + 30, y: p.y + 33)))]
    var s: [String: Any] = ["scene": name, "target": [p.x, p.y], "measuredTip": [m.x, m.y], "tipErrorPt": err, "cursorWindow": cursorNo,
                            "hitTip": hits[0].1, "hitBody": hits[1].1, "hitBadge": hits[2].1,
                            "hitNeverCursor": hits.allSatisfy { $0.1 != cursorNo }]
    if let e = expectHit { s["expectedHit"] = e; s["hitTipIsExpected"] = hits[0].1 == e }
    for (k, v) in extra { s[k] = v }
    scenes.append(s)
  }

  func go(_ name: String, _ p: CGPoint, above: Int, expectHit: Int?) async {
    await cursor.move(to: p, above: CGWindowID(above))
    await sleep(0.45) // 도착 후 통통 튀는 흔들림이 가라앉을 때까지
    var extra: [String: Any] = [:]
    if let r = cursor.lastMoveReport { extra["moveDistancePt"] = r.distance; extra["plannedMoveSec"] = r.planned }
    record(name, to: p, expectHit: expectHit, extra: extra)
  }

  func zOrderNames(person: Int, target: Int) -> [String: Any] {
    let ids = windows().map { $0.id }
    let c = cursor.windowNumber
    let ip = ids.firstIndex(of: person), ic = ids.firstIndex(of: c), it = ids.firstIndex(of: target)
    var ok = false
    if let ip, let ic, let it { ok = ip < ic && ic < it }
    var adjacent = false
    if let ic, let it { adjacent = it - ic >= 1 } // 바로 위(사이에 다른 앱 창이 끼면 안 됨)
    if let ic, let it { adjacent = (ids[(ic + 1)..<it].filter { _ in true }.isEmpty) }
    return ["order(front→back)": ["person", "cursor", "target"], "personIdx": ip as Any, "cursorIdx": ic as Any, "targetIdx": it as Any, "personAboveCursorAboveTarget": ok, "cursorImmediatelyAboveTarget": adjacent]
  }

  // MARK: 실행

  func run() async -> Int32 {
    try? FileManager.default.createDirectory(atPath: o.outDir, withIntermediateDirectories: true)
    guard !o.targetApp.isEmpty, !o.personApp.isEmpty else {
      log("--target-app, --person-app 경로가 필요하다(증거 디렉터리 ext/build의 Fleet Spike Target.app, Fleet Spike Person.app).")
      return 2
    }
    let screens = NSScreen.screens.map { ["frame": [$0.frame.minX, $0.frame.minY, $0.frame.width, $0.frame.height], "scale": $0.backingScaleFactor] }
    result["environment"] = ["os": ProcessInfo.processInfo.operatingSystemVersionString, "screens": screens,
                             "reduceMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "demoPid": ProcessInfo.processInfo.processIdentifier]

    // 시험 앱: 대상(뒤) → 사람 대역(앞, 대상의 오른쪽 아래를 가린다)
    let logDir = NSTemporaryDirectory()
    guard let tProc = launch(o.targetApp, exe: "fleet-spike-target", args: ["--log", logDir + "cursor-demo-target.jsonl", "--origin", "60,100", "--title", "Cursor Demo Target"]),
          let tWin = await waitWindow(pid: tProc.processIdentifier) else { log("대상 창을 띄우지 못했다"); cleanup(); return 3 }
    await sleep(0.4)
    guard let pProc = launch(o.personApp, exe: "fleet-spike-person", args: ["--log", logDir + "cursor-demo-person.jsonl", "--origin", "400,300", "--title", "Person Stand-in"]),
          let pWin = await waitWindow(pid: pProc.processIdentifier) else { log("사람 대역 창을 띄우지 못했다"); cleanup(); return 3 }
    await sleep(0.8)
    let tb = tWin.bounds, pb = pWin.bounds
    let dark = makeBackdrop(dark: true, at: CGPoint(x: 1120, y: 120), size: CGSize(width: 420, height: 270))
    let light = makeBackdrop(dark: false, at: CGPoint(x: 1120, y: 440), size: CGSize(width: 420, height: 270))
    await sleep(0.4)
    let target = tWin.id, person = pWin.id

    let titleH = tb.height - 660
    func content(_ cx: CGFloat, _ cyFromBottom: CGFloat) -> CGPoint { CGPoint(x: tb.minX + cx, y: tb.minY + titleH + (660 - cyFromBottom)) }
    let A = content(112, 450), B = content(210, 575), C = content(190, 315), Dd = content(510, 575), Q = content(510, 450)
    result["layout"] = ["targetWindow": target, "targetBounds": [tb.minX, tb.minY, tb.width, tb.height], "personWindow": person, "personBounds": [pb.minX, pb.minY, pb.width, pb.height],
                        "darkBackdrop": dark.windowNumber, "lightBackdrop": light.windowNumber, "points": ["A": [A.x, A.y], "B": [B.x, B.y], "C": [C.x, C.y], "D": [Dd.x, Dd.y], "Q_occluded": [Q.x, Q.y]]]

    // 불변 기준
    let frontBefore = frontPid()
    let pointerBefore = pointer()
    let wideRect = tb // 시험 창 안쪽만 찍는다(주변 배경 화면이 증거에 남지 않도록)
    let personFront = frontBefore == pProc.processIdentifier
    frontPids.insert(frontBefore)

    cursor.frameObserver = { [unowned self] ts, _, moving in
      self.frameCount += 1
      self.pointerSamples += 1
      self.pointerSet.insert(self.pointerKey())
      if NSRunningApplication.current.isActive { self.helperActiveSeen = true }
      if self.frameCount % 5 == 0 { self.frontPids.insert(self.frontPid()) }
      if moving {
        if let l = self.lastMovingTs, ts - l < 0.1 { self.intervals.append(ts - l) }
        self.lastMovingTs = ts
      } else { self.lastMovingTs = nil }
    }

    // 1) 등장 + 여러 지점 이동
    cursor.show(at: A, above: CGWindowID(target))
    await sleep(0.7)
    record("show A (pop-in)", to: A, expectHit: target)
    _ = await capture("01-show", wideRect)
    await go("move A→B", B, above: target, expectHit: target)

    // 2) 이동 중 캡처(느린 시간 ×5로 한 프레임을 잡는다)
    cursor.timeScale = 5
    let farMove = Task { @MainActor in await self.cursor.move(to: C, above: CGWindowID(target)) }
    await sleep(0.10)
    _ = await capture("02-moving", wideRect)
    // 두 번째 캡처는 같은 이동의 다른 순간
    await sleep(0.05)
    let mid = cursor.tip
    _ = await capture("02-moving-zoom", zoomRect(mid))
    await farMove.value
    cursor.timeScale = 1
    await sleep(0.45)
    record("move B→C (slow ×5 capture)", to: C, expectHit: target)

    // 3) 각 pulse
    await cursor.pulse(.click); await sleep(0.5)
    cursor.timeScale = 5
    let clickTask = Task { @MainActor in await self.cursor.pulse(.click) }
    await sleep(0.45)
    _ = await capture("03-click-ripple", zoomRect(C))
    await clickTask.value
    await sleep(2.8); cursor.timeScale = 1
    await cursor.pulse(.doubleClick); await sleep(0.7)
    cursor.timeScale = 5
    let rc = Task { @MainActor in await self.cursor.pulse(.rightClick) }
    await sleep(0.55)
    _ = await capture("04-right-click", zoomRect(C))
    await rc.value
    await sleep(3.2); cursor.timeScale = 1
    scenes.append(["scene": "pulses click/doubleClick/rightClick", "ok": true])

    await cursor.pulse(.typing(true)); await sleep(0.9)
    _ = await capture("05-typing", zoomRect(C))
    await cursor.pulse(.typing(false)); await sleep(0.4)
    for d in [AICursorPulse.Direction.up, .down, .left, .right] {
      cursor.timeScale = 3
      let t = Task { @MainActor in await self.cursor.pulse(.scroll(d)) }
      await sleep(0.55)
      if case .down = d { _ = await capture("06-scroll-down", zoomRect(C)) }
      await t.value; await sleep(1.4); cursor.timeScale = 1
    }
    await cursor.pulse(.dragBegin); await sleep(0.4)
    _ = await capture("07-drag-grab", zoomRect(C))
    await go("drag C→D (grabbed)", Dd, above: target, expectHit: target)
    await cursor.pulse(.dragEnd); await sleep(0.6)

    // 4) 대상 창 위 정렬 (사람 창은 그 위)
    cursor.reorder(above: CGWindowID(target))
    await sleep(0.2)
    var z = zOrderNames(person: person, target: target)
    result["zOrderAtVisiblePoint"] = z

    // 5) 사람 대역 창에 가려진 지점
    await go("move D→Q (occluded by person)", Q, above: target, expectHit: person)
    z = zOrderNames(person: person, target: target)
    result["zOrderAtOccludedPoint"] = z
    _ = await capture("08-occluded", CGRect(x: Q.x - 150, y: Q.y - 110, width: 280, height: 220))
    cursor.show(at: CGPoint(x: pb.minX - 14, y: Q.y + 60), above: CGWindowID(target)); await sleep(0.8)
    record("partial occlusion at person edge", to: CGPoint(x: pb.minX - 14, y: Q.y + 60), expectHit: target)
    _ = await capture("08b-partial-occlusion", CGRect(x: pb.minX - 160, y: Q.y - 20, width: 280, height: 200))
    cursor.show(at: Q, above: CGWindowID(target)); await sleep(0.8)
    let occShown = await capture("tmp-occ-shown", zoomRect(Q))
    cursor.hide(animated: false)
    await sleep(0.35)
    let occHidden = await capture("tmp-occ-hidden", zoomRect(Q))
    var occDiff: Int? = nil
    if let a = occShown, let b = occHidden { occDiff = diffPixels(a, b) }
    // 대조군: 가려지지 않은 지점에서는 커서 유무가 화면 픽셀을 바꾼다
    cursor.show(at: A, above: CGWindowID(target)); await sleep(0.8)
    let visShown = await capture("tmp-vis-shown", zoomRect(A))
    cursor.hide(animated: false); await sleep(0.35)
    let visHidden = await capture("tmp-vis-hidden", zoomRect(A))
    var visDiff: Int? = nil
    if let a = visShown, let b = visHidden { visDiff = diffPixels(a, b) }
    for n in ["tmp-occ-shown", "tmp-occ-hidden", "tmp-vis-shown", "tmp-vis-hidden"] { try? FileManager.default.removeItem(atPath: o.outDir + "/" + n + ".png"); shots.removeAll { $0 == n + ".png" } }
    result["occlusion"] = ["occludedPointCursorPixelsChanged": occDiff as Any, "visiblePointCursorPixelsChanged": visDiff as Any,
                           "occludedPointHitWindow": hit(Q), "personWindow": person]

    // 6) 다크·라이트 배경 위
    let dp = CGPoint(x: 1120 + 150, y: 120 + 120), lp = CGPoint(x: 1120 + 150, y: 440 + 120)
    cursor.show(at: A, above: CGWindowID(target)); await sleep(0.5)
    await go("move → dark backdrop", dp, above: dark.windowNumber, expectHit: dark.windowNumber)
    _ = await capture("09-dark", CGRect(x: 1120, y: 120, width: 420, height: 270))
    cursor.timeScale = 5
    let dr = Task { @MainActor in await self.cursor.pulse(.click) }
    await sleep(0.4)
    _ = await capture("10-dark-click", zoomRect(dp))
    await dr.value; await sleep(2.8); cursor.timeScale = 1
    await go("move → light backdrop", lp, above: light.windowNumber, expectHit: light.windowNumber)
    _ = await capture("11-light", CGRect(x: 1120, y: 440, width: 420, height: 270))
    cursor.timeScale = 5
    let lr = Task { @MainActor in await self.cursor.pulse(.click) }
    await sleep(0.4)
    _ = await capture("12-light-click", zoomRect(lp))
    await lr.value; await sleep(2.8); cursor.timeScale = 1

    // 7) 대기 CPU (링크 정지 확인)
    await sleep(0.6)
    let t0 = cpuSeconds(), k0 = cursor.tickCount, w0 = Date()
    await sleep(2.0)
    let t1 = cpuSeconds(), k1 = cursor.tickCount, w1 = Date()
    result["idle"] = ["wallSec": w1.timeIntervalSince(w0), "processCpuSec": t1 - t0, "cpuPercent": (t1 - t0) / w1.timeIntervalSince(w0) * 100, "displayLinkTicks": k1 - k0]

    // 8) hide
    cursor.hide(animated: true)
    let visibleRightAfterHide = cursor.isVisible
    await sleep(0.5)
    let panelGone = !cursor.panel.isVisible
    let pointerAfter = pointer()
    let frontAfter = frontPid()

    // 집계
    let sorted = intervals.sorted()
    func pct(_ q: Double) -> Double { sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * q))] }
    let mean = intervals.isEmpty ? 0 : intervals.reduce(0, +) / Double(intervals.count)
    let refresh = NSScreen.main?.maximumFramesPerSecond ?? 60
    result["frames"] = ["movingFrameIntervals": intervals.count, "meanIntervalMs": mean * 1000, "p50Ms": pct(0.5) * 1000, "p95Ms": pct(0.95) * 1000, "maxMs": (sorted.last ?? 0) * 1000,
                        "over25msCount": intervals.filter { $0 > 0.025 }.count, "approxFps": mean > 0 ? 1 / mean : 0, "screenMaxFps": refresh, "totalDisplayLinkTicks": frameCount]
    result["invariants"] = ["realPointerBefore": [pointerBefore.x, pointerBefore.y], "realPointerAfter": [pointerAfter.x, pointerAfter.y],
                            "realPointerSamplesDuringFrames": pointerSamples, "realPointerDistinctPositionsDuringFrames": pointerSet.count, "realPointerPositions": Array(pointerSet),
                            "frontmostPidBefore": frontBefore, "frontmostPidAfter": frontAfter, "frontmostPidsSeen": Array(frontPids), "frontmostWasPersonStandIn": personFront,
                            "helperIsActiveEver": helperActiveSeen, "helperIsActiveNow": NSRunningApplication.current.isActive,
                            "panel": ["level": cursor.panel.level.rawValue, "ignoresMouseEvents": cursor.panel.ignoresMouseEvents, "canBecomeKey": cursor.panel.canBecomeKey, "canBecomeMain": cursor.panel.canBecomeMain,
                                      "styleNonactivating": cursor.panel.styleMask.contains(.nonactivatingPanel), "canJoinAllSpaces": cursor.panel.collectionBehavior.contains(.canJoinAllSpaces),
                                      "collectionBehavior": cursor.panel.collectionBehavior.rawValue]]
    result["scenes"] = scenes
    result["moveDurations"] = scenes.compactMap { s -> [String: Any]? in
      guard let d = s["moveDistancePt"], let p = s["plannedMoveSec"] else { return nil }
      return ["scene": s["scene"] as Any, "distancePt": d, "plannedMs": (p as! Double) * 1000]
    }
    result["hide"] = ["isVisibleRightAfterHide": visibleRightAfterHide, "panelOrderedOut": panelGone]

    let allHitsOK = scenes.allSatisfy { ($0["hitNeverCursor"] as? Bool) ?? true }
    let expectedOK = scenes.allSatisfy { ($0["hitTipIsExpected"] as? Bool) ?? true }
    let maxErr = tipGeometryErrors.max() ?? 0
    checks["realPointerUnchangedInAllFrames"] = pointerSet.count == 1 && pointerSet.first == "\(pointerBefore.x),\(pointerBefore.y)" && pointerAfter == pointerBefore
    checks["frontmostAppUnchanged"] = frontPids == [frontBefore] && frontAfter == frontBefore && personFront
    checks["helperNeverActive"] = !helperActiveSeen && !NSRunningApplication.current.isActive
    checks["hitTestNeverCursorWindow"] = allHitsOK
    checks["hitTestPointsToUnderlyingWindow"] = expectedOK
    checks["tipExactWithinHalfPoint"] = maxErr < 0.5
    checks["cursorAboveTargetBelowPerson"] = (result["zOrderAtVisiblePoint"] as? [String: Any])?["cursorImmediatelyAboveTarget"] as? Bool == true && (result["zOrderAtOccludedPoint"] as? [String: Any])?["personAboveCursorAboveTarget"] as? Bool == true
    checks["occludedPointCursorHiddenByPerson"] = (occDiff ?? Int.max) <= 4 && (visDiff ?? 0) > 200
    checks["panelNormalLevelNoAllSpaces"] = cursor.panel.level == .normal && !cursor.panel.collectionBehavior.contains(.canJoinAllSpaces)
    checks["idleCpuNearZero"] = ((result["idle"] as? [String: Any])?["cpuPercent"] as? Double ?? 100) < 2 && ((result["idle"] as? [String: Any])?["displayLinkTicks"] as? Int ?? 99) <= 2
    checks["hideWorks"] = !visibleRightAfterHide && panelGone
    checks["frameIntervalNearRefresh"] = mean > 0 && mean < 1.0 / 50
    result["maxTipErrorPt"] = maxErr
    result["checks"] = checks
    result["allChecksPass"] = !checks.values.contains(false)
    result["screenshots"] = shots

    cleanup()
    // 정리 후 전면 앱 복귀 확인
    await sleep(0.5)
    result["afterCleanup"] = ["frontmostPid": frontPid(), "testAppsRunning": procs.contains { $0.isRunning }]

    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: URL(fileURLWithPath: o.outDir + "/cursor-demo.json"))
      FileHandle.standardOutput.write(data); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    return (result["allChecksPass"] as? Bool) == true ? 0 : 1
  }

  func cleanup() {
    cursor.hide(animated: false)
    for w in backdrops { w.orderOut(nil); w.close() }
    backdrops = []
    for p in procs where p.isRunning { p.terminate() }
  }

  func cpuSeconds() -> Double {
    var u = rusage(); getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6 + Double(u.ru_stime.tv_sec) + Double(u.ru_stime.tv_usec) / 1e6
  }
}
#endif
