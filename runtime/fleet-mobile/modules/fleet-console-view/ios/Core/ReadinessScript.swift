import Foundation

// 스테이징 WebView의 readiness 핸드셰이크 스크립트. 같은 출처 /api/v1/status가 Console 상태를 답해야 하고,
// 그다음 페이지가 페인트 신호를 켜 두었으면(브리지 v1.6 개정 r7) 첫 의미 있는 화면을 그렸다는 신호를 최대
// 2.5초 기다린다 — 그래야 commit 순간 흰 프레임이나 "불러오는 중" 화면이 보이지 않는다. 신호가 없는 구 페이지는
// 지금처럼 곧바로 readiness를 보낸다. 신호가 끝내 오지 않아도 마감 뒤에는 보낸다(전환이 막히지 않는다).
public enum ReadinessScript {
  public static let paintWaitMs = 2_500

  public static func source(nonce: String, handler: String) -> String {
    let quoted = quote(nonce)
    return """
    void (async () => {
      try {
        const response = await fetch('/api/v1/status', { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok || response.redirected || new URL(response.url).origin !== location.origin) return;
        const value = await response.json();
        if (typeof value?.name !== 'string' || !value.name || typeof value?.version !== 'string' || !value.version) return;
        if (window.__fleetMobilePaintSignal === true && window.__fleetMobilePainted !== true) {
          await new Promise((resolve) => {
            let timer = null;
            const done = () => { window.removeEventListener('fleet-mobile-painted', done); if (timer !== null) clearTimeout(timer); resolve(); };
            window.addEventListener('fleet-mobile-painted', done);
            timer = setTimeout(done, \(paintWaitMs));
            if (window.__fleetMobilePainted === true) done();
          });
        }
        window.webkit.messageHandlers.\(handler).postMessage(\(quoted));
      } catch (_) {}
    })();
    """
  }

  private static func quote(_ value: String) -> String {
    (try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
  }
}
