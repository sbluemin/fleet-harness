package com.dotobokuri.fleet.mobile

import android.content.Context
import org.json.JSONObject

/**
 * The mobile appearance bridge (shared/bridge-contract.md v1.1): the device-owned colour mode and
 * font scale, the script that hands them to the page, and the gate for the page's messages.
 *
 * The message channel is a second door from page JavaScript into the shell. It carries display
 * preferences only, and it opens under the readiness rules: the committed view, its main frame,
 * the exact local gateway origin, and a body that matches one whitelisted shape exactly.
 * Anything else is dropped without failing the connection.
 */
internal enum class ColorMode(val wire: String) {
  SYSTEM("system"), DARK("dark"), LIGHT("light");

  companion object {
    fun of(value: Any?): ColorMode? = entries.firstOrNull { it.wire == value }
  }
}

internal enum class FontScale(val wire: String) {
  SMALL("small"), DEFAULT("default"), LARGE("large");

  companion object {
    fun of(value: Any?): FontScale? = entries.firstOrNull { it.wire == value }
  }
}

internal data class Appearance(val colorMode: ColorMode, val fontScale: FontScale) {
  fun dark(systemDark: Boolean): Boolean = when (colorMode) {
    ColorMode.SYSTEM -> systemDark
    ColorMode.DARK -> true
    ColorMode.LIGHT -> false
  }

  companion object {
    val DEFAULT = Appearance(ColorMode.SYSTEM, FontScale.DEFAULT)
  }
}

/** What the page may show about the console it is running in — that console only. */
internal data class ConsolePresentation(val label: String, val monogram: String, val tone: String) {
  companion object {
    private val TONES = listOf("crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose")

    /** Same choice as the shell's `toneFor`/`monogramFor` (shell/palette.ts), so both draw one identity. */
    fun of(target: PersistedTarget): ConsolePresentation? {
      val label = target.label.trim().let { if (it.codePointCount(0, it.length) > 64) it.substring(0, it.offsetByCodePoints(0, 64)) else it }
      if (label.isEmpty()) return null
      val monogram = String(Character.toChars(label.codePointAt(0))).uppercase()
      var hash = 0x811c9dc5.toInt()
      for (unit in target.origin) {
        hash = hash xor unit.code
        hash *= 0x01000193
      }
      val tone = TONES[(hash.toLong() and 0xffffffffL).rem(TONES.size).toInt()]
      return ConsolePresentation(label, monogram, tone)
    }
  }
}

internal sealed interface AppearanceMessage {
  data class Set(val appearance: Appearance) : AppearanceMessage
  data class Chrome(val top: String, val bottom: String) : AppearanceMessage
  data object Consoles : AppearanceMessage
}

internal object AppearanceBridge {
  const val MESSAGE_OBJECT = "fleetAppearance"
  private const val MAX_BODY = 256
  private val CHROME_TOP = setOf("bg", "bg-deep")
  private val CHROME_BOTTOM = setOf("bg", "bg-deep", "surface")

  /** The whole gate. Each argument is a condition the caller measured on the arriving message. */
  fun accept(fromCommittedView: Boolean, isMainFrame: Boolean, fromGatewayOrigin: Boolean, body: String?): AppearanceMessage? {
    if (!fromCommittedView || !isMainFrame || !fromGatewayOrigin) return null
    if (body == null || body.length > MAX_BODY) return null
    val json = try { JSONObject(body) } catch (_: Exception) { return null }
    if (json.opt("v") != 1) return null
    val keys = json.keys().asSequence().toSet()
    return when (json.opt("type")) {
      "set" -> {
        if (keys != setOf("v", "type", "colorMode", "fontScale")) return null
        val colorMode = ColorMode.of(json.opt("colorMode")) ?: return null
        val fontScale = FontScale.of(json.opt("fontScale")) ?: return null
        AppearanceMessage.Set(Appearance(colorMode, fontScale))
      }
      "chrome" -> {
        if (keys != setOf("v", "type", "top", "bottom")) return null
        val top = json.opt("top") as? String ?: return null
        val bottom = json.opt("bottom") as? String ?: return null
        if (top !in CHROME_TOP || bottom !in CHROME_BOTTOM) return null
        AppearanceMessage.Chrome(top, bottom)
      }
      "consoles" -> if (keys == setOf("v", "type")) AppearanceMessage.Consoles else null
      else -> null
    }
  }

  /**
   * One script for both moments — document start and a live update — so the page always reads
   * the value it was told about. Every value passes through the JSON encoder and is quoted once
   * more as a JavaScript string; nothing is concatenated into code.
   */
  fun script(appearance: Appearance, systemDark: Boolean, console: ConsolePresentation?): String {
    val value = JSONObject()
      .put("v", 1)
      .put("colorMode", appearance.colorMode.wire)
      .put("systemScheme", if (systemDark) "dark" else "light")
      .put("fontScale", appearance.fontScale.wire)
    if (console != null) {
      value.put("console", JSONObject().put("label", console.label).put("monogram", console.monogram).put("tone", console.tone))
    }
    val literal = JSONObject.quote(value.toString())
    return "(() => { const v = JSON.parse($literal); if (v.console) Object.freeze(v.console); Object.freeze(v); " +
      "Object.defineProperty(window, \"__fleetMobileAppearance\", { value: v, configurable: true, enumerable: false, writable: false }); " +
      "window.dispatchEvent(new CustomEvent(\"fleet-mobile-appearance\", { detail: v })); })();"
  }

  /** The page background before it paints, matching `--m-bg`, so a load never flashes the wrong pole. */
  fun backgroundColor(dark: Boolean): Int = if (dark) 0xFF151515.toInt() else 0xFFF7F6F2.toInt()
}

internal class AppearanceStore(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences("fleet-mobile-appearance", Context.MODE_PRIVATE)

  fun load(): Appearance = Appearance(
    ColorMode.of(preferences.getString(KEY_COLOR_MODE, null)) ?: ColorMode.SYSTEM,
    FontScale.of(preferences.getString(KEY_FONT_SCALE, null)) ?: FontScale.DEFAULT,
  )

  fun save(appearance: Appearance): Boolean = preferences.edit()
    .putString(KEY_COLOR_MODE, appearance.colorMode.wire)
    .putString(KEY_FONT_SCALE, appearance.fontScale.wire)
    .commit()

  private companion object {
    const val KEY_COLOR_MODE = "colorMode"
    const val KEY_FONT_SCALE = "fontScale"
  }
}
