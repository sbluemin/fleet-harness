package com.dotobokuri.fleet.mobile

import android.util.JsonReader
import android.util.JsonToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.StringReader

/** Android's JSONObject(String) accepts non-JSON syntax and silently overwrites duplicate keys. */
internal object BridgeJson {
  fun parse(text: String): JSONObject? = try {
    JsonReader(StringReader(text)).use { reader ->
      val value = read(reader, 0) as? JSONObject
      value?.takeIf { reader.peek() == JsonToken.END_DOCUMENT }
    }
  } catch (_: Exception) { null }

  private fun read(reader: JsonReader, depth: Int): Any {
    require(depth <= 24)
    return when (reader.peek()) {
      JsonToken.BEGIN_OBJECT -> JSONObject().apply {
        reader.beginObject()
        while (reader.hasNext()) {
          val key = reader.nextName()
          require(!has(key))
          put(key, read(reader, depth + 1))
        }
        reader.endObject()
      }
      JsonToken.BEGIN_ARRAY -> JSONArray().apply {
        reader.beginArray()
        while (reader.hasNext()) put(read(reader, depth + 1))
        reader.endArray()
      }
      JsonToken.STRING -> reader.nextString()
      JsonToken.NUMBER -> reader.nextString().let { it.toLongOrNull() ?: it.toDouble() }
      JsonToken.BOOLEAN -> reader.nextBoolean()
      JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
      else -> throw IllegalArgumentException("invalid_json")
    }
  }
}
