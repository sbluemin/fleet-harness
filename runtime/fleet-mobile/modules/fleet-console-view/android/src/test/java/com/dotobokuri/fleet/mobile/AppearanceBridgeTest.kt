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
      """{"v":1,"type":"consoles","origin":"https://other.example"}""",
      """{"v":1,"type":"navigate","url":"https://other.example"}""",
      """{"v":1,"type":"set","colorMode":"dark","fontScale":"${"x".repeat(240)}"}""",
      "not json",
      null,
    )
    for (body in rejected) assertNull(body, AppearanceBridge.accept(true, true, true, body))
    assertEquals(AppearanceMessage.Consoles, AppearanceBridge.accept(true, true, true, """{"v":1,"type":"consoles"}"""))
  }

  @Test
  fun quotesTheConsoleLabelInsteadOfSplicingItIntoCode() {
    val label = "\"); alert(1); (\"</script>"
    val target = PersistedTarget("https://fleet.example:7443", "fleet.example", 7443, label, "A".repeat(64), LoopbackIdentity("127.44.1.9", 40001))
    val script = AppearanceBridge.script(Appearance.DEFAULT, systemDark = true, console = ConsolePresentation.of(target))
    assertFalse(script.contains(label))
    val prefix = "JSON.parse("
    val literal = script.substring(script.indexOf(prefix) + prefix.length, script.indexOf("); if (v.console)"))
    val value = JSONObject(JSONArray("[$literal]").getString(0))
    assertEquals(label, value.getJSONObject("console").getString("label"))
    assertEquals("dark", value.getString("systemScheme"))
  }
}
