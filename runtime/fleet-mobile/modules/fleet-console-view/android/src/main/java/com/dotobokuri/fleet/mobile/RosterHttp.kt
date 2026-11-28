package com.dotobokuri.fleet.mobile

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException

/** A single fixed HTTP exchange on the pinned socket. Neither redirects nor cookie writes exist here. */
internal object RosterHttp {
  const val PATH = "/api/v1/console-roster"
  const val MAX_BODY = 1_048_576

  fun exchange(input: InputStream, output: OutputStream, target: PersistedTarget, pairing: String): RosterReading {
    HttpCodec.writeHead(output, "GET $PATH HTTP/1.1", Headers(listOf(
      Header("Host", target.authority),
      Header("Accept", "application/json"),
      Header("Accept-Encoding", "identity"),
      Header("Connection", "close"),
      Header("Cookie", pairing),
    )))
    output.flush()
    val stream = input.buffered()
    val response = HttpCodec.readResponse(stream)
    return when (response.code) {
      // Consoles predating this route can reject pairing-only auth before route lookup.
      401, 403, 404 -> RosterReading(RosterStatus.UNSUPPORTED)
      200 -> {
        // A failed or oversized transfer still propagates as unavailable; only a complete body can be unsupported.
        val body = readBody(stream, response.bodyKind)
        val text = try {
          Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(body)).toString()
        } catch (_: CharacterCodingException) {
          return RosterReading(RosterStatus.UNSUPPORTED)
        }
        val roster = BridgeJson.parse(text)?.let(ConsoleRoster::project) ?: return RosterReading(RosterStatus.UNSUPPORTED)
        RosterReading(RosterStatus.OK, roster)
      }
      else -> RosterReading(RosterStatus.UNAVAILABLE)
    }
  }

  private fun readBody(input: InputStream, kind: BodyKind): ByteArray {
    val body = object : ByteArrayOutputStream() {
      override fun write(bytes: ByteArray, off: Int, len: Int) {
        require(len <= MAX_BODY - count) { "roster_too_large" }
        super.write(bytes, off, len)
      }
    }
    when (kind) {
      is BodyKind.FIXED -> {
        require(kind.length <= MAX_BODY) { "roster_too_large" }
        HttpCodec.copyExactly(input, body, kind.length)
      }
      BodyKind.CHUNKED -> HttpCodec.copyChunked(input, body, decode = true)
      BodyKind.UNTIL_CLOSE -> HttpCodec.copyUntilEof(input, body, flushEach = false)
      BodyKind.NONE -> Unit
    }
    return body.toByteArray()
  }
}
