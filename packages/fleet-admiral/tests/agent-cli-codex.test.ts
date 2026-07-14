import { describe, expect, it } from "vitest";

import { buildCodexPlatformArgs } from "../src/agent-cli/codex/codex.js";

describe("Codex Agent CLI profile", () => {
  it("adds Ctrl+Enter to the session-local editor newline keymap on Windows", () => {
    expect(buildCodexPlatformArgs("win32")).toEqual([
      "-c",
      "tui.keymap.editor.insert_newline=['ctrl-j','ctrl-m','enter','shift-enter','alt-enter','ctrl-enter']",
    ]);
  });

  it.each(["darwin", "linux"] satisfies NodeJS.Platform[])("does not override the editor newline keymap on %s", (platform) => {
    expect(buildCodexPlatformArgs(platform)).toEqual([]);
  });
});
