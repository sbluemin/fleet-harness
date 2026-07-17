import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createPairingModal, createPairingModalOptions, parsePairingNavigation } from "../src/pairing-modal.js";

describe("pairing modal", () => {
  it("uses a fixed, sandboxed, script-free child-window boundary", () => {
    const parent = fakeParent();
    expect(createPairingModalOptions(parent as never)).toEqual({
      parent,
      modal: true,
      show: false,
      width: 460,
      height: 330,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        partition: "fleet-desktop-pairing",
      },
    });
  });

  it("prevents every navigation before accepting only one exact private-scheme form result", async () => {
    const parent = fakeParent();
    const modalWindow = fakeModalWindow();
    const BrowserWindow = browserWindowConstructor(modalWindow);
    const prompt = createPairingModal({ BrowserWindow: BrowserWindow as never, pairingPagePath: "/desktop/pairing/index.html" });
    const result = prompt.prompt(parent as never);
    const navigate = modalWindow.webContents.listeners("will-navigate")[0] as (event: { preventDefault(): void }, url: string) => void;
    const duplicate = { preventDefault: vi.fn() };
    navigate(duplicate, "fleet-desktop-pairing://submit/?target=127.0.0.1%3A4310&target=127.0.0.1%3A4311");
    expect(duplicate.preventDefault).toHaveBeenCalledOnce();
    expect(modalWindow.destroy).not.toHaveBeenCalled();
    const submit = { preventDefault: vi.fn() };
    navigate(submit, "fleet-desktop-pairing://submit/?mode=loopback&target=127.0.0.1%3A4310");
    await expect(result).resolves.toBe("127.0.0.1:4310");
    expect(submit.preventDefault).toHaveBeenCalledOnce();
    expect(modalWindow.destroy).toHaveBeenCalledOnce();
    expect(modalWindow.setMenu).toHaveBeenCalledExactlyOnceWith(null);
    expect(modalWindow.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledExactlyOnceWith(true);
    expect(parent.webContents.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
  });

  it("focuses an existing prompt and resolves Escape exactly once", async () => {
    const parent = fakeParent();
    const modalWindow = fakeModalWindow();
    const BrowserWindow = browserWindowConstructor(modalWindow);
    const modal = createPairingModal({ BrowserWindow: BrowserWindow as never, pairingPagePath: "/desktop/pairing/index.html" });
    const first = modal.prompt(parent as never);
    const second = modal.prompt(parent as never);
    expect(BrowserWindow).toHaveBeenCalledOnce();
    expect(modalWindow.focus).toHaveBeenCalledOnce();
    const input = modalWindow.webContents.listeners("before-input-event")[0] as (event: { preventDefault(): void }, input: { type: string; key: string }) => void;
    input({ preventDefault: vi.fn() }, { type: "keyDown", key: "Escape" });
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(parent.webContents.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
  });

  it("resolves close and parent destruction as null exactly once", async () => {
    const closedParent = fakeParent();
    const closedWindow = fakeModalWindow();
    const closedModal = createPairingModal({ BrowserWindow: browserWindowConstructor(closedWindow) as never, pairingPagePath: "/desktop/pairing/index.html" });
    const closedResult = closedModal.prompt(closedParent as never);
    closedWindow.emit("closed");
    closedWindow.emit("closed");
    await expect(closedResult).resolves.toBeNull();
    expect(closedParent.webContents.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);

    const destroyedParent = fakeParent();
    const destroyedWindow = fakeModalWindow();
    const destroyedModal = createPairingModal({ BrowserWindow: browserWindowConstructor(destroyedWindow) as never, pairingPagePath: "/desktop/pairing/index.html" });
    const destroyedResult = destroyedModal.prompt(destroyedParent as never);
    destroyedParent.emit("closed");
    destroyedParent.emit("closed");
    await expect(destroyedResult).resolves.toBeNull();
    expect(destroyedWindow.destroy).toHaveBeenCalledOnce();
    expect(destroyedParent.webContents.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
  });

  it("denies redirects, popups, permissions, downloads, and subframe navigation", () => {
    const parent = fakeParent();
    const modalWindow = fakeModalWindow();
    const modal = createPairingModal({ BrowserWindow: browserWindowConstructor(modalWindow) as never, pairingPagePath: "/desktop/pairing/index.html" });
    void modal.prompt(parent as never);
    const redirect = { preventDefault: vi.fn() };
    (modalWindow.webContents.listeners("will-redirect")[0] as (event: { preventDefault(): void }) => void)(redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    expect(modalWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: "https://example.test" })).toEqual({ action: "deny" });
    const permission = modalWindow.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as (_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    const callback = vi.fn();
    permission({}, "notifications", callback);
    expect(callback).toHaveBeenCalledWith(false);
    const download = { preventDefault: vi.fn() };
    modalWindow.webContents.session.emit("will-download", download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
    const frame = { preventDefault: vi.fn() };
    (modalWindow.webContents.listeners("will-navigate")[0] as (event: { preventDefault(): void }, url: string, inPlace: boolean, main: boolean) => void)(frame, "https://evil.test", false, false);
    expect(frame.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("pairing navigation parser", () => {
  it("rejects credentials, ports, hashes, extra paths, and unknown parameters", () => {
    expect(parsePairingNavigation("fleet-desktop-pairing://cancel/")).toBeNull();
    expect(parsePairingNavigation("fleet-desktop-pairing://submit/?target=127.0.0.1%3A4310")).toBe("127.0.0.1:4310");
    expect(parsePairingNavigation("fleet-desktop-pairing://submit/?mode=loopback&target=127.0.0.1%3A4310")).toBe("127.0.0.1:4310");
    expect(parsePairingNavigation("fleet-desktop-pairing://submit/?mode=ssh&host=user%40devbox")).toBe("ssh:user@devbox");
    for (const value of [
      "fleet-desktop-pairing://submit/?target=one&other=two",
      "fleet-desktop-pairing://submit/?mode=ssh&host=devbox&other=two",
      "fleet-desktop-pairing://submit/?mode=ssh&host=dev%20box",
      "fleet-desktop-pairing://submit/?mode=ssh&host=%ZZ",
      "fleet-desktop-pairing://submit/?mode=ssh&host=devbox%0Aevil",
      "fleet-desktop-pairing://submit/?target=one&",
      "fleet-desktop-pairing://submit/?tar%67et=one",
      "fleet-desktop-pairing://submit/path?target=one",
      "fleet-desktop-pairing://user@submit/?target=one",
      "fleet-desktop-pairing://submit:4310/?target=one",
      "fleet-desktop-pairing://submit/?target=one#two",
      "fleet-desktop-pairing://submit/?target=one#",
      "fleet-desktop-pairing://submit/?target=one ",
      "fleet-desktop-pairing://submit/?target=one\t",
      "fleet-desktop-pairing://submit/?target=one\n",
      "fleet-desktop-pairing://cancel/?target=one",
      "fleet-desktop-pairing://CANCEL/",
    ]) expect(parsePairingNavigation(value)).toBeUndefined();
  });
});

function fakeParent() {
  const parent = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean; webContents: { setIgnoreMenuShortcuts: ReturnType<typeof vi.fn> } };
  parent.isDestroyed = () => false;
  parent.webContents = { setIgnoreMenuShortcuts: vi.fn() };
  return parent;
}

function fakeModalWindow() {
  const modal = new EventEmitter() as EventEmitter & {
    isDestroyed: () => boolean;
    destroy: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setMenu: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    webContents: EventEmitter & {
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
      session: EventEmitter & { setPermissionRequestHandler: ReturnType<typeof vi.fn> };
    };
  };
  let destroyed = false;
  modal.isDestroyed = () => destroyed;
  modal.destroy = vi.fn(() => { destroyed = true; modal.emit("closed"); });
  modal.show = vi.fn();
  modal.focus = vi.fn();
  modal.setMenu = vi.fn();
  modal.loadFile = vi.fn(async () => undefined);
  const contents = new EventEmitter() as typeof modal.webContents;
  contents.setWindowOpenHandler = vi.fn();
  contents.setIgnoreMenuShortcuts = vi.fn();
  contents.session = new EventEmitter() as typeof contents.session;
  contents.session.setPermissionRequestHandler = vi.fn();
  modal.webContents = contents;
  return modal;
}

function browserWindowConstructor(window: ReturnType<typeof fakeModalWindow>) {
  return vi.fn(function FakeBrowserWindow() { return window; });
}
