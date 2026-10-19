package com.dotobokuri.fleet.mobile

import android.os.SystemClock

/**
 * Decides whether a page whose WebView renderer died may reload on its own. One death is recovered
 * silently; a second within [windowMs] waits for the person, so a renderer that keeps dying cannot
 * reload forever.
 */
internal class RendererRecovery(
  private val windowMs: Long = WINDOW_MS,
  private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
  private var lastDeathAt: Long? = null

  /** Records a death; true when the page may reload without asking. */
  fun allowsAutomaticReload(): Boolean {
    val now = clock()
    val previous = lastDeathAt
    lastDeathAt = now
    return previous == null || now - previous >= windowMs
  }

  companion object {
    const val WINDOW_MS = 60_000L
    /** The error code shown when the shell stops reloading a page whose renderer keeps dying. */
    const val CODE = "webview_renderer_gone"
  }
}
