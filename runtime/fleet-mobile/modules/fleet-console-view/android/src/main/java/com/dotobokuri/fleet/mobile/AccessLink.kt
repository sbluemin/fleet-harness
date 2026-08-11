package com.dotobokuri.fleet.mobile

import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

internal data class AccessTarget(
  val origin: String,
  val hostname: String,
  val port: Int,
  val label: String,
  val token: String,
  val fingerprint: String,
) {
  val consoleUrl: String get() = "$origin/console/"
  val joinUrl: String get() = "$origin/api/v1/join"
  fun withoutCredential(identity: LoopbackIdentity): PersistedTarget =
    PersistedTarget(origin, hostname, port, label, fingerprint, identity)
}

internal data class PersistedTarget(
  val origin: String,
  val hostname: String,
  val port: Int,
  val label: String,
  val fingerprint: String,
  val loopback: LoopbackIdentity,
) {
  val consoleUrl: String get() = "$origin/console/"
  val joinUrl: String get() = "$origin/api/v1/join"
  val readinessUrl: String get() = "$origin/api/v1/status"
}

internal object AccessLink {
  private val tokenPattern = Regex("^[A-Za-z0-9_-]{16,512}$")
  private val fingerprintPattern = Regex("^[0-9A-F]{64}$")
  private val codePattern = Regex("^[A-Za-z0-9_-]+$")
  private val whitespaceOrControl = Regex("[\\u0000-\\u001f\\u007f\\s]")
  private val hiddenLabelChars = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]")
  private val labelWhitespace = Regex("\\s+")
  private val expectedKeys = setOf("v", "endpoint", "token", "fingerprint", "label")

  fun parse(raw: String): AccessTarget {
    val value = raw.trim()
    invalidUnless(value.isNotEmpty() && value.length <= FleetLinkInbox.MAX_INPUT_LENGTH)
    invalidUnless(!whitespaceOrControl.containsMatchIn(value))
    val uri = try { Uri.parse(value) } catch (_: RuntimeException) { invalid() }
    invalidUnless(uri.scheme.equals("fleet", ignoreCase = true) && uri.host.equals("join", ignoreCase = true) && uri.port == -1)
    invalidUnless(uri.userInfo == null && uri.fragment == null && uri.path.orEmpty().isEmpty())
    invalidUnless(uri.queryParameterNames == setOf("code") && uri.getQueryParameters("code").size == 1)
    val code = uri.getQueryParameter("code") ?: invalid()
    invalidUnless(codePattern.matches(code) && code.length % 4 != 1)
    val decodedBytes = try {
      Base64.decode(padBase64Url(code), Base64.URL_SAFE or Base64.NO_WRAP)
    } catch (_: IllegalArgumentException) { invalid() }
    invalidUnless(Base64.encodeToString(decodedBytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) == code)
    val decoded = try {
      Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(decodedBytes))
        .toString()
    } catch (_: Exception) { invalid() }
    val payload = try { JSONObject(decoded) } catch (_: Exception) { invalid() }
    invalidUnless(payload.keys().asSequence().toSet() == expectedKeys)
    invalidUnless(payload.optInt("v", -1) == 1)
    val endpoint = payload.strictString("endpoint")
    val token = payload.strictString("token")
    val fingerprint = normalizeFingerprint(payload.strictString("fingerprint"))
    val label = sanitizeLabel(payload.strictString("label"))
    invalidUnless(tokenPattern.matches(token) && fingerprintPattern.matches(fingerprint) && label.isNotEmpty())
    val parsedEndpoint = parseEndpoint(endpoint)
    return AccessTarget(
      origin = parsedEndpoint.origin,
      hostname = parsedEndpoint.hostname,
      port = parsedEndpoint.port,
      label = label,
      token = token,
      fingerprint = fingerprint,
    )
  }

  fun normalizeFingerprint(value: String): String = value.replace(Regex("[^0-9a-fA-F]"), "").uppercase()

  private fun sanitizeLabel(value: String): String = value
    .replace(hiddenLabelChars, "")
    .replace(labelWhitespace, " ")
    .trim()
    .take(48)

  private fun parseEndpoint(value: String): Endpoint {
    val uri = try { URI(value) } catch (_: Exception) { invalid() }
    invalidUnless(uri.scheme == "https" && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
    invalidUnless(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
    val rawHost = uri.host?.lowercase() ?: invalid()
    val host = if (rawHost.startsWith("[") && rawHost.endsWith("]")) rawHost.slice(1 until rawHost.lastIndex) else rawHost
    val port = if (uri.port == -1) 443 else uri.port
    invalidUnless(port in 1..65535)
    val renderedHost = if (host.contains(':')) "[$host]" else host
    val origin = if (port == 443) "https://$renderedHost" else "https://$renderedHost:$port"
    return Endpoint(origin, host, port)
  }

  private fun JSONObject.strictString(key: String): String {
    invalidUnless(has(key) && get(key) is String)
    return getString(key)
  }

  private fun padBase64Url(value: String): String = value + "=".repeat((4 - value.length % 4) % 4)
  private fun invalidUnless(condition: Boolean) { if (!condition) invalid() }
  private fun invalid(): Nothing = throw IllegalArgumentException("pairing_target_invalid")

  private data class Endpoint(val origin: String, val hostname: String, val port: Int)
}
