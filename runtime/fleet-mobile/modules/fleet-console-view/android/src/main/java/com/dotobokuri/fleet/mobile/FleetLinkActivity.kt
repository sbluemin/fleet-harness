package com.dotobokuri.fleet.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Receives Fleet access URIs without ever handing them to React Native or Expo. */
class FleetLinkActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    consumeAndForward(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    consumeAndForward(intent)
  }

  private fun consumeAndForward(source: Intent) {
    val candidate = source.dataString
    // Clear the credential-bearing URI before validation, parsing, handoff, or lifecycle forwarding.
    source.data = null
    setIntent(source)
    if (source.action == Intent.ACTION_VIEW && FleetLinkInbox.isCandidate(candidate)) {
      FleetLinkInbox.offer(candidate!!)
    }

    val foreground = Intent().apply {
      setClassName(this@FleetLinkActivity, "com.dotobokuri.fleet.mobile.MainActivity")
      addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    startActivity(foreground)
    finish()
  }
}
