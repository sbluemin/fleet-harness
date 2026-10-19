package com.dotobokuri.fleet.mobile

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.WebChromeClient.FileChooserParams
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FileChooserTest {
  @Test
  fun pickerOpensOnlyForConsoleImageRequestsAndAnswersEachRequestOnce() {
    val images = arrayOf("image/*")
    assertNull(ImagePick.from(fromActiveConsole = false, FileChooserParams.MODE_OPEN, images))
    assertNull(ImagePick.from(fromActiveConsole = true, FileChooserParams.MODE_OPEN, arrayOf("image/png", "application/pdf")))
    assertNull(ImagePick.from(fromActiveConsole = true, FileChooserParams.MODE_OPEN, arrayOf("")))
    assertNull(ImagePick.from(fromActiveConsole = true, FileChooserParams.MODE_SAVE, images))
    assertNotNull(ImagePick.from(fromActiveConsole = true, FileChooserParams.MODE_OPEN_MULTIPLE, arrayOf("image/png,image/jpeg")))

    val answers = mutableListOf<Array<Uri>?>()
    val page = Any()
    val answer = FileChooserAnswer(page, multiple = true) { answers.add(it) }
    assertTrue(FileChooserRelay.begin(answer))
    assertFalse(FileChooserRelay.begin(FileChooserAnswer(Any(), multiple = false) { answers.add(it) }))

    val picked = Uri.parse("content://media/picker/0/1")
    val result = Intent().apply {
      clipData = ClipData.newRawUri(null, Uri.parse("file:///data/data/com.dotobokuri.fleet.mobile/shared_prefs/x.xml")).apply {
        addItem(ClipData.Item(picked))
        addItem(ClipData.Item(Uri.parse("content://com.dotobokuri.fleet.mobile.own/secret")))
      }
    }
    FileChooserRelay.complete(FileChooserRelay.REQUEST_CODE, Activity.RESULT_OK, result) { it.authority == "media" }
    FileChooserRelay.cancelFor(page)
    FileChooserRelay.complete(FileChooserRelay.REQUEST_CODE, Activity.RESULT_CANCELED, null) { true }

    assertEquals(1, answers.size)
    assertArrayEquals(arrayOf(picked), answers.single())

    val cancelled = FileChooserAnswer(page, multiple = false) { answers.add(it) }
    assertTrue(FileChooserRelay.begin(cancelled))
    FileChooserRelay.complete(FileChooserRelay.REQUEST_CODE, Activity.RESULT_CANCELED, null) { true }
    cancelled.deliver(null)
    assertEquals(2, answers.size)
    assertNull(answers.last())

    // A page whose renderer died is answered at once; the picker result that follows is dropped.
    val orphaned = FileChooserAnswer(page, multiple = false) { answers.add(it) }
    assertTrue(FileChooserRelay.begin(orphaned))
    FileChooserRelay.cancelFor(page)
    FileChooserRelay.complete(FileChooserRelay.REQUEST_CODE, Activity.RESULT_OK, Intent().setData(picked)) { true }
    assertEquals(3, answers.size)
    assertNull(answers.last())
  }
}
