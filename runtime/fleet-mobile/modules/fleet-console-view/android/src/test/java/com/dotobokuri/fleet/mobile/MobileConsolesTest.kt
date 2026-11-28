package com.dotobokuri.fleet.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

class MobileConsolesTest {
  private fun target(index: Int) = PersistedTarget(
    "https://host-$index.example:7443", "host-$index.example", 7443, "Console $index", "A".repeat(64),
    LoopbackIdentity("127.1.2.3", 8900 + index), "opaque-id-$index",
  )

  @Test
  fun projectsAndFitsUtf8StateWithoutChangingTheSavedRosterOrOrder() {
    val targets = (1..18).map(::target)
    val active = targets.last()
    val preview = "🍵".repeat(80)
    val row = JSONObject().put("id", "lead").put("name", "あ".repeat(48)).put("run", "working").put("preview", preview)
      .put("look", JSONObject().put("base", 1).put("tone", JSONObject.NULL).put("cookie", "must-not-be-relayed"))
      .put("commanders", JSONArray((1..8).map { index ->
        JSONObject().put("id", "goal-$index").put("title", "あ".repeat(120)).put("run", "working")
          .put("done", 1).put("total", 2).put("fingerprint", "must-not-be-relayed")
      }))
    val summary = JSONObject().put("v", 1).put("more", 0).put("commodores", JSONArray(List(40) { row }))
      .put("address", "must-not-be-relayed")
    val roster = requireNotNull(ConsoleRoster.project(summary))
    val state = MobileConsoles.serialized(targets, active, targets.drop(1).associate { it.id to RosterMemory(RosterStatus.OK, 12, roster) }, null)
    assertTrue(state.toByteArray(Charsets.UTF_8).size <= 65_536)
    assertFalse(state.contains("must-not-be-relayed"))
    assertFalse(state.contains(".example"))
    val entries = JSONObject(state).getJSONArray("consoles")
    assertEquals((targets.take(15) + active).map { it.id }, (0..15).map { entries.getJSONObject(it).getString("id") })
    assertTrue(entries.getJSONObject(15).getBoolean("active"))
    for (index in listOf(0, 15)) for (field in listOf("status", "at", "roster")) assertTrue(entries.getJSONObject(index).isNull(field))
    val kept = entries.getJSONObject(1).getJSONObject("roster")
    assertNotNull(ConsoleRoster.project(kept))
    assertFalse(kept.toString().contains("preview"))
    assertEquals(0, kept.getJSONArray("commodores").getJSONObject(0).getJSONArray("commanders").length())
    assertEquals(8, kept.getJSONArray("commodores").getJSONObject(0).getInt("moreCommanders"))
    assertTrue(entries.getJSONObject(14).getJSONObject("roster").getLong("more") > 0)
    assertEquals(preview, roster.getJSONArray("commodores").getJSONObject(0).getString("preview"))
    assertEquals(8, roster.getJSONArray("commodores").getJSONObject(0).getJSONArray("commanders").length())
    assertNull(ConsoleRoster.project(summary.put("commodores", JSONArray(listOf(row.put("run", "invalid"))))))
  }

  @Test
  fun failureDiscardsOnlyTheCandidateArrivalAndKeepsTheVisibleConsole() {
    val current = target(1)
    val other = target(2)
    val switch = SeamlessSwitch()
    switch.start(7, other, ConsoleArrival("lead", null, 2.0), 0)
    assertNull(switch.forDocument(7, current.id, 0))
    assertNull(switch.fail(6, "remote_link_unreachable"))
    val failure = requireNotNull(switch.fail(7, "remote_host_not_paired"))
    val previous = RosterMemory(RosterStatus.OK, 12L, JSONObject().put("v", 1).put("more", 0).put("commodores", JSONArray()))
    val roster = RosterMemory.of(RosterReading(failure.status), previous, 20L)
    val visible = JSONObject(MobileConsoles.serialized(listOf(current, other), current, mapOf(other.id to roster), switch.pending?.arrival))
    assertTrue(visible.isNull("arrival"))
    val entries = visible.getJSONArray("consoles")
    assertTrue(entries.getJSONObject(0).getBoolean("active"))
    assertFalse(entries.getJSONObject(1).getBoolean("active"))
    assertTrue(entries.getJSONObject(1).isNull("roster"))
    assertEquals("unpaired", entries.getJSONObject(1).getString("status"))
    assertEquals(roster, RosterMemory.of(RosterReading(RosterStatus.UNSUPPORTED), roster, 25L))
    assertEquals(mapOf("type" to "switch-failed", "active" to true, "label" to other.label, "origin" to other.origin,
      "code" to "remote_host_not_paired"), failure.event())
    assertEquals(previous.roster, RosterMemory.of(RosterReading(RosterStatus.UNAVAILABLE), previous, 20L).roster)
  }

  @Test
  fun onlyTheFirstEligibleMainDocumentReceivesArrivalAndOldPageStillReadsAppearance() {
    val active = target(1)
    val origin = active.loopback.origin
    val switch = SeamlessSwitch()
    switch.start(7, active, ConsoleArrival("leader", "goal", 18.5), System.currentTimeMillis())
    val pending = requireNotNull(switch.forDocument(7, active.id, System.currentTimeMillis()))
    val normal = MobileConsoles.serialized(listOf(active), active, emptyMap(), null)
    val arriving = MobileConsoles.serialized(listOf(active), active, emptyMap(), pending.arrival)
    val beforeCommit = MobileConsoles.script(origin, normal, pending to arriving)
    switch.finish(7)
    assertNull(switch.forDocument(7, active.id, System.currentTimeMillis()))
    val afterCommit = MobileConsoles.script(origin, normal)
    val appearance = AppearanceBridge.script(Appearance.DEFAULT, false, ConsolePresentation.of(active))
    // Use the Node already required by the Android Gradle build to exercise the actual generated JS
    // in isolated realms. Same-view reload is a new realm with the same sessionStorage.
    val js = """
      const vm = require('node:vm');
      const a = require('node:assert/strict');
      const [origin, staging, committed, appearance] = process.argv.slice(1);
      const storage = new Map();
      function doc({ sameOrigin = true, main = true, clock = Date.now(), store = storage } = {}) {
        const events = [];
        const window = {dispatchEvent: event => events.push(event)};
        window.top = main ? window : {};
        const context = vm.createContext({window, location: {origin: sameOrigin ? origin : 'https://different.example', pathname:'/console/'},
          Date: {now: () => clock}, sessionStorage: {getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},
          CustomEvent: class { constructor(type, {detail}) { this.type = type; this.detail = detail; } }});
        return {...window, window, events, run: script=>vm.runInContext(script, context)};
      }
      for (const invalid of [doc({main:false}), doc({sameOrigin:false})]) {
        invalid.run(staging);
        a.equal(invalid.events.length, 0);
        a.equal(invalid.window.__fleetMobileConsoles, undefined);
      }
      const first = doc();
      first.run(staging);
      const state = first.window.__fleetMobileConsoles;
      a.equal(state.arrival.commander, 'goal');
      a.equal(state.arrival.scrollTop, 18.5);
      a.ok(Object.isFrozen(state.arrival) && Object.isFrozen(state.consoles[0]));
      a.equal(first.events[0].type, 'fleet-mobile-consoles');
      a.equal(first.events[0].detail, state);
      first.run(committed);
      a.equal(first.events[1].detail.arrival, null);
      a.equal(first.window.__fleetMobileConsoles.arrival, null);
      const reloaded = doc();
      reloaded.run(staging);
      a.equal(reloaded.window.__fleetMobileConsoles.arrival, null);
      const expired = doc({clock: Date.now() + 31000, store:new Map()});
      expired.run(staging);
      a.equal(expired.window.__fleetMobileConsoles.arrival, null);
      // An old subscriber uses its original event and fields, ignoring the additive relay.
      const legacy = doc();
      legacy.run(appearance);
      legacy.run(committed);
      const oldValue = legacy.events.find(e=>e.type==='fleet-mobile-appearance').detail;
      a.equal(oldValue.colorMode, 'system');
      a.equal(oldValue.console.label, 'Console 1');
      a.ok(oldValue.consoles.roster && oldValue.consoles.seamless);
    """.trimIndent()
    val process = ProcessBuilder("node", "-e", js, origin, beforeCommit, afterCommit, appearance).redirectErrorStream(true).start()
    try {
      assertTrue("Generated JavaScript did not finish", process.waitFor(10, TimeUnit.SECONDS))
      assertEquals(process.inputStream.bufferedReader().readText(), 0, process.exitValue())
    } finally {
      process.destroyForcibly()
    }
  }
}
