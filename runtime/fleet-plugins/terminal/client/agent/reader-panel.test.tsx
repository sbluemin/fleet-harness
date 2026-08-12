// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RevealedMarkdown } from "./reader-panel.js";
import { parseReaderFrame } from "./reader-types.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode): HTMLDivElement {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  act(() => root!.render(node));
  return container;
}

function stubFrames(): { readonly run: () => void } {
  const pending: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  return {
    run: () => {
      const queued = pending.splice(0, pending.length);
      for (const callback of queued) callback(performance.now());
    },
  };
}

describe("transcript reader reveal", () => {
  it("paints a block that is not being revealed in full immediately", () => {
    const node = render(<RevealedMarkdown text="A finished paragraph." revealing={false} language="en" />);

    expect(node.textContent).toContain("A finished paragraph.");
  });

  it("snaps a partly revealed block to full as soon as a newer block arrives", () => {
    const frames = stubFrames();
    const text = "A long assistant answer that would otherwise take a while to reveal.";
    render(<RevealedMarkdown text={text} revealing={true} language="en" />);
    act(() => frames.run());

    // The reveal stops the moment `revealing` drops — the reader is never shown less than the
    // session has already produced.
    render(<RevealedMarkdown text={text} revealing={false} language="en" />);

    expect(container?.textContent).toContain(text);
  });

  it("short-circuits the reveal under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const text = "Motion-sensitive readers get the whole block at once.";

    const node = render(<RevealedMarkdown text={text} revealing={true} language="en" />);

    expect(node.textContent).toContain(text);
  });
});

describe("transcript reader frame parsing", () => {
  it("accepts the frames the server actually sends", () => {
    expect(parseReaderFrame({ type: "opened", generation: 1, truncated: false, reset: true }))
      .toEqual({ type: "opened", generation: 1, truncated: false, reset: true });
    expect(parseReaderFrame({
      type: "live",
      generation: 2,
      blocks: [{ seq: 4, role: "assistant", kind: "text", text: "hello" }],
    })).toEqual({
      type: "live",
      generation: 2,
      blocks: [{ seq: 4, role: "assistant", kind: "text", text: "hello" }],
    });
  });

  it("rejects a frame carrying a block shape the reader does not define", () => {
    expect(parseReaderFrame({ type: "live", generation: 1, blocks: [{ seq: 1, role: "assistant", kind: "transcript" }] })).toBeNull();
    expect(parseReaderFrame({ type: "live", generation: 1, blocks: [{ seq: 0, role: "assistant", kind: "text" }] })).toBeNull();
    expect(parseReaderFrame({ type: "live", generation: 1, blocks: [{ seq: 1, role: "system", kind: "text" }] })).toBeNull();
    expect(parseReaderFrame({ type: "live", blocks: [] })).toBeNull();
  });

  it("drops fields the reader contract does not carry", () => {
    const frame = parseReaderFrame({
      type: "backfill",
      generation: 1,
      blocks: [{ seq: 1, role: "assistant", kind: "text", text: "ok", transcriptPath: "/secret/transcript.jsonl", sessionId: "provider-secret" }],
    });

    expect(JSON.stringify(frame)).not.toMatch(/transcriptPath|provider-secret|transcript\.jsonl/u);
  });
});
