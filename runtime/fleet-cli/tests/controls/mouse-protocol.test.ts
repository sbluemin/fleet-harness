import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createMouseProtocol } from "../../src/controls/pty.js";

describe("mouse protocol", () => {
  it("detects DECSET and DECRST mouse protocol state from child output", () => {
    const protocol = createMouseProtocol();

    protocol.detectChildRequest("\x1b[?1000h\x1b[?1006h");
    assert.deepEqual(protocol.getState(), {
      activeEncoding: "sgr",
      activeProtocol: "vt200",
      mouseTrackingEnabled: true,
    });

    protocol.detectChildRequest("\x1b[?1006l");
    assert.deepEqual(protocol.getState(), {
      activeEncoding: "default",
      activeProtocol: "vt200",
      mouseTrackingEnabled: false,
    });
  });

  it("handles batched and mixed private mode chunks", () => {
    const protocol = createMouseProtocol();

    protocol.detectChildRequest("before\x1b[?25l\x1b[?1002;1006hafter");

    assert.deepEqual(protocol.getState(), {
      activeEncoding: "sgr",
      activeProtocol: "drag",
      mouseTrackingEnabled: true,
    });
  });

  it("requires wheel-capable protocol and SGR encoding", () => {
    const protocol = createMouseProtocol();

    protocol.detectChildRequest("\x1b[?9h\x1b[?1006h");
    assert.equal(protocol.getState().mouseTrackingEnabled, false);

    protocol.detectChildRequest("\x1b[?1000h\x1b[?1006l");
    assert.equal(protocol.getState().mouseTrackingEnabled, false);

    protocol.detectChildRequest("\x1b[?1000h\x1b[?1006h");
    assert.equal(protocol.getState().mouseTrackingEnabled, true);

    protocol.detectChildRequest("\x1b[?1000l");
    assert.equal(protocol.getState().mouseTrackingEnabled, false);
  });
});
