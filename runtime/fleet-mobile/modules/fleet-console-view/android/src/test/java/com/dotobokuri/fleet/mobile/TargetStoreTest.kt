package com.dotobokuri.fleet.mobile

import android.content.Context
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class TargetStoreTest {
  private val context: Context = RuntimeEnvironment.getApplication()

  private fun preferences() = context.getSharedPreferences("fleet-mobile-target", Context.MODE_PRIVATE)

  private fun target(origin: String, host: String, port: Int, label: String = "Console", fingerprint: Char = 'A') = PersistedTarget(
    origin, host, port, label, fingerprint.toString().repeat(64), LoopbackIdentity("127.44.${port % 200 + 1}.9", 40000 + port % 1000),
  )

  private fun store() = TargetStore(context)

  @Test
  fun migratesLegacySingleTargetIntoDeckAndDropsOldKey() {
    preferences().edit().clear().commit()
    val legacy = JSONObject()
      .put("origin", "https://fleet.example:7443")
      .put("hostname", "fleet.example")
      .put("port", 7443)
      .put("label", "Fleet")
      .put("fingerprint", "B".repeat(64))
      .put("localHost", "127.44.2.9")
      .put("localPort", 40443)
    preferences().edit().putString("target-v2", legacy.toString()).commit()

    val migrated = store()
    assertEquals("https://fleet.example:7443", migrated.active()?.origin)
    assertEquals(1, migrated.list().size)
    assertNull(preferences().getString("target-v2", null))
  }

  @Test
  fun upsertKeysByOriginAndMakesTheTargetActive() {
    preferences().edit().clear().commit()
    val deck = store()
    assertTrue(deck.upsert(target("https://one.example:1001", "one.example", 1001, "One")))
    assertTrue(deck.upsert(target("https://two.example:1002", "two.example", 1002, "Two")))
    assertEquals("https://two.example:1002", deck.active()?.origin)
    assertEquals(2, deck.list().size)

    assertTrue(deck.upsert(target("https://one.example:1001", "one.example", 1001, "One again", 'C')))
    assertEquals(2, deck.list().size)
    assertEquals("https://one.example:1001", deck.active()?.origin)
    assertEquals("C".repeat(64), deck.find("https://one.example:1001")?.fingerprint)
  }

  @Test
  fun removeClearsActiveOnlyForTheRemovedOrigin() {
    preferences().edit().clear().commit()
    val deck = store()
    deck.upsert(target("https://one.example:1001", "one.example", 1001))
    deck.upsert(target("https://two.example:1002", "two.example", 1002))

    assertTrue(deck.remove("https://two.example:1002"))
    assertNull(deck.active())
    assertEquals(1, deck.list().size)
    assertFalse(deck.remove("https://two.example:1002"))

    deck.upsert(target("https://two.example:1002", "two.example", 1002))
    assertTrue(deck.remove("https://one.example:1001"))
    assertEquals("https://two.example:1002", deck.active()?.origin)
  }

  @Test
  fun stateSurvivesReconstructionAndInvalidEntriesAreDropped() {
    preferences().edit().clear().commit()
    store().upsert(target("https://one.example:1001", "one.example", 1001))
    assertEquals("https://one.example:1001", store().active()?.origin)

    val tampered = JSONObject(preferences().getString("targets-v3", null)!!)
    tampered.getJSONArray("targets").getJSONObject(0).put("fingerprint", "not-hex")
    preferences().edit().putString("targets-v3", tampered.toString()).commit()
    assertNull(store().active())
    assertTrue(store().list().isEmpty())

    preferences().edit().putString("targets-v3", "garbage").commit()
    assertTrue(store().list().isEmpty())
    assertNull(preferences().getString("targets-v3", null))
  }

  @Test
  fun resumeIdentityReusesSavedIdentityUnlessTheLiveGatewayHoldsIt() {
    preferences().edit().clear().commit()
    val deck = store()
    val stored = target("https://one.example:1001", "one.example", 1001)
    val other = target("https://two.example:1002", "two.example", 1002)
    val fresh = LoopbackIdentity("127.99.9.9", 49999)

    assertEquals(stored.loopback, deck.resumeIdentity(stored, null, false) { fresh })
    assertEquals(stored.loopback, deck.resumeIdentity(stored, other, true) { fresh })
    assertEquals(fresh, deck.resumeIdentity(stored, stored, true) { fresh })
  }
}
