import ExpoModulesCore
import WebKit
import Network

// FleetConsoleView.kt의 iOS 이식. 하드닝된 WKWebView가 로컬 게이트웨이 오리진만 로드하고,
// 네이티브가 핀 프리플라이트·페어링 조인·상태 확인 후 후보 게이트웨이를 띄운 다음, 스테이징
// WebView가 readiness 핸드셰이크에 성공해야 커밋한다. 상태기계·이벤트·에러코드는 Android와
// 정확히 같게 유지한다(JS 셸이 공유되므로).
//
// iOS 차이: readiness는 WebViewCompat 대신 WKScriptMessageHandler로 받되 수신 측에서
// frameInfo(메인프레임+로컬 오리진)와 논스를 검증한다. 로컬 인증서 핀은 onReceivedSslError
// 대신 WKNavigationDelegate의 ServerTrust 챌린지에서 LocalCertificatePolicy로 확인한다.
// 비로컬 서브리소스 차단은 shouldInterceptRequest가 없으므로 게이트웨이(로컬 오리진만 서빙)
// 와 재작성된 CSP(connect-src 로컬 한정)가 담당한다.
// Simulator와 물리 iPad에서 페어링부터 readiness 커밋까지 검증했다.

public final class FleetConsoleView: ExpoView, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  private static let readinessObject = "fleetReadiness"
  private static let userAgentProduct = "FleetMobile/0.1.0"

  private final class StagedLoad {
    let attemptId: Int64
    let target: PersistedTarget
    let gateway: LoopbackGateway
    let cookieSnapshot: FleetCookieSnapshot
    let view: WKWebView
    let readinessNonce: String
    var localCertificateObserved = false
    var readinessRequested = false
    init(attemptId: Int64, target: PersistedTarget, gateway: LoopbackGateway, cookieSnapshot: FleetCookieSnapshot, view: WKWebView, readinessNonce: String) {
      self.attemptId = attemptId; self.target = target; self.gateway = gateway
      self.cookieSnapshot = cookieSnapshot; self.view = view; self.readinessNonce = readinessNonce
    }
  }

  private let onFleetEvent = EventDispatcher()
  private let kv: KeyValueStore = UserDefaultsKeyValueStore()
  private let targetStore: TargetStore
  private let cookies: FleetCookieJar
  private let connection: RemoteConnection
  private let worker = DispatchQueue(label: "fleet-mobile-connection")
  private let attempt = AtomicCounter()
  private lazy var linkReceiver = FleetLinkReceiver { [weak self] link in self?.receiveLink(link) }

  private var activeTarget: PersistedTarget?
  private var activeView: WKWebView?
  private var activeGateway: LoopbackGateway?
  private var staging: StagedLoad?
  // 커밋된 로드도 붙들어 둔다. WKWebView의 델리게이트는 self 하나이므로, 커밋 이후에도
  // 어느 타깃/게이트웨이의 뷰인지 되찾을 수 있어야 한다 — Android는 WebViewClient가 staged를
  // 캡처해 그 역할을 하지만, 여기서는 뷰 identity로 찾으므로 활성 로드를 따로 들고 있어야 한다.
  private var activeLoad: StagedLoad?
  private let appearanceStore = AppearanceStore(store: UserDefaultsKeyValueStore(suiteName: "fleet-mobile-appearance"))
  private lazy var appearance: Appearance = appearanceStore.load()
  private var systemDark: Bool { traitCollection.userInterfaceStyle == .dark }
  private var lastSystemDark: Bool?
  // 시도가 시작되어 커밋/실패로 정착하기 전까지 참. resume()이 이 값을 보지 않으면 포그라운드
  // 복귀가 인플라이트 시도를 저장된 타깃으로 덮어쓴다 — 콜드 스타트 링크는 attempt 카운터를
  // 뺏기고 조용히 사라진다(실기기에서 재현). 메인 스레드에서만 읽고 쓴다.
  private var attemptInFlight = false
  // 잘못된 링크 오류는 사용자가 다음 행동을 고를 때까지 포그라운드 복귀로 덮지 않는다.
  private var invalidLinkPending = false
  private var detached = false
  // 모바일 심리스(브리지 v1.6). 다른 페어링 콘솔의 명부·도착 위치를 기억하고, 명부 조회는 동시 2개까지.
  // 메인 스레드에서만 읽고 쓴다.
  private let consoles = MobileConsolesHub()
  private let rosterQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "fleet-mobile-console-roster"
    queue.maxConcurrentOperationCount = 2
    queue.qualityOfService = .utility
    return queue
  }()
  /// 페이지의 switch로 시작한 시도. 이 시도의 실패는 오류 화면이 아니라 switch-failed다.
  private var seamlessAttemptId: Int64?

  public required init(appContext: AppContext? = nil) {
    let store = kv
    targetStore = TargetStore(store: store)
    cookies = FleetCookieJar(store: store)
    connection = RemoteConnection(cookies: cookies)
    super.init(appContext: appContext)

    activeTarget = targetStore.active()
    // 콜드 스타트 fleet:// 가 동기 전달되면 영속 activeTarget 재연결보다 앞선다.
    let deliveredPendingLink = FleetLinkInbox.attach(linkReceiver)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)

    if deliveredPendingLink {
      return
    }
    if let target = activeTarget {
      emit("connecting", label: target.label, origin: target.origin)
      beginAttempt(target, token: nil)
    } else {
      emit("waiting")
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Insets

  public override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    applyInsets()
  }

  private var lastChromeInsets: UIEdgeInsets = .zero
  private var keyboardInset: CGFloat = 0
  /// 커밋된 페이지가 opt-in한 뒤에만 참. 새 메인 프레임 문서가 커밋되면 끈다.
  private var edgeToEdge = false
  private var publishedInsets: AppearanceInsets?

  @objc private func keyboardChanged(_ note: Notification) {
    var inset: CGFloat = 0
    if note.name != UIResponder.keyboardWillHideNotification,
       let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
       let window = self.window {
      let overlap = self.convert(self.bounds, to: window).maxY - frame.minY
      inset = max(0, overlap)
    }
    keyboardInset = inset
    applyInsets()
  }

  private func applyInsets() {
    let chrome = safeAreaInsets
    let chromeChanged = chrome != lastChromeInsets
    lastChromeInsets = chrome
    // 키보드는 네이티브가 흡수(하단 패딩), 크롬 인셋만 JS로.
    layoutWebViews()
    if chromeChanged { emitInsets(chrome) }
    let next = advertisedInsets()
    if next != publishedInsets {
      publishedInsets = next
      republishAppearance()
    }
  }

  /// CSS px. 키보드가 떠 있는 동안 bottom은 0 — 키보드 높이 자체는 프레임이 계속 담당한다.
  /// 좌우는 항상 0이다. 컷아웃과 측면 바는 프레임 패딩이 맡으므로 웹이 다시 밀지 않는다.
  private func advertisedInsets() -> AppearanceInsets {
    AppearanceInsets(
      top: Double(lastChromeInsets.top),
      right: 0,
      bottom: keyboardInset > 0 ? 0 : Double(lastChromeInsets.bottom),
      left: 0)
  }

  private func enterEdgeToEdge() {
    guard !edgeToEdge else { return }
    edgeToEdge = true
    layoutWebViews()
    emitPayload(["type": "edge", "on": true])
  }

  /// 새 메인 프레임 문서(새로고침, 다른 Console, 오류 페이지)는 아직 opt-in하지 않았다.
  private func leaveEdgeToEdge() {
    guard edgeToEdge else { return }
    edgeToEdge = false
    layoutWebViews()
    emitPayload(["type": "edge", "on": false])
  }

  private func emitInsets(_ chrome: UIEdgeInsets) {
    main {
      self.onFleetEvent([
        "type": "insets",
        "insetTop": Double(chrome.top),
        "insetRight": Double(chrome.right),
        "insetBottom": Double(chrome.bottom),
        "insetLeft": Double(chrome.left),
      ])
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    layoutWebViews()
  }

  private func layoutWebViews() {
    let chrome = safeAreaInsets
    // opt-in 뒤에는 상단·하단 시스템 바 아래로 펼친다. 좌우 패딩과 키보드 하단은 항상 비워 둔다.
    let top: CGFloat = edgeToEdge ? 0 : chrome.top
    let left = chrome.left
    let right = chrome.right
    let bottom = edgeToEdge ? keyboardInset : max(chrome.bottom, keyboardInset)
    let frame = CGRect(
      x: left, y: top,
      width: max(0, bounds.width - left - right),
      height: max(0, bounds.height - top - bottom))
    for sub in subviews where sub is WKWebView {
      sub.frame = frame
      // opt-in 뒤에는 UIKit이 넣어 둔 인셋이 남아 페이지가 상태바 아래에서 시작하면 안 된다.
      if edgeToEdge, let web = sub as? WKWebView {
        web.scrollView.contentInset = .zero
        web.scrollView.scrollIndicatorInsets = .zero
      }
    }
  }

  // MARK: - JS-facing methods

  private func receiveLink(_ rawLink: String) {
    let parsed: AccessTarget
    do { parsed = try AccessLink.parse(rawLink) }
    catch { failInvalidLink(); return }
    let identity = targetStore.identityFor(parsed, live: activeTarget, hasLiveGateway: activeGateway != nil) { LoopbackIdentity.reserve() }
    beginAttempt(parsed.withoutCredential(identity), token: parsed.token)
  }

  public func retry() {
    dismissLinkError()
    guard let current = activeTarget else { emit("error", code: "pairing_target_invalid"); return }
    beginAttempt(current, token: nil)
  }

  public func resume() {
    // 포그라운드 복귀는 아무것도 붙어 있지 않을 때의 복구 수단이다. 시도가 진행 중이면
    // 그 시도가 결론을 내게 두어야 한다 — 여기서 재연결하면 저장된 타깃이 방금 들어온
    // 콜드 스타트 링크를 이긴다.
    if invalidLinkPending {
      // JS 마운트 전 init 이벤트를 놓쳤더라도 오류를 다시 받는다. 재연결은 하지 않는다.
      emit("error", code: "pairing_target_invalid")
      return
    }
    if attemptInFlight { return }
    if activeView == nil && activeTarget != nil { retry(); return }
    // 포그라운드 복귀(개정 r4): 보이는 콘솔이 있으면 다른 콘솔 명부를 스스로 한 번 새로 읽는다.
    main { if self.activeView != nil { self.refreshRosters() } }
  }

  public func dismissLinkError() {
    main { self.invalidLinkPending = false }
  }

  public func submitAccessLink(_ link: String) { receiveLink(link) }

  public func connectTo(_ origin: String) {
    main {
      self.invalidLinkPending = false
      guard let stored = self.targetStore.find(origin) else { self.emit("error", code: "target_missing"); return }
      self.connect(stored, seamless: false)
    }
  }

  /// RN의 connectTo와 페이지의 switch가 같은 단계 로드 경로를 쓴다.
  private func connect(_ stored: PersistedTarget, seamless: Bool) {
    let identity = targetStore.resumeIdentity(stored, live: activeTarget, hasLiveGateway: activeGateway != nil) { LoopbackIdentity.reserve() }
    let candidate = PersistedTarget(origin: stored.origin, hostname: stored.hostname, port: stored.port, label: stored.label, fingerprint: stored.fingerprint, loopback: identity)
    beginAttempt(candidate, token: nil, seamless: seamless)
  }

  public func removeTarget(_ origin: String) {
    main {
      self.invalidLinkPending = false
      guard let removed = self.targetStore.find(origin) else { return }
      if let id = self.targetStore.records().first(where: { $0.target.origin == origin })?.id { self.consoles.forget(id) }
      let wasActive = self.activeTarget?.origin == origin
      let wasStaging = self.staging?.target.origin == origin
      self.targetStore.remove(origin)
      if wasActive || wasStaging {
        self.attempt.increment()
        // 이 제거가 진행 중이던 시도를 끝낸다. 표시해 두지 않으면 resume()이 영원히 막힌다.
        self.attemptInFlight = false
        self.destroyStaging()
        if wasActive {
          if let view = self.activeView { view.removeFromSuperview(); view.destroySafely() }
          self.activeView = nil
          self.activeLoad = nil
          self.activeGateway?.close(); self.activeGateway = nil
          self.activeTarget = nil
        }
        if let active = self.activeTarget { self.emit("connected", label: active.label, origin: active.origin) }
        else { self.emit("waiting") }
      }
      self.cookies.clear(removed.origin)
      _ = removed
      self.republishConsoles()
    }
  }

  public func listTargets() -> [[String: Any]] {
    let activeOrigin = activeTarget?.origin
    return targetStore.list().map { target in
      [
        "origin": target.origin,
        "label": target.label,
        "host": target.hostname,
        "port": target.port,
        "fingerprint": String(target.fingerprint.prefix(8)),
        "active": target.origin == activeOrigin,
      ]
    }
  }

  /// true면 WKWebView가 back을 소비, false면 JS가 landing으로 나가야 한다.
  public func navigateBack() -> Bool {
    // WKWebView(url/canGoBack/goBack)는 메인 스레드 전용이고 이 함수는 JS에서 임의의 큐로
    // 불린다. Android가 latch로 하는 것과 같이 메인으로 넘기고 기다리되, 2초를 넘기면
    // JS를 붙잡아 두지 않고 false(= landing으로 나가기)로 답한다.
    if Thread.isMainThread { return navigateBackOnMain() }
    var consumed = false
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      consumed = self.navigateBackOnMain()
      done.signal()
    }
    if done.wait(timeout: .now() + .seconds(2)) == .timedOut { return false }
    return consumed
  }

  private func navigateBackOnMain() -> Bool {
    guard let view = activeView else { return false }
    // 목표이 열려 있을 때만 콘솔 내부 히스토리가 back을 답한다. 그 규칙이 없으면 콘솔의
    // 페이지 히스토리가 먼저 답해서, 여기로 돌아오는 대신 콘솔 화면들 사이를 걸어다닌다.
    guard isObjectiveOpen(view), view.canGoBack else { return false }
    view.goBack()
    return true
  }

  private func isObjectiveOpen(_ view: WKWebView) -> Bool {
    guard let url = view.url, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    return comps.queryItems?.contains { $0.name == "op" && !($0.value ?? "").isEmpty } ?? false
  }

  // MARK: - Lifecycle

  public override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { teardown() }
  }

  private func teardown() {
    guard !detached else { return }
    detached = true
    FleetLinkInbox.detach(linkReceiver)
    attempt.increment()
    rosterQueue.cancelAllOperations()
    destroyStaging()
    activeView?.destroySafely(); activeView = nil
    activeLoad = nil
    activeGateway?.close(); activeGateway = nil
  }

  // MARK: - Attempt pipeline

  private func beginAttempt(_ candidate: PersistedTarget, token: String?, seamless: Bool = false) {
    let id = attempt.increment()
    main {
      guard self.isCurrent(id) else { return }
      self.attemptInFlight = true
      self.invalidLinkPending = false
      // 페이지의 switch가 아닌 시도는 남은 도착 위치를 가져가지 않는다.
      self.seamlessAttemptId = seamless ? id : nil
      if !seamless { self.consoles.clearArrival() }
      let launch = {
        guard self.isCurrent(id) else { return }
        self.emit("connecting", label: candidate.label, origin: candidate.origin, seamless: seamless)
        self.worker.async { self.runCandidate(id, candidate, token) }
      }
      if self.staging == nil { launch() } else { self.destroyStaging(launch) }
    }
  }

  private func runCandidate(_ id: Int64, _ candidate: PersistedTarget, _ token: String?) {
    var gateway: LoopbackGateway?
    var cookieSnapshot: FleetCookieSnapshot?
    var candidateTouchedCookies = false
    func restore() {
      if candidateTouchedCookies, let snap = cookieSnapshot {
        try? cookies.restore(candidate.origin, candidate.port, snap)
      }
    }
    do {
      guard isCurrent(id) else { return }
      FleetLog.stage("preflight")
      try connection.preflight(candidate)
      guard isCurrent(id) else { return }
      FleetLog.stage("cookie-snapshot")
      cookieSnapshot = try cookies.snapshot(candidate.origin, candidate.port)
      candidateTouchedCookies = true
      FleetLog.stage("join")
      try connection.join(candidate, token: token, deviceName: deviceName())
      guard isCurrent(id) else { restore(); return }
      FleetLog.stage("verify-reachable")
      try connection.verifyReachable(candidate)
      guard isCurrent(id) else { restore(); return }
      FleetLog.stage("gateway-identity")
      let started = try LoopbackGateway(target: candidate, remote: connection, cookies: cookies)
      FleetLog.stage("gateway-listen")
      try started.start()
      gateway = started
      FleetLog.stage("gateway-ready")
      guard isCurrent(id) else { started.close(); restore(); return }
      guard let snap = cookieSnapshot else { throw ConnectionFailure("cookie_snapshot_missing") }
      main {
        if self.isCurrent(id) { self.stageWebView(id, candidate, started, snap) }
        else { started.close(); self.worker.async { try? self.cookies.restore(candidate.origin, candidate.port, snap) } }
      }
    } catch let failure as ConnectionFailure {
      FleetLog.failed("pipeline", failure.code)
      gateway?.close(); restore()
      failIfCurrent(id, failure.code, candidate.label, candidate.origin, failure.retryAfterSeconds)
    } catch {
      // 여기로 오는 것은 ConnectionFailure가 아닌 모든 오류다(게이트웨이 기동, 키체인 identity,
      // 쿠키 저장 등). 사용자에게는 Android와 같은 코드를 주되, 실제 원인은 로그에 남긴다.
      FleetLog.failed("pipeline", String(describing: error))
      gateway?.close(); restore()
      failIfCurrent(id, "remote_link_unreachable", candidate.label, candidate.origin, nil)
    }
  }

  private func stageWebView(_ id: Int64, _ candidate: PersistedTarget, _ gateway: LoopbackGateway, _ cookieSnapshot: FleetCookieSnapshot) {
    guard isCurrent(id) else { gateway.close(); return }
    let nonce = UUID().uuidString
    let config = WKWebViewConfiguration()
    config.userContentController.add(self, name: Self.readinessObject)
    config.userContentController.add(self, name: AppearanceBridge.messageObject)
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    // 의도적으로 Android와 다르다. Android는 기본(영속) WebView 프로필에 DOM storage를 켜므로
    // 콘솔의 localStorage가 재시작을 넘어 살아남는다. iOS는 시도마다 새 스토어를 쓴다 —
    // 게이트웨이 시크릿 쿠키와 콘솔 세션 쿠키가 프로세스 밖으로 새어 나가지 않고, 커밋되지
    // 못한 스테이징 WebView가 남긴 상태도 함께 사라진다. 대가는 콘솔의 UI 기호가 매번
    // 초기화된다는 것이고, 그건 크리덴셜 격리와 바꿀 만하다.
    config.websiteDataStore = .nonPersistent()
    config.suppressesIncrementalRendering = false
    let prefs = WKWebpagePreferences()
    prefs.allowsContentJavaScript = true
    config.defaultWebpagePreferences = prefs

    FleetLog.stage("stage-webview")
    let webView = WKWebView(frame: bounds, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.isOpaque = true
    webView.scrollView.bounces = false
    // 프레임을 시스템 바 아래로 늘려도 스크롤 뷰가 안전 영역만큼 내용을 밀면 그 자리는 빈 띠가 된다.
    webView.insetsLayoutMarginsFromSafeArea = false
    webView.scrollView.insetsLayoutMarginsFromSafeArea = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.pinchGestureRecognizer?.isEnabled = false // 터미널은 핀치를 리사이즈로 읽는다
    webView.allowsBackForwardNavigationGestures = false
    webView.customUserAgent = (webView.value(forKey: "userAgent") as? String).map { "\($0) \(Self.userAgentProduct)" } ?? Self.userAgentProduct
    // 게이트웨이 시크릿 쿠키를 로컬 오리진에 심는다(로드 전에 완료 대기).
    let staged = StagedLoad(attemptId: id, target: candidate, gateway: gateway, cookieSnapshot: cookieSnapshot, view: webView, readinessNonce: nonce)
    staging = staged
    // 문서 시작 스크립트: 겉모습 + 콘솔 명부 상태(이 전환의 도착 위치 포함, 개정 r1).
    installUserScripts(staged)
    webView.isHidden = true
    addSubview(webView)
    layoutWebViews()
    installLocalCookie(staged) {
      guard self.staging === staged, self.isCurrent(id) else { return }
      guard let url = URL(string: gateway.consoleUrl) else { self.failStaged(staged, "navigation_denied"); return }
      webView.load(URLRequest(url: url))
    }
  }

  private func installLocalCookie(_ staged: StagedLoad, then: @escaping () -> Void) {
    // Android(LoopbackGateway.installLocalCookie)가 CookieManager에 넘기는 것과 **같은**
    // Set-Cookie 문자열을 파싱해 쓴다. 속성을 여기서 다시 손으로 나열하면 HttpOnly와
    // SameSite가 빠지고(실제로 빠져 있었다) 콘솔 JS가 document.cookie로 게이트웨이 시크릿을
    // 읽을 수 있게 된다 — Android에는 없는 구멍이다. 헤더 하나를 원천으로 두면 다시 갈라지지 않는다.
    let secretCookie = URL(string: staged.gateway.origin).flatMap { origin in
      HTTPCookie.cookies(
        withResponseHeaderFields: ["Set-Cookie": staged.gateway.localCookieHeader],
        for: origin
      ).first
    }
    let store = staged.view.configuration.websiteDataStore.httpCookieStore
    if let cookie = secretCookie {
      store.setCookie(cookie) { self.main { then() } }
    } else {
      failStaged(staged, "navigation_denied")
    }
  }

  // MARK: - WKScriptMessageHandler (readiness)

  public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    if message.name == AppearanceBridge.messageObject {
      // 스테이징 중인 뷰는 아직 커밋되지 않았으므로 셸을 대신해 말할 수 없다.
      let origin = message.frameInfo.securityOrigin
      let gatewayOrigin = activeGateway?.origin
      let accepted = AppearanceBridge.accept(
        fromCommittedView: activeView != nil && message.webView === activeView,
        isMainFrame: message.frameInfo.isMainFrame,
        fromGatewayOrigin: gatewayOrigin != nil && "\(origin.protocol)://\(origin.host):\(origin.port)" == gatewayOrigin,
        body: message.body)
      if let accepted { onAppearanceMessage(accepted) }
      return
    }
    guard let staged = staging, message.name == Self.readinessObject, isCurrent(staged.attemptId) else { return }
    let frame = message.frameInfo
    let origin = frame.securityOrigin
    let localOrigin = "\(origin.protocol)://\(origin.host):\(origin.port)"
    let matches = frame.isMainFrame
      && localOrigin == staged.gateway.origin
      && (message.body as? String) == staged.readinessNonce
    if matches { commitStaged(staged) } else { failStaged(staged, "remote_host_unavailable") }
  }

  // MARK: - WKNavigationDelegate

  public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let staged = contextFor(webView), let url = navigationAction.request.url else {
      decisionHandler(.cancel); return
    }
    if navigationAction.targetFrame == nil {
      // 새 창(target=_blank) 요청. 콘솔은 외부 링크를 모두 새 창으로 그리므로, 사용자가 누른
      // 다른 오리진 http(s)만 OS 브라우저로 넘긴다. 새 WKWebView는 만들지 않는다.
      decisionHandler(.cancel)
      if navigationAction.navigationType == .linkActivated, isForeignWeb(url, staged) { delegateExternally(url) }
      return
    }
    let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
    if !isMainFrame {
      // 서브리소스: 로컬 오리진만 허용(그 외는 CSP/게이트웨이가 이미 막지만 방어적으로 취소).
      decisionHandler(isLocalOrigin(url, staged.gateway) ? .allow : .cancel); return
    }
    if isAllowedLocalMainFrame(url, staged.gateway) { decisionHandler(.allow); return }
    if sameRemoteOrigin(url, staged.target) {
      decisionHandler(.cancel)
      webView.load(URLRequest(url: URL(string: toLocalUrl(url, staged.gateway)) ?? url))
      return
    }
    if navigationAction.navigationType == .linkActivated, isForeignWeb(url, staged) {
      decisionHandler(.cancel)
      delegateExternally(url)
      return
    }
    decisionHandler(.cancel)
  }

  public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    guard let load = contextFor(webView) else { decisionHandler(.cancel); return }
    // 커밋 전 메인프레임 오류만 시도를 실패시킨다. 커밋 뒤에는 콘솔이 스스로 오류를 그리게 두고
    // 셸이 세션을 무너뜨리지 않는다(Android의 onReceivedHttpError가 no-op이 되는 것과 같다).
    if isStaging(load), let http = navigationResponse.response as? HTTPURLResponse, navigationResponse.isForMainFrame {
      if http.statusCode == 401 { decisionHandler(.cancel); failStaged(load, "remote_host_session_expired"); return }
      if http.statusCode >= 400 { decisionHandler(.cancel); failStaged(load, "remote_host_unavailable"); return }
    }
    decisionHandler(.allow)
  }

  public func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard let staged = contextFor(webView), challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else {
      completionHandler(.cancelAuthenticationChallenge, nil); return
    }
    let host = challenge.protectionSpace.host
    let leaf: SecCertificate? = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
    if host == staged.gateway.host, let leaf,
       LocalCertificatePolicy.matches(leaf, staged.gateway.localCertificate, staged.gateway.host) {
      staged.localCertificateObserved = true
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      failStaged(staged, "remote_link_unverified")
    }
  }

  public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // 스테이징 중인 첫 문서는 아직 커밋된 뷰가 아니다. 화면에 올라온 뒤의 새 문서만 패딩으로 되돌린다.
    guard navigation != nil, webView === activeView else { return }
    leaveEdgeToEdge()
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let staged = contextFor(webView), let url = webView.url, isAllowedLocalMainFrame(url, staged.gateway) else {
      if let staged = contextFor(webView) { failStaged(staged, "navigation_denied") }
      return
    }
    // 문서가 자리에 앉은 뒤 다시 알려, didCommit에서 패딩으로 돌아간 페이지가 opt-in할 수 있게 한다.
    if webView === activeView { republishAppearance() }
    if !staged.localCertificateObserved { failStaged(staged, "remote_link_pin_not_observed"); return }
    if staged.readinessRequested { return }
    staged.readinessRequested = true
    webView.evaluateJavaScript(readinessScript(staged), completionHandler: nil)
  }

  public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if let staged = contextFor(webView) { failStaged(staged, "remote_host_unavailable") }
  }

  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if let staged = contextFor(webView) { failStaged(staged, "remote_host_unavailable") }
  }

  // 커밋된 활성 WKWebView의 콘텐츠 프로세스가 죽으면 검은 연결 화면을 남기지 않는다.
  // 죽은 스테이징 자원을 닫고 현재 활성 타깃으로 새 시도를 연다. 스테이징/비활성 뷰는 무시한다.
  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard let activeLoad, activeLoad.view === webView else { return }
    recoverTerminatedActiveLoad(activeLoad, target: activeTarget)
  }

  private func recoverTerminatedActiveLoad(_ doomed: StagedLoad, target: PersistedTarget?) {
    destroyStaging()
    if let view = activeView {
      view.removeFromSuperview()
      view.destroySafely()
    }
    activeView = nil
    activeLoad = nil
    activeGateway?.close()
    activeGateway = nil
    guard let target else {
      emit("error", code: "remote_host_unavailable")
      return
    }
    beginAttempt(target, token: nil)
  }

  // MARK: - WKUIDelegate (deny windows/media/file)

  public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    // 앵커의 새 창 요청은 decidePolicyFor에서 이미 취소되므로, 여기 닿는 것은 window.open이다.
    // javaScriptCanOpenWindowsAutomatically가 꺼져 있어 사용자 제스처 없는 팝업은 오지 못한다.
    // 다른 오리진 http(s)만 OS 브라우저로 넘기고, 새 WKWebView는 만들지 않는다.
    if let staged = contextFor(webView), let url = navigationAction.request.url, isForeignWeb(url, staged) {
      delegateExternally(url)
    }
    return nil
  }

  // MARK: - Appearance bridge

  public func getAppearance() -> [String: Any] {
    ["colorMode": appearance.colorMode.rawValue, "fontScale": appearance.fontScale.rawValue]
  }

  /// Android 내비게이션 바 아이콘 대비용. iOS 홈 인디케이터는 스스로 대비를 맞춘다.
  public func setNavigationBarStyle(_ dark: Bool) {}

  public override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    let dark = systemDark
    if lastSystemDark == dark { return }
    let first = lastSystemDark == nil
    lastSystemDark = dark
    if !first { refreshAppearance() }
  }

  private func appearanceScript(for target: PersistedTarget) -> String {
    AppearanceBridge.script(appearance, systemDark: systemDark, console: ConsolePresentation.of(label: target.label, origin: target.origin, hostname: target.hostname, port: target.port), appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, insets: advertisedInsets())
  }

  private func appearanceUserScript(for target: PersistedTarget) -> WKUserScript {
    WKUserScript(source: appearanceScript(for: target), injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  /// 살아 있는 페이지마다 다시 알린다: 다음 로드는 문서 시작 스크립트로, 열린 페이지는 지금 바로.
  private func republishAppearance() {
    if let staged = staging { installUserScripts(staged) }
    if let view = activeView, let load = activeLoad, load.view === view {
      installUserScripts(load)
      view.evaluateJavaScript(appearanceScript(for: load.target), completionHandler: nil)
    }
  }

  /// 한 뷰의 문서 시작 스크립트 전부. 겉모습과 콘솔 명부는 함께 다시 심어야 한쪽이 지워지지 않는다.
  private func installUserScripts(_ load: StagedLoad) {
    let content = load.view.configuration.userContentController
    content.removeAllUserScripts()
    content.addUserScript(appearanceUserScript(for: load.target))
    content.addUserScript(WKUserScript(source: consolesScript(for: load), injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  // MARK: - Seamless consoles (브리지 v1.6)

  /// 이 뷰의 문서가 받을 상태. 그 문서의 콘솔이 활성 항목이고, 도착 위치는 그 콘솔이 switch의 대상일 때만 실린다.
  private func consolesScript(for load: StagedLoad, failed: String? = nil) -> String {
    let records = targetStore.records()
    let documentId = records.first { $0.target.origin == load.target.origin }?.id
    let state = consoles.state(records: records, activeOrigin: load.target.origin, arrivalFor: documentId, now: Date())
    return MobileConsolesBridge.script(state, gatewayOrigin: load.gateway.origin, failed: failed)
  }

  /// 명부·목록·도착 위치가 바뀌면: 단계 로드 중인 뷰는 문서 시작 스크립트만, 보이는 문서는 지금 바로.
  /// `failed`(개정 r6)는 이번에 보내는 이벤트 detail에만 실린다 — 문서 시작 전역과 다음 문서에는 가지 않는다.
  private func republishConsoles(failed: String? = nil) {
    if let staged = staging { installUserScripts(staged) }
    if let view = activeView, let load = activeLoad, load.view === view {
      installUserScripts(load)
      view.evaluateJavaScript(consolesScript(for: load, failed: failed), completionHandler: nil)
    }
  }

  /// 페이지의 roster 요청. 대상별 최소 간격·동시 2개는 허브와 큐가 지킨다. 바뀐 결과만 다시 알린다.
  private func refreshRosters() {
    let due = consoles.claimDue(records: targetStore.records(), activeOrigin: activeTarget?.origin, now: Date())
    for record in due {
      rosterQueue.addOperation { [weak self] in
        guard let self else { return }
        let outcome = self.connection.readRoster(record.target)
        self.main {
          guard !self.detached else { return }
          guard self.targetStore.find(id: record.id) != nil else { self.consoles.forget(record.id); return }
          if self.consoles.record(record.id, outcome, now: Date()) { self.republishConsoles() }
        }
      }
    }
  }

  private func receiveSwitch(console: String, commodore: String, commander: String?, scrollTop: Double?) {
    switch consoles.decide(consoleId: console, records: targetStore.records(), activeOrigin: activeTarget?.origin) {
    case .ignore:
      return
    case .openSheet(let record):
      // 페어링이 끊긴 콘솔로는 넘어가지 않는다. RN 콘솔 시트가 재페어링 경로를 보인다.
      emitPayload(["type": "consoles", "origin": record.target.origin, "code": "remote_host_not_paired"])
    case .connect(let record):
      consoles.setArrival(targetId: record.id, MobileConsoleArrival(commodore: commodore, commander: commander, scrollTop: scrollTop), now: Date())
      // TTL은 단계 로드가 끝나지 않을 때의 안전장치다.
      DispatchQueue.main.asyncAfter(deadline: .now() + MobileConsolesHub.arrivalTtl + 0.5) { [weak self] in
        guard let self, !self.detached else { return }
        if self.consoles.expireArrival(now: Date()) { self.republishConsoles() }
      }
      invalidLinkPending = false
      connect(record.target, seamless: true)
    }
  }

  /// 시도 실패를 알린다. 페이지가 시작한 전환이 보이는 콘솔 위에서 실패하면 오류 화면 대신 switch-failed —
  /// 활성 콘솔·게이트웨이·뷰는 그대로다. 실패한 대상의 상태는 네이티브 캐시에 남긴다(개정 r2).
  private func reportAttemptFailure(_ id: Int64, code: String, candidateLabel: String?, origin: String?, retryAfter: Int?) {
    let targetId = origin.flatMap { origin in
      origin == activeTarget?.origin ? nil : targetStore.records().first { $0.target.origin == origin }?.id
    }
    let seamless = seamlessAttemptId == id
    if seamless { seamlessAttemptId = nil }
    let (report, changed) = consoles.attemptFailed(targetId: targetId, code: code, seamless: seamless, activeVisible: activeView != nil)
    if report == .switchFailed {
      var payload: [String: Any] = ["type": "switch-failed", "code": code, "active": true]
      if let candidateLabel { payload["label"] = candidateLabel }
      if let origin { payload["origin"] = origin }
      emitPayload(payload)
      // 상태가 바뀌지 않았어도 반드시 한 번 다시 알린다(개정 r6). 페이지는 이 id의 "여는 중"을 바로 푼다.
      republishConsoles(failed: targetId)
      return
    }
    if changed { republishConsoles() }
    emit("error", code: code, label: activeTarget?.label ?? candidateLabel, origin: origin, retryAfterSeconds: retryAfter)
  }

  private func refreshAppearance() {
    republishAppearance()
    emitPayload(["type": "appearance", "colorMode": appearance.colorMode.rawValue, "fontScale": appearance.fontScale.rawValue])
  }

  private func onAppearanceMessage(_ message: AppearanceMessage) {
    switch message {
    case .set(let next):
      if next != appearance {
        appearance = next
        appearanceStore.save(next)
      }
      // 값이 같아도 확정을 보낸다 — 페이지는 낙관적으로 먼저 칠하고 이 응답을 기다린다.
      refreshAppearance()
    case .chrome(let top, let bottom):
      emitPayload(["type": "chrome", "top": top, "bottom": bottom])
    case .edge:
      enterEdgeToEdge()
    case .consoles:
      emitPayload(["type": "consoles"])
    case .roster:
      refreshRosters()
    case .arrived:
      if consoles.clearArrival() { republishConsoles() }
    case .switchConsole(let console, let commodore, let commander, let scrollTop):
      receiveSwitch(console: console, commodore: commodore, commander: commander, scrollTop: scrollTop)
    }
  }

  private func emitPayload(_ payload: [String: Any]) {
    main { self.onFleetEvent(payload) }
  }

  // MARK: - readiness JS

  private func readinessScript(_ staged: StagedLoad) -> String {
    ReadinessScript.source(nonce: staged.readinessNonce, handler: Self.readinessObject)
  }

  // MARK: - commit / fail

  private func commitStaged(_ staged: StagedLoad) {
    guard staging === staged, isCurrent(staged.attemptId) else { return }
    attemptInFlight = false
    FleetLog.stage("commit")
    guard targetStore.upsert(staged.target) else { failStaged(staged, "remote_target_persist_failed"); return }
    let previousView = activeView
    let previousGateway = activeGateway
    activeTarget = staged.target
    activeGateway = staged.gateway
    activeView = staged.view
    activeLoad = staged
    staging = nil
    // 도착 위치는 이 단계 로드 문서에서 한 번만 쓰인다(개정 r1): 문서 시작 스크립트를 arrival=null로 바꾸고
    // 최신 상태를 한 번 더 보낸다. 이후 같은 뷰의 다른 문서·재적재에는 도착 위치가 가지 않는다.
    seamlessAttemptId = nil
    consoles.clearArrival()
    if let record = targetStore.records().first(where: { $0.target.origin == staged.target.origin }) { consoles.recordConnected(record.id) }
    // 새 문서는 아직 opt-in하지 않았다. 보이기 전에 패딩으로 되돌리고 능력을 다시 알린다.
    leaveEdgeToEdge()
    republishAppearance()
    republishConsoles()
    // 단계 로드 문서의 첫 roster 요청은 readiness 전이라 게이트에 버려질 수 있다(개정 r4) — 셸이 먼저 읽는다.
    refreshRosters()
    staged.view.isHidden = false
    layoutWebViews()
    if let previousView, previousView !== staged.view { previousView.removeFromSuperview(); previousView.destroySafely() }
    if previousGateway !== staged.gateway { previousGateway?.close() }
    emit("connected", label: staged.target.label, origin: staged.target.origin)
  }

  private func failStaged(_ staged: StagedLoad, _ code: String) {
    guard staging === staged, isCurrent(staged.attemptId) else { return }
    attemptInFlight = false
    FleetLog.failed("staged-webview", code)
    staging = nil
    staged.view.removeFromSuperview()
    staged.view.destroySafely()
    staged.gateway.close()
    worker.async { try? self.cookies.restore(staged.target.origin, staged.target.port, staged.cookieSnapshot) }
    reportAttemptFailure(staged.attemptId, code: code, candidateLabel: staged.target.label, origin: staged.target.origin, retryAfter: nil)
  }

  private func failIfCurrent(_ id: Int64, _ code: String, _ candidateLabel: String?, _ candidateOrigin: String?, _ retryAfter: Int?) {
    guard isCurrent(id) else { return }
    main {
      guard self.isCurrent(id) else { return }
      self.attemptInFlight = false
      self.destroyStaging {
        if self.isCurrent(id) {
          self.reportAttemptFailure(id, code: code, candidateLabel: candidateLabel, origin: candidateOrigin, retryAfter: retryAfter)
        }
      }
    }
  }

  private func failInvalidLink() {
    let id = attempt.increment()
    main {
      guard self.isCurrent(id) else { return }
      self.invalidLinkPending = true
      self.attemptInFlight = false
      self.destroyStaging {
        if self.isCurrent(id) { self.emit("error", code: "pairing_target_invalid") }
      }
    }
  }

  private func destroyStaging(_ afterRestore: @escaping () -> Void = {}) {
    guard let doomed = staging else { afterRestore(); return }
    staging = nil
    doomed.view.removeFromSuperview()
    doomed.view.destroySafely()
    doomed.gateway.close()
    worker.async {
      try? self.cookies.restore(doomed.target.origin, doomed.target.port, doomed.cookieSnapshot)
      self.main { afterRestore() }
    }
  }

  // MARK: - helpers

  private func isCurrent(_ id: Int64) -> Bool { !detached && attempt.get() == id }

  /// 이 WebView가 속한 로드 — 스테이징 중이든 이미 커밋됐든. 커밋 이후를 못 찾으면 살아 있는
  /// 콘솔의 내비게이션과 TLS 챌린지가 전부 거부된다.
  private func contextFor(_ webView: WKWebView) -> StagedLoad? {
    if let staging, staging.view === webView { return staging }
    if let activeLoad, activeLoad.view === webView { return activeLoad }
    return nil
  }

  /// 아직 커밋 전인가. 실패 처리(failStaged)는 스테이징에만 의미가 있고, 커밋 뒤에는 무시된다
  /// — Android에서 staging이 null이 되어 failStaged가 no-op이 되는 것과 같은 동작이다.
  private func isStaging(_ load: StagedLoad) -> Bool { staging === load }

  private func isAllowedLocalMainFrame(_ url: URL, _ gateway: LoopbackGateway) -> Bool {
    guard isLocalOrigin(url, gateway), url.user == nil, url.fragment == nil else { return false }
    let path = url.path
    return path == "/console" || path == "/console/"
  }

  private func isLocalOrigin(_ url: URL, _ gateway: LoopbackGateway) -> Bool {
    url.scheme == "https" && url.host == gateway.host && (url.port ?? 443) == gateway.port && url.user == nil
  }

  private func sameRemoteOrigin(_ url: URL, _ target: PersistedTarget) -> Bool {
    guard url.scheme == "https", let host = url.host, host.caseInsensitiveCompare(target.hostname) == .orderedSame else { return false }
    return (url.port ?? 443) == target.port && url.user == nil
  }

  /// OS 브라우저로 넘길 수 있는 주소: 원격 콘솔과 로컬 게이트웨이 오리진이 아닌 http(s).
  private func isForeignWeb(_ url: URL, _ staged: StagedLoad) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host?.isEmpty == false else { return false }
    return url.user == nil && !sameRemoteOrigin(url, staged.target) && !isLocalOrigin(url, staged.gateway)
  }

  private func toLocalUrl(_ url: URL, _ gateway: LoopbackGateway) -> String {
    var result = gateway.origin
    let path = url.path.isEmpty ? "/" : url.path
    result += path
    if let query = url.query { result += "?" + query }
    if let fragment = url.fragment { result += "#" + fragment }
    return result
  }

  private func delegateExternally(_ url: URL) {
    DispatchQueue.main.async { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
  }

  private func deviceName() -> String {
    let name = UIDevice.current.name
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    let capped = String(trimmed.prefix(80))
    return capped.isEmpty ? "iOS device" : capped
  }

  private func emit(_ type: String, code: String? = nil, label: String? = nil, origin: String? = nil, retryAfterSeconds: Int? = nil, seamless: Bool = false) {
    main {
      var payload: [String: Any] = ["type": type, "active": self.activeView != nil]
      if seamless { payload["seamless"] = true }
      if let code { payload["code"] = code }
      if let label { payload["label"] = label }
      if let origin { payload["origin"] = origin }
      if let retryAfterSeconds { payload["retryAfterSeconds"] = retryAfterSeconds }
      self.onFleetEvent(payload)
    }
  }

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }
}

private extension WKWebView {
  func destroySafely() {
    stopLoading()
    navigationDelegate = nil
    uiDelegate = nil
    configuration.userContentController.removeAllScriptMessageHandlers()
    removeFromSuperview()
  }
}

// FleetConsoleView.kt AtomicLong 대응.
final class AtomicCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64 = 0
  @discardableResult func increment() -> Int64 { lock.lock(); defer { lock.unlock() }; value += 1; return value }
  func get() -> Int64 { lock.lock(); defer { lock.unlock() }; return value }
}
