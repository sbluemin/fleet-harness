package com.dotobokuri.fleet.mobile

import org.json.JSONObject

/** Probe only the staged document. Native still checks the nonce, frame, gateway, and attempt. */
internal object StageReadiness {
  const val MESSAGE_OBJECT = "fleetReadiness"
  private const val PAINT_TIMEOUT_MS = 2_500

  fun script(nonce: String): String = """
    void (async () => {
      try {
        const response = await fetch('/api/v1/status', {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok || response.redirected || new URL(response.url).origin !== location.origin) return;
        const value = await response.json();
        if (typeof value?.name !== 'string' || !value.name || typeof value?.version !== 'string' || !value.version) return;
        if (window.__fleetMobilePaintSignal === true && window.__fleetMobilePainted !== true) {
          await new Promise(resolve => {
            const done = () => {
              window.removeEventListener('fleet-mobile-painted', done);
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(done, $PAINT_TIMEOUT_MS);
            window.addEventListener('fleet-mobile-painted', done, { once: true });
          });
        }
        window.$MESSAGE_OBJECT.postMessage(${JSONObject.quote(nonce)});
      } catch (_) {}
    })();
  """.trimIndent()
}
