package com.dotobokuri.fleet.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class AccessLinkTest {
  private val vectors by lazy { JSONObject(protocolVectorsFile().readText()) }

  @Test
  fun parsesEveryConsoleProtocolVectorWithoutDrift() {
    val values = vectors.getJSONArray("positive")
    for (index in 0 until values.length()) {
      val vector = values.getJSONObject(index)
      val expected = vector.getJSONObject("parsed")
      val parsed = AccessLink.parse(vector.getString("link"))

      assertEquals(vector.getString("name"), expected.getString("origin"), parsed.origin)
      assertEquals(vector.getString("name"), expected.getString("hostname"), parsed.hostname)
      assertEquals(vector.getString("name"), expected.getInt("port"), parsed.port)
      assertEquals(vector.getString("name"), expected.getString("label"), parsed.label)
      assertEquals(vector.getString("name"), expected.getString("consoleUrl"), parsed.consoleUrl)
      assertEquals(vector.getString("name"), expected.getString("joinUrl"), parsed.joinUrl)
      assertEquals(vector.getString("name"), expected.getString("token"), parsed.token)
      assertEquals(vector.getString("name"), expected.getString("fingerprint"), parsed.fingerprint)
    }
  }

  @Test
  fun rejectsEveryConsoleProtocolNegativeVectorWithoutDrift() {
    val values = vectors.getJSONArray("negative")
    for (index in 0 until values.length()) {
      val vector = values.getJSONObject(index)
      val failure = assertThrows(vector.getString("name"), IllegalArgumentException::class.java) {
        AccessLink.parse(vector.getString("link"))
      }
      assertEquals(vector.getString("name"), "pairing_target_invalid", failure.message)
    }
  }

  @Test
  fun durableTargetNeverCarriesTheCredential() {
    val parsed = AccessLink.parse(vectors.getJSONArray("positive").getJSONObject(0).getString("link"))
    val durable = parsed.withoutCredential(LoopbackIdentity("127.77.23.91", 43871))

    assertFalse(durable.toString().contains(parsed.token))
    assertEquals(parsed.fingerprint, durable.fingerprint)
  }

  @Test
  fun rejectsInputAboveTheNativeInboxLimit() {
    val prefix = "fleet://join?code="
    val oversized = prefix + "A".repeat(FleetLinkInbox.MAX_INPUT_LENGTH - prefix.length + 1)

    assertEquals("pairing_target_invalid", assertThrows(IllegalArgumentException::class.java) {
      AccessLink.parse(oversized)
    }.message)
  }

  private fun protocolVectorsFile(): File {
    var current: File? = File(System.getProperty("user.dir")).absoluteFile
    while (current != null) {
      val direct = File(current, "runtime/fleet-console/access-protocol/vectors.json")
      if (direct.isFile) return direct
      val sibling = File(current, "../fleet-console/access-protocol/vectors.json").canonicalFile
      if (sibling.isFile) return sibling
      current = current.parentFile
    }
    throw AssertionError("runtime/fleet-console/access-protocol/vectors.json was not found")
  }
}
