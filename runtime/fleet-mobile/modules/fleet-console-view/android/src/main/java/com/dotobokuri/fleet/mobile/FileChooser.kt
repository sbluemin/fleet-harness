package com.dotobokuri.fleet.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** An image request the shell may answer with the system picker. */
internal data class ImagePick(val mimeTypes: List<String>, val multiple: Boolean) {
  companion object {
    private val IMAGE_MIME = Regex("^image/(\\*|[a-z0-9][a-z0-9.+-]*)$")

    /**
     * Null denies the request. Only the committed Console page may ask, only to open files, and
     * only when every accepted type is an image MIME type; an empty accept list is not an image request.
     */
    fun from(fromActiveConsole: Boolean, mode: Int, acceptTypes: Array<String>?): ImagePick? {
      if (!fromActiveConsole) return null
      if (mode != FileChooserParams.MODE_OPEN && mode != FileChooserParams.MODE_OPEN_MULTIPLE) return null
      val types = acceptTypes.orEmpty()
        .flatMap { it.split(',') }
        .map { it.trim().lowercase(Locale.ROOT) }
        .filter { it.isNotEmpty() }
        .distinct()
      if (types.isEmpty() || !types.all(IMAGE_MIME::matches)) return null
      return ImagePick(types, mode == FileChooserParams.MODE_OPEN_MULTIPLE)
    }
  }

  fun intent(): Intent {
    val single = mimeTypes.singleOrNull()?.takeIf { it != "image/*" }
    // The system photo picker needs no storage permission; older systems fall back to the document picker.
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Intent(MediaStore.ACTION_PICK_IMAGES).apply {
        type = single ?: "image/*"
        if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
      }
    } else {
      Intent(Intent.ACTION_GET_CONTENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = single ?: "image/*"
        if (single == null && mimeTypes.any { it != "image/*" }) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
      }
    }
  }
}

/** WebView must hear exactly one answer per chooser request — a second one crashes the app. */
internal class FileChooserAnswer(
  val owner: Any,
  val multiple: Boolean,
  private val callback: ValueCallback<Array<Uri>>,
) {
  private val answered = AtomicBoolean(false)

  fun deliver(uris: Array<Uri>?) {
    if (answered.compareAndSet(false, true)) callback.onReceiveValue(uris)
  }
}

/**
 * Process-only handoff between the view that opened the picker and the module that receives the
 * activity result. One picker at a time; a process death drops the request with the page.
 */
internal object FileChooserRelay {
  const val REQUEST_CODE = 0x4643

  private val pending = AtomicReference<FileChooserAnswer?>(null)

  fun begin(answer: FileChooserAnswer): Boolean = pending.compareAndSet(null, answer)

  /** Ignores results that are not ours or arrive after the request was cancelled. */
  fun complete(requestCode: Int, resultCode: Int, data: Intent?, isForeignContent: (Uri) -> Boolean) {
    if (requestCode != REQUEST_CODE) return
    val answer = pending.getAndSet(null) ?: return
    answer.deliver(selected(resultCode, data, answer.multiple, isForeignContent))
  }

  fun cancel(answer: FileChooserAnswer) {
    pending.compareAndSet(answer, null)
    answer.deliver(null)
  }

  fun cancelFor(owner: Any) {
    val answer = pending.get() ?: return
    if (answer.owner === owner) cancel(answer)
  }

  /** Only content another app serves reaches the page; a picker cannot hand back this app's own files. */
  internal fun selected(resultCode: Int, data: Intent?, multiple: Boolean, isForeignContent: (Uri) -> Boolean): Array<Uri>? {
    if (resultCode != Activity.RESULT_OK || data == null) return null
    val candidates = buildList {
      data.clipData?.let { clip -> for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(::add) }
      if (isEmpty()) data.data?.let(::add)
    }
    val accepted = candidates
      .filter { it.scheme == "content" && !it.authority.isNullOrEmpty() && isForeignContent(it) }
      .distinct()
      .let { if (multiple) it else it.take(1) }
    return accepted.takeIf { it.isNotEmpty() }?.toTypedArray()
  }
}
