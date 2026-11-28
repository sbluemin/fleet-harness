package com.dotobokuri.fleet.mobile

import org.json.JSONArray
import org.json.JSONObject

internal enum class RosterStatus(val wire: String) {
  OK("ok"), UNSUPPORTED("unsupported"), UNAVAILABLE("unavailable"), UNPAIRED("unpaired"),
}

internal data class RosterReading(val status: RosterStatus, val roster: JSONObject? = null)

internal data class RosterMemory(val status: RosterStatus, val at: Long?, val roster: JSONObject?) {
  companion object {
    fun of(reading: RosterReading, previous: RosterMemory?, at: Long): RosterMemory = when (reading.status) {
      RosterStatus.OK -> RosterMemory(reading.status, at, reading.roster)
      RosterStatus.UNAVAILABLE, RosterStatus.UNSUPPORTED -> {
        // A failed background read cannot supersede an explicit native not-paired result.
        if (previous?.status == RosterStatus.UNPAIRED) previous
        else RosterMemory(reading.status, previous?.at, previous?.roster?.takeIf { reading.status == RosterStatus.UNAVAILABLE })
      }
      RosterStatus.UNPAIRED -> RosterMemory(reading.status, previous?.at, null)
    }
  }
}

internal data class ConsoleArrival(val commodore: String, val commander: String?, val scrollTop: Double?) {
  fun json(): JSONObject = JSONObject().put("commodore", commodore)
    .put("commander", commander ?: JSONObject.NULL).put("scrollTop", scrollTop ?: JSONObject.NULL)
}

/** Main-thread switch state, tied to the existing attempt id rather than an origin or the visible page. */
internal class SeamlessSwitch {
  data class Pending(val attempt: Long, val target: PersistedTarget, val arrival: ConsoleArrival, val expiresAt: Long) {
    // A fresh staging view has a fresh sessionStorage; this is not a shared or durable key.
    val documentKey: String get() = "fleet-mobile-arrival-$attempt"
  }

  var pending: Pending? = null
    private set

  fun start(attempt: Long, target: PersistedTarget, arrival: ConsoleArrival?, now: Long) {
    pending = arrival?.let { Pending(attempt, target, it, now + TTL_MS) }
  }

  fun forDocument(attempt: Long, targetId: String, now: Long): Pending? =
    pending?.takeIf { it.attempt == attempt && it.target.id == targetId && now < it.expiresAt }

  data class Failure(val target: PersistedTarget, val code: String) {
    val status = if (code == "remote_host_not_paired") RosterStatus.UNPAIRED else RosterStatus.UNAVAILABLE
    fun event(): Map<String, Any> = mapOf(
      "type" to "switch-failed", "label" to target.label, "origin" to target.origin, "active" to true, "code" to code,
    )
  }

  // Expiry only removes arrival from the document; the attempt is still seamless until it ends.
  fun finish(attempt: Long): Pending? = pending?.takeIf { it.attempt == attempt }?.also { pending = null }
  fun fail(attempt: Long, code: String): Failure? = finish(attempt)?.let { Failure(it.target, code) }
  fun cancel() { pending = null }

  companion object { const val TTL_MS = 30_000L }
}

internal object MobileConsoles {
  const val MAX_FRAME = 65_536
  private const val MAX_ENTRIES = 16
  private val idPattern = Regex("[A-Za-z0-9-]{1,64}")

  fun validId(id: String): Boolean = idPattern.matches(id)

  fun serialized(
    targets: List<PersistedTarget>, active: PersistedTarget,
    rosters: Map<String, RosterMemory>, arrival: ConsoleArrival?,
  ): String {
    val deck = if (targets.any { it.id == active.id }) targets else targets + active
    val visible = deck.take(MAX_ENTRIES).let { first ->
      if (first.any { it.id == active.id }) first else first.dropLast(1) + active
    }
    val entries = visible.map { target ->
      val presentation = requireNotNull(ConsolePresentation.of(target))
      val isActive = target.id == active.id
      val memory = rosters[target.id]?.takeUnless { isActive }
      JSONObject()
        .put("id", target.id).put("label", presentation.label)
        .put("monogram", presentation.monogram).put("tone", presentation.tone)
        .put("active", isActive)
        .put("status", memory?.status?.wire ?: JSONObject.NULL)
        .put("at", memory?.at ?: JSONObject.NULL)
        .put("roster", memory?.roster?.let { JSONObject(it.toString()) } ?: JSONObject.NULL)
    }
    val value = JSONObject().put("v", 1).put("consoles", JSONArray(entries))
      .put("arrival", arrival?.json() ?: JSONObject.NULL)
    fit(value, entries)
    return value.toString()
  }

  private fun utf8(value: JSONObject): Int = value.toString().toByteArray(Charsets.UTF_8).size

  private fun fit(frame: JSONObject, entries: List<JSONObject>) {
    var bytes = utf8(frame)
    if (bytes <= MAX_FRAME) return
    val rosters = entries.asReversed().mapNotNull { it.optJSONObject("roster") }
    val rows = rosters.flatMap { roster ->
      roster.getJSONArray("commodores").let { list -> (list.length() - 1 downTo 0).map(list::getJSONObject) }
    }
    // Changes within one object have the same UTF-8 delta as in the full frame. Don't serialize
    // the whole deck again for every trimmed preview/commander (there can be thousands of them).
    fun shrink(row: JSONObject, change: () -> Unit) {
      val before = utf8(row)
      change()
      bytes += utf8(row) - before
    }
    for (row in rows) {
      if (bytes <= MAX_FRAME) return
      if (row.has("preview")) shrink(row) { row.remove("preview") }
    }
    for (row in rows) {
      val commanders = row.optJSONArray("commanders") ?: continue
      while (bytes > MAX_FRAME && commanders.length() > 0) {
        shrink(row) {
          commanders.remove(commanders.length() - 1)
          row.put("moreCommanders", (row.optInt("moreCommanders") + 1).coerceAtMost(100_000))
        }
      }
    }
    for (roster in rosters) {
      val commodores = roster.getJSONArray("commodores")
      val start = commodores.length()
      var more = roster.getLong("more")
      while (bytes > MAX_FRAME && commodores.length() > 0) {
        val previousLength = more.toString().length
        more = (more + 1).coerceAtMost(ConsoleRoster.MAX_SAFE_INTEGER)
        bytes += more.toString().length - previousLength
        val removed = commodores.remove(commodores.length() - 1) as JSONObject
        bytes -= utf8(removed) + if (commodores.length() > 0) 1 else 0
      }
      if (commodores.length() != start) roster.put("more", more)
      if (bytes <= MAX_FRAME) return
    }
    // A valid response can consist entirely of large section tables. Keep the native deck and
    // statuses even then, shedding tables (now that no surviving rows refer to them).
    for (roster in rosters) {
      if (bytes <= MAX_FRAME) return
      if (roster.has("sections")) shrink(roster) { roster.remove("sections") }
    }
  }

  /** AndroidX's origin rule also matches subframes; the top-frame and exact origin guards are mandatory. */
  fun script(origin: String, normal: String, stage: Pair<SeamlessSwitch.Pending, String>? = null): String {
    val location = JSONObject.quote(origin)
    val choose = stage?.let { (pending, withArrival) ->
      val key = JSONObject.quote(pending.documentKey)
      "try { if (!sessionStorage.getItem($key)) { sessionStorage.setItem($key, '1'); " +
        "if (Date.now() < ${pending.expiresAt}) raw = ${JSONObject.quote(withArrival)}; } } catch (_) {} "
    }.orEmpty()
    return "(() => { if (window !== window.top || location.origin !== $location || " +
      "!(location.pathname === '/console' || location.pathname.startsWith('/console/'))) return; " +
      "let raw = ${JSONObject.quote(normal)}; $choose" +
      "const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }; " +
      "const v = freeze(JSON.parse(raw)); " +
      "Object.defineProperty(window, '__fleetMobileConsoles', {value: v, configurable: true}); " +
      "window.dispatchEvent(new CustomEvent('fleet-mobile-consoles', {detail: v})); })();"
  }
}

/** Native counterpart of protocol/desktop/console-section.ts isConsoleRosterSummary.
 * Project every nesting level: the shared TS validator intentionally tolerates extra fields. */
internal object ConsoleRoster {
  const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
  private val runs = setOf("working", "waiting", "quiet")

  fun project(input: JSONObject): JSONObject? = try {
    require(integer(input.opt("v"), 1) == 1L)
    JSONObject().put("v", 1).put("more", integer(input.opt("more"), MAX_SAFE_INTEGER))
      .put("commodores", array(input.opt("commodores"), 40, ::commodore))
      .also { result ->
        optional(input, result, "sections") { array(it, 100, ::section) }
        optional(input, result, "unsectionedCollapsed", ::onlyTrue)
      }
  } catch (_: IllegalArgumentException) { null }

  fun clean(value: Any?, max: Int): String {
    require(value is String && value.length in 1..max && value.none { it < ' ' || it == '\u007f' })
    return value
  }

  private fun integer(value: Any?, max: Long): Long {
    require(value is Number)
    val n = value.toDouble()
    require(n.isFinite() && n >= 0 && n <= max && n % 1.0 == 0.0)
    return n.toLong()
  }

  private fun onlyTrue(value: Any?): Boolean { require(value == true); return true }

  private fun run(value: Any?): String { require(value is String && value in runs); return value }

  private fun look(value: Any?): Any {
    if (value === JSONObject.NULL) return JSONObject.NULL
    require(value is JSONObject)
    val tone = value.opt("tone")
    return JSONObject().put("base", integer(value.opt("base"), 9_999))
      .put("tone", if (tone === JSONObject.NULL) JSONObject.NULL else clean(tone, 64))
  }

  private fun array(value: Any?, max: Int, projectRow: (JSONObject) -> JSONObject): JSONArray {
    require(value is JSONArray && value.length() <= max)
    return JSONArray().apply {
      for (i in 0 until value.length()) put(projectRow(requireNotNull(value.optJSONObject(i))))
    }
  }

  private fun optional(source: JSONObject, dest: JSONObject, key: String, projectValue: (Any?) -> Any) {
    if (source.has(key)) dest.put(key, projectValue(source.opt(key)))
  }

  private fun commodore(value: JSONObject): JSONObject = JSONObject()
    .put("id", clean(value.opt("id"), 128)).put("name", clean(value.opt("name"), 120))
    .put("run", run(value.opt("run"))).put("look", look(value.opt("look")))
    .also { row ->
      optional(value, row, "section") { clean(it, 128) }
      optional(value, row, "preview") { clean(it, 160) }
      optional(value, row, "commanders") { array(it, 8, ::commander) }
      optional(value, row, "moreCommanders") { integer(it, 100_000) }
    }

  private fun commander(value: JSONObject): JSONObject = JSONObject()
    .put("id", clean(value.opt("id"), 128)).put("title", clean(value.opt("title"), 120))
    .put("run", run(value.opt("run")))
    .also { row ->
      val total = integer(value.opt("total"), 100_000)
      row.put("total", total).put("done", integer(value.opt("done"), total))
      optional(value, row, "look", ::look)
    }

  private fun section(value: JSONObject): JSONObject = JSONObject()
    .put("id", clean(value.opt("id"), 128)).put("name", clean(value.opt("name"), 80))
    .also { optional(value, it, "collapsed", ::onlyTrue) }
}
