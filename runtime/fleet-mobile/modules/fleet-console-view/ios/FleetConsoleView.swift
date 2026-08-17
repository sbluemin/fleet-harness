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
  private var detached = false

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
    let bottom = max(chrome.bottom, keyboardInset)
    let frame = CGRect(
      x: chrome.left, y: chrome.top,
      width: max(0, bounds.width - chrome.left - chrome.right),
      height: max(0, bounds.height - chrome.top - bottom))
    for sub in subviews where sub is WKWebView { sub.frame = frame }
  }

  // MARK: - JS-facing methods

  private func receiveLink(_ rawLink: String) {
    let parsed: AccessTarget
    do { parsed = try AccessLink.parse(rawLink) }
    catch { failCurrent("pairing_target_invalid", nil); return }
    let identity = targetStore.identityFor(parsed, live: activeTarget, hasLiveGateway: activeGateway != nil) { LoopbackIdentity.reserve() }
    beginAttempt(parsed.withoutCredential(identity), token: parsed.token)
  }

  public func retry() {
    guard let current = activeTarget else { emit("error", code: "pairing_target_invalid"); return }
    beginAttempt(current, token: nil)
  }

  public func resume() {
    if activeView == nil && activeTarget != nil { retry() }
  }

  public func submitAccessLink(_ link: String) { receiveLink(link) }

  public func connectTo(_ origin: String) {
    main {
      guard let stored = self.targetStore.find(origin) else { self.emit("error", code: "target_missing"); return }
      let identity = self.targetStore.resumeIdentity(stored, live: self.activeTarget, hasLiveGateway: self.activeGateway != nil) { LoopbackIdentity.reserve() }
      let candidate = PersistedTarget(origin: stored.origin, hostname: stored.hostname, port: stored.port, label: stored.label, fingerprint: stored.fingerprint, loopback: identity)
      self.beginAttempt(candidate, token: nil)
    }
  }

  public func removeTarget(_ origin: String) {
    main {
      guard let removed = self.targetStore.find(origin) else { return }
      let wasActive = self.activeTarget?.origin == origin
      let wasStaging = self.staging?.target.origin == origin
      self.targetStore.remove(origin)
      if wasActive || wasStaging {
        self.attempt.increment()
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
    // 오퍼레이션이 열려 있을 때만 콘솔 내부 히스토리가 back을 답한다. 그 규칙이 없으면 콘솔의
    // 페이지 히스토리가 먼저 답해서, 여기로 돌아오는 대신 콘솔 화면들 사이를 걸어다닌다.
    guard isOperationOpen(view), view.canGoBack else { return false }
    view.goBack()
    return true
  }

  private func isOperationOpen(_ view: WKWebView) -> Bool {
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
    destroyStaging()
    activeView?.destroySafely(); activeView = nil
    activeLoad = nil
    activeGateway?.close(); activeGateway = nil
  }

  // MARK: - Attempt pipeline

  private func beginAttempt(_ candidate: PersistedTarget, token: String?) {
    let id = attempt.increment()
    main {
      guard self.isCurrent(id) else { return }
      let launch = {
        self.emit("connecting", label: candidate.label, origin: candidate.origin)
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
    webView.scrollView.pinchGestureRecognizer?.isEnabled = false // 터미널은 핀치를 리사이즈로 읽는다
    webView.allowsBackForwardNavigationGestures = false
    webView.customUserAgent = (webView.value(forKey: "userAgent") as? String).map { "\($0) \(Self.userAgentProduct)" } ?? Self.userAgentProduct
    // 게이트웨이 시크릿 쿠키를 로컬 오리진에 심는다(로드 전에 완료 대기).
    let staged = StagedLoad(attemptId: id, target: candidate, gateway: gateway, cookieSnapshot: cookieSnapshot, view: webView, readinessNonce: nonce)
    staging = staged
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
    if navigationAction.navigationType == .linkActivated, isForeignHttps(url, staged.target) {
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

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let staged = contextFor(webView), let url = webView.url, isAllowedLocalMainFrame(url, staged.gateway) else {
      if let staged = contextFor(webView) { failStaged(staged, "navigation_denied") }
      return
    }
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
    return nil
  }

  // MARK: - readiness JS

  private func readinessScript(_ staged: StagedLoad) -> String {
    let nonce = jsonQuote(staged.readinessNonce)
    return """
    void (async () => {
      try {
        const response = await fetch('/api/v1/status', { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok || response.redirected || new URL(response.url).origin !== location.origin) return;
        const value = await response.json();
        if (typeof value?.name !== 'string' || !value.name || typeof value?.version !== 'string' || !value.version) return;
        window.webkit.messageHandlers.\(Self.readinessObject).postMessage(\(nonce));
      } catch (_) {}
    })();
    """
  }

  // MARK: - commit / fail

  private func commitStaged(_ staged: StagedLoad) {
    guard staging === staged, isCurrent(staged.attemptId) else { return }
    FleetLog.stage("commit")
    guard targetStore.upsert(staged.target) else { failStaged(staged, "remote_target_persist_failed"); return }
    let previousView = activeView
    let previousGateway = activeGateway
    activeTarget = staged.target
    activeGateway = staged.gateway
    activeView = staged.view
    activeLoad = staged
    staging = nil
    staged.view.isHidden = false
    layoutWebViews()
    if let previousView, previousView !== staged.view { previousView.removeFromSuperview(); previousView.destroySafely() }
    if previousGateway !== staged.gateway { previousGateway?.close() }
    emit("connected", label: staged.target.label, origin: staged.target.origin)
  }

  private func failStaged(_ staged: StagedLoad, _ code: String) {
    guard staging === staged, isCurrent(staged.attemptId) else { return }
    FleetLog.failed("staged-webview", code)
    staging = nil
    staged.view.removeFromSuperview()
    staged.view.destroySafely()
    staged.gateway.close()
    worker.async { try? self.cookies.restore(staged.target.origin, staged.target.port, staged.cookieSnapshot) }
    emit("error", code: code, label: activeTarget?.label ?? staged.target.label, origin: staged.target.origin)
  }

  private func failIfCurrent(_ id: Int64, _ code: String, _ candidateLabel: String?, _ candidateOrigin: String?, _ retryAfter: Int?) {
    guard isCurrent(id) else { return }
    main {
      guard self.isCurrent(id) else { return }
      self.destroyStaging {
        self.emit("error", code: code, label: self.activeTarget?.label ?? candidateLabel, origin: candidateOrigin, retryAfterSeconds: retryAfter)
      }
    }
  }

  private func failCurrent(_ code: String, _ candidateLabel: String?) {
    let id = attempt.increment()
    main {
      guard self.isCurrent(id) else { return }
      self.destroyStaging {
        self.emit("error", code: code, label: self.activeTarget?.label ?? candidateLabel)
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

  private func isForeignHttps(_ url: URL, _ target: PersistedTarget) -> Bool {
    url.scheme == "https" && !sameRemoteOrigin(url, target) && url.user == nil
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

  private func emit(_ type: String, code: String? = nil, label: String? = nil, origin: String? = nil, retryAfterSeconds: Int? = nil) {
    main {
      var payload: [String: Any] = ["type": type, "active": self.activeView != nil]
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

  private func jsonQuote(_ value: String) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: [value]), let s = String(data: data, encoding: .utf8) {
      // ["x"] → "x"
      return String(s.dropFirst().dropLast())
    }
    return "\"\(value)\""
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
