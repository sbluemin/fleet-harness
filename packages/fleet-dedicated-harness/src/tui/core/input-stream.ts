import type { LocalTui } from "./renderer.js";

export function attachInputStream(ui: LocalTui): () => void {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const onData = (data: Buffer | string) => {
    ui.emitInput(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  };

  stdin.setEncoding("utf8");
  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", onData);

  return () => {
    stdin.off("data", onData);
    if (stdin.isTTY) {
      stdin.setRawMode(Boolean(wasRaw));
    }
  };
}

