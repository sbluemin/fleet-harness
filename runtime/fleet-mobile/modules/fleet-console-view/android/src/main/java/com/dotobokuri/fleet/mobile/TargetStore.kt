package com.dotobokuri.fleet.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.ServerSocket
import java.net.URI
import java.net.InetAddress
import java.security.SecureRandom

internal data class LoopbackIdentity(val host: String, val port: Int) {
  val authority: String get() = "$host:$port"
  val origin: String get() = "https://$authority"

  companion object {
    fun create(random: SecureRandom = SecureRandom()): LoopbackIdentity {
      val bytes = ByteArray(3).also(random::nextBytes)
      val host = "127.${1 + (bytes[0].toInt() and 0xff) % 254}.${1 + (bytes[1].toInt() and 0xff) % 254}.${1 + (bytes[2].toInt() and 0xff) % 254}"
      val port = ServerSocket(0, 1, InetAddress.getByName(host)).use { it.localPort }
      return LoopbackIdentity(host, port)
    }
  }
}

/**
 * Durable saved-console deck. A saved target stores where to go and what certificate to trust —
 * never a credential; pairing secrets stay in CookieManager under the remote origin. The deck is
 * keyed by remote origin: re-adding a console at the same address replaces its entry (label,
 * fingerprint, loopback identity) instead of growing a duplicate.
 */
internal class TargetStore(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences("fleet-mobile-target", Context.MODE_PRIVATE)

  fun active(): PersistedTarget? = state().let { current -> current.targets.firstOrNull { it.origin == current.active } }

  fun list(): List<PersistedTarget> = state().targets

  fun find(origin: String): PersistedTarget? = state().targets.firstOrNull { it.origin == origin }

  /** Commit synchronously so visible target, local origin, and durable metadata cannot diverge. */
  fun upsert(target: PersistedTarget): Boolean {
    if (!isValid(target)) return false
    val current = state()
    return write(State(target.origin, current.targets.filterNot { it.origin == target.origin } + target))
  }

  fun remove(origin: String): Boolean {
    val current = state()
    val remaining = current.targets.filterNot { it.origin == origin }
    if (remaining.size == current.targets.size) return false
    return write(State(current.active.takeIf { it != origin }, remaining))
  }

  fun identityFor(candidate: AccessTarget, live: PersistedTarget?, hasLiveGateway: Boolean): LoopbackIdentity {
    val stored = find(candidate.origin)
    val occupied = hasLiveGateway && live != null && stored != null && live.loopback == stored.loopback
    return selectIdentity(candidate, stored, occupied) { LoopbackIdentity.create() }
  }

  /** A resumed target reuses its saved identity unless the live gateway is already bound to it. */
  fun resumeIdentity(
    stored: PersistedTarget,
    live: PersistedTarget?,
    hasLiveGateway: Boolean,
    fresh: () -> LoopbackIdentity = { LoopbackIdentity.create() },
  ): LoopbackIdentity =
    if (hasLiveGateway && live != null && live.loopback == stored.loopback) fresh() else stored.loopback

  private data class State(val active: String?, val targets: List<PersistedTarget>)

  private fun state(): State {
    migrateLegacy()
    val raw = preferences.getString(KEY, null) ?: return State(null, emptyList())
    val parsed = try {
      readState(JSONObject(raw))
    } catch (_: Exception) {
      null
    }
    if (parsed == null) {
      preferences.edit().remove(KEY).commit()
      return State(null, emptyList())
    }
    return parsed
  }

  private fun readState(value: JSONObject): State {
    val entries = mutableListOf<PersistedTarget>()
    val array = value.getJSONArray("targets")
    for (index in 0 until array.length()) {
      val target = try { readTarget(array.getJSONObject(index)) } catch (_: Exception) { continue }
      if (isValid(target) && entries.none { it.origin == target.origin }) entries.add(target)
    }
    val active = value.optString("active").takeIf { name -> entries.any { it.origin == name } }
    return State(active, entries)
  }

  private fun readTarget(value: JSONObject): PersistedTarget = PersistedTarget(
    origin = value.getString("origin"),
    hostname = value.getString("hostname"),
    port = value.getInt("port"),
    label = value.getString("label"),
    fingerprint = value.getString("fingerprint"),
    loopback = LoopbackIdentity(value.getString("localHost"), value.getInt("localPort")),
  )

  private fun write(state: State): Boolean {
    val targets = JSONArray()
    state.targets.forEach { target ->
      targets.put(
        JSONObject()
          .put("origin", target.origin)
          .put("hostname", target.hostname)
          .put("port", target.port)
          .put("label", target.label)
          .put("fingerprint", target.fingerprint)
          .put("localHost", target.loopback.host)
          .put("localPort", target.loopback.port),
      )
    }
    val value = JSONObject().put("targets", targets)
    state.active?.let { value.put("active", it) }
    return preferences.edit().putString(KEY, value.toString()).commit()
  }

  /** The single-target v2 record becomes a one-entry deck with that target active. */
  private fun migrateLegacy() {
    val raw = preferences.getString(LEGACY_KEY, null) ?: return
    if (preferences.getString(KEY, null) == null) {
      val legacy = try {
        readTarget(JSONObject(raw))
      } catch (_: Exception) {
        null
      }
      if (legacy != null && isValid(legacy)) write(State(legacy.origin, listOf(legacy)))
    }
    preferences.edit().remove(LEGACY_KEY).commit()
  }

  private fun isValid(target: PersistedTarget): Boolean {
    val uri = try { URI(target.origin) } catch (_: Exception) { return false }
    val port = if (uri.port == -1) 443 else uri.port
    return uri.scheme == "https" && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
      (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") &&
      uri.host.equals(target.hostname, ignoreCase = true) && port == target.port &&
      target.port in 1..65535 && target.fingerprint.matches(Regex("^[0-9A-F]{64}$")) &&
      target.label.isNotBlank() && target.label.length <= 48 &&
      target.loopback.host.matches(Regex("^127(?:\\.(?:0|[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-5])){3}$")) &&
      target.loopback.host != "127.0.0.1" && target.loopback.port in 1..65535
  }

  companion object {
    private const val KEY = "targets-v3"
    private const val LEGACY_KEY = "target-v2"

    internal fun selectIdentity(
      candidate: AccessTarget,
      active: PersistedTarget?,
      hasLiveActive: Boolean,
      fresh: () -> LoopbackIdentity,
    ): LoopbackIdentity {
      val sameTarget = active != null && active.origin == candidate.origin && active.fingerprint == candidate.fingerprint
      return if (sameTarget && !hasLiveActive) active.loopback else fresh()
    }
  }
}
