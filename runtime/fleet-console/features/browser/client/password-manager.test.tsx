// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordManagerCard } from "./password-manager.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const secret = "s3cret-value";
const vault = {
  available: true,
  reason: null,
  offerToSave: true,
  osAuthSupported: true,
  entries: [
    { id: "a", origin: "https://example.com", username: "ada", createdAt: 1, updatedAt: 2, password: secret },
    { id: "b", origin: "https://other.test", username: "grace", createdAt: 1, updatedAt: 2 },
  ],
  neverSaveOrigins: ["https://never.example"],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mount(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => { root!.render(createElement(PasswordManagerCard)); });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("password manager settings", () => {
  it("lists and searches metadata, and never keeps a revealed secret after the section closes", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      calls.push({ method: init?.method ?? "GET", url, body });
      if (url.endsWith("/reveal")) return json({ password: secret });
      if (url.endsWith("/copy")) return json({ copied: true, password: secret });
      if (url.endsWith("/settings") && init?.method === "POST") return json({ offerToSave: false });
      if (url.endsWith("/save")) return json({ entry: { id: "c", origin: "https://fresh.example", username: "ada", createdAt: 3, updatedAt: 3 }, created: true });
      if (url.endsWith("/update")) return json({ entry: { id: "a", origin: "https://example.com", username: "ada-2", createdAt: 1, updatedAt: 4 } });
      if (url.endsWith("/delete") && !url.endsWith("/never-save")) return json({ deleted: true });
      if (url.endsWith("/never-save")) return json({ neverSaveOrigins: [] });
      return json(vault);
    });
    mount(fetchMock);
    await flush();
    expect(container!.textContent).toContain("https://example.com");
    expect(container!.textContent).toContain("ada");
    expect(container!.textContent).not.toContain(secret);

    const search = container!.querySelector("input[type=search]") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setValue.call(search, "grace"); search.dispatchEvent(new Event("input", { bubbles: true })); search.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(container!.textContent).toContain("https://other.test");
    expect(container!.textContent).not.toContain("https://example.com");

    act(() => { setValue.call(search, ""); search.dispatchEvent(new Event("input", { bubbles: true })); search.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    const show = [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show https://example.com");
    act(() => { show!.click(); });
    await flush();
    expect(container!.textContent).toContain(secret);
    act(() => root?.unmount());
    root = null;
    expect(document.body.textContent).not.toContain(secret);

    mount(fetchMock);
    await flush();
    const copy = [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Copy https://example.com");
    act(() => { copy!.click(); });
    await flush();
    expect(container!.textContent).toContain("Copied");
    expect(container!.textContent).not.toContain(secret);
    expect(calls.some((call) => call.url.endsWith("/copy") && call.method === "POST")).toBe(true);

    const remove = [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Remove https://never.example");
    act(() => { remove!.click(); });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/never-save") && call.method === "DELETE")).toBe(true);
    expect(container!.textContent).not.toContain("https://never.example");

    const add = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Add password");
    act(() => { add!.click(); });
    await flush();
    const fields = [...container!.querySelectorAll("input")].filter((input) => input.type !== "search" && input.type !== "checkbox");
    act(() => {
      setValue.call(fields[0], "https://fresh.example/login");
      fields[0]!.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(fields[1], "ada");
      fields[1]!.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(fields[2], secret);
      fields[2]!.dispatchEvent(new Event("input", { bubbles: true }));
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    const saved = calls.find((call) => call.url.endsWith("/save"));
    expect(saved?.body).toMatchObject({ origin: "https://fresh.example", username: "ada", password: secret });
    expect(container!.querySelector("input[type=password]")?.getAttribute("value") ?? "").not.toContain(secret);

    const edit = [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Edit https://example.com");
    act(() => { edit!.click(); });
    await flush();
    const editFields = [...container!.querySelectorAll("form input")];
    act(() => {
      setValue.call(editFields[0], "ada-2");
      editFields[0]!.dispatchEvent(new Event("input", { bubbles: true }));
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/update") && (call.body as { username?: string }).username === "ada-2")).toBe(true);

    const del = [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Delete https://example.com");
    act(() => { del!.click(); });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/delete") && call.method === "POST")).toBe(true);

    const offer = container!.querySelector("input[type=checkbox]") as HTMLInputElement;
    act(() => { offer.click(); });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/settings") && call.method === "POST" && (call.body as { enabled?: boolean }).enabled === false)).toBe(true);

    fetchMock.mockImplementation(async (url: string) => url.endsWith("/reveal") ? json({ error: "os_auth_cancelled" }, 403) : json(vault));
    const showAgain = [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Show https://example.com");
    act(() => { showAgain!.click(); });
    await flush();
    expect(container!.textContent).toContain("OS authentication was cancelled");
    expect(container!.textContent).not.toContain(secret);
  });
});
