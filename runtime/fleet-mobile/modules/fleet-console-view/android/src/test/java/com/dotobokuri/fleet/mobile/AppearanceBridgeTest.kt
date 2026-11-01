package com.dotobokuri.fleet.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The page-to-shell appearance channel is a security boundary: only the committed page's own messages pass. */
@RunWith(RobolectricTestRunner::class)
class AppearanceBridgeTest {
  private val set = """{"v":1,"type":"set","colorMode":"dark","fontScale":"large"}"""

  @Test
  fun acceptsOnlyTheCommittedMainFrameOfTheGatewayOrigin() {
    assertEquals(
      AppearanceMessage.Set(Appearance(ColorMode.DARK, FontScale.LARGE)),
      AppearanceBridge.accept(fromCommittedView = true, isMainFrame = true, fromGatewayOrigin = true, body = set),
    )
    assertNull(AppearanceBridge.accept(fromCommittedView = false, isMainFrame = true, fromGatewayOrigin = true, body = set))
    assertNull(AppearanceBridge.accept(fromCommittedView = true, isMainFrame = false, fromGatewayOrigin = true, body = set))
    assertNull(AppearanceBridge.accept(fromCommittedView = true, isMainFrame = true, fromGatewayOrigin = false, body = set))
  }

  @Test
  fun dropsEveryBodyOutsideTheWhitelistedShapes() {
    val rejected = listOf(
      """{"v":1,"type":"set","colorMode":"dark","fontScale":"large","extra":1}""",
      """{"v":1,"type":"set","colorMode":"dark"}""",
      """{"v":1,"type":"set","colorMode":"sepia","fontScale":"large"}""",
      """{"v":2,"type":"set","colorMode":"dark","fontScale":"large"}""",
      """{"v":"1","type":"set","colorMode":"dark","fontScale":"large"}""",
      """{"v":1,"type":"chrome","top":"#000000","bottom":"bg"}""",
      """{"v":1,"type":"edge","on":true,"extra":1}""",
      """{"v":1,"type":"edge"}""",
      """{"v":1,"type":"edge","on":false}""",
      """{"v":1,"type":"edge","on":1}""",
      """{"v":1,"type":"edge","on":"true"}""",
      """{"v":1,"type":"consoles","origin":"https://other.example"}""",
      """{"v":1,"type":"navigate","url":"https://other.example"}""",
      """{"v":1,"type":"set","colorMode":"dark","fontScale":"${"x".repeat(240)}"}""",
      "not json",
      null,
    )
    for (body in rejected) assertNull(body, AppearanceBridge.accept(true, true, true, body))
    assertEquals(AppearanceMessage.Consoles, AppearanceBridge.accept(true, true, true, """{"v":1,"type":"consoles"}"""))
    assertEquals(AppearanceMessage.Edge, AppearanceBridge.accept(true, true, true, """{"v":1,"type":"edge","on":true}"""))
    assertNull(AppearanceBridge.accept(fromCommittedView = false, isMainFrame = true, fromGatewayOrigin = true, body = """{"v":1,"type":"edge","on":true}"""))
  }

  @Test
  fun quotesTheConsoleLabelInsteadOfSplicingItIntoCode() {
    val label = "\"); alert(1); (\"</script>"
    val target = PersistedTarget("https://fleet.example:7443", "fleet.example", 7443, label, "A".repeat(64), LoopbackIdentity("127.44.1.9", 40001))
    val script = AppearanceBridge.script(
      Appearance.DEFAULT,
      systemDark = true,
      console = ConsolePresentation.of(target),
      appVersion = "0.3.3",
      insets = AppearanceInsets.of(47.0, 0.0, 34.5, 8.0),
    )
    assertFalse(script.contains(label))
    val value = parsed(script)
    assertEquals(label, value.getJSONObject("console").getString("label"))
    assertEquals("fleet.example:7443", value.getJSONObject("console").getString("address"))
    assertEquals("dark", value.getString("systemScheme"))
    assertEquals("0.3.3", value.getJSONObject("app").getString("version"))
    assertEquals(true, value.getJSONObject("chrome").getBoolean("scrim"))
    assertEquals(true, value.getJSONObject("chrome").getBoolean("edge"))
    val insets = value.getJSONObject("insets")
    assertEquals(47.0, insets.getDouble("top"), 0.0)
    assertEquals(0.0, insets.getDouble("right"), 0.0)
    assertEquals(34.5, insets.getDouble("bottom"), 0.0)
    assertEquals(8.0, insets.getDouble("left"), 0.0)
    val clamped = parsed(AppearanceBridge.script(
      Appearance.DEFAULT,
      systemDark = false,
      console = null,
      insets = AppearanceInsets.of(Double.NaN, -1.0, Double.POSITIVE_INFINITY, 0.0),
    )).getJSONObject("insets")
    assertEquals(0.0, clamped.getDouble("top"), 0.0)
    assertEquals(0.0, clamped.getDouble("right"), 0.0)
    assertEquals(0.0, clamped.getDouble("bottom"), 0.0)
    assertEquals(0.0, clamped.getDouble("left"), 0.0)
  }

  private fun parsed(script: String): JSONObject {
    val prefix = "JSON.parse("
    val literal = script.substring(script.indexOf(prefix) + prefix.length, script.indexOf("); if (v.console)"))
    return JSONObject(JSONArray("[$literal]").getString(0))
  }
}
