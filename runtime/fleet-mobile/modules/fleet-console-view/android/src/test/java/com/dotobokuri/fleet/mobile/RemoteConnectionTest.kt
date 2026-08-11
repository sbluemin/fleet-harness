package com.dotobokuri.fleet.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteConnectionTest {
  @Test
  fun retryAfterTrustsOnlyBoundedDeltaSeconds() {
    assertEquals(60, RetryAfterHeader.seconds("60"))
    assertEquals(120, RetryAfterHeader.seconds(" 120 "))
    assertEquals(0, RetryAfterHeader.seconds("0"))
    assertEquals(86_400, RetryAfterHeader.seconds("86400"))
    assertNull(RetryAfterHeader.seconds("86401"))
    assertNull(RetryAfterHeader.seconds("-1"))
    assertNull(RetryAfterHeader.seconds("12.5"))
    assertNull(RetryAfterHeader.seconds("Wed, 21 Oct 2026 07:28:00 GMT"))
    assertNull(RetryAfterHeader.seconds(null))
  }

  @Test
  fun connectionFailureCarriesOptionalRetryDelay() {
    assertEquals(60, ConnectionFailure("remote_link_throttled", null, 60).retryAfterSeconds)
    assertNull(ConnectionFailure("remote_link_rejected").retryAfterSeconds)
  }
}
