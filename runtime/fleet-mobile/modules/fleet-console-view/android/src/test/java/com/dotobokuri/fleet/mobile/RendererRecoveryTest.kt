package com.dotobokuri.fleet.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererRecoveryTest {
  @Test
  fun aRendererThatKeepsDyingStopsReloadingUntilItStaysUp() {
    var now = 1_000L
    val recovery = RendererRecovery(windowMs = 60_000L) { now }

    assertTrue(recovery.allowsAutomaticReload())
    now += 10_000L
    assertFalse(recovery.allowsAutomaticReload())
    now += 30_000L
    assertFalse(recovery.allowsAutomaticReload())
    now += 60_000L
    assertTrue(recovery.allowsAutomaticReload())
  }
}
