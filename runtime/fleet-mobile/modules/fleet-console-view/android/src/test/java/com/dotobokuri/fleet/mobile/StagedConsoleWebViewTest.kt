package com.dotobokuri.fleet.mobile

import android.view.MotionEvent
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class StagedConsoleWebViewTest {
  @Test
  fun stagingIsRenderableButCannotTakeInputOrAccessibilityUntilRevealed() {
    val view = StagedConsoleWebView(RuntimeEnvironment.getApplication())
    val down = MotionEvent.obtain(0L, 0L, MotionEvent.ACTION_DOWN, 5f, 5f, 0)
    try {
      var touches = 0
      view.setOnTouchListener { _, _ -> touches++; true }
      assertEquals(View.VISIBLE, view.visibility)
      assertEquals(0f, view.alpha, 0f)
      assertFalse(view.isFocusable)
      assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, view.importantForAccessibility)
      assertFalse(view.dispatchTouchEvent(down))
      assertEquals(0, touches)

      view.reveal()
      assertEquals(View.VISIBLE, view.visibility)
      assertEquals(1f, view.alpha, 0f)
      assertTrue(view.isFocusableInTouchMode)
      assertTrue(view.importantForAccessibility != View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS)
      assertTrue(view.dispatchTouchEvent(down))
      assertEquals(1, touches)
    } finally {
      down.recycle()
      view.destroy()
    }
  }
}
