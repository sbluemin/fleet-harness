package com.dotobokuri.fleet.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LoopbackGatewayTest {
  @Test fun requiresExactHostAndGatewayCookie() {
    val request = HttpCodec.readRequest(ByteArrayInputStream(
      "GET /console/ HTTP/1.1\r\nHost: 127.0.0.1:4312\r\nCookie: a=b; fleet_mobile_gateway=secret\r\n\r\n"
        .toByteArray(),
    ))
    assertEquals("127.0.0.1:4312", request.host)
    assertTrue(request.hasCookie("fleet_mobile_gateway", "secret"))
    assertFalse(request.hasCookie("fleet_mobile_gateway", "other"))
  }

  @Test fun rejectsConflictingFraming() {
    assertThrows(IllegalArgumentException::class.java) {
      HttpCodec.readRequest(ByteArrayInputStream(
        "POST /api HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"
          .toByteArray(),
      ))
    }
  }

  @Test fun rewritesHostOriginRefererAndRemoteCookie() {
    val rewritten = GatewayPolicy.rewriteRequestHeaders(
      Headers(listOf(
        Header("Host", "127.0.0.1:4312"),
        Header("Origin", "http://127.0.0.1:4312"),
        Header("Referer", "http://127.0.0.1:4312/console/"),
        Header("Cookie", "fleet_mobile_gateway=secret"),
        Header("Connection", "keep-alive"),
      )),
      "http://127.0.0.1:4312",
      "https://fleet.example:7443",
      "fleet.example:7443",
      "fleet_pairing=remote",
      false,
    )
    assertEquals("fleet.example:7443", rewritten.first("Host"))
    assertEquals("https://fleet.example:7443", rewritten.first("Origin"))
    assertEquals("https://fleet.example:7443/console/", rewritten.first("Referer"))
    assertEquals("fleet_pairing=remote", rewritten.first("Cookie"))
    assertEquals(null, rewritten.first("Keep-Alive"))
  }

  @Test fun stripsSetCookieAndRewritesOnlyAllowedLocations() {
    val rewritten = GatewayPolicy.rewriteResponseHeaders(
      Headers(listOf(
        Header("Set-Cookie", "remote=secret"),
        Header("Location", "https://fleet.example:7443/console/?x=1"),
        Header("Content-Type", "text/html"),
      )),
      "https://fleet.example:7443",
      "http://127.0.0.1:4312",
      false,
    )
    assertTrue(rewritten.values("Set-Cookie").isEmpty())
    assertEquals("http://127.0.0.1:4312/console/?x=1", rewritten.first("Location"))
    assertThrows(IllegalArgumentException::class.java) {
      GatewayPolicy.rewriteLocation("https://foreign.example/", "https://fleet.example:7443", "http://127.0.0.1:4312")
    }
  }

  @Test fun streamsChunkedSseWithoutBufferingWholeBody() {
    val input = ByteArrayInputStream("4\r\ndata\r\n1\r\n\n\r\n0\r\n\r\n".toByteArray())
    val output = CountingOutputStream()
    HttpCodec.copyChunked(input, output, decode = true, flushEach = true)
    assertEquals("data\n", output.bytes.toString(Charsets.UTF_8))
    assertTrue(output.flushes >= 2)
  }

  @Test fun eventStreamOutlivesTheOrdinaryRequestReadTimeout() {
    val upstream = Socket().apply { soTimeout = 8_000 }
    val response = HttpResponse(
      "HTTP/1.1 200 OK",
      200,
      Headers(listOf(Header("Content-Type", "text/event-stream; charset=utf-8"))),
      BodyKind.UNTIL_CLOSE,
    )

    ResponseSocketPolicy.prepare(upstream, response)

    assertEquals(0, upstream.soTimeout)
    upstream.close()
  }

  @Test fun preservesWebSocketPathTicketAndUpgradeContract() {
    val request = HttpCodec.readRequest(ByteArrayInputStream(
      ("GET /api/v1/socket?ticket=once HTTP/1.1\r\n" +
        "Host: 127.0.0.1:4312\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Key: abc\r\nCookie: fleet_mobile_gateway=secret\r\n\r\n").toByteArray(),
    ))
    assertEquals("/api/v1/socket?ticket=once", request.target)
    assertTrue(request.isWebSocketUpgrade)
    val rewritten = GatewayPolicy.rewriteRequestHeaders(
      request.headers,
      "http://127.0.0.1:4312",
      "https://fleet.example",
      "fleet.example",
      "remote=session",
      true,
    )
    assertEquals("Upgrade", rewritten.first("Connection"))
    assertEquals("websocket", rewritten.first("Upgrade"))
    assertEquals("abc", rewritten.first("Sec-WebSocket-Key"))
  }

  @Test fun headResponseDoesNotWaitForRepresentationBody() {
    val response = HttpCodec.readResponse(ByteArrayInputStream(
      "HTTP/1.1 200 OK\r\nContent-Length: 9000\r\n\r\n".toByteArray(),
    ), "HEAD")
    assertEquals(BodyKind.NONE, response.bodyKind)
  }

  @Test fun rewritesCspToExactLocalConnectBoundary() {
    val value = GatewayPolicy.rewriteCsp(
      "default-src 'self'; connect-src 'self' ws: wss: https://api.github.com; script-src 'self'; report-uri /csp",
      "https://127.77.23.91:43871",
    )
    assertTrue(value.contains("script-src 'self'"))
    assertTrue(value.contains("connect-src 'self' https://127.77.23.91:43871 wss://127.77.23.91:43871"))
    assertFalse(value.contains("api.github.com"))
    assertFalse(value.contains("report-uri"))
  }

  @Test fun stableLoopbackOriginsAreHostScopedAndHttps() {
    val first = LoopbackIdentity("127.77.23.91", 43871)
    val restored = LoopbackIdentity(first.host, first.port)
    val candidate = LoopbackIdentity("127.88.9.11", 43872)
    assertEquals("https://127.77.23.91:43871", restored.origin)
    assertFalse(first.host == candidate.host)
  }

  @Test fun liveSameTargetGetsFreshIdentityButColdRestartReusesPersistedIdentity() {
    val activeIdentity = LoopbackIdentity("127.77.23.91", 43871)
    val active = PersistedTarget(
      "https://fleet.example", "fleet.example", 443, "Fleet", "A".repeat(64), activeIdentity,
    )
    val candidate = AccessTarget(
      "https://fleet.example", "fleet.example", 443, "Fleet", "token-token-token-1", "A".repeat(64),
    )
    val freshIdentity = LoopbackIdentity("127.88.9.11", 43872)
    assertEquals(activeIdentity, TargetStore.selectIdentity(candidate, active, false) { freshIdentity })
    assertEquals(freshIdentity, TargetStore.selectIdentity(candidate, active, true) { freshIdentity })
  }

  @Test fun cookieRollbackRestoresOldFleetCookiesAndExpiresCandidateOnlyNames() {
    val snapshot = FleetCookiePolicy.snapshot(
      "fleet_console_pairing_7443=old-pair; fleet_console_session_7443=old-session; unrelated=x",
      7443,
    )
    val headers = FleetCookiePolicy.restoreHeaders(
      snapshot,
      "fleet_console_pairing_7443=new-pair; fleet_console_session_7443=new-session; fleet_console_session_7444=candidate",
      7443,
    )
    assertFalse(headers.any { it.startsWith("fleet_console_session_7444=") })
    assertTrue(headers.any { it.startsWith("fleet_console_pairing_7443=old-pair; Max-Age=31536000") })
    assertTrue(headers.any { it.startsWith("fleet_console_session_7443=old-session; Secure") })
    assertFalse(headers.any { it.startsWith("unrelated=") })
  }

  @Test fun remoteCookiesStayWithinTheExactHostAndConsolePort() {
    val mixed = "fleet_console_session_7443=right-session; fleet_console_pairing_7443=right-pair; " +
      "fleet_console_session_7444=other-session; unrelated=x"
    assertEquals(
      "fleet_console_session_7443=right-session; fleet_console_pairing_7443=right-pair",
      FleetCookiePolicy.requestHeader(mixed, 7443),
    )

    val accepted = FleetCookiePolicy.validateSetCookieHeaders(
      listOf(
        "fleet_console_session_7443=new-session; HttpOnly; SameSite=Strict; Path=/; Secure",
        "fleet_console_pairing_7443=new-pair; Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/; Secure",
      ),
      7443,
    )
    assertEquals(2, accepted.size)
    assertThrows(IllegalArgumentException::class.java) {
      FleetCookiePolicy.validateSetCookieHeaders(
        listOf("fleet_console_session_7443=poison; Domain=.example.test; HttpOnly; SameSite=Strict; Path=/; Secure"),
        7443,
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      FleetCookiePolicy.validateSetCookieHeaders(
        listOf("fleet_console_session_7444=other; HttpOnly; SameSite=Strict; Path=/; Secure"),
        7443,
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      FleetCookiePolicy.validateSetCookieHeaders(
        listOf("fleet_console_session_7443=value; Max-Age=60; HttpOnly; SameSite=Strict; Path=/; Secure"),
        7443,
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      FleetCookiePolicy.validateSetCookieHeaders(
        listOf("fleet_console_pairing_7443=value; Max-Age; HttpOnly; SameSite=Strict; Path=/; Secure"),
        7443,
      )
    }
  }

  @Test fun localLeafMatchesOnlyExactDerAndIpSan() {
    val identity = LocalTlsIdentity.create("127.77.23.91")
    assertTrue(LocalCertificatePolicy.matches(identity.certificate, identity.certificate, "127.77.23.91"))
    assertFalse(LocalCertificatePolicy.matches(identity.certificate, identity.certificate, "127.77.23.92"))
  }

  @Test fun validatesWebSocketAcceptAndPreservesNegotiationHeaders() {
    val headers = Headers(listOf(
      Header("Connection", "Upgrade"),
      Header("Upgrade", "websocket"),
      Header("Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
      Header("Sec-WebSocket-Protocol", "fleet"),
      Header("Sec-WebSocket-Extensions", "permessage-deflate"),
    ))
    assertTrue(GatewayPolicy.validWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==", headers))
    val rewritten = GatewayPolicy.rewriteResponseHeaders(headers, "https://fleet.example", "https://127.77.23.91:43871", true)
    assertEquals("fleet", rewritten.first("Sec-WebSocket-Protocol"))
    assertEquals("permessage-deflate", rewritten.first("Sec-WebSocket-Extensions"))
  }

  @Test fun rawRelayDoesNotParseWebSocketFrames() {
    val bytes = byteArrayOf(0x82.toByte(), 0x7f, 0, 1, 2, 3, 4, 5)
    val output = ByteArrayOutputStream()
    HttpCodec.copyUntilEof(ByteArrayInputStream(bytes), output, true)
    assertTrue(bytes.contentEquals(output.toByteArray()))
  }

  @Test fun closedClientDuringErrorResponseDoesNotEscapeGatewayWorker() {
    val closedOutput = object : OutputStream() {
      override fun write(value: Int) { throw IOException("Socket is closed") }
    }

    GatewayErrorResponse.write(closedOutput, 400, "Bad request")
  }

  @Test fun localWebSocketEofClosesSilentUpstreamAndReleasesRelay() {
    val localServer = ServerSocket(0)
    val upstreamServer = ServerSocket(0)
    val localPeer = Socket("127.0.0.1", localServer.localPort)
    val client = localServer.accept()
    val upstream = Socket("127.0.0.1", upstreamServer.localPort)
    val upstreamPeer = upstreamServer.accept()
    val workers = Executors.newCachedThreadPool()
    val relay = Executors.newSingleThreadExecutor()
    val closed = mutableSetOf<Socket>()
    val future = relay.submit {
      BidirectionalRelay.run(
        client,
        client.getInputStream(),
        upstream.getInputStream(),
        client.getOutputStream(),
        upstream,
        workers,
      ) { socket ->
        synchronized(closed) { closed += socket }
        try { socket.close() } catch (_: Exception) { }
      }
    }
    try {
      localPeer.shutdownOutput()
      future.get(2, TimeUnit.SECONDS)
      assertTrue(client.isClosed)
      assertTrue(upstream.isClosed)
      synchronized(closed) {
        assertTrue(client in closed)
        assertTrue(upstream in closed)
      }
    } finally {
      localPeer.close()
      upstreamPeer.close()
      localServer.close()
      upstreamServer.close()
      workers.shutdownNow()
      relay.shutdownNow()
    }
  }

  private class CountingOutputStream : ByteArrayOutputStream() {
    var flushes = 0
    val bytes: ByteArray get() = toByteArray()
    override fun flush() { flushes += 1 }
  }
}
