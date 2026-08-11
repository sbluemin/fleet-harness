package com.dotobokuri.fleet.mobile

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class FleetLinkActivityTest {
  @Test
  fun exportedActivityClearsDataAndForwardsOnlyCredentialFreeIntent() {
    FleetLinkInbox.consume()
    val raw = "fleet://join?code=abc"
    val source = Intent(Intent.ACTION_VIEW, Uri.parse(raw))
    val controller = Robolectric.buildActivity(FleetLinkActivity::class.java, source).create()
    val activity = controller.get()

    assertNull(activity.intent.data)
    assertEquals(raw, FleetLinkInbox.consume())
    val foreground = shadowOf(activity).nextStartedActivity
    assertNull(foreground.data)
    assertNull(foreground.action)
    assertEquals("com.dotobokuri.fleet.mobile.MainActivity", foreground.component?.className)
  }

  @Test
  fun candidateCheckIsExactAndBounded() {
    assertTrue(FleetLinkInbox.isCandidate("fleet://join?code=abc"))
    assertFalse(FleetLinkInbox.isCandidate("FLEET://JOIN?CODE=abc"))
    assertFalse(FleetLinkInbox.isCandidate("fleet://pair?code=abc"))
    assertFalse(FleetLinkInbox.isCandidate(" fleet://join?code=abc"))
    assertFalse(FleetLinkInbox.isCandidate("fleet://join?mode=x&code=abc"))
    assertFalse(FleetLinkInbox.isCandidate("fleet://join?code=" + "a".repeat(4096)))
  }

  @Test
  fun inboxConsumptionIsOneShot() {
    FleetLinkInbox.consume()
    FleetLinkInbox.offer("fleet://join?code=abc")

    assertEquals("fleet://join?code=abc", FleetLinkInbox.consume())
    assertNull(FleetLinkInbox.consume())
  }
}
