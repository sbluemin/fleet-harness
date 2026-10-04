package com.dotobokuri.fleet.mobile

import java.util.concurrent.atomic.AtomicReference

/**
 * Process-only one-shot handoff between the exported link activity and the native Console view.
 * Android never persists this object, so a process death deliberately drops an unconsumed credential.
 */
internal object FleetLinkInbox {
  const val MAX_INPUT_LENGTH = 4096
  private const val PREFIX = "fleet://join?code="

  private val pending = AtomicReference<String?>(null)
  private val receiver = AtomicReference<((String) -> Unit)?>(null)

  fun isCandidate(value: String?): Boolean = value != null &&
    value.length in 1..MAX_INPUT_LENGTH &&
    value.startsWith(PREFIX)

  fun offer(value: String) {
    if (!isCandidate(value)) return
    pending.set(value)
    drain()
  }

  /** Returns whether a pending link was handed to [next] during attach. */
  fun attach(next: (String) -> Unit): Boolean {
    receiver.set(next)
    return drain()
  }

  fun detach(next: (String) -> Unit) {
    receiver.compareAndSet(next, null)
  }

  internal fun consume(): String? = pending.getAndSet(null)

  private fun drain(): Boolean {
    val active = receiver.get() ?: return false
    val link = consume() ?: return false
    active(link)
    return true
  }
}
