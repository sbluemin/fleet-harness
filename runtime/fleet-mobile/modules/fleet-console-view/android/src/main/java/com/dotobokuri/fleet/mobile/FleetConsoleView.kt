package com.dotobokuri.fleet.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@SuppressLint("SetJavaScriptEnabled")
internal class FleetConsoleView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private data class StagedLoad(
    val attemptId: Long,
    val target: PersistedTarget,
    val gateway: LoopbackGateway,
    val cookieSnapshot: FleetCookieSnapshot,
    val view: WebView,
    val readinessNonce: String,
    var localCertificateObserved: Boolean = false,
    var readinessRequested: Boolean = false,
  )

  private val onFleetEvent by EventDispatcher()
  private val targetStore = TargetStore(context)
  private val cookies = FleetCookieStore()
  private val connection = RemoteConnection(cookies)
  private val worker = Executors.newSingleThreadExecutor { task ->
    Thread(task, "fleet-mobile-connection").apply { isDaemon = true }
  }
  private val main = Handler(Looper.getMainLooper())
  private val attempt = AtomicLong(0)
  private val linkReceiver: (String) -> Unit = ::receiveLink

  @Volatile private var activeTarget: PersistedTarget? = targetStore.active()
  private var activeView: WebView? = null
  private var activeGateway: LoopbackGateway? = null
  private var staging: StagedLoad? = null
  private val appearanceStore = AppearanceStore(context)
  private val appVersion: String? = try { context.packageManager.getPackageInfo(context.packageName, 0).versionName } catch (_: Exception) { null }
  // Read by JS on the module thread, written on main.
  @Volatile private var appearance = appearanceStore.load()
  private var systemDark = isSystemDark(resources.configuration)
  // The document-start script of each view, replaced whenever the value changes so the next load starts right.
  private val startScripts = WeakHashMap<WebView, ScriptHandler>()
  private var documentStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
  // True from the moment an attempt starts until it commits or fails. resume() must not look past it:
  // a foreground return would otherwise overwrite an in-flight cold-start link attempt with the
  // stored target. Volatile because beginAttempt can start from the JS thread.
  @Volatile private var attemptInFlight = false
  // 잘못된 링크 오류는 사용자가 다음 행동을 고를 때까지 포그라운드 복귀로 덮지 않는다.
  @Volatile private var invalidLinkPending = false
  private var detached = false
  private var chromeInsets: Insets = Insets.NONE
  private var imeInsets: Insets = Insets.NONE

  init {
    WebView.setWebContentsDebuggingEnabled(false)
    CookieManager.getInstance().setAcceptCookie(true)
    // A cold-start link outranks the persisted reconnect: it starts the only attempt.
    val linkDelivered = FleetLinkInbox.attach(linkReceiver)
    // Android 15+ forces edge-to-edge for this targetSdk, so this view owns its own insets: the
    // WebView shrinks under status bar, cutout, and keyboard, and JS gets the chrome insets in dp.
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
      applyWindowInsets(
        insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()),
        insets.getInsets(WindowInsetsCompat.Type.ime()),
      )
      insets
    }
    if (!linkDelivered) {
      activeTarget?.let {
        emit("connecting", label = it.label, origin = it.origin)
        beginAttempt(it, null)
      } ?: emit("waiting")
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ViewCompat.requestApplyInsets(this)
  }

  private fun applyWindowInsets(chrome: Insets, ime: Insets) {
    if (chrome == chromeInsets && ime == imeInsets) return
    val chromeChanged = chrome != chromeInsets
    chromeInsets = chrome
    imeInsets = ime
    setPadding(chrome.left, chrome.top, chrome.right, maxOf(chrome.bottom, ime.bottom))
    layoutWebViews()
    post(::layoutWebViews)
    if (chromeChanged) emitInsets(chrome)
  }

  /** JS overlays draw over the whole window and pad themselves; the keyboard inset stays native. */
  private fun emitInsets(chrome: Insets) {
    val density = resources.displayMetrics.density
    main.post {
      onFleetEvent(
        mapOf(
          "type" to "insets",
          "insetTop" to chrome.top / density,
          "insetRight" to chrome.right / density,
          "insetBottom" to chrome.bottom / density,
          "insetLeft" to chrome.left / density,
        ),
      )
    }
  }

  private fun receiveLink(rawLink: String) {
    val parsed = try {
      AccessLink.parse(rawLink)
    } catch (_: IllegalArgumentException) {
      failInvalidLink()
      return
    }
    beginAttempt(parsed.withoutCredential(targetStore.identityFor(parsed, activeTarget, activeGateway != null)), parsed.token)
  }

  fun retry() {
    dismissLinkError()
    val current = activeTarget ?: run {
      emit("error", "pairing_target_invalid")
      return
    }
    beginAttempt(current, null)
  }

  fun resume() {
    if (invalidLinkPending) {
      // JS 마운트 전 init 이벤트를 놓쳤더라도 오류를 다시 받는다. 재연결은 하지 않는다.
      emit("error", "pairing_target_invalid")
      return
    }
    if (attemptInFlight) return
    if (activeView == null && activeTarget != null) retry()
  }

  fun dismissLinkError() {
    invalidLinkPending = false
  }

  /** JS entry for pasted or scanned links; the intent inbox and this path converge on receiveLink. */
  fun submitAccessLink(link: String) {
    receiveLink(link)
  }

  fun connectTo(origin: String) {
    dismissLinkError()
    main.post {
      val stored = targetStore.find(origin) ?: run {
        emit("error", "target_missing")
        return@post
      }
      val identity = targetStore.resumeIdentity(stored, activeTarget, activeGateway != null)
      beginAttempt(stored.copy(loopback = identity), null)
    }
  }

  fun removeTarget(origin: String) {
    dismissLinkError()
    main.post {
      val removed = targetStore.find(origin) ?: return@post
      val wasActive = activeTarget?.origin == origin
      val wasStaging = staging?.target?.origin == origin
      targetStore.remove(origin)
      if (wasActive || wasStaging) {
        attempt.incrementAndGet()
        attemptInFlight = false
        destroyStaging()
        if (wasActive) {
          activeView?.let {
            removeView(it)
            it.destroySafely()
          }
          activeView = null
          activeGateway?.close()
          activeGateway = null
          activeTarget = null
        }
        activeTarget?.let { emit("connected", label = it.label, origin = it.origin) } ?: emit("waiting")
      }
      // Forgetting a console also drops its pairing secret; the server row ages out on its own.
      worker.execute {
        try { cookies.restoreAndAwait(removed.origin, removed.port, FleetCookieSnapshot(emptyMap())) } catch (_: Exception) { }
      }
    }
  }

  fun listTargets(): List<Map<String, Any>> {
    val activeOrigin = activeTarget?.origin
    return targetStore.list().map { target ->
      mapOf(
        "origin" to target.origin,
        "label" to target.label,
        "host" to target.hostname,
        "port" to target.port,
        "fingerprint" to target.fingerprint.take(8),
        "active" to (target.origin == activeOrigin),
      )
    }
  }

  /**
   * True when the page took the back press; false asks JS to leave for the console list.
   *
   * The page decides first (bridge contract §8): `window.__fleetMobileBack()` returns true when it
   * stepped back itself — a sheet, the drawer, a detail screen. It has [PAGE_BACK_BUDGET_MS] to
   * answer; silence, false, or a throw hand the press to the shell. A page without the function
   * (an older Console) keeps the earlier rule: back leaves an open operation through history.
   */
  fun navigateBack(promise: Promise) {
    main.post {
      val view = activeView ?: run {
        promise.resolve(false)
        return@post
      }
      // View functions run on the main thread, so the answer is awaited by callback, not by blocking.
      val settled = AtomicBoolean(false)
      val settle = { handled: Boolean -> if (settled.compareAndSet(false, true)) promise.resolve(handled) }
      main.postDelayed({ settle(false) }, PAGE_BACK_BUDGET_MS)
      view.evaluateJavascript(PAGE_BACK_SCRIPT) { result ->
        when {
          settled.get() -> Unit
          result == "\"absent\"" -> settle(legacyOperationBack(view))
          else -> settle(result == "true")
        }
      }
    }
  }

  private fun legacyOperationBack(view: WebView): Boolean {
    if (view !== activeView || !isOperationOpen(view) || !view.canGoBack()) return false
    view.goBack()
    return true
  }

  /** The console names the open operation in its address, which is the only signal the shell needs. */
  private fun isOperationOpen(view: WebView): Boolean {
    val url = view.url ?: return false
    return try {
      Uri.parse(url).getQueryParameter("op")?.isNotEmpty() == true
    } catch (_: Exception) {
      false
    }
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    layoutWebViews(measuredWidth, measuredHeight)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    layoutWebViews(right - left, bottom - top)
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    layoutWebViews(width, height)
  }

  private fun layoutWebViews(width: Int = this.width, height: Int = this.height) {
    // Read this view's padding before the child scope: inside apply, paddingLeft would be the
    // WebView's own, which would place the page at the origin — clipped by clipToPadding on the
    // inset edges and short of the opposite ones.
    val insetLeft = paddingLeft
    val insetTop = paddingTop
    val innerWidth = width - insetLeft - paddingRight
    val innerHeight = height - insetTop - paddingBottom
    if (innerWidth <= 0 || innerHeight <= 0) return
    val childWidth = View.MeasureSpec.makeMeasureSpec(innerWidth, View.MeasureSpec.EXACTLY)
    val childHeight = View.MeasureSpec.makeMeasureSpec(innerHeight, View.MeasureSpec.EXACTLY)
    for (index in 0 until childCount) {
      getChildAt(index).apply {
        measure(childWidth, childHeight)
        layout(insetLeft, insetTop, insetLeft + innerWidth, insetTop + innerHeight)
      }
    }
  }

  override fun onDetachedFromWindow() {
    detached = true
    FleetLinkInbox.detach(linkReceiver)
    attempt.incrementAndGet()
    destroyStaging()
    activeView?.destroySafely()
    activeView = null
    activeGateway?.close()
    activeGateway = null
    worker.shutdownNow()
    super.onDetachedFromWindow()
  }

  private fun beginAttempt(candidate: PersistedTarget, token: String?) {
    val id = attempt.incrementAndGet()
    attemptInFlight = true
    dismissLinkError()
    main.post {
      if (!isCurrent(id)) return@post
      val launch = {
        if (isCurrent(id)) {
          emit("connecting", label = candidate.label, origin = candidate.origin)
          worker.execute { runCandidate(id, candidate, token) }
        }
      }
      if (staging == null) launch() else destroyStaging(launch)
    }
  }

  private fun runCandidate(id: Long, candidate: PersistedTarget, token: String?) {
    var gateway: LoopbackGateway? = null
    var cookieSnapshot: FleetCookieSnapshot? = null
    var candidateTouchedCookies = false
    try {
      if (!isCurrent(id)) return
      connection.preflight(candidate)
      if (!isCurrent(id)) return
      cookieSnapshot = cookies.snapshot(candidate.origin, candidate.port)
      candidateTouchedCookies = true
      connection.join(candidate, token, deviceName())
      if (!isCurrent(id)) {
        cookies.restoreAndAwait(candidate.origin, candidate.port, cookieSnapshot)
        return
      }
      connection.verifyReachable(candidate)
      if (!isCurrent(id)) {
        cookies.restoreAndAwait(candidate.origin, candidate.port, cookieSnapshot)
        return
      }
      gateway = LoopbackGateway(candidate, connection, cookies).also {
        it.start()
        it.installLocalCookie()
      }
      if (!isCurrent(id)) {
        gateway.close()
        cookies.restoreAndAwait(candidate.origin, candidate.port, cookieSnapshot)
        return
      }
      val candidateGateway = gateway
      val snapshot = cookieSnapshot ?: throw IllegalStateException("cookie_snapshot_missing")
      main.post {
        if (isCurrent(id)) stageWebView(id, candidate, candidateGateway, snapshot)
        else {
          candidateGateway.close()
          worker.execute { try { cookies.restoreAndAwait(candidate.origin, candidate.port, snapshot) } catch (_: Exception) { } }
        }
      }
    } catch (failure: ConnectionFailure) {
      gateway?.close()
      if (candidateTouchedCookies) cookieSnapshot?.let { try { cookies.restoreAndAwait(candidate.origin, candidate.port, it) } catch (_: Exception) { } }
      failIfCurrent(id, failure.code, candidate.label, candidate.origin, failure.retryAfterSeconds)
    } catch (_: Exception) {
      gateway?.close()
      if (candidateTouchedCookies) cookieSnapshot?.let { try { cookies.restoreAndAwait(candidate.origin, candidate.port, it) } catch (_: Exception) { } }
      failIfCurrent(id, "remote_link_unreachable", candidate.label, candidate.origin)
    }
  }

  private fun stageWebView(
    id: Long,
    candidate: PersistedTarget,
    gateway: LoopbackGateway,
    cookieSnapshot: FleetCookieSnapshot,
  ) {
    if (!isCurrent(id)) {
      gateway.close()
      return
    }
    val webView = WebView(context)
    val staged = StagedLoad(id, candidate, gateway, cookieSnapshot, webView, UUID.randomUUID().toString())
    staging = staged
    configureWebView(staged)
    webView.visibility = INVISIBLE
    addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    layoutWebViews()
    post(::layoutWebViews)
    webView.loadUrl(gateway.consoleUrl)
  }

  private fun configureWebView(staged: StagedLoad) {
    val webView = staged.view
    with(webView.settings) {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      allowFileAccessFromFileURLs = false
      allowUniversalAccessFromFileURLs = false
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      // Pinch belongs to the page: the terminal reads it as a resize. Browser zoom runs on the
      // compositor, so a page handler cannot reliably cancel it — the setting has to be off.
      setSupportZoom(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      mediaPlaybackRequiresUserGesture = true
      builtInZoomControls = false
      displayZoomControls = false
      cacheMode = WebSettings.LOAD_NO_CACHE
      setGeolocationEnabled(false)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
      // The marker lets the Console pin its mobile shell regardless of viewport width; the local
      // gateway origin churns across re-links, so a stored preference cannot carry this signal.
      userAgentString = "$userAgentString $USER_AGENT_PRODUCT"
    }
    // A programmatically added WebView is not focusable in touch mode by default, so a tap on a
    // page input never reaches the input method and the keyboard stays down.
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
    try {
      WebViewCompat.addWebMessageListener(
        webView,
        READINESS_OBJECT,
        setOf(staged.gateway.origin),
        object : WebViewCompat.WebMessageListener {
          override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
          ) {
            val current = staging
            if (current !== staged || !isCurrent(staged.attemptId)) return
            if (isMainFrame && isLocalOrigin(sourceOrigin, staged.gateway) && message.data == staged.readinessNonce) {
              commitStaged(staged)
            } else {
              failStaged(staged, "remote_host_unavailable")
            }
          }
        },
      )
    } catch (_: Exception) {
      failStaged(staged, "remote_host_readiness_unsupported")
      return
    }
    webView.setBackgroundColor(AppearanceBridge.backgroundColor(appearance.dark(systemDark)))
    installAppearanceScript(webView, staged.gateway, staged.target)
    try {
      WebViewCompat.addWebMessageListener(
        webView,
        AppearanceBridge.MESSAGE_OBJECT,
        setOf(staged.gateway.origin),
        object : WebViewCompat.WebMessageListener {
          override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
          ) {
            // A staging view is not committed yet, so its page cannot speak for the shell.
            val gateway = activeGateway
            val accepted = AppearanceBridge.accept(
              fromCommittedView = gateway != null && view === activeView,
              isMainFrame = isMainFrame,
              fromGatewayOrigin = gateway != null && isLocalOrigin(sourceOrigin, gateway),
              body = message.data,
            ) ?: return
            onAppearanceMessage(accepted)
          }
        },
      )
    } catch (_: Exception) {
      // Readiness already proved the listener API; losing this channel only freezes the preference.
    }
    webView.setDownloadListener { _, _, _, _, _ -> failStaged(staged, "navigation_denied") }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean = false
      override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
      override fun onShowFileChooser(webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>?, fileChooserParams: FileChooserParams?): Boolean {
        filePathCallback?.onReceiveValue(null)
        return false
      }
      override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean = true
    }
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return !isLocalOrigin(request.url, staged.gateway)
        if (isAllowedLocalMainFrame(request.url, staged.gateway)) return false
        if (sameRemoteOrigin(request.url, staged.target)) {
          view?.loadUrl(toLocalUrl(request.url, staged.gateway))
        } else if (request.hasGesture() && isForeignWeb(request.url, staged)) {
          // Multiple windows are off, so a target=_blank link arrives here as a main-frame
          // navigation: the Console's new-window http(s) links take this same route out.
          delegateExternally(request.url)
        }
        return true
      }

      @Deprecated("Deprecated by Android")
      override fun shouldOverrideUrlLoading(view: WebView?, url: String): Boolean {
        val uri = Uri.parse(url)
        if (isAllowedLocalMainFrame(uri, staged.gateway)) return false
        if (sameRemoteOrigin(uri, staged.target)) view?.loadUrl(toLocalUrl(uri, staged.gateway))
        return true
      }

      override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? =
        if (isLocalOrigin(request.url, staged.gateway)) null else deniedResponse()

      override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        if (url == null || !isAllowedLocalMainFrame(Uri.parse(url), staged.gateway)) {
          view?.stopLoading()
          failStaged(staged, "navigation_denied")
          return
        }
        super.onPageStarted(view, url, favicon)
      }

      override fun onPageCommitVisible(view: WebView?, url: String?) {
        super.onPageCommitVisible(view, url)
        // Without document-start scripts the page learns its appearance at first commit instead.
        if (!documentStartSupported && view != null && url != null && isAllowedLocalMainFrame(Uri.parse(url), staged.gateway)) {
          view.evaluateJavascript(appearanceScriptFor(staged.target), null)
        }
      }

      override fun onPageFinished(view: WebView?, url: String?) {
        if (view == null || url == null || !isAllowedLocalMainFrame(Uri.parse(url), staged.gateway)) {
          failStaged(staged, "navigation_denied")
          return
        }
        if (!staged.localCertificateObserved) {
          failStaged(staged, "remote_link_pin_not_observed")
          return
        }
        if (staged.readinessRequested) return
        staged.readinessRequested = true
        view.evaluateJavascript(readinessScript(staged), null)
      }

      override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError?) {
        if (request.isForMainFrame) failStaged(staged, "remote_host_unavailable")
      }

      override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest, errorResponse: WebResourceResponse?) {
        if (!request.isForMainFrame) return
        failStaged(staged, if (errorResponse?.statusCode == 401) "remote_host_session_expired" else "remote_host_unavailable")
      }

      override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError) {
        val errorUri = try { Uri.parse(error.url) } catch (_: Exception) { null }
        val presented = certificateOf(error.certificate)
        val onlyUntrusted = error.primaryError == SslError.SSL_UNTRUSTED &&
          error.hasError(SslError.SSL_UNTRUSTED) &&
          !error.hasError(SslError.SSL_NOTYETVALID) && !error.hasError(SslError.SSL_EXPIRED) &&
          !error.hasError(SslError.SSL_IDMISMATCH) && !error.hasError(SslError.SSL_DATE_INVALID) &&
          !error.hasError(SslError.SSL_INVALID)
        val accepted = onlyUntrusted && errorUri != null && isLocalOrigin(errorUri, staged.gateway) &&
          presented != null && LocalCertificatePolicy.matches(presented, staged.gateway.localCertificate, staged.gateway.host)
        if (accepted) {
          staged.localCertificateObserved = true
          handler.proceed()
        } else {
          handler.cancel()
          failStaged(staged, "remote_link_unverified")
        }
      }

      override fun onSafeBrowsingHit(view: WebView?, request: WebResourceRequest?, threatType: Int, callback: SafeBrowsingResponse) {
        callback.backToSafety(true)
        failStaged(staged, "navigation_denied")
      }
    }
  }

  fun getAppearance(): Map<String, Any> = appearance.let {
    mapOf("colorMode" to it.colorMode.wire, "fontScale" to it.fontScale.wire)
  }

  /** The shell paints its own screens; only it knows when a dark camera covers a light mode. */
  fun setNavigationBarStyle(dark: Boolean) {
    main.post {
      val window = appContext.currentActivity?.window ?: return@post
      WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = !dark
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val dark = isSystemDark(newConfig)
    if (dark == systemDark) return
    systemDark = dark
    refreshAppearance()
  }

  private fun isSystemDark(configuration: Configuration): Boolean =
    (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private fun appearanceScriptFor(target: PersistedTarget): String =
    AppearanceBridge.script(appearance, systemDark, ConsolePresentation.of(target), appVersion)

  private fun installAppearanceScript(webView: WebView, gateway: LoopbackGateway, target: PersistedTarget) {
    if (!documentStartSupported) return
    startScripts.remove(webView)?.remove()
    try {
      startScripts[webView] = WebViewCompat.addDocumentStartJavaScript(webView, appearanceScriptFor(target), setOf(gateway.origin))
    } catch (_: Exception) {
      documentStartSupported = false
    }
  }

  /** Tell every live page again: the next load through its document-start script, the open page right now. */
  private fun refreshAppearance() {
    val background = AppearanceBridge.backgroundColor(appearance.dark(systemDark))
    staging?.let { staged ->
      staged.view.setBackgroundColor(background)
      installAppearanceScript(staged.view, staged.gateway, staged.target)
    }
    val view = activeView
    val gateway = activeGateway
    val target = activeTarget
    if (view != null && gateway != null && target != null) {
      view.setBackgroundColor(background)
      installAppearanceScript(view, gateway, target)
      view.evaluateJavascript(appearanceScriptFor(target), null)
    }
    emitPayload(mapOf("type" to "appearance", "colorMode" to appearance.colorMode.wire, "fontScale" to appearance.fontScale.wire))
  }

  private fun onAppearanceMessage(message: AppearanceMessage) {
    when (message) {
      is AppearanceMessage.Set -> {
        if (message.appearance != appearance) {
          appearance = message.appearance
          appearanceStore.save(message.appearance)
        }
        // Confirm even an unchanged value: the page painted optimistically and waits for the answer.
        refreshAppearance()
      }
      is AppearanceMessage.Chrome -> emitPayload(mapOf("type" to "chrome", "top" to message.top, "bottom" to message.bottom))
      AppearanceMessage.Consoles -> emitPayload(mapOf("type" to "consoles"))
    }
  }

  private fun emitPayload(payload: Map<String, Any>) {
    main.post { onFleetEvent(payload) }
  }

  private fun readinessScript(staged: StagedLoad): String {
    val nonce = org.json.JSONObject.quote(staged.readinessNonce)
    return """
      void (async () => {
        try {
          const response = await fetch('/api/v1/status', {
            method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json' }
          });
          if (!response.ok || response.redirected || new URL(response.url).origin !== location.origin) return;
          const value = await response.json();
          if (typeof value?.name !== 'string' || !value.name || typeof value?.version !== 'string' || !value.version) return;
          window.$READINESS_OBJECT.postMessage($nonce);
        } catch (_) {}
      })();
    """.trimIndent()
  }

  private fun commitStaged(staged: StagedLoad) {
    if (staging !== staged || !isCurrent(staged.attemptId)) return
    attemptInFlight = false
    if (!targetStore.upsert(staged.target)) {
      failStaged(staged, "remote_target_persist_failed")
      return
    }
    val previousView = activeView
    val previousGateway = activeGateway
    activeTarget = staged.target
    activeGateway = staged.gateway
    activeView = staged.view
    staging = null
    staged.view.visibility = VISIBLE
    staged.view.requestFocus()
    layoutWebViews()
    post(::layoutWebViews)
    if (previousView != null && previousView !== staged.view) {
      removeView(previousView)
      previousView.destroySafely()
    }
    if (previousGateway !== staged.gateway) previousGateway?.close()
    emit("connected", label = staged.target.label, origin = staged.target.origin)
  }

  private fun failStaged(staged: StagedLoad, code: String) {
    if (staging !== staged || !isCurrent(staged.attemptId)) return
    attemptInFlight = false
    staging = null
    removeView(staged.view)
    staged.view.destroySafely()
    staged.gateway.close()
    worker.execute {
      try { cookies.restoreAndAwait(staged.target.origin, staged.target.port, staged.cookieSnapshot) } catch (_: Exception) { }
    }
    emit("error", code, activeTarget?.label ?: staged.target.label, staged.target.origin)
  }

  private fun failIfCurrent(id: Long, code: String, candidateLabel: String?, candidateOrigin: String? = null, retryAfterSeconds: Int? = null) {
    if (!isCurrent(id)) return
    main.post {
      if (!isCurrent(id)) return@post
      attemptInFlight = false
      destroyStaging {
        if (isCurrent(id)) emit("error", code, activeTarget?.label ?: candidateLabel, candidateOrigin, retryAfterSeconds)
      }
    }
  }

  private fun failInvalidLink() {
    val id = attempt.incrementAndGet()
    invalidLinkPending = true
    main.post {
      if (!isCurrent(id)) return@post
      attemptInFlight = false
      destroyStaging {
        if (isCurrent(id)) emit("error", "pairing_target_invalid")
      }
    }
  }

  private fun destroyStaging(afterRestore: () -> Unit = {}) {
    val doomed = staging ?: run {
      afterRestore()
      return
    }
    staging = null
    removeView(doomed.view)
    doomed.view.destroySafely()
    doomed.gateway.close()
    worker.execute {
      try { cookies.restoreAndAwait(doomed.target.origin, doomed.target.port, doomed.cookieSnapshot) } catch (_: Exception) { }
      main.post(afterRestore)
    }
  }

  private fun WebView.destroySafely() {
    stopLoading()
    clearHistory()
    removeAllViews()
    destroy()
  }

  private fun isCurrent(id: Long): Boolean = !detached && attempt.get() == id

  private fun isAllowedLocalMainFrame(uri: Uri, gateway: LoopbackGateway): Boolean {
    if (!isLocalOrigin(uri, gateway) || uri.encodedUserInfo != null || uri.fragment != null) return false
    val path = uri.path.orEmpty()
    return path == "/console" || path == "/console/"
  }

  private fun isLocalOrigin(uri: Uri, gateway: LoopbackGateway): Boolean = uri.scheme == "https" &&
    uri.host == gateway.host && uri.port == gateway.port && uri.encodedUserInfo == null

  private fun sameRemoteOrigin(uri: Uri, target: PersistedTarget): Boolean {
    if (uri.scheme != "https" || !uri.host.equals(target.hostname, ignoreCase = true)) return false
    val port = if (uri.port == -1) 443 else uri.port
    return port == target.port && uri.encodedUserInfo == null
  }

  private fun toLocalUrl(uri: Uri, gateway: LoopbackGateway): String = buildString {
    append(gateway.origin)
    append(uri.encodedPath?.takeIf(String::isNotEmpty) ?: "/")
    uri.encodedQuery?.let { append('?').append(it) }
    uri.encodedFragment?.let { append('#').append(it) }
  }

  /** Addresses the OS browser may open: http(s) outside both the remote Console and the local gateway. */
  private fun isForeignWeb(uri: Uri, staged: StagedLoad): Boolean {
    val scheme = uri.scheme?.lowercase()
    return (scheme == "https" || scheme == "http") && !uri.host.isNullOrEmpty() && uri.encodedUserInfo == null &&
      !sameRemoteOrigin(uri, staged.target) && !isLocalOrigin(uri, staged.gateway)
  }

  private fun delegateExternally(uri: Uri) {
    val intent = Intent(Intent.ACTION_VIEW, uri).apply { addCategory(Intent.CATEGORY_BROWSABLE) }
    try { context.startActivity(intent) } catch (_: Exception) { }
  }

  private fun deniedResponse(): WebResourceResponse = WebResourceResponse(
    "text/plain",
    "UTF-8",
    403,
    "Blocked by Fleet Mobile",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0)),
  )

  private fun certificateOf(certificate: android.net.http.SslCertificate?): X509Certificate? {
    if (certificate == null) return null
    return try {
      val bytes = android.net.http.SslCertificate.saveState(certificate)?.getByteArray("x509-certificate") ?: return null
      CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
    } catch (_: Exception) { null }
  }

  private fun deviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
    .filter { it.isNotBlank() }
    .joinToString(" ")
    .trim()
    .take(80)
    .ifEmpty { "Android device" }

  private fun emit(type: String, code: String? = null, label: String? = null, origin: String? = null, retryAfterSeconds: Int? = null) {
    main.post {
      val payload = mutableMapOf<String, Any>("type" to type, "active" to (activeView != null))
      if (code != null) payload["code"] = code
      if (label != null) payload["label"] = label
      if (origin != null) payload["origin"] = origin
      if (retryAfterSeconds != null) payload["retryAfterSeconds"] = retryAfterSeconds
      onFleetEvent(payload)
    }
  }

  private companion object {
    const val READINESS_OBJECT = "fleetReadiness"
    const val PAGE_BACK_BUDGET_MS = 300L

    /** Only a literal `true` counts as handled; anything else the page does is the shell's press. */
    const val PAGE_BACK_SCRIPT =
      "(() => { const f = window.__fleetMobileBack; if (typeof f !== \"function\") return \"absent\"; " +
        "try { return f() === true; } catch (_) { return false; } })()"

    /** Version mirrors the module version in build.gradle. */
    const val USER_AGENT_PRODUCT = "FleetMobile/0.1.0"
  }
}
