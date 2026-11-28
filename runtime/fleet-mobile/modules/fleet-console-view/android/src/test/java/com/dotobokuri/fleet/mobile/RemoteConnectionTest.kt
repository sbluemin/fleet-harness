package com.dotobokuri.fleet.mobile

import android.webkit.CookieManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.InetAddress
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLServerSocket

@RunWith(RobolectricTestRunner::class)
class RemoteConnectionTest {
  @Test
  fun rosterUsesPinnedTlsAndOnlyReadsThePairingCookieEvenWhenTheServerReturnsSetCookie() {
    val host = "127.0.0.1"
    val identity = LocalTlsIdentity.create(host)
    val executor = Executors.newSingleThreadExecutor()
    try {
      (identity.context.serverSocketFactory.createServerSocket(0, 2, InetAddress.getByName(host)) as SSLServerSocket).use { listener ->
        listener.soTimeout = 10_000
        val port = listener.localPort
        val target = PersistedTarget("https://$host:$port", host, port, "Fleet", RemoteConnection.fingerprint(identity.certificate), LoopbackIdentity("127.2.3.4", 43210))
        val cookieManager = CookieManager.getInstance()
        val pairing = "fleet_console_pairing_$port"
        val session = "fleet_console_session_$port"
        cookieManager.setCookie(target.origin, "$pairing=paired; Path=/; Secure; HttpOnly")
        cookieManager.setCookie(target.origin, "$session=original; Path=/; Secure; HttpOnly")
        val responseBody = """{"v":1,"more":0,"commodores":[]}"""
        val received = executor.submit<List<HttpRequest>> {
          listOf(false, true).map { oversized ->
            listener.accept().use { client ->
              client.soTimeout = 8_000
              val request = HttpCodec.readRequest(client.getInputStream().buffered())
              val size = if (oversized) RosterHttp.MAX_BODY + 1 else responseBody.length
              val output = client.getOutputStream()
              HttpCodec.writeHead(output, "HTTP/1.1 200 OK", Headers(listOf(
                Header("Set-Cookie", "$pairing=changed; Secure; HttpOnly; SameSite=Strict; Path=/"),
                Header("Set-Cookie", "$session=changed; Secure; HttpOnly; SameSite=Strict; Path=/"),
                Header("Content-Length", size.toString()),
                Header("Connection", "close"),
              )))
              if (!oversized) output.write(responseBody.toByteArray(Charsets.UTF_8))
              output.flush()
              request
            }
          }
        }
        val cookies = FleetCookieStore(cookieManager)
        val before = cookies.snapshot(target.origin, port)
        assertEquals(mapOf(pairing to "paired", session to "original"), before.values)
        val remote = RemoteConnection(cookies)
        val reading = remote.readRoster(target)
        assertEquals(RosterStatus.OK, reading.status)
        assertEquals(0, reading.roster?.getJSONArray("commodores")?.length())
        assertEquals(RosterStatus.UNAVAILABLE, remote.readRoster(target).status)
        assertEquals(before, cookies.snapshot(target.origin, port))
        for (request in received.get(10, TimeUnit.SECONDS)) {
          assertEquals("GET", request.method)
          assertEquals("/api/v1/console-roster", request.target)
          assertEquals(listOf("$pairing=paired"), request.headers.values("Cookie"))
          assertTrue(request.headers.containsToken("Connection", "close"))
        }
      }
    } finally {
      executor.shutdownNow()
    }
  }

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
