import Foundation
import JavaScriptCore
import XCTest
@testable import FleetConsoleCore

// 셸이 페이지에 넣는 스크립트를 문자열이 아니라 실제 JavaScript 엔진에서 돌려 본다. WKWebView가 주는 것 중
// 스크립트가 쓰는 표면(window 이벤트, fetch, URL, 타이머, messageHandlers)만 흉내 낸다.
final class PageScriptTests: XCTestCase {
  private final class Page {
    let context = JSContext()!
    var posted: [String] = []
    var exceptions: [String] = []

    init(origin: String, status: String = #"{"name":"Fleet","version":"1.0.0"}"#) {
      context.exceptionHandler = { [weak self] _, value in self?.exceptions.append(value?.toString() ?? "?") }
      let post: @convention(block) (String) -> Void = { [weak self] value in self?.posted.append(value) }
      context.setObject(post, forKeyedSubscript: "__post" as NSString)
      context.evaluateScript("""
      const listeners = {};
      const timers = [];
      globalThis.window = globalThis;
      window.top = window;
      globalThis.location = { origin: \(Self.quote(origin)) };
      window.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
      window.removeEventListener = (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); };
      window.dispatchEvent = (event) => { (listeners[event.type] || []).slice().forEach((fn) => fn(event)); return true; };
      globalThis.Event = class { constructor(type) { this.type = type; } };
      globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
      globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; };
      globalThis.clearTimeout = (id) => { if (timers[id]) timers[id].live = false; };
      globalThis.__fire = () => { timers.forEach((t) => { if (t.live) { t.live = false; t.fn(); } }); };
      globalThis.__timerDelays = () => timers.map((t) => t.ms);
      globalThis.__listenerCount = (type) => (listeners[type] || []).length;
      globalThis.URL = class { constructor(url) { this.origin = url.match(/^[a-z]+:\\/\\/[^/]+/)[0]; } };
      globalThis.fetch = async (path) => ({ ok: true, redirected: false, url: location.origin + path, json: async () => (\(status)) });
      window.webkit = { messageHandlers: { fleetReadiness: { postMessage: (v) => __post(v) } } };
      globalThis.__consoleEvents = [];
      window.addEventListener('fleet-mobile-consoles', (e) => __consoleEvents.push(e.detail));
      """)
    }

    func run(_ script: String) { context.evaluateScript(script) }
    func value(_ expression: String) -> JSValue { context.evaluateScript(expression) }

    static func quote(_ value: String) -> String {
      String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
    }
  }

  private let readiness = ReadinessScript.source(nonce: "nonce-1", handler: "fleetReadiness")

  // MARK: r7 — readiness waits for the page's first meaningful paint

  func testAnOldPageWithoutThePaintSignalIsReadyAtOnce() {
    let page = Page(origin: "https://127.0.0.1:41000")
    page.run(readiness)
    XCTAssertEqual(page.posted, ["nonce-1"])
    XCTAssertEqual(page.exceptions, [])
  }

  func testAPageWithThePaintSignalIsReadyOnlyAfterItPainted() {
    let page = Page(origin: "https://127.0.0.1:41000")
    page.run("window.__fleetMobilePaintSignal = true;")
    page.run(readiness)
    XCTAssertEqual(page.posted, [], "readiness must wait for the paint event")
    XCTAssertEqual(page.value("__timerDelays()[0]").toInt32(), 2500)
    page.run("window.__fleetMobilePainted = true; window.dispatchEvent(new Event('fleet-mobile-painted'));")
    XCTAssertEqual(page.posted, ["nonce-1"])
    // 마감 타이머가 나중에 다시 보내지 않고, 리스너도 남지 않는다.
    page.run("__fire();")
    XCTAssertEqual(page.posted, ["nonce-1"])
    XCTAssertEqual(page.value("__listenerCount('fleet-mobile-painted')").toInt32(), 0)
  }

  func testAPageThatAlreadyPaintedIsReadyAtOnce() {
    let page = Page(origin: "https://127.0.0.1:41000")
    page.run("window.__fleetMobilePaintSignal = true; window.__fleetMobilePainted = true;")
    page.run(readiness)
    XCTAssertEqual(page.posted, ["nonce-1"])
  }

  func testAPageThatNeverPaintsIsStillReadyAtTheDeadline() {
    let page = Page(origin: "https://127.0.0.1:41000")
    page.run("window.__fleetMobilePaintSignal = true;")
    page.run(readiness)
    XCTAssertEqual(page.posted, [])
    page.run("__fire();")
    XCTAssertEqual(page.posted, ["nonce-1"])
    page.run("window.dispatchEvent(new Event('fleet-mobile-painted'));")
    XCTAssertEqual(page.posted, ["nonce-1"])
  }

  func testThePaintWaitNeverReplacesTheStatusCheck() {
    let page = Page(origin: "https://127.0.0.1:41000", status: #"{"name":""}"#)
    page.run("window.__fleetMobilePaintSignal = true; window.__fleetMobilePainted = true;")
    page.run(readiness)
    page.run("__fire();")
    XCTAssertEqual(page.posted, [])
  }

  // MARK: r6 — a failed switch is announced once, in the event only

  func testAFailedSwitchRidesOnlyOnTheOneEventDetail() throws {
    let store = TargetStore(store: InMemoryKeyValueStore())
    store.upsert(PersistedTarget(origin: "https://home.example:7443", hostname: "home.example", port: 7443, label: "Home",
                                 fingerprint: String(repeating: "A", count: 64), loopback: LoopbackIdentity(host: "127.0.0.1", port: 41000)))
    store.upsert(PersistedTarget(origin: "https://other.example:7444", hostname: "other.example", port: 7444, label: "Other",
                                 fingerprint: String(repeating: "A", count: 64), loopback: LoopbackIdentity(host: "127.0.0.1", port: 41001)))
    let records = store.records()
    let hub = MobileConsolesHub()
    // 이미 unavailable이었던 대상: 상태는 바뀌지 않지만 실패는 알려야 한다.
    hub.recordConnectFailure(records[1].id, code: "remote_link_unreachable")
    XCTAssertFalse(hub.attemptFailed(targetId: records[1].id, code: "remote_link_unreachable", seamless: true, activeVisible: true).changed)
    let state = hub.state(records: records, activeOrigin: records[0].target.origin, arrivalFor: records[0].id, now: Date())

    let page = Page(origin: "https://127.0.0.1:41000")
    page.run(MobileConsolesBridge.script(state, gatewayOrigin: "https://127.0.0.1:41000", failed: records[1].id))
    XCTAssertEqual(page.exceptions, [])
    XCTAssertEqual(page.value("__consoleEvents.length").toInt32(), 1)
    XCTAssertEqual(page.value("__consoleEvents[0].failed").toString(), records[1].id)
    XCTAssertEqual(page.value("__consoleEvents[0].consoles[1].status").toString(), "unavailable")
    XCTAssertTrue(page.value("Object.isFrozen(__consoleEvents[0])").toBool())
    XCTAssertTrue(page.value("window.__fleetMobileConsoles.failed === undefined").toBool(), "the document-start global never carries failed")
    XCTAssertTrue(page.value("Object.isFrozen(window.__fleetMobileConsoles.consoles[1])").toBool())

    // 다음 재발행(실패 없음)에는 failed가 없다. 다른 오리진의 문서는 아무것도 받지 않는다.
    page.run(MobileConsolesBridge.script(state, gatewayOrigin: "https://127.0.0.1:41000"))
    XCTAssertTrue(page.value("__consoleEvents[1].failed === undefined").toBool())
    let foreign = Page(origin: "https://127.0.0.1:41001")
    foreign.run(MobileConsolesBridge.script(state, gatewayOrigin: "https://127.0.0.1:41000", failed: records[1].id))
    XCTAssertEqual(foreign.value("__consoleEvents.length").toInt32(), 0)
    XCTAssertTrue(foreign.value("window.__fleetMobileConsoles === undefined").toBool())
  }
}
