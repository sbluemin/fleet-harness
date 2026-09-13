import { spawn } from "node:child_process";
import { marked } from "marked";
import { ComputerUseInputError } from "./computer-use-platform.js";

export type ClipboardRestoration = "restored" | "preserved_newer_contents" | "failed";

// The previous clipboard stays in this short-lived process's memory, never argv,
// disk, logs or model output. EOF (including parent exit) releases the clipboard.
const PASTEBOARD = String.raw`
ObjC.import('AppKit');
function run() {
  var input=$.NSFileHandle.fileHandleWithStandardInput, output=$.NSFileHandle.fileHandleWithStandardOutput;
  function emit(value) { output.writeData($(JSON.stringify(value)+'\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
  function read(length) {
    var data=$.NSMutableData.data;
    while (data.length<length) {
      var chunk=input.readDataOfLength(length-data.length);
      if (!chunk.length) throw Error('input_closed');
      data.appendData(chunk);
    }
    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding));
  }
  var length=Number(read(8));
  if (!Number.isSafeInteger(length)||length<1||length>2000000) throw Error('invalid_input');
  var payload=JSON.parse(read(length)), board=$.NSPasteboard.generalPasteboard;
  var originalCount=Number(board.changeCount), saved=[], items=board.pasteboardItems, bytes=0;
  for (var i=0;i<items.count;i++) {
    var source=items.objectAtIndex(i), copy=$.NSPasteboardItem.alloc.init, types=source.types;
    for (var j=0;j<types.count;j++) {
      var type=types.objectAtIndex(j), data=source.dataForType(type);
      bytes+=Number(data.length);
      if (bytes>64*1024*1024) throw Error('clipboard_backup_too_large');
      if (!data || !copy.setDataForType(data,type)) throw Error('clipboard_backup_failed');
    }
    saved.push(copy);
  }
  var replacement=$.NSPasteboardItem.alloc.init;
  if (!replacement.setStringForType($(payload.text),$('public.utf8-plain-text'))) throw Error('clipboard_encode_failed');
  if (payload.html!==undefined && !replacement.setStringForType($(payload.html),$('public.html'))) throw Error('clipboard_encode_failed');
  if (Number(board.changeCount)!==originalCount) throw Error('clipboard_changed');
  if (payload.allowActivation!==true) {
    var front=$.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!(ObjC.unwrap(front.bundleIdentifier)===payload.app || ObjC.unwrap(front.bundleURL.path)===payload.app || ObjC.unwrap(front.localizedName)===payload.app)) {
      emit({activationBlocked:true});
      return;
    }
  }
  board.clearContents;
  var ownedCount=Number(board.changeCount);
  try {
    var written=board.writeObjects($([replacement]));
    ownedCount=Number(board.changeCount);
    if (!written) throw Error('clipboard_write_failed');
    emit({ready:true});
    input.readDataToEndOfFile;
  } finally {
    if (Number(board.changeCount)!==ownedCount) emit({restoration:'preserved_newer_contents'});
    else {
      board.clearContents;
      var restored=!saved.length || board.writeObjects($(saved));
      emit({restoration:restored?'restored':'failed'});
    }
  }
}`;

export async function prepareMacPaste(app: string, text: string, format: "text" | "md" | "html", allowActivation: boolean): Promise<{ finish(): Promise<ClipboardRestoration> }> {
  const markup = format === "md" ? await marked.parse(text, { async: false }) : format === "html" ? text : undefined;
  // NSPasteboard HTML otherwise defaults to a legacy encoding in some Mac apps.
  const html = markup === undefined ? undefined : `<meta charset="utf-8">${markup}`;
  const payload = Buffer.from(JSON.stringify({ app, allowActivation, text, ...(html === undefined ? {} : { html }) }));
  const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", PASTEBOARD], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); // Never forward errors that might contain clipboard content.
  let restoration: ClipboardRestoration = "failed";
  let ready = false;
  let output = "";
  let release!: () => void;
  let rejectReady!: (error: Error) => void;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    child.stdin.end();
    closeTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  const started = new Promise<void>((resolve, reject) => { release = resolve; rejectReady = reject; });
  const finished = new Promise<ClipboardRestoration>((resolve) => {
    child.once("close", () => {
      clearTimeout(startTimer);
      clearTimeout(leaseTimer);
      clearTimeout(closeTimer);
      if (!ready) rejectReady(new Error("computer_use_clipboard_prepare_failed"));
      resolve(restoration);
    });
  });
  const fail = () => { close(); rejectReady(new Error("computer_use_clipboard_prepare_failed")); };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 4096) { fail(); return; }
    let newline: number;
    while ((newline = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        if (record.activationBlocked === true) { close(); rejectReady(new ComputerUseInputError("computer_use_activation_blocked", "The target stopped being frontmost before clipboard replacement. No paste key was sent.")); }
        if (record.ready === true) { ready = true; clearTimeout(startTimer); release(); }
        if (["restored", "preserved_newer_contents", "failed"].includes(record.restoration)) restoration = record.restoration;
      } catch { fail(); }
    }
  });
  // Native actions time out at 90 seconds. Never leave our pasteboard lease open.
  const startTimer = setTimeout(fail, 5000);
  const leaseTimer = setTimeout(close, 100_000);
  child.stdin.write(Buffer.concat([Buffer.from(String(payload.length).padStart(8, "0")), payload]));
  try { await started; }
  catch (error) { close(); await finished; throw error; }
  return { finish: async () => { close(); return finished; } };
}
