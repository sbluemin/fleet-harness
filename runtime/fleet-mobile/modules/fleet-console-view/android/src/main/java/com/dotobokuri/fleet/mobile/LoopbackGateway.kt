package com.dotobokuri.fleet.mobile

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLSocket

internal class LoopbackGateway(
  private val target: PersistedTarget,
  private val remote: RemoteConnection,
  private val cookies: FleetCookieStore,
) : AutoCloseable {
  private val localTls = LocalTlsIdentity.create(target.loopback.host)
  private val running = AtomicBoolean(false)
  private val permits = Semaphore(MAX_CONNECTIONS)
  private val activeSockets = ConcurrentHashMap.newKeySet<Socket>()
  private val workers: ExecutorService = Executors.newCachedThreadPool { task ->
    Thread(task, "fleet-mobile-gateway-client").apply { isDaemon = true }
  }
  private var server: ServerSocket? = null
  private var acceptThread: Thread? = null
  val secret: String = ByteArray(32).also(SecureRandom()::nextBytes).let {
    Base64.getUrlEncoder().withoutPadding().encodeToString(it)
  }
  val port: Int get() = target.loopback.port
  val host: String get() = target.loopback.host
  val origin: String get() = target.loopback.origin
  val consoleUrl: String get() = "$origin/console/"
  val localCertificate: X509Certificate get() = localTls.certificate

  fun start() {
    check(running.compareAndSet(false, true))
    try {
      server = (localTls.context.serverSocketFactory.createServerSocket() as SSLServerSocket).apply {
        bind(InetSocketAddress(InetAddress.getByName(host), port), MAX_CONNECTIONS)
        enabledProtocols = supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
      }
      acceptThread = Thread(::acceptLoop, "fleet-mobile-gateway-accept").apply {
        isDaemon = true
        start()
      }
    } catch (failure: Exception) {
      running.set(false)
      throw failure
    }
  }

  fun installLocalCookie() {
    cookies.applyAndAwait(
      origin,
      listOf("$COOKIE_NAME=$secret; HttpOnly; Secure; SameSite=Strict; Path=/"),
    )
  }

  private fun acceptLoop() {
    while (running.get()) {
      val client = try { server?.accept() ?: break } catch (_: Exception) { break }
      if (!permits.tryAcquire()) {
        client.use { writeError(it, 503, "Gateway busy") }
        continue
      }
      activeSockets += client
      if (!running.get()) {
        closeSocket(client)
        permits.release()
        continue
      }
      try {
        workers.execute {
          try {
            handle(client)
          } catch (_: Exception) {
            // A client disconnect must never escape a gateway worker and terminate the app process.
          } finally {
            closeSocket(client)
            permits.release()
          }
        }
      } catch (_: RejectedExecutionException) {
        closeSocket(client)
        permits.release()
      }
    }
  }

  private fun handle(client: Socket) {
    client.soTimeout = SOCKET_TIMEOUT_MS
    val input = BufferedInputStream(client.getInputStream())
    val output = BufferedOutputStream(client.getOutputStream())
    val request = try { HttpCodec.readRequest(input) } catch (_: Exception) {
      writeError(output, 400, "Bad request")
      return
    }
    val expectedHost = "$host:$port"
    if (request.host != expectedHost || !request.hasCookie(COOKIE_NAME, secret)) {
      writeError(output, 403, "Forbidden")
      return
    }
    if (request.method == "CONNECT" || request.target.startsWith("http://") || request.target.startsWith("https://") ||
      !request.target.startsWith("/") || request.target.startsWith("//")) {
      writeError(output, 400, "Bad request")
      return
    }
    val websocket = request.isWebSocketUpgrade
    val websocketKey = if (websocket) request.headers.first("Sec-WebSocket-Key")?.takeIf(String::isNotBlank) else null
    if (websocket && websocketKey == null) {
      writeError(output, 400, "Bad WebSocket request")
      return
    }
    val upstream = try { remote.openPinnedSocket(target) } catch (_: Exception) {
      writeError(output, 502, "Bad gateway")
      return
    }
    activeSockets += upstream
    if (!running.get()) {
      closeSocket(upstream)
      return
    }
    try {
      relayRequest(request, input, upstream, websocket)
      relayResponse(client, input, upstream, output, request.method, websocket, websocketKey)
    } catch (_: Exception) {
      if (!client.isClosed) {
        try { writeError(output, 502, "Bad gateway") } catch (_: Exception) { }
      }
    } finally {
      closeSocket(upstream)
    }
  }

  private fun relayRequest(request: HttpRequest, localInput: InputStream, upstream: SSLSocket, websocket: Boolean) {
    val output = BufferedOutputStream(upstream.outputStream)
    val remoteCookie = cookies.readRemote(target.origin, target.port)
    var rewritten = GatewayPolicy.rewriteRequestHeaders(
      request.headers,
      origin,
      target.origin,
      target.authority,
      remoteCookie,
      websocket,
    )
    if (request.bodyKind == BodyKind.CHUNKED) {
      rewritten = Headers(rewritten.entries + Header("Transfer-Encoding", "chunked"))
    }
    HttpCodec.writeHead(output, "${request.method} ${request.target} HTTP/1.1", rewritten)
    when (request.bodyKind) {
      BodyKind.NONE -> output.flush()
      is BodyKind.FIXED -> {
        HttpCodec.copyExactly(localInput, output, request.bodyKind.length)
        output.flush()
      }
      BodyKind.CHUNKED -> {
        HttpCodec.copyChunked(localInput, output, decode = false)
        output.flush()
      }
      BodyKind.UNTIL_CLOSE -> throw IllegalArgumentException("request_body_until_close")
    }
  }

  private fun relayResponse(
    client: Socket,
    localInput: InputStream,
    upstream: SSLSocket,
    localOutput: BufferedOutputStream,
    requestMethod: String,
    websocket: Boolean,
    websocketKey: String?,
  ) {
    val input = BufferedInputStream(upstream.inputStream)
    val response = HttpCodec.readResponse(input, requestMethod)
    if (response.code in 300..399) {
      writeError(localOutput, 502, "Remote redirect refused")
      return
    }
    if (websocket && response.code == 101 && !GatewayPolicy.validWebSocketAccept(websocketKey!!, response.headers)) {
      writeError(localOutput, 502, "Bad WebSocket handshake")
      return
    }
    val setCookies = response.headers.values("Set-Cookie")
    if (setCookies.isNotEmpty()) cookies.applyRemoteAndAwait(target.origin, target.port, setCookies)
    val rewritten = try {
      GatewayPolicy.rewriteResponseHeaders(response.headers, target.origin, origin, websocket && response.code == 101)
    } catch (_: IllegalArgumentException) {
      writeError(localOutput, 502, "Bad gateway")
      return
    }
    HttpCodec.writeHead(localOutput, response.statusLine, rewritten)
    localOutput.flush()
    if (websocket && response.code == 101) {
      client.soTimeout = 0
      upstream.soTimeout = 0
      relayBidirectionally(client, localInput, input, localOutput, upstream)
      return
    }
    ResponseSocketPolicy.prepare(upstream, response)
    when (response.bodyKind) {
      BodyKind.NONE -> Unit
      is BodyKind.FIXED -> HttpCodec.copyExactly(input, localOutput, response.bodyKind.length, flushEach = response.isEventStream)
      BodyKind.CHUNKED -> HttpCodec.copyChunked(input, localOutput, decode = false, flushEach = response.isEventStream)
      BodyKind.UNTIL_CLOSE -> HttpCodec.copyUntilEof(input, localOutput, response.isEventStream)
    }
    localOutput.flush()
  }

  private fun relayBidirectionally(
    client: Socket,
    localInput: InputStream,
    upstreamInput: InputStream,
    localOutput: OutputStream,
    upstream: SSLSocket,
  ) {
    BidirectionalRelay.run(
      client,
      localInput,
      upstreamInput,
      localOutput,
      upstream,
      workers,
      ::closeSocket,
    )
  }

  override fun close() {
    if (!running.compareAndSet(true, false)) return
    try { server?.close() } catch (_: Exception) { }
    acceptThread?.interrupt()
    activeSockets.toList().forEach(::closeSocket)
    workers.shutdownNow()
  }

  private fun closeSocket(socket: Socket) {
    activeSockets -= socket
    try { socket.close() } catch (_: Exception) { }
  }

  private fun writeError(socket: Socket, code: Int, reason: String) {
    try {
      writeError(BufferedOutputStream(socket.getOutputStream()), code, reason)
    } catch (_: Exception) {
      // The peer may already be gone; the error response is best-effort only.
    }
  }

  private fun writeError(output: OutputStream, code: Int, reason: String) {
    GatewayErrorResponse.write(output, code, reason)
  }

  private companion object {
    const val COOKIE_NAME = "fleet_mobile_gateway"
    const val MAX_CONNECTIONS = 16
    const val SOCKET_TIMEOUT_MS = 30_000
  }
}

internal object ResponseSocketPolicy {
  fun prepare(upstream: Socket, response: HttpResponse) {
    if (response.isEventStream) upstream.soTimeout = 0
  }
}

internal object GatewayErrorResponse {
  fun write(output: OutputStream, code: Int, reason: String) {
    try {
      val body = "$reason\n".toByteArray(Charsets.UTF_8)
      HttpCodec.writeHead(
        output,
        "HTTP/1.1 $code $reason",
        Headers(listOf(
          Header("Content-Type", "text/plain; charset=utf-8"),
          Header("Content-Length", body.size.toString()),
          Header("Cache-Control", "no-store"),
          Header("Connection", "close"),
        )),
      )
      output.write(body)
      output.flush()
    } catch (_: Exception) {
      // A closed TLS socket cannot receive an error body and must not crash the process.
    }
  }
}

internal object BidirectionalRelay {
  fun run(
    client: Socket,
    localInput: InputStream,
    upstreamInput: InputStream,
    localOutput: OutputStream,
    upstream: Socket,
    workers: ExecutorService,
    closeSocket: (Socket) -> Unit,
  ) {
    val toRemote = workers.submit {
      try {
        HttpCodec.copyUntilEof(localInput, upstream.outputStream, true)
      } catch (_: Exception) { } finally {
        closeSocket(client)
        closeSocket(upstream)
      }
    }
    try {
      HttpCodec.copyUntilEof(upstreamInput, localOutput, true)
    } catch (_: Exception) { } finally {
      closeSocket(client)
      closeSocket(upstream)
      toRemote.cancel(true)
    }
  }
}

internal data class LocalTlsIdentity(val context: SSLContext, val certificate: X509Certificate) {
  companion object {
    fun create(host: String, now: Date = Date()): LocalTlsIdentity {
      val keys = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
      val subject = X500Name("CN=$host")
      val notBefore = Date(now.time - 60_000)
      val notAfter = Date(now.time + 24 * 60 * 60 * 1000L)
      val certificate = JcaX509CertificateConverter().getCertificate(
        JcaX509v3CertificateBuilder(
          subject,
          BigInteger(160, SecureRandom()),
          notBefore,
          notAfter,
          subject,
          keys.public,
        )
          .addExtension(Extension.basicConstraints, true, BasicConstraints(false))
          .addExtension(Extension.subjectAlternativeName, false, GeneralNames(GeneralName(GeneralName.iPAddress, host)))
          .build(JcaContentSignerBuilder("SHA256withECDSA").build(keys.private)),
      ).apply { verify(keys.public) }
      val password = ByteArray(32).also(SecureRandom()::nextBytes).let { Base64.getEncoder().encodeToString(it).toCharArray() }
      val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null)
        setKeyEntry("loopback", keys.private, password, arrayOf(certificate))
      }
      val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
      val context = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, SecureRandom()) }
      return LocalTlsIdentity(context, certificate)
    }
  }
}

internal object LocalCertificatePolicy {
  fun matches(presented: X509Certificate, expected: X509Certificate, host: String, now: Date = Date()): Boolean = try {
    presented.checkValidity(now)
    presented.basicConstraints < 0 && presented.encoded.contentEquals(expected.encoded) &&
      CertificatePolicy.hasExactSubjectAlternativeName(presented, host)
  } catch (_: Exception) { false }
}

internal val PersistedTarget.authority: String
  get() {
    val host = if (hostname.contains(':')) "[$hostname]" else hostname
    return if (port == 443) host else "$host:$port"
  }

internal data class Header(val name: String, val value: String)
internal data class Headers(val entries: List<Header>) {
  fun values(name: String): List<String> = entries.filter { it.name.equals(name, true) }.map(Header::value)
  fun first(name: String): String? = values(name).firstOrNull()
  fun containsToken(name: String, token: String): Boolean = values(name).flatMap { it.split(',') }
    .any { it.trim().equals(token, true) }
}

internal sealed interface BodyKind {
  data object NONE : BodyKind
  data class FIXED(val length: Long) : BodyKind
  data object CHUNKED : BodyKind
  data object UNTIL_CLOSE : BodyKind
}

internal data class HttpRequest(
  val method: String,
  val target: String,
  val headers: Headers,
  val bodyKind: BodyKind,
) {
  val host: String? get() = headers.first("Host")
  val isWebSocketUpgrade: Boolean get() = method == "GET" && headers.containsToken("Connection", "upgrade") &&
    headers.first("Upgrade")?.equals("websocket", true) == true
  fun hasCookie(name: String, expected: String): Boolean = headers.values("Cookie").flatMap { it.split(';') }.any {
    val pair = it.trim().split('=', limit = 2)
    pair.size == 2 && pair[0] == name && pair[1] == expected
  }
}

internal data class HttpResponse(
  val statusLine: String,
  val code: Int,
  val headers: Headers,
  val bodyKind: BodyKind,
) {
  val isEventStream: Boolean get() = headers.first("Content-Type")?.substringBefore(';')?.trim()
    ?.equals("text/event-stream", true) == true
}

internal object GatewayPolicy {
  private val fixedHopByHop = setOf(
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  )

  fun rewriteRequestHeaders(
    headers: Headers,
    localOrigin: String,
    remoteOrigin: String,
    remoteAuthority: String,
    remoteCookie: String?,
    websocket: Boolean,
  ): Headers {
    val nominated = connectionNominations(headers)
    val omitted = fixedHopByHop + nominated + setOf("host", "cookie")
    val result = headers.entries.filterNot { it.name.lowercase(Locale.ROOT) in omitted }.map { header ->
      when {
        header.name.equals("Origin", true) && header.value == localOrigin -> Header(header.name, remoteOrigin)
        header.name.equals("Referer", true) -> Header(header.name, rewriteReferer(header.value, localOrigin, remoteOrigin))
        else -> header
      }
    }.toMutableList()
    result += Header("Host", remoteAuthority)
    if (remoteCookie != null) result += Header("Cookie", remoteCookie)
    if (websocket) {
      result += Header("Connection", "Upgrade")
      result += Header("Upgrade", "websocket")
    }
    return Headers(result)
  }

  fun rewriteResponseHeaders(headers: Headers, remoteOrigin: String, localOrigin: String, websocket: Boolean): Headers {
    val nominated = connectionNominations(headers)
    val omitted = fixedHopByHop + nominated + setOf("set-cookie", "transfer-encoding")
    val result = headers.entries.filterNot { it.name.lowercase(Locale.ROOT) in omitted }.map { header ->
      when {
        header.name.equals("Location", true) -> Header(header.name, rewriteLocation(header.value, remoteOrigin, localOrigin))
        header.name.equals("Content-Security-Policy", true) -> Header(header.name, rewriteCsp(header.value, localOrigin))
        else -> header
      }
    }.toMutableList()
    if (result.none { it.name.equals("Content-Security-Policy", true) }) {
      result += Header("Content-Security-Policy", rewriteCsp("default-src 'self'", localOrigin))
    }
    if (websocket) {
      result += Header("Connection", "Upgrade")
      result += Header("Upgrade", "websocket")
    } else {
      if (headers.containsToken("Transfer-Encoding", "chunked")) result += Header("Transfer-Encoding", "chunked")
      result += Header("Connection", "close")
    }
    return Headers(result)
  }

  fun validWebSocketAccept(key: String, headers: Headers): Boolean {
    val expected = Base64.getEncoder().encodeToString(
      MessageDigest.getInstance("SHA-1").digest((key.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.ISO_8859_1)),
    )
    return headers.first("Upgrade")?.equals("websocket", true) == true &&
      headers.containsToken("Connection", "upgrade") && headers.first("Sec-WebSocket-Accept") == expected
  }

  fun rewriteCsp(value: String, localOrigin: String): String {
    val authority = URI(localOrigin).rawAuthority
    val directives = value.split(';').map(String::trim).filter(String::isNotEmpty)
      .filterNot {
        val name = it.substringBefore(' ').lowercase(Locale.ROOT)
        name == "connect-src" || name == "report-uri" || name == "report-to"
      }.toMutableList()
    directives += "connect-src 'self' https://$authority wss://$authority"
    return directives.joinToString("; ")
  }

  fun rewriteLocation(value: String, remoteOrigin: String, localOrigin: String): String {
    if (value.startsWith("/") && !value.startsWith("//")) return localOrigin + value
    val uri = try { URI(value) } catch (_: Exception) { throw IllegalArgumentException("invalid_location") }
    if (uri.isAbsolute && originOf(uri) == remoteOrigin) {
      val suffix = buildString {
        append(uri.rawPath.ifEmpty { "/" })
        uri.rawQuery?.let { append('?').append(it) }
        uri.rawFragment?.let { append('#').append(it) }
      }
      return localOrigin + suffix
    }
    throw IllegalArgumentException("foreign_location")
  }

  private fun rewriteReferer(value: String, localOrigin: String, remoteOrigin: String): String {
    if (value == localOrigin) return remoteOrigin
    if (value.startsWith("$localOrigin/")) return remoteOrigin + value.removePrefix(localOrigin)
    return value
  }

  private fun connectionNominations(headers: Headers): Set<String> = headers.values("Connection")
    .flatMap { it.split(',') }.map { it.trim().lowercase(Locale.ROOT) }.filter(String::isNotEmpty).toSet()

  private fun originOf(uri: URI): String {
    if (uri.scheme != "https" || uri.rawUserInfo != null || uri.host == null) throw IllegalArgumentException("invalid_location")
    val port = if (uri.port == -1) 443 else uri.port
    val host = if (uri.host.contains(':')) "[${uri.host}]" else uri.host
    return if (port == 443) "https://$host" else "https://$host:$port"
  }
}

internal object HttpCodec {
  private const val MAX_HEADER_BYTES = 64 * 1024
  private const val MAX_LINE_BYTES = 8 * 1024

  fun readRequest(input: InputStream): HttpRequest {
    val lines = readHead(input)
    val parts = lines.first().split(' ')
    if (parts.size != 3 || parts[2] != "HTTP/1.1" || !parts[0].matches(Regex("^[A-Z]+$"))) throw IllegalArgumentException("bad_request_line")
    val headers = parseHeaders(lines.drop(1))
    if (headers.values("Host").size != 1) throw IllegalArgumentException("bad_host")
    return HttpRequest(parts[0], parts[1], headers, requestBodyKind(headers))
  }

  fun readResponse(input: InputStream, requestMethod: String = "GET"): HttpResponse {
    val lines = readHead(input)
    val match = Regex("^HTTP/1\\.[01] ([0-9]{3})(?: .*)?$").matchEntire(lines.first())
      ?: throw IllegalArgumentException("bad_status_line")
    val code = match.groupValues[1].toInt()
    val headers = parseHeaders(lines.drop(1))
    val body = when {
      requestMethod == "HEAD" || code in 100..199 || code == 204 || code == 304 -> BodyKind.NONE
      headers.containsToken("Transfer-Encoding", "chunked") -> BodyKind.CHUNKED
      headers.first("Content-Length") != null -> BodyKind.FIXED(contentLength(headers))
      else -> BodyKind.UNTIL_CLOSE
    }
    validateFraming(headers)
    return HttpResponse(lines.first(), code, headers, body)
  }

  fun writeHead(output: OutputStream, startLine: String, headers: Headers) {
    output.write("$startLine\r\n".toByteArray(Charsets.ISO_8859_1))
    headers.entries.forEach { output.write("${it.name}: ${it.value}\r\n".toByteArray(Charsets.ISO_8859_1)) }
    output.write("\r\n".toByteArray(Charsets.ISO_8859_1))
  }

  fun copyExactly(input: InputStream, output: OutputStream, length: Long, flushEach: Boolean = false) {
    var remaining = length
    val buffer = ByteArray(16 * 1024)
    while (remaining > 0) {
      val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
      if (count < 0) throw EOFException()
      output.write(buffer, 0, count)
      if (flushEach) output.flush()
      remaining -= count
    }
  }

  fun copyUntilEof(input: InputStream, output: OutputStream, flushEach: Boolean) {
    val buffer = ByteArray(16 * 1024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) return
      output.write(buffer, 0, count)
      if (flushEach) output.flush()
    }
  }

  fun copyChunked(input: InputStream, output: OutputStream, decode: Boolean, flushEach: Boolean = false) {
    while (true) {
      val sizeLine = readLine(input, MAX_LINE_BYTES)
      val size = sizeLine.substringBefore(';').trim().toLongOrNull(16) ?: throw IllegalArgumentException("bad_chunk")
      if (size < 0) throw IllegalArgumentException("bad_chunk")
      if (!decode) output.write("$sizeLine\r\n".toByteArray(Charsets.ISO_8859_1))
      if (size == 0L) {
        while (true) {
          val trailer = readLine(input, MAX_LINE_BYTES)
          if (!decode) output.write("$trailer\r\n".toByteArray(Charsets.ISO_8859_1))
          if (trailer.isEmpty()) break
        }
        return
      }
      copyExactly(input, output, size, flushEach)
      if (readLine(input, 2).isNotEmpty()) throw IllegalArgumentException("bad_chunk")
      if (!decode) output.write("\r\n".toByteArray(Charsets.ISO_8859_1))
    }
  }

  private fun requestBodyKind(headers: Headers): BodyKind {
    validateFraming(headers)
    return when {
      headers.containsToken("Transfer-Encoding", "chunked") -> BodyKind.CHUNKED
      headers.first("Content-Length") != null -> BodyKind.FIXED(contentLength(headers))
      else -> BodyKind.NONE
    }
  }

  private fun validateFraming(headers: Headers) {
    val lengths = headers.values("Content-Length")
    if (lengths.distinct().size > 1 || lengths.any { it.toLongOrNull() == null || it.toLong() < 0 }) throw IllegalArgumentException("bad_length")
    val encodings = headers.values("Transfer-Encoding").flatMap { it.split(',') }.map { it.trim().lowercase(Locale.ROOT) }
    if (lengths.isNotEmpty() && encodings.isNotEmpty()) throw IllegalArgumentException("conflicting_framing")
    if (encodings.isNotEmpty() && encodings != listOf("chunked")) throw IllegalArgumentException("bad_transfer_encoding")
  }

  private fun contentLength(headers: Headers): Long = headers.first("Content-Length")!!.toLong()

  private fun readHead(input: InputStream): List<String> {
    val lines = mutableListOf<String>()
    var total = 0
    while (true) {
      val line = readLine(input, MAX_LINE_BYTES)
      total += line.toByteArray(Charsets.ISO_8859_1).size + 2
      if (total > MAX_HEADER_BYTES) throw IllegalArgumentException("headers_too_large")
      if (line.isEmpty()) break
      lines += line
    }
    if (lines.isEmpty()) throw IllegalArgumentException("empty_head")
    return lines
  }

  private fun parseHeaders(lines: List<String>): Headers = Headers(lines.map { line ->
    if (line.startsWith(' ') || line.startsWith('\t')) throw IllegalArgumentException("folded_header")
    val separator = line.indexOf(':')
    if (separator <= 0) throw IllegalArgumentException("bad_header")
    val name = line.substring(0, separator)
    val value = line.substring(separator + 1).trim()
    if (!name.matches(Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")) || value.any { it.code == 0 || it == '\r' || it == '\n' }) {
      throw IllegalArgumentException("bad_header")
    }
    Header(name, value)
  })

  private fun readLine(input: InputStream, limit: Int): String {
    val bytes = ArrayList<Byte>()
    while (bytes.size <= limit) {
      val value = input.read()
      if (value < 0) throw EOFException()
      if (value == '\r'.code) {
        if (input.read() != '\n'.code) throw IllegalArgumentException("bad_line_ending")
        return bytes.toByteArray().toString(Charsets.ISO_8859_1)
      }
      if (value == '\n'.code) throw IllegalArgumentException("bad_line_ending")
      bytes += value.toByte()
    }
    throw IllegalArgumentException("line_too_large")
  }
}
