// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { installCodeCopyHandler, renderMarkdown } from "@fleet-console/markdown/core";

/**
 * 코드블록 Copy 버튼은 마크다운 렌더러가 만든다. 렌더된 HTML을 붙이는 표면이 동작을 설치하지
 * 않으면 보이는 컨트롤이 아무 일도 하지 않는다 — 툴팁이 약속한 상호작용을 코드가 끄는 결함이다.
 */
function mountRendered(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(markdown, { untrustedRemoteBody: true, copyLabel: "Copy" }).html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("rendered code-block copy control", () => {
  it("writes the block source to the clipboard when the button is clicked", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const host = mountRendered("```bash\necho hi\n```");
    const release = installCodeCopyHandler(host, { copiedLabel: "Copied" });

    host.querySelector<HTMLElement>('[data-action="copy-code"]')!.click();
    await Promise.resolve();

    // data-code는 코드블록의 원본 텍스트를 그대로 담는다(마지막 개행 포함 여부는 렌더러 소관).
    expect(writeText).toHaveBeenCalledTimes(1);
    const [firstCall] = writeText.mock.calls;
    expect(String((firstCall as unknown as readonly unknown[] | undefined)?.[0] ?? "").trim()).toBe("echo hi");
    release();
  });

  it("shows the copied label and restores the original", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => undefined } });
    const host = mountRendered("```bash\necho hi\n```");
    const release = installCodeCopyHandler(host, { copiedLabel: "Copied" });
    const button = host.querySelector<HTMLElement>('[data-action="copy-code"]')!;

    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button.textContent).toBe("Copied");

    await vi.advanceTimersByTimeAsync(1_300);
    expect(button.textContent).toBe("Copy");
    release();
    vi.useRealTimers();
  });

  it("stops handling once released", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const host = mountRendered("```bash\necho hi\n```");
    installCodeCopyHandler(host, { copiedLabel: "Copied" })();

    host.querySelector<HTMLElement>('[data-action="copy-code"]')!.click();
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });

  it("ignores a clipboard-less environment instead of throwing", () => {
    vi.stubGlobal("navigator", {});
    const host = mountRendered("```bash\necho hi\n```");
    const release = installCodeCopyHandler(host, { copiedLabel: "Copied" });
    expect(() => host.querySelector<HTMLElement>('[data-action="copy-code"]')!.click()).not.toThrow();
    release();
  });
});
