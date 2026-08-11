package com.dotobokuri.fleet.mobile

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

internal class RemoteConnection(
  private val cookies: FleetCookieStore = FleetCookieStore(),
) {
  fun preflight(target: PersistedTarget) {
    openPinnedSocket(target).use { }
  }

  fun openPinnedSocket(target: PersistedTarget): SSLSocket {
    val trust = StrictPinnedTrustManager(target)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val socket = context.socketFactory.createSocket() as SSLSocket
    try {
      socket.soTimeout = TIMEOUT_MS
      socket.enabledProtocols = socket.supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
      socket.connect(InetSocketAddress(target.hostname, target.port), TIMEOUT_MS)
      val parameters = socket.sslParameters
      // A raw TLS socket sends no ALPN offer, so the upstream cannot select HTTP/2.
      parameters.endpointIdentificationAlgorithm = "HTTPS"
      if (!CertificatePolicy.isIpLiteral(target.hostname)) {
        parameters.serverNames = listOf(javax.net.ssl.SNIHostName(target.hostname))
      }
      socket.sslParameters = parameters
      socket.startHandshake()
      val certificate = socket.session.peerCertificates.firstOrNull() as? X509Certificate
        ?: throw ConnectionFailure("remote_link_unverified")
      CertificatePolicy.verifyLeaf(certificate, target)
      return socket
    } catch (failure: ConnectionFailure) {
      try { socket.close() } catch (_: Exception) { }
      throw failure
    } catch (failure: Exception) {
      try { socket.close() } catch (_: Exception) { }
      throw mappedTlsFailure(failure)
    }
  }

  fun join(target: PersistedTarget, token: String?, deviceName: String) {
    request(
      target = target,
      url = target.joinUrl,
      method = "POST",
      body = JSONObject().apply {
        if (token != null) put("token", token)
        put("device", deviceName)
      }.toString(),
    ).use { response ->
      when (response.code) {
        in 200..299 -> Unit
        401 -> throw ConnectionFailure(if (token == null) "remote_host_not_paired" else "remote_link_rejected")
        403 -> throw ConnectionFailure("remote_link_host_mismatch")
        409 -> throw ConnectionFailure(
          if (response.errorCode() == "paired_device_limit") "remote_link_device_limit" else "remote_link_control_held",
        )
        // The join guard rejects these before reading the body, so even a valid token is refused
        // until Retry-After passes; they are wait states, not identity failures.
        429 -> throw ConnectionFailure("remote_link_throttled", retryAfterSeconds = response.retryAfterSeconds())
        503 -> throw ConnectionFailure("remote_host_busy", retryAfterSeconds = response.retryAfterSeconds())
        else -> throw ConnectionFailure("remote_link_unverified")
      }
    }
  }

  fun verifyReachable(target: PersistedTarget) {
    request(target, target.readinessUrl, "GET", null).use { response ->
      if (response.code == 401) throw ConnectionFailure("remote_host_session_expired")
      if (response.code !in 200..299 || !response.isConsoleStatus()) {
        throw ConnectionFailure("remote_host_unavailable")
      }
    }
  }

  private fun request(target: PersistedTarget, url: String, method: String, body: String?): Response {
    requireExpectedAuthority(target, url)
    val connection = URL(url).openConnection() as? HttpsURLConnection
      ?: throw ConnectionFailure("remote_link_unverified")
    connection.instanceFollowRedirects = false
    connection.connectTimeout = TIMEOUT_MS
    connection.readTimeout = TIMEOUT_MS
    connection.requestMethod = method
    connection.sslSocketFactory = SSLContext.getInstance("TLS").apply {
      init(null, arrayOf(StrictPinnedTrustManager(target)), null)
    }.socketFactory
    connection.hostnameVerifier = StrictHostnameVerifier(target)
    connection.setRequestProperty("Accept", "application/json")
    // CookieManager is the only cookie store. Read at the last possible moment for every request.
    cookies.readRemote(url, target.port)?.let { connection.setRequestProperty("Cookie", it) }
    if (body != null) {
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    }
    val code = try {
      connection.responseCode
    } catch (failure: Exception) {
      connection.disconnect()
      throw mappedTlsFailure(failure)
    }
    if (code in 300..399) {
      connection.disconnect()
      throw ConnectionFailure("remote_link_redirect_refused")
    }
    try {
      cookies.applyRemoteAndAwait(url, target.port, setCookieHeaders(connection))
    } catch (failure: Exception) {
      connection.disconnect()
      throw ConnectionFailure("remote_link_cookie_failed", failure)
    }
    return Response(connection, code)
  }

  private fun requireExpectedAuthority(target: PersistedTarget, value: String) {
    val uri = try { URI(value) } catch (_: Exception) { throw ConnectionFailure("remote_link_unverified") }
    val port = if (uri.port == -1) 443 else uri.port
    if (uri.scheme != "https" || uri.rawUserInfo != null || uri.rawFragment != null ||
      !uri.host.equals(target.hostname, ignoreCase = true) || port != target.port) {
      throw ConnectionFailure("remote_link_host_mismatch")
    }
    val renderedHost = if (target.hostname.contains(':')) "[${target.hostname}]" else target.hostname
    val expectedOrigin = if (target.port == 443) "https://$renderedHost" else "https://$renderedHost:${target.port}"
    if (target.origin != expectedOrigin) throw ConnectionFailure("remote_link_host_mismatch")
  }

  private fun setCookieHeaders(connection: HttpsURLConnection): List<String> = connection.headerFields.entries
    .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
    .flatMap { it.value.orEmpty() }

  private fun mappedTlsFailure(failure: Exception): ConnectionFailure {
    var current: Throwable? = failure
    while (current != null) {
      when (current.message) {
        "certificate_pin_mismatch" -> return ConnectionFailure("remote_link_fingerprint_mismatch", failure)
        "certificate_hostname_mismatch",
        "certificate_expired",
        "certificate_not_yet_valid",
        "certificate_not_leaf",
        "missing_leaf_certificate" -> return ConnectionFailure("remote_link_unverified", failure)
      }
      current = current.cause
    }
    return ConnectionFailure("remote_link_unreachable", failure)
  }

  private class Response(private val connection: HttpsURLConnection, val code: Int) : AutoCloseable {
    private fun body(): String? {
      val stream = if (code >= HttpURLConnection.HTTP_BAD_REQUEST) connection.errorStream else connection.inputStream
      return try { stream?.bufferedReader()?.use { it.readText() } } catch (_: Exception) { null }
    }

    fun errorCode(): String? = try {
      body()?.let { JSONObject(it).optString("error").takeIf(String::isNotEmpty) }
    } catch (_: Exception) { null }

    fun retryAfterSeconds(): Int? = RetryAfterHeader.seconds(connection.getHeaderField("Retry-After"))

    fun isConsoleStatus(): Boolean = try {
      val value = JSONObject(body() ?: return false)
      value.getString("name").isNotEmpty() && value.getString("version").isNotEmpty()
    } catch (_: Exception) { false }

    override fun close() { connection.disconnect() }
  }

  private class StrictPinnedTrustManager(private val target: PersistedTarget) : X509TrustManager {
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      throw CertificateException("client_certificates_not_accepted")
    }
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull() ?: throw CertificateException("missing_leaf_certificate")
      CertificatePolicy.verifyLeaf(leaf, target)
    }
  }

  private class StrictHostnameVerifier(private val target: PersistedTarget) : HostnameVerifier {
    override fun verify(hostname: String?, session: SSLSession?): Boolean {
      if (hostname == null || session == null || !hostname.equals(target.hostname, ignoreCase = true)) return false
      val leaf = session.peerCertificates.firstOrNull() as? X509Certificate ?: return false
      return try {
        CertificatePolicy.verifyLeaf(leaf, target)
        true
      } catch (_: Exception) {
        false
      }
    }
  }

  companion object {
    private const val TIMEOUT_MS = 8_000

    fun fingerprint(certificate: X509Certificate): String = MessageDigest.getInstance("SHA-256")
      .digest(certificate.encoded)
      .joinToString("") { "%02X".format(Locale.ROOT, it.toInt() and 0xff) }
  }
}

internal data class FleetCookieSnapshot(val values: Map<String, String>)

internal object FleetCookiePolicy {
  private val valuePattern = Regex("^[A-Za-z0-9_-]*$")

  fun requestHeader(header: String?, port: Int): String? = scoped(header, port)
    .also { require(it.values.all(valuePattern::matches)) }
    .entries
    .joinToString("; ") { (name, value) -> "$name=$value" }
    .takeIf(String::isNotEmpty)

  fun snapshot(header: String?, port: Int): FleetCookieSnapshot = FleetCookieSnapshot(
    scoped(header, port).also { require(it.values.all(valuePattern::matches)) },
  )

  fun restoreHeaders(snapshot: FleetCookieSnapshot, currentHeader: String?, port: Int): List<String> {
    val currentNames = scoped(currentHeader, port).keys
    val expired = (currentNames - snapshot.values.keys).map {
      "$it=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"
    }
    val restored = snapshot.values.map { (name, value) ->
      val maxAge = if (name == pairingName(port)) "; Max-Age=31536000" else ""
      "$name=$value$maxAge; Secure; HttpOnly; SameSite=Strict; Path=/"
    }
    return expired + restored
  }

  fun validateSetCookieHeaders(values: List<String>, port: Int): List<String> {
    val seen = mutableSetOf<String>()
    return values.map { value ->
      val parts = value.split(';').map(String::trim)
      val pair = parts.firstOrNull()?.split('=', limit = 2).orEmpty()
      require(pair.size == 2 && pair[0] in names(port) && seen.add(pair[0]) && valuePattern.matches(pair[1]))
      val attributes = linkedMapOf<String, String?>()
      parts.drop(1).forEach { raw ->
        val attribute = raw.split('=', limit = 2)
        val name = attribute[0].lowercase(Locale.ROOT)
        require(name in setOf("httponly", "secure", "samesite", "path", "max-age") && name !in attributes)
        attributes[name] = attribute.getOrNull(1)
      }
      require(attributes["httponly"] == null && "httponly" in attributes)
      require(attributes["secure"] == null && "secure" in attributes)
      require(attributes["samesite"]?.equals("Strict", ignoreCase = true) == true)
      require(attributes["path"] == "/")
      val maxAge = attributes["max-age"]
      require("max-age" !in attributes || maxAge?.toLongOrNull()?.let { it >= 0 } == true)
      require(maxAge == null || pair[0] == pairingName(port))
      require(pair[1].isNotEmpty() || maxAge == "0")
      buildString {
        append(pair[0]).append('=').append(pair[1])
        if (maxAge != null) append("; Max-Age=").append(maxAge)
        append("; Secure; HttpOnly; SameSite=Strict; Path=/")
      }
    }
  }

  private fun names(port: Int): Set<String> = setOf(sessionName(port), pairingName(port))
  private fun sessionName(port: Int): String = "fleet_console_session_$port"
  private fun pairingName(port: Int): String = "fleet_console_pairing_$port"

  private fun scoped(header: String?, port: Int): Map<String, String> {
    val pairs = parse(header).filter { it.first in names(port) }
    require(pairs.map { it.first }.distinct().size == pairs.size)
    return pairs.toMap()
  }

  private fun parse(header: String?): List<Pair<String, String>> = header.orEmpty().split(';').mapNotNull {
    val pair = it.trim().split('=', limit = 2)
    if (pair.size == 2 && pair[0].isNotEmpty()) pair[0] to pair[1] else null
  }
}

internal class FleetCookieStore(
  private val manager: CookieManager = CookieManager.getInstance(),
  private val main: Handler = Handler(Looper.getMainLooper()),
) {
  fun readRemote(url: String, port: Int): String? = FleetCookiePolicy.requestHeader(manager.getCookie(url), port)

  fun snapshot(url: String, port: Int): FleetCookieSnapshot = FleetCookiePolicy.snapshot(manager.getCookie(url), port)

  fun restoreAndAwait(url: String, port: Int, snapshot: FleetCookieSnapshot) {
    applyAndAwait(url, FleetCookiePolicy.restoreHeaders(snapshot, manager.getCookie(url), port))
  }

  fun applyRemoteAndAwait(url: String, port: Int, values: List<String>) {
    applyAndAwait(url, FleetCookiePolicy.validateSetCookieHeaders(values, port))
  }

  fun applyAndAwait(url: String, values: List<String>) {
    values.forEach { value ->
      val latch = CountDownLatch(1)
      val accepted = AtomicBoolean(false)
      main.post {
        manager.setCookie(url, value) { success ->
          accepted.set(success)
          latch.countDown()
        }
      }
      if (!latch.await(COOKIE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
        throw IllegalStateException("cookie_callback_timeout")
      }
      if (!accepted.get()) throw IllegalStateException("cookie_rejected")
    }
    // Preserve header order by waiting for each callback before applying the next cookie.
    manager.flush()
  }

  private companion object {
    const val COOKIE_TIMEOUT_MS = 8_000L
  }
}

internal object CertificatePolicy {
  fun verifyLeaf(certificate: X509Certificate, target: PersistedTarget, now: Date = Date()) {
    try {
      certificate.checkValidity(now)
    } catch (failure: java.security.cert.CertificateExpiredException) {
      throw CertificateException("certificate_expired", failure)
    } catch (failure: java.security.cert.CertificateNotYetValidException) {
      throw CertificateException("certificate_not_yet_valid", failure)
    }
    if (certificate.basicConstraints >= 0) throw CertificateException("certificate_not_leaf")
    if (!hasExactSubjectAlternativeName(certificate, target.hostname)) {
      throw CertificateException("certificate_hostname_mismatch")
    }
    if (RemoteConnection.fingerprint(certificate) != target.fingerprint) {
      throw CertificateException("certificate_pin_mismatch")
    }
  }

  fun hasExactSubjectAlternativeName(certificate: X509Certificate, hostname: String): Boolean {
    val expectedType = if (isIpLiteral(hostname)) 7 else 2
    return try {
      certificate.subjectAlternativeNames.orEmpty().any { name ->
        name.size >= 2 && name[0] == expectedType && when (expectedType) {
          7 -> sameIpAddress(hostname, name[1]?.toString().orEmpty())
          else -> name[1]?.toString()?.equals(hostname, ignoreCase = true) == true
        }
      }
    } catch (_: Exception) {
      false
    }
  }

  fun isIpLiteral(host: String): Boolean = host.contains(':') ||
    host.matches(Regex("^(?:0|[1-9]\\d{0,2})(?:\\.(?:0|[1-9]\\d{0,2})){3}$")) &&
      host.split('.').all { it.toIntOrNull() in 0..255 }

  private fun sameIpAddress(left: String, right: String): Boolean = try {
    InetAddress.getByName(left).address.contentEquals(InetAddress.getByName(right).address)
  } catch (_: Exception) {
    false
  }
}

/** Only the delta-seconds form is trusted; an HTTP-date or out-of-range value yields no countdown. */
internal object RetryAfterHeader {
  fun seconds(value: String?): Int? = value?.trim()?.toLongOrNull()?.takeIf { it in 0..86_400 }?.toInt()
}

internal class ConnectionFailure(
  val code: String,
  cause: Throwable? = null,
  val retryAfterSeconds: Int? = null,
) : Exception(code, cause)
