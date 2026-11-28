package com.dotobokuri.fleet.mobile

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView

/** Stay renderable before commit without drawing over, taking focus from, or intercepting the old page. */
internal class StagedConsoleWebView(context: Context) : WebView(context) {
  private val normalAccessibility = importantForAccessibility
  private var committed = false

  init {
    visibility = View.VISIBLE
    alpha = 0f
    isFocusableInTouchMode = false
    isFocusable = false
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  }

  // Alpha doesn't gate Android input hit-testing. A touch through an unhandled area must not reach staging.
  override fun dispatchTouchEvent(event: MotionEvent): Boolean = committed && super.dispatchTouchEvent(event)
  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean = committed && super.dispatchGenericMotionEvent(event)
  override fun dispatchHoverEvent(event: MotionEvent): Boolean = committed && super.dispatchHoverEvent(event)

  fun reveal() {
    committed = true
    alpha = 1f
    importantForAccessibility = normalAccessibility
    // Match the prior committed WebView behaviour: a tap on an input can focus and raise the IME.
    isFocusable = true
    isFocusableInTouchMode = true
  }
}
