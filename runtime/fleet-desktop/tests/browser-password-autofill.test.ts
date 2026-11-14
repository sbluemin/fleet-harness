import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_BROWSER_EVENT,
  DESKTOP_BROWSER_EVENTS_PATH,
  DESKTOP_BROWSER_PATH,
  DESKTOP_BROWSER_RELAY_PATH,
  type DesktopBrowserSnapshot,
} from "@fleet-console/protocol/desktop";
import { passwordPromptIdentity, passwordRevealText, readChromeMessage } from "../src/chrome/contract.js";
import {
  chooseAutofillCredential,
  chooseLoginForm,
  createBrowserPasswordPageAgent,
  decideSavePrompt,
  fleetPasswordFill,
  fleetPasswordScan,
  fleetPasswordSession,
  loginFormKey,
  PASSWORD_CONSOLE_PREFIX,
  type BrowserPasswordPageAgentDeps,
  type FleetPasswordDocument,
  type FleetPasswordDomEvent,
  type FleetPasswordInput,
  type FleetPasswordNode,
  type FleetPasswordPageScan,
  type PasswordPrompt,
  type StoredLoginCredential,
} from "../src/browser-password-page.js";
import type { PasswordMatchType } from "../src/browser-password-vault.js";
import { createDesktopBrowserViews, type PageHost } from "../src/browser-views.js";

class FakeInput implements FleetPasswordInput {
  tagName = "INPUT";
  attrs = new Map<string, string>();
  form: FakeForm | null = null;
  dispatched: unknown[] = [];
  focused = false;
  visible = true;
  #value = "";
  get value(): string { return this.#value; }
  set value(next: string) { this.#value = next; }
  get disabled(): boolean { return this.attrs.has("disabled"); }
  offsetParent: unknown = {};
  constructor(init: { type?: string; name?: string; id?: string; autocomplete?: string; value?: string; form?: FakeForm | null; button?: boolean; tag?: string } = {}) {
    if (init.tag !== undefined) this.tagName = init.tag;
    if (init.type !== undefined) this.attrs.set("type", init.type);
    if (init.name !== undefined) this.attrs.set("name", init.name);
    if (init.id !== undefined) this.attrs.set("id", init.id);
    if (init.autocomplete !== undefined) this.attrs.set("autocomplete", init.autocomplete);
    if (init.value !== undefined) this.#value = init.value;
    if (init.form !== undefined) this.form = init.form;
    if (init.button) this.attrs.set("data-button", "1");
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  getClientRects(): ArrayLike<unknown> { return this.visible ? [{ width: 10, height: 10 }] : []; }
  closest(selector: string): unknown {
    if (selector === "form") return this.form;
    if (this.tagName === "BUTTON" || this.attrs.get("data-button") === "1") return this;
    return null;
  }
  focus(): void { this.focused = true; }
  click(): void { /* 기록 불필요 */ }
  dispatchEvent(event: unknown): boolean { this.dispatched.push(event); return true; }
  querySelectorAll(): ArrayLike<FleetPasswordInput> { return []; }
}

class FakeForm implements FleetPasswordNode {
  tagName = "FORM";
  children: FakeInput[] = [];
  constructor(public action = "") {}
  getAttribute(name: string): string | null { return name === "action" ? this.action : null; }
  querySelectorAll(selector: string): ArrayLike<FleetPasswordInput> {
    return this.children.filter((child) => matchSelector(child, selector));
  }
}

function matchSelector(element: FakeInput, selector: string): boolean {
  for (const part of selector.split(",")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("input")) continue;
    const type = element.attrs.get("type");
    const typed = /\[type=(?:"([^"]+)"|([^\]]+))\]/.exec(trimmed);
    if (trimmed.includes(":not([type])")) {
      if (type === undefined) return true;
      continue;
    }
    if (typed) {
      if (type === (typed[1] ?? typed[2])) return true;
      continue;
    }
    return true;
  }
  return false;
}

class FakeDoc implements FleetPasswordDocument {
  tagName = "#document";
  listeners = new Map<string, ((event: FleetPasswordDomEvent) => void)[]>();
  constructor(public children: FakeInput[] = []) {}
  getAttribute(): string | null { return null; }
  querySelectorAll(selector: string): ArrayLike<FleetPasswordInput> {
    return this.children.filter((child) => matchSelector(child, selector));
  }
  addEventListener(type: string, listener: (event: FleetPasswordDomEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: FleetPasswordDomEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const inputEvent = (target: unknown, extra: Partial<FleetPasswordDomEvent> = {}): FleetPasswordDomEvent => ({
  target, type: "event", ...extra, preventDefault: () => undefined,
});

const loginDoc = (): { doc: FakeDoc; form: FakeForm; user: FakeInput; password: FakeInput } => {
  const form = new FakeForm("/login");
  const user = new FakeInput({ type: "text", name: "username", autocomplete: "username", form });
  const password = new FakeInput({ type: "password", name: "password", autocomplete: "current-password", form });
  form.children.push(user, password);
  return { doc: new FakeDoc([user, password]), form, user, password };
};

describe("isolated login form scan", () => {
  it("finds the username paired with a visible password", () => {
    const { doc } = loginDoc();
    const scan = fleetPasswordScan(doc);
    expect(scan.forms).toHaveLength(1);
    expect(scan.forms[0]).toMatchObject({ usernameName: "username", usernameVisible: true, newPassword: false, passwordHasValue: false });
    expect(scan.forms[0]).not.toHaveProperty("passwordValue");
    expect(chooseLoginForm(scan.forms)?.usernameName).toBe("username");
  });

  it("skips hidden passwords and marks signup forms", () => {
    const form = new FakeForm("/join");
    const hidden = new FakeInput({ type: "password", name: "pw", form });
    hidden.visible = false;
    const first = new FakeInput({ type: "password", name: "new", autocomplete: "new-password", form });
    const confirm = new FakeInput({ type: "password", name: "confirm", autocomplete: "new-password", form });
    form.children.push(hidden, first, confirm);
    const scan = fleetPasswordScan(new FakeDoc([hidden, first, confirm]));
    expect(scan.forms).toHaveLength(2);
    expect(scan.forms.every((form) => form.newPassword)).toBe(true);
    expect(chooseLoginForm(scan.forms)).toBeNull();
  });

  it("prefers the username-autocomplete candidate in document scope", () => {
    const mail = new FakeInput({ type: "email", name: "mail", value: "a@b.c" });
    const text = new FakeInput({ type: "text", name: "q" });
    const password = new FakeInput({ type: "password", name: "pw" });
    const user = new FakeInput({ name: "login", autocomplete: "username" });
    const scan = fleetPasswordScan(new FakeDoc([mail, text, password, user]));
    expect(scan.forms[0]?.usernameName).toBe("login");
    expect(scan.forms[0]?.usernameValue).toBe("");
  });
});

describe("isolated fill", () => {
  it("sets values through the native setter and notifies frameworks", () => {
    const RealEvent = (globalThis as unknown as { Event?: unknown }).Event;
    (globalThis as unknown as { Event?: unknown }).Event = class {
      type: string;
      init: unknown;
      constructor(type: string, init: unknown) { this.type = type; this.init = init; }
    };
    try {
      const { doc, user, password } = loginDoc();
      const calls: string[] = [];
      const proto = Object.getPrototypeOf(user) as { value?: unknown };
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      expect(typeof descriptor?.set).toBe("function");
      expect(fleetPasswordFill(doc, { form: 0, usernameName: "username", username: "ada", password: "s3cr3t" })).toBe(true);
      expect(user.value).toBe("ada");
      expect(password.value).toBe("s3cr3t");
      for (const element of [user, password]) {
        const types = element.dispatched.map((event) => (event as { type?: unknown }).type);
        expect(types).toEqual(["input", "change"]);
        for (const event of element.dispatched) calls.push(JSON.stringify((event as { init?: unknown }).init));
      }
      expect(calls.every((init) => init.includes("true"))).toBe(true);
    } finally {
      (globalThis as unknown as { Event?: unknown }).Event = RealEvent;
    }
  });

  it("never overwrites a different username the person already typed", () => {
    const { doc } = loginDoc();
    doc.children[0]!.value = "someone-else";
    expect(fleetPasswordFill(doc, { form: 0, usernameName: "username", username: "ada", password: "s3cr3t" })).toBe(false);
    expect(doc.children[1]!.value).toBe("");
  });

  it("returns false when the form is gone", () => {
    const { doc } = loginDoc();
    expect(fleetPasswordFill(doc, { form: 3, usernameName: "username", username: "ada", password: "s3cr3t" })).toBe(false);
  });
});

describe("isolated submit and focus reporters", () => {
  const session = (doc: FakeDoc, mutateDelayMs = 0): string[] => {
    const posted: string[] = [];
    fleetPasswordSession(doc, (text) => posted.push(text), { scan: (scope, withValues) => fleetPasswordScan(scope, withValues) }, mutateDelayMs);
    return posted;
  };

  it("reports a submit once and skips signup or empty values", () => {
    const { doc, form, user, password } = loginDoc();
    const posted = session(doc);
    user.value = "ada";
    password.value = "s3cr3t";
    doc.fire("submit", inputEvent(form));
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!)).toEqual({ kind: "submitted", username: "ada", password: "s3cr3t" });

    password.value = "";
    doc.fire("submit", inputEvent(form));
    expect(posted).toHaveLength(1);
  });

  it("reports a formless button click and Enter as a submit", () => {
    const user = new FakeInput({ type: "text", name: "u", value: "ada" });
    const password = new FakeInput({ type: "password", name: "p", value: "pw" });
    const button = new FakeInput({ button: true });
    button.tagName = "BUTTON";
    const doc = new FakeDoc([user, password, button]);
    const posted = session(doc);
    doc.fire("click", inputEvent(button));
    expect(posted).toHaveLength(1);
    doc.fire("keydown", inputEvent(password, { type: "keydown", key: "Enter" }));
    expect(posted).toHaveLength(2);
  });

  it("reports an in-form React-style button while native submits stay single", () => {
    const form = new FakeForm("/login");
    const user = new FakeInput({ type: "text", name: "u", value: "ada", form });
    const password = new FakeInput({ type: "password", name: "p", value: "pw", form });
    const jsButton = new FakeInput({ tag: "BUTTON", type: "button", form });
    const nativeButton = new FakeInput({ tag: "BUTTON", type: "submit", form });
    form.children.push(user, password, jsButton, nativeButton);
    const doc = new FakeDoc([user, password, jsButton, nativeButton]);
    const posted = session(doc);
    doc.fire("click", inputEvent(jsButton));
    expect(posted.map((text) => JSON.parse(text))).toEqual([{ kind: "submitted", username: "ada", password: "pw" }]);
    doc.fire("click", inputEvent(nativeButton));
    expect(posted).toHaveLength(1);
    doc.fire("submit", inputEvent(form));
    expect(posted).toHaveLength(2);
  });

  it("reports Enter inside a form as a submit signal", () => {
    const { doc, password, user } = loginDoc();
    const posted = session(doc);
    user.value = "ada";
    password.value = "pw";
    doc.fire("keydown", inputEvent(password, { type: "keydown", key: "Enter" }));
    expect(posted.map((text) => JSON.parse(text))).toEqual([{ kind: "submitted", username: "ada", password: "pw" }]);
  });

  it("banks typed credentials as user-input and never reports empties", () => {
    const { doc, user, password } = loginDoc();
    const posted = session(doc);
    user.value = "ada";
    doc.fire("input", inputEvent(user, { type: "input" }));
    expect(posted).toHaveLength(0);
    password.value = "pw";
    doc.fire("input", inputEvent(password, { type: "input" }));
    doc.fire("change", inputEvent(password, { type: "change" }));
    expect(posted.map((text) => JSON.parse(text))).toEqual([{ kind: "user-input", username: "ada", password: "pw" }]);
    // JS 가 비우듯 password 만 지워도 빈 쌍은 보고하지 않는다.
    password.value = "";
    doc.fire("input", inputEvent(password, { type: "input" }));
    expect(posted).toHaveLength(1);
  });

  it("reports focus on plain text inputs of a login form without autocomplete", () => {
    const form = new FakeForm("/login");
    const user = new FakeInput({ type: "text", name: "id", form });
    const password = new FakeInput({ type: "password", name: "pw", form });
    form.children.push(user, password);
    const doc = new FakeDoc([user, password]);
    const posted = session(doc);
    doc.fire("focusin", inputEvent(user));
    doc.fire("focusin", inputEvent(password));
    doc.fire("click", inputEvent(user));
    expect(posted.map((text) => JSON.parse(text))).toEqual([{ kind: "field-focused" }, { kind: "field-focused" }, { kind: "field-focused" }]);
  });

  it("reports focus on text inputs near a login form, and silence without one", () => {
    const { doc, user, password } = loginDoc();
    const other = new FakeInput({ type: "text", name: "search" });
    doc.children.push(other);
    const posted = session(doc);
    doc.fire("focusin", inputEvent(other));
    doc.fire("focusin", inputEvent(user));
    doc.fire("focusin", inputEvent(password));
    expect(posted.map((text) => JSON.parse(text))).toEqual([{ kind: "field-focused" }, { kind: "field-focused" }, { kind: "field-focused" }]);

    const plain = new FakeDoc([new FakeInput({ type: "text", name: "q" })]);
    const silent = session(plain);
    plain.fire("focusin", inputEvent(plain.children[0]!));
    expect(silent).toHaveLength(0);
  });

  it("reports dynamic DOM changes through the observer", async () => {
    const observers: { callback: () => void; target: unknown }[] = [];
    const RealObserver = (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver;
    (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver = class {
      constructor(private callback: () => void) { observers.push({ callback: this.callback, target: null }); }
      observe(target: unknown): void { observers[observers.length - 1]!.target = target; }
    };
    try {
      const { doc } = loginDoc();
      const posted = session(doc);
      expect(observers).toHaveLength(1);
      observers[0]!.callback();
      observers[0]!.callback();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(posted.map((text) => JSON.parse(text))).toEqual([{ kind: "forms-changed" }]);
    } finally {
      (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver = RealObserver;
    }
  });
});

describe("autofill and save decisions", () => {
  const creds: StoredLoginCredential[] = [
    { id: "old", username: "ada", updatedAt: 100, matchType: "exact" },
    { id: "new", username: "grace", updatedAt: 300, matchType: "exact" },
  ];

  it("fills the latest account on agent tabs, one account on user tabs, and asks otherwise", () => {
    expect(chooseAutofillCredential([], true)).toBeNull();
    expect(chooseAutofillCredential([creds[0]!], false)).toEqual(creds[0]);
    expect(chooseAutofillCredential(creds, true)).toEqual(creds[1]);
    expect(chooseAutofillCredential(creds, false)).toBe("pick");
  });

  it("waits for a pick on psl-only or mixed matches, and fills single exact", () => {
    const single: StoredLoginCredential[] = [{ id: "a", username: "ada", updatedAt: 1, matchType: "exact" }];
    expect(chooseAutofillCredential(single, false)).toEqual(single[0]);
    expect(chooseAutofillCredential(single, true)).toEqual(single[0]);
    const pslOnly: StoredLoginCredential[] = [{ id: "b", username: "ada", updatedAt: 2, matchType: "psl" }];
    expect(chooseAutofillCredential(pslOnly, false)).toBe("pick");
    expect(chooseAutofillCredential(pslOnly, true)).toBeNull();
    const mixed: StoredLoginCredential[] = [
      { id: "a", username: "ada", updatedAt: 1, matchType: "exact" },
      { id: "b", username: "ada", updatedAt: 2, matchType: "psl" },
    ];
    expect(chooseAutofillCredential(mixed, false)).toBe("pick");
    expect(chooseAutofillCredential(mixed, true)).toEqual(mixed[0]);
  });

  it("offers save, update, or silence", () => {
    const stored = [
      { id: "a", username: "ada", password: "one", updatedAt: 100 },
      { id: "g", username: "grace", password: "two", updatedAt: 200 },
    ];
    const policy = { offerToSave: true, neverSaved: false };
    expect(decideSavePrompt({ username: "ada", password: "one" }, stored, policy)).toEqual({ kind: "none" });
    expect(decideSavePrompt({ username: "new", password: "pw" }, stored, policy)).toEqual({ kind: "save" });
    expect(decideSavePrompt({ username: "ada", password: "changed" }, stored, policy)).toEqual({ kind: "update", entryId: "a" });
    expect(decideSavePrompt({ username: "", password: "pw" }, stored, policy)).toEqual({ kind: "none" });
    expect(decideSavePrompt({ username: "new", password: "pw" }, stored, { ...policy, offerToSave: false })).toEqual({ kind: "none" });
    expect(decideSavePrompt({ username: "new", password: "pw" }, stored, { ...policy, neverSaved: true })).toEqual({ kind: "none" });
  });

  it("keys one fill per page and form state", () => {
    const scan: FleetPasswordPageScan["forms"][number] = { index: 0, action: "/l", passwordName: "pw", usernameName: "un", usernameVisible: true, usernameValue: "", usernameHasValue: false, passwordHasValue: false, passwordCount: 1, newPassword: false };
    expect(loginFormKey("https://a.example", scan)).toBe(loginFormKey("https://a.example", scan));
    expect(loginFormKey("https://a.example", scan)).not.toBe(loginFormKey("https://b.example", scan));
  });
});

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const cannedScan = (overrides: Partial<FleetPasswordPageScan["forms"][number]> = {}): FleetPasswordPageScan => ({
  forms: [{ index: 0, action: "/login", passwordName: "pw", usernameName: "un", usernameVisible: true, usernameValue: "", usernameHasValue: false, passwordHasValue: false, passwordCount: 1, newPassword: false, ...overrides }],
});

function stubVault(credentials: { id: string; username: string; password: string; updatedAt: number; matchType?: PasswordMatchType; origin?: string }[], policy: { offerToSave: boolean; neverSaved: boolean } = { offerToSave: true, neverSaved: false }) {
  const full = credentials.map((entry) => ({ matchType: "exact" as const, origin: "https://a.example", ...entry }));
  const commands: Record<string, unknown>[] = [];
  const vault: BrowserPasswordPageAgentDeps["vault"] = {
    forOrigin: () => ({ offerToSave: policy.offerToSave, neverSaved: policy.neverSaved, credentials: full }),
    command: async (params) => { commands.push(params); return {}; },
  };
  return { vault, commands };
}

function stubHandle(url: string, scan: FleetPasswordPageScan | null) {
  const codes: string[] = [];
  return {
    codes,
    handle: {
      url: () => url,
      executeIsolated: async (code: string): Promise<unknown> => {
        codes.push(code);
        if (code.includes("focusPassword")) return true;
        return scan;
      },
    },
  };
}

describe("page agent orchestration", () => {
  it("fills a single account on a user tab once per page state", async () => {
    const { vault } = stubVault([{ id: "a", username: "ada", password: "pw", updatedAt: 1 }]);
    const prompts: (PasswordPrompt | null)[] = [];
    const stub = stubHandle("https://a.example/login", cannedScan());
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent.attachView("v1", stub.handle);
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    const fills = stub.codes.filter((code) => code.includes("focusPassword"));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toContain("ada");
    expect(prompts).toHaveLength(0);
    const before = stub.codes.length;
    agent.pageReady("v1");
    await tick();
    expect(stub.codes.length).toBeGreaterThan(before);
    expect(stub.codes.filter((code) => code.includes("focusPassword"))).toHaveLength(1);
  });

  it("fills the latest account on an agent tab including temporary sessions", async () => {
    const { vault } = stubVault([
      { id: "old", username: "ada", password: "one", updatedAt: 10 },
      { id: "new", username: "grace", password: "two", updatedAt: 20 },
    ]);
    const stub = stubHandle("https://a.example/", cannedScan());
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5 });
    agent.attachView("v1", stub.handle);
    // profile === null 임시 세션도 같은 호출 경로다 — 핸들에 프로필 분기가 없다.
    agent.setVisible("v1", true, true);
    agent.pageReady("v1");
    await tick();
    const fills = stub.codes.filter((code) => code.includes("focusPassword"));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toContain("grace");
  });

  it("never overwrites input the person already typed", async () => {
    const { vault } = stubVault([{ id: "a", username: "ada", password: "pw", updatedAt: 1 }]);
    const stub = stubHandle("https://a.example/", cannedScan({ passwordHasValue: true }));
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5 });
    agent.attachView("v1", stub.handle);
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    expect(stub.codes.filter((code) => code.includes("focusPassword"))).toHaveLength(0);
  });

  it("shows the picker on field focus with several accounts and fills the pick", async () => {
    const { vault, commands } = stubVault([
      { id: "a", username: "ada", password: "one", updatedAt: 1 },
      { id: "g", username: "grace", password: "two", updatedAt: 2 },
    ]);
    const prompts: (PasswordPrompt | null)[] = [];
    const stub = stubHandle("https://a.example/", cannedScan());
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    void commands;
    agent.attachView("v1", stub.handle);
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    expect(stub.codes.filter((code) => code.includes("focusPassword"))).toHaveLength(0);
    agent.binding("v1", JSON.stringify({ kind: "field-focused" }));
    await tick();
    expect(prompts.at(-1)).toEqual({ kind: "pick", viewId: "v1", origin: "https://a.example", usernames: ["ada", "grace"], origins: ["https://a.example", "https://a.example"] });
    await agent.chromeAction("password-pick", "grace");
    const fills = stub.codes.filter((code) => code.includes("focusPassword"));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toContain("grace");
    expect(prompts.at(-1)).toBeNull();
  });

  it("prompts save for a new pair, update for a changed password, and silence for a repeat", async () => {
    const stored = [{ id: "a", username: "ada", password: "one", updatedAt: 1 }];
    const { vault, commands } = stubVault(stored);
    const prompts: (PasswordPrompt | null)[] = [];
    const stub = stubHandle("https://a.example/", { forms: [] });
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, settleDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent.attachView("v1", stub.handle);

    agent.binding("v1", JSON.stringify({ kind: "submitted", username: "ada", password: "one" }));
    await tick();
    expect(prompts).toHaveLength(0);

    agent.binding("v1", JSON.stringify({ kind: "submitted", username: "new", password: "pw" }));
    await tick();
    expect(prompts.at(-1)).toMatchObject({ kind: "save-prompt", mode: "save", username: "new" });
    await agent.chromeAction("password-save");
    expect(commands.at(-1)).toMatchObject({ action: "save", origin: "https://a.example", username: "new" });
    expect(prompts.at(-1)).toBeNull();

    agent.binding("v1", JSON.stringify({ kind: "submitted", username: "ada", password: "changed" }));
    await tick();
    expect(prompts.at(-1)).toMatchObject({ kind: "save-prompt", mode: "update", entryId: "a" });
    await agent.chromeAction("password-never");
    expect(commands.at(-1)).toMatchObject({ action: "add-never-save", origin: "https://a.example" });
    expect(prompts.at(-1)).toBeNull();

    agent.binding("v1", JSON.stringify({ kind: "submitted", username: "x", password: "y" }));
    await tick();
    expect(prompts.at(-1)).not.toBeNull();
    await agent.chromeAction("password-dismiss");
    expect(prompts.at(-1)).toBeNull();
    expect(agent.cancelPrompt()).toBe(false);
  });

  it("refuses non-http origins, corrupt vaults, and malformed messages", async () => {
    const failing = {
      forOrigin: () => { throw new Error("encryption_unavailable"); },
      command: async () => ({}),
    };
    const prompts: (PasswordPrompt | null)[] = [];
    for (const url of ["about:blank", "chrome://settings", "not a url"]) {
      const stub = stubHandle(url, cannedScan());
      const agent = createBrowserPasswordPageAgent({ vault: failing, scanDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
      agent.attachView("v1", stub.handle);
      agent.setVisible("v1", true, true);
      agent.pageReady("v1");
      agent.binding("v1", JSON.stringify({ kind: "submitted", username: "u", password: "p" }));
      agent.binding("v1", "not json");
      agent.binding("v1", JSON.stringify({ kind: "submitted", username: "", password: "p" }));
      agent.binding("v1", JSON.stringify({ kind: "unknown" }));
      await tick();
      expect(stub.codes.filter((code) => code.includes("focusPassword"))).toHaveLength(0);
    }
    expect(prompts).toHaveLength(0);
  });
});

describe("chrome contract password actions", () => {
  const message = (action: string, body: Record<string, unknown> = {}): string =>
    JSON.stringify(["fleet-chrome", "bar", action, body]);

  it("parses the password card and picker actions", () => {
    expect(readChromeMessage(message("password-save"))).toEqual({ role: "bar", action: { action: "password-save" } });
    expect(readChromeMessage(message("password-dismiss"))).toEqual({ role: "bar", action: { action: "password-dismiss" } });
    expect(readChromeMessage(message("password-never"))).toEqual({ role: "bar", action: { action: "password-never" } });
    expect(readChromeMessage(message("password-pick", { username: "ada@example.com" }))).toEqual({ role: "bar", action: { action: "password-pick", username: "ada@example.com" } });
    expect(readChromeMessage(message("password-pick", { username: "ada", origin: "https://b.example" }))).toEqual({ role: "bar", action: { action: "password-pick", username: "ada", origin: "https://b.example" } });
  });

  it("rejects malformed password actions", () => {
    expect(readChromeMessage(message("password-pick", {}))).toBeNull();
    expect(readChromeMessage(message("password-pick", { username: "" }))).toBeNull();
    expect(readChromeMessage(message("password-pick", { username: "x".repeat(513) }))).toBeNull();
    expect(readChromeMessage(message("password-pick", { username: 7 }))).toBeNull();
    expect(readChromeMessage(message("password-pick", { username: "ada", origin: "" }))).toBeNull();
    expect(readChromeMessage(message("password-pick", { username: "ada", origin: 7 }))).toBeNull();
  });
});

describe("browser views password hooks", () => {
  const ORIGIN = "http://127.0.0.1:4310";

  const fakeSession = () => ({
    webRequest: { onBeforeSendHeaders: () => undefined, onHeadersReceived: () => undefined },
  });

  const fakeView = (created: { contents: EventEmitter }[]) => {
    const contents = Object.assign(new EventEmitter(), {
      id: 41,
      mainFrame: { url: "" },
      session: fakeSession(),
      debugger: Object.assign(new EventEmitter(), {
        attach: () => undefined,
        detach: () => undefined,
        isAttached: () => true,
        sendCommand: async () => ({}),
      }),
      setWindowOpenHandler: () => undefined,
      loadURL: async () => undefined,
      insertCSS: async () => "",
      getURL: () => "https://a.example/login",
      executeJavaScriptInIsolatedWorld: async () => ({ forms: [] }),
      isFocused: () => false,
      isDestroyed: () => false,
      close: () => undefined,
    });
    created.push({ contents });
    return { webContents: contents, setBorderRadius: () => undefined, setBounds: () => undefined, setVisible: () => undefined };
  };

  const drive = async (
    hooks: { attachView: (...args: never[]) => void } & Record<string, (...args: never[]) => void>,
    surface: { inputLocked: () => boolean },
    extraView: { agent?: boolean } = {},
    whileLive?: (contents: EventEmitter & { debugger: EventEmitter }, relays: unknown[]) => Promise<void> | void,
  ) => {
    const lifetime: DesktopBrowserSnapshot = {
      generation: 1,
      views: [{ id: "view-1", objectiveId: "op-1", partition: "p1", profile: null, visible: true, url: "https://a.example/login", ...extraView }],
      commands: [],
    };
    const relays: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const { pathname } = new URL(String(input));
      if (pathname === DESKTOP_BROWSER_RELAY_PATH) {
        if (typeof init?.body === "string") relays.push(JSON.parse(init.body) as unknown);
        return new Response(null, { status: 204 });
      }
      if (pathname === DESKTOP_BROWSER_PATH) return Response.json(lifetime);
      if (pathname === DESKTOP_BROWSER_EVENTS_PATH) {
        const frame = new TextEncoder().encode(`event: ${DESKTOP_BROWSER_EVENT}\ndata: ${JSON.stringify(lifetime)}\n\n`);
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(frame) }));
      }
      return new Response(null, { status: 404 });
    });
    const created: { contents: EventEmitter & { debugger: EventEmitter } }[] = [];
    const shell = { isDestroyed: () => false, contentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), park: vi.fn(), present: vi.fn(), remove: vi.fn(), scale: () => 1, reclaimFocus: vi.fn() } satisfies PageHost;
    const views = createDesktopBrowserViews({
      shell: () => shell,
      consoleContents: () => null,
      surface: { apply: vi.fn(), target: () => null, lastPage: () => null, inputLocked: surface.inputLocked, refresh: vi.fn(), dispose: vi.fn() },
      createView: () => fakeView(created) as never,
      product: () => "Chrome/150.0",
      userAgent: () => "agent",
      fetch: fetch as typeof globalThis.fetch,
      passwords: hooks as never,
    });
    await views.start(ORIGIN);
    await vi.waitFor(() => expect(created.length).toBe(1));
    if (whileLive) await whileLive(created[0]!.contents, relays);
    views.stop();
    return created[0]!.contents;
  };

  it("attaches views, reports readiness, routes isolated console lines, and suppresses them from the debugger relay", async () => {
    const calls: string[] = [];
    let channelPrefix = "";
    const contents = await drive({
      attachView: (...args: never[]) => {
        calls.push(`attach:${String((args as unknown[])[0])}`);
        channelPrefix = ((args as unknown[])[1] as { consolePrefix?: string }).consolePrefix ?? "";
      },
      setVisible: (...args: never[]) => calls.push(`visible:${(args as unknown[]).join(",")}`),
      pageReady: (...args: never[]) => calls.push(`ready:${String((args as unknown[])[0])}`),
      binding: (...args: never[]) => calls.push(`binding:${String((args as unknown[])[0])}:${String((args as unknown[])[1])}`),
      detachView: (...args: never[]) => calls.push(`detach:${String((args as unknown[])[0])}`),
    }, { inputLocked: () => true }, {}, async (liveContents, relays) => {
      expect(channelPrefix.startsWith(PASSWORD_CONSOLE_PREFIX)).toBe(true);
      expect(channelPrefix.length).toBeGreaterThan(PASSWORD_CONSOLE_PREFIX.length);
      const secretPayload = `${channelPrefix}${JSON.stringify({ kind: "submitted", username: "ada", password: "s3cret-password" })}`;
      liveContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: secretPayload }],
      });
      liveContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "normal page log" }],
      });
      await tick();
      const serialized = JSON.stringify(relays);
      expect(serialized).toContain("normal page log");
      expect(serialized).not.toContain("s3cret-password");
      expect(serialized).not.toContain(PASSWORD_CONSOLE_PREFIX);
    });
    expect(calls).toContain("attach:view-1");
    expect(calls).toContain("visible:view-1,true,true");
    contents.emit("dom-ready");
    expect(calls).toContain("ready:view-1");
    const line = `${channelPrefix}${JSON.stringify({ kind: "field-focused" })}`;
    contents.emit("console-message", { frame: (contents as unknown as { mainFrame: unknown }).mainFrame, message: line });
    expect(calls).toContain(`binding:view-1:${JSON.stringify({ kind: "field-focused" })}`);
    contents.emit("console-message", { frame: (contents as unknown as { mainFrame: unknown }).mainFrame, message: `${PASSWORD_CONSOLE_PREFIX}${JSON.stringify({ kind: "field-focused" })}` });
    contents.emit("console-message", { frame: (contents as unknown as { mainFrame: unknown }).mainFrame, message: "[fleet-chrome, bar]" });
    contents.emit("console-message", { frame: { url: "https://other.invalid/" }, message: line });
    expect(calls.filter((call) => call.startsWith("binding:")).length).toBe(1);
    expect(calls).toContain("detach:view-1");
  });

  it("reads the agent mark from the snapshot even when the lock is off", async () => {
    const calls: string[] = [];
    await drive({
      attachView: (...args: never[]) => calls.push(`attach:${String((args as unknown[])[0])}`),
      setVisible: (...args: never[]) => calls.push(`visible:${(args as unknown[]).join(",")}`),
      pageReady: () => undefined,
      binding: () => undefined,
      detachView: () => undefined,
    }, { inputLocked: () => false }, { agent: true });
    expect(calls).toContain("attach:view-1");
    expect(calls).toContain("visible:view-1,true,true");
  });

  it("routes navigation signals to the password hooks", async () => {
    const calls: string[] = [];
    const contents = await drive({
      attachView: (...args: never[]) => calls.push(`attach:${String((args as unknown[])[0])}`),
      setVisible: (...args: never[]) => calls.push(`visible:${(args as unknown[]).join(",")}`),
      pageReady: () => undefined,
      binding: () => undefined,
      detachView: () => undefined,
      navigationStarted: () => calls.push("nav-start"),
      navigationCommitted: (...args: never[]) => calls.push(`nav-commit:${JSON.stringify((args as unknown[])[1])}`),
      navigationFailed: () => calls.push("nav-fail"),
      sameDocumentNavigated: () => calls.push("nav-same"),
    }, { inputLocked: () => false });
    contents.emit("will-navigate", { url: "https://a.example/", isMainFrame: true, isSameDocument: false });
    contents.emit("did-navigate", {}, "https://a.example/", 200);
    contents.emit("did-navigate-in-page", {}, "https://a.example/#x", true);
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://a.example/", true);
    // 주소줄 등 브라우저가 여는 항해(will-navigate 없음)·동일 문서·서브프레임 신호는 제출 대기로 잇지 않는다.
    contents.emit("did-start-navigation", { url: "https://other.example/", isMainFrame: true, isSameDocument: false });
    contents.emit("will-navigate", { url: "https://a.example/#frag", isMainFrame: true, isSameDocument: true });
    contents.emit("did-navigate-in-page", {}, "https://a.example/#y", false);
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://a.example/", false);
    expect(calls.filter((call) => call.startsWith("nav-"))).toEqual([
      "nav-start",
      'nav-commit:{"url":"https://a.example/","httpStatus":200}',
      "nav-same",
      "nav-fail",
    ]);
  });

  it("keeps did-navigate-in-page solely on sameDocumentNavigated so pushState preserves provisional input", async () => {
    const calls: string[] = [];
    const contents = await drive({
      attachView: () => undefined,
      setVisible: () => undefined,
      pageReady: () => calls.push("pageReady"),
      binding: () => undefined,
      detachView: () => undefined,
      navigationStarted: () => undefined,
      navigationCommitted: () => undefined,
      navigationFailed: () => undefined,
      sameDocumentNavigated: () => calls.push("sameDocumentNavigated"),
    }, { inputLocked: () => false });
    contents.emit("did-navigate-in-page", {}, "https://a.example/dashboard", true);
    expect(calls).toEqual(["sameDocumentNavigated"]);
  });
});

describe("password prompt reveal helpers", () => {
  it("masks by default and flips both texts together", () => {
    expect(passwordRevealText("s3cr3t", false)).toEqual({ mask: "••••••••", toggleKey: "password.show" });
    expect(passwordRevealText("s3cr3t", true)).toEqual({ mask: "s3cr3t", toggleKey: "password.hide" });
    const identity = { mode: "save", origin: "https://a.example", username: "ada", password: "pw" };
    expect(passwordPromptIdentity(identity)).toBe(passwordPromptIdentity({ ...identity }));
    expect(passwordPromptIdentity(identity)).not.toBe(passwordPromptIdentity({ ...identity, password: "other" }));
    expect(passwordPromptIdentity(identity)).not.toBe(passwordPromptIdentity({ ...identity, mode: "update" }));
  });
});

describe("password agent background and retention rules", () => {
  it("fills a hidden agent tab without waiting for display", async () => {
    const { vault } = stubVault([{ id: "a", username: "ada", password: "pw", updatedAt: 1 }]);
    const stub = stubHandle("https://a.example/", cannedScan());
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5 });
    agent.attachView("v1", stub.handle);
    agent.setVisible("v1", false, true);
    agent.pageReady("v1");
    await tick();
    const fills = stub.codes.filter((code) => code.includes("focusPassword"));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toContain("ada");
  });

  it("keeps a save prompt across hide but drops the picker", async () => {
    const { vault } = stubVault([]);
    const prompts: (PasswordPrompt | null)[] = [];
    const stub = stubHandle("https://a.example/", { forms: [] });
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, settleDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent.attachView("v1", stub.handle);
    agent.setVisible("v1", true, false);
    agent.binding("v1", JSON.stringify({ kind: "submitted", username: "new", password: "pw" }));
    await tick();
    expect(prompts.at(-1)).toMatchObject({ kind: "save-prompt" });
    agent.setVisible("v1", false, false);
    await tick();
    expect(agent.prompt()).toMatchObject({ kind: "save-prompt" });

    const multi = stubVault([
      { id: "a", username: "ada", password: "one", updatedAt: 1 },
      { id: "g", username: "grace", password: "two", updatedAt: 2 },
    ]);
    const stub2 = stubHandle("https://b.example/", cannedScan());
    const agent2 = createBrowserPasswordPageAgent({ vault: multi.vault, scanDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent2.attachView("v2", stub2.handle);
    agent2.setVisible("v2", true, false);
    agent2.binding("v2", JSON.stringify({ kind: "field-focused" }));
    await tick();
    expect(prompts.at(-1)).toMatchObject({ kind: "pick" });
    agent2.setVisible("v2", false, false);
    expect(agent2.prompt()).toBeNull();
    expect(prompts.at(-1)).toBeNull();
  });

  it("refuses to fill if the tab navigated to another origin while scanning", async () => {
    const { vault } = stubVault([{ id: "a", username: "single@a", password: "secret-a", updatedAt: 1 }]);
    let currentUrl = "https://a.example/login";
    const codes: string[] = [];
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5 });
    agent.attachView("v1", {
      url: () => currentUrl,
      executeIsolated: async (code) => {
        codes.push(code);
        if (code.includes("fleetPasswordScan")) {
          // Simulate navigation to b.example completing during the scan await.
          currentUrl = "https://b.example/login";
          return { origin: "https://a.example", ...cannedScan() };
        }
        return true;
      },
    });
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    expect(codes.some((code) => code.includes("focusPassword"))).toBe(false);
  });

  it("re-installs listeners and refills on same-URL document reload while deduplicating same-document readiness", async () => {
    const { vault } = stubVault([{ id: "a", username: "ada", password: "pw", updatedAt: 1 }]);
    let docInstalled = false;
    let fillCount = 0;
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5 });
    agent.attachView("v1", {
      url: () => "https://a.example/login",
      executeIsolated: async (code) => {
        if (code.includes("fleetPasswordSession")) {
          if (docInstalled) return false;
          docInstalled = true;
          return true;
        }
        if (code.includes("fleetPasswordScan")) return { origin: "https://a.example", ...cannedScan() };
        if (code.includes("focusPassword")) {
          fillCount += 1;
          return true;
        }
        return null;
      },
    });
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    expect(fillCount).toBe(1);

    // Second readiness on the same document (e.g. dom-ready after did-navigate) deduplicates.
    agent.pageReady("v1");
    await tick();
    expect(fillCount).toBe(1);

    // Same-URL reload creates a fresh document where session install returns true again.
    docInstalled = false;
    agent.pageReady("v1");
    await tick();
    expect(fillCount).toBe(2);
  });
});

describe("provisional credentials and login verdicts", () => {
  const loginScan = (): FleetPasswordPageScan => ({ origin: "https://login.example", ...cannedScan() });

  function verdictHarness(urls: { login: string; landing: string }) {
    let currentUrl = urls.login;
    let landed = false;
    const codes: string[] = [];
    const prompts: (PasswordPrompt | null)[] = [];
    const { vault, commands } = stubVault([]);
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, settleDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent.attachView("v1", {
      url: () => currentUrl,
      executeIsolated: async (code: string) => {
        codes.push(code);
        if (code.includes("fleetPasswordSession")) return true;
        if (code.includes("fleetPasswordScan")) return landed ? { forms: [] } : loginScan();
        if (code.includes("focusPassword")) return true;
        return null;
      },
    });
    agent.setVisible("v1", true, false);
    return { agent, prompts, commands, codes, go: (landing: boolean) => { landed = landing; if (landing) currentUrl = urls.landing; } };
  }

  it("prompts after JS-cleared submit followed by a successful navigation", async () => {
    const h = verdictHarness({ login: "https://login.example/", landing: "https://app.example/home" });
    h.agent.pageReady("v1");
    await tick();
    // JS 가 submit 직전 칸을 비워 DOM submit 값이 비어도 입력 중 보관이 살아 있다.
    h.agent.binding("v1", JSON.stringify({ kind: "user-input", username: "ada", password: "pw" }));
    h.agent.navigationStarted("v1");
    h.go(true);
    h.agent.navigationCommitted("v1", { url: "https://app.example/home", httpStatus: 200 });
    await tick(40);
    expect(h.prompts.at(-1)).toMatchObject({ kind: "save-prompt", mode: "save", origin: "https://login.example", username: "ada" });
    await h.agent.chromeAction("password-save");
    expect(h.commands.at(-1)).toMatchObject({ action: "save", origin: "https://login.example", username: "ada", password: "pw" });
    expect(h.prompts.at(-1)).toBeNull();
  });

  it("stays silent when the login form reappears or the load fails", async () => {
    const h = verdictHarness({ login: "https://login.example/", landing: "https://login.example/?error=1" });
    h.agent.pageReady("v1");
    await tick();
    h.agent.binding("v1", JSON.stringify({ kind: "submitted", username: "ada", password: "wrong" }));
    h.go(false);
    h.agent.pageReady("v1");
    await tick(40);
    expect(h.agent.prompt()).toBeNull();
    expect(h.prompts).toHaveLength(0);

    h.agent.binding("v1", JSON.stringify({ kind: "submitted", username: "ada", password: "pw" }));
    h.agent.navigationCommitted("v1", { url: "https://login.example/", httpStatus: 401 });
    await tick(40);
    expect(h.agent.prompt()).toBeNull();
    expect(h.prompts).toHaveLength(0);
  });

  it("prompts when an SPA login removes the form without navigating", async () => {
    const h = verdictHarness({ login: "https://app.example/login", landing: "https://app.example/login" });
    h.agent.pageReady("v1");
    await tick();
    h.agent.binding("v1", JSON.stringify({ kind: "submitted", username: "new", password: "pw" }));
    await tick(40);
    // 폼이 그대로 있으면 아직 성공이 아니다.
    expect(h.agent.prompt()).toBeNull();
    h.go(true);
    h.agent.sameDocumentNavigated("v1");
    await tick(40);
    expect(h.prompts.at(-1)).toMatchObject({ kind: "save-prompt", mode: "save", origin: "https://app.example" });

    // user-input 후 별도 submitted 없이 pushState(sameDocumentNavigated)로 폼이 사라져도 제안한다.
    const h2 = verdictHarness({ login: "https://app.example/login", landing: "https://app.example/dashboard" });
    h2.agent.pageReady("v1");
    await tick();
    h2.agent.binding("v1", JSON.stringify({ kind: "user-input", username: "spa", password: "pw" }));
    h2.go(true);
    h2.agent.sameDocumentNavigated("v1");
    await tick(40);
    expect(h2.prompts.at(-1)).toMatchObject({ kind: "save-prompt", mode: "save", origin: "https://app.example", username: "spa" });
  });
});

describe("psl matching and picker origins", () => {
  it("fills single exact immediately but waits on psl mixes", async () => {
    const { vault } = stubVault([
      { id: "e", username: "ada", password: "pw", updatedAt: 2, matchType: "exact", origin: "https://a.example" },
      { id: "p", username: "ada", password: "pw2", updatedAt: 1, matchType: "psl", origin: "https://b.example" },
    ]);
    const prompts: (PasswordPrompt | null)[] = [];
    const stub = stubHandle("https://a.example/", cannedScan());
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, settleDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent.attachView("v1", stub.handle);
    // 사용자 탭: exact 1개·전체 2개라 즉시 채우지 않는다.
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    expect(stub.codes.filter((code) => code.includes("focusPassword"))).toHaveLength(0);

    agent.binding("v1", JSON.stringify({ kind: "field-focused" }));
    await tick();
    expect(prompts.at(-1)).toEqual({
      kind: "pick",
      viewId: "v1",
      origin: "https://a.example",
      usernames: ["ada", "ada"],
      origins: ["https://a.example", "https://b.example"],
    });
    await agent.chromeAction("password-pick", "ada", "https://b.example");
    const fills = stub.codes.filter((code) => code.includes("focusPassword"));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toContain("pw2");
    expect(prompts.at(-1)).toBeNull();

    // 에이전트 탭: exact 만 즉시 채운다.
    const stub2 = stubHandle("https://a.example/", cannedScan());
    const agent2 = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, settleDebounceMs: 5 });
    agent2.attachView("v2", stub2.handle);
    agent2.setVisible("v2", false, true);
    agent2.pageReady("v2");
    await tick();
    const agentFills = stub2.codes.filter((code) => code.includes("focusPassword"));
    expect(agentFills).toHaveLength(1);
    expect(agentFills[0]).toContain('"password":"pw"');
  });

  it("saves a separate exact entry instead of updating a psl sibling with the same username", async () => {
    const { vault, commands } = stubVault([
      { id: "psl-a", username: "ada", password: "old-a-password", updatedAt: 1, matchType: "psl", origin: "https://a.example.com" },
    ]);
    let landed = false;
    const prompts: (PasswordPrompt | null)[] = [];
    const agent = createBrowserPasswordPageAgent({ vault, scanDebounceMs: 5, settleDebounceMs: 5, onPrompt: (prompt) => prompts.push(prompt) });
    agent.attachView("v1", {
      url: () => (landed ? "https://b.example.com/home" : "https://b.example.com/login"),
      executeIsolated: async (code) => {
        if (code.includes("fleetPasswordSession")) return true;
        if (code.includes("fleetPasswordScan")) return landed ? { forms: [] } : { origin: "https://b.example.com", ...cannedScan() };
        return true;
      },
    });
    agent.setVisible("v1", true, false);
    agent.pageReady("v1");
    await tick();
    agent.binding("v1", JSON.stringify({ kind: "user-input", username: "ada", password: "new-b-password" }));
    agent.navigationStarted("v1");
    landed = true;
    agent.pageReady("v1");
    await tick(40);
    expect(prompts.at(-1)).toMatchObject({ kind: "save-prompt", mode: "save", origin: "https://b.example.com", username: "ada" });
    await agent.chromeAction("password-save");
    expect(commands.at(-1)).toEqual({ action: "save", origin: "https://b.example.com", username: "ada", password: "new-b-password" });
  });
});
