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
    { id: "b", origin: "https://example.com", username: "grace", createdAt: 1, updatedAt: 2 },
    { id: "c", origin: "https://other.test", username: "bea", createdAt: 1, updatedAt: 2 },
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
  document.body.querySelector(".settings-password-scrim")?.remove();
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
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
  if (!found) throw new Error(`missing button ${label}`);
  return found as HTMLButtonElement;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("password manager settings", () => {
  it("opens one row per site and keeps the secret inside the detail dialog", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    let entries = vault.entries.map((entry) => ({ ...entry }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ method: init?.method ?? "GET", url, body });
      if (url.includes("/favicon")) return json({ error: "not_found" }, 404);
      if (url.endsWith("/reveal")) return body?.id === "missing" ? json({ error: "os_auth_cancelled" }, 403) : json({ password: secret });
      if (url.endsWith("/copy")) return json({ copied: true, password: secret });
      if (url.endsWith("/settings") && init?.method === "POST") return json({ offerToSave: body?.enabled === true });
      if (url.endsWith("/save")) return json({ entry: { id: "d", origin: "https://fresh.example", username: "ada", createdAt: 3, updatedAt: 3 }, created: true });
      if (url.endsWith("/update")) {
        entries = entries.map((entry) => entry.id === body?.id ? { ...entry, username: String(body?.username ?? entry.username) } : entry);
        return json({ entry: entries.find((entry) => entry.id === body?.id) });
      }
      if (url.endsWith("/delete") && !url.endsWith("/never-save")) {
        entries = entries.filter((entry) => entry.id !== body?.id);
        return json({ deleted: true });
      }
      if (url.endsWith("/never-save")) return json({ neverSaveOrigins: [] });
      return json({ ...vault, entries });
    });
    mount(fetchMock);
    await flush();

    expect(container!.textContent).toContain("example.com");
    expect(container!.textContent).toContain("other.test");
    expect(container!.textContent).not.toContain("ada");
    expect(container!.textContent).not.toContain(secret);
    expect(container!.textContent).toContain("2");
    const icon = container!.querySelector("img");
    expect(icon?.getAttribute("src")).toBe(`/api/v1/browser/passwords/favicon?origin=${encodeURIComponent("https://example.com")}`);
    act(() => { icon!.dispatchEvent(new Event("error")); });
    await flush();
    expect(container!.querySelector("img[src*='example.com']")).toBeNull();
    expect(container!.textContent).toContain("E");

    const search = container!.querySelector("input[type=search]") as HTMLInputElement;
    act(() => { setInput(search, "grace"); });
    await flush();
    expect(container!.textContent).toContain("example.com");
    expect(container!.textContent).not.toContain("other.test");
    act(() => { setInput(search, ""); });
    await flush();

    act(() => { buttonByLabel("example.com, 2").click(); });
    await flush();
    const dialog = document.body.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("ada");
    expect(dialog?.textContent).toContain("grace");
    expect(dialog?.textContent).toContain("https://example.com");
    expect(dialog?.textContent).not.toContain(secret);

    act(() => { buttonByLabel("Show ada https://example.com").click(); });
    await flush();
    expect(document.body.textContent).toContain(secret);
    let leaked = false;
    const bubble = (event: Event) => { if ((event as KeyboardEvent).key === "Escape") leaked = true; };
    window.addEventListener("keydown", bubble);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    window.removeEventListener("keydown", bubble);
    await flush();
    expect(leaked).toBe(false);
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);

    act(() => { buttonByLabel("other.test").click(); });
    await flush();
    act(() => { buttonByLabel("Copy bea https://other.test").click(); });
    await flush();
    expect(document.body.textContent).toContain("Copied");
    expect(document.body.textContent).not.toContain(secret);

    act(() => { buttonByLabel("Edit").click(); });
    await flush();
    const name = document.body.querySelector("form input") as HTMLInputElement;
    act(() => {
      setInput(name, "bea-2");
      document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/update") && call.body && (call.body as { username?: string }).username === "bea-2")).toBe(true);

    act(() => { buttonByLabel("Delete bea-2 https://other.test").click(); });
    await flush();
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/delete") && call.method === "POST")).toBe(true);

    act(() => { buttonByLabel("Add").click(); });
    await flush();
    const fields = [...document.body.querySelectorAll("form input")] as HTMLInputElement[];
    act(() => {
      setInput(fields[0]!, "https://fresh.example/login");
      setInput(fields[1]!, "ada");
      setInput(fields[2]!, secret);
      document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls.find((call) => call.url.endsWith("/save"))?.body).toMatchObject({ origin: "https://fresh.example", username: "ada", password: secret });
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);

    const offer = container!.querySelector("input[type=checkbox]") as HTMLInputElement;
    act(() => { offer.click(); });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/settings") && call.method === "POST" && (call.body as { enabled?: boolean }).enabled === false)).toBe(true);
    act(() => { buttonByLabel("Remove https://never.example").click(); });
    await flush();
    expect(calls.some((call) => call.url.endsWith("/never-save") && call.method === "DELETE")).toBe(true);
    expect(container!.textContent).not.toContain("never.example");

    act(() => { buttonByLabel("example.com, 2").click(); });
    await flush();
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/reveal") ? json({ error: "os_auth_cancelled" }, 403) : json({ ...vault, entries }));
    act(() => { buttonByLabel("Show ada https://example.com").click(); });
    await flush();
    expect(document.body.textContent).toContain("OS authentication was cancelled");
    expect(document.body.textContent).not.toContain(secret);
    act(() => { buttonByLabel("Done").click(); });
    await flush();
    expect(document.body.textContent).not.toContain(secret);
  });
});
