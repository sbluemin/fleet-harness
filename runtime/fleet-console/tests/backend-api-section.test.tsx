// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CoreApiCatalogGroups,
  groupApiCatalog,
  PluginApiCatalogGroups,
  pluginIdFromPath,
  type ApiCatalogGroup,
} from "../core/client/src/components/backend-api-section.js";
import type { ApiCatalogEntry } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Backend API hierarchy", () => {
  it.each([
    ["/plugins/terminality", "terminality"],
    ["/plugins/terminality/x", "terminality"],
    ["/api/v1/plugins/repository", "repository"],
    ["/api/v1/plugins/repository/search", "repository"],
    ["/plugins", null],
    ["/plugins/", null],
    ["/api/v1/plugins", null],
    ["/api/v1/plugins/", null],
    ["/plugin/terminality/x", null],
    ["/api/v1/plugins//x", null],
  ])("classifies %s by path namespace", (path, expected) => {
    expect(pluginIdFromPath(path)).toBe(expected);
  });

  it("groups Core by category and plugins only by plugin ID while retaining source order", () => {
    const hierarchy = groupApiCatalog([
      entry("/operations", "Operations", "core-one"),
      entry("/plugins/terminality/x", "Misleading category", "plugin-one"),
      entry("/api/v1/plugins/terminality/y", "Other category", "plugin-two"),
      entry("/plugin/terminality/x", "Operations", "core-two"),
      entry("/plugins/repository/x", "Operations", "repository"),
      entry("/plugins", "", "uncategorized"),
    ], "Uncategorized");

    expect(hierarchy.coreGroups.map((group) => group.label)).toEqual(["Operations", "Uncategorized"]);
    expect(hierarchy.coreGroups[0]?.entries.map((route) => route.summary)).toEqual(["core-one", "core-two"]);
    expect(hierarchy.pluginGroups.map((group) => group.label)).toEqual(["terminality", "repository"]);
    expect(hierarchy.pluginGroups[0]?.entries.map((route) => route.summary)).toEqual(["plugin-one", "plugin-two"]);
  });

  it("defaults every Core category expanded, toggles independently, and expands fresh categories", () => {
    renderCoreGroups([coreGroup("Operations"), coreGroup("Settings")]);

    const operations = disclosure("core", "Operations");
    const operationsListId = operations.getAttribute("aria-controls");
    expect(operations.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure("core", "Settings").getAttribute("aria-expanded")).toBe("true");
    expect(operations.textContent).toContain("1Hide routes");
    expect(operationsListId).not.toBeNull();
    expect(document.getElementById(operationsListId ?? "")).not.toBeNull();

    act(() => operations.click());
    expect(disclosure("core", "Operations").getAttribute("aria-expanded")).toBe("false");
    expect(disclosure("core", "Operations").textContent).toContain("1Show routes");
    expect(disclosure("core", "Settings").getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(operationsListId ?? "")).toBeNull();

    renderCoreGroups([coreGroup("Operations"), coreGroup("Settings"), coreGroup("Desktop")]);
    expect(disclosure("core", "Operations").getAttribute("aria-expanded")).toBe("false");
    expect(disclosure("core", "Settings").getAttribute("aria-expanded")).toBe("true");
    expect(disclosure("core", "Desktop").getAttribute("aria-expanded")).toBe("true");
  });

  it("defaults every plugin expanded, toggles independently, and expands fresh IDs", () => {
    renderPluginGroups([group("terminality"), group("repository")]);

    expect(disclosure("plugin", "terminality").getAttribute("aria-expanded")).toBe("true");
    expect(disclosure("plugin", "repository").getAttribute("aria-expanded")).toBe("true");
    expect(disclosure("plugin", "terminality").textContent).toContain("1Hide routes");

    act(() => disclosure("plugin", "terminality").click());
    expect(disclosure("plugin", "terminality").getAttribute("aria-expanded")).toBe("false");
    expect(disclosure("plugin", "terminality").textContent).toContain("1Show routes");
    expect(disclosure("plugin", "repository").getAttribute("aria-expanded")).toBe("true");

    renderPluginGroups([group("terminality"), group("repository"), group("skills")]);
    expect(disclosure("plugin", "terminality").getAttribute("aria-expanded")).toBe("false");
    expect(disclosure("plugin", "repository").getAttribute("aria-expanded")).toBe("true");
    expect(disclosure("plugin", "skills").getAttribute("aria-expanded")).toBe("true");
  });
});

function renderCoreGroups(groups: readonly ApiCatalogGroup[]): void {
  act(() => root?.render(<CoreApiCatalogGroups groups={groups} />));
}

function renderPluginGroups(groups: readonly ApiCatalogGroup[]): void {
  act(() => root?.render(<PluginApiCatalogGroups groups={groups} />));
}

function disclosure(kind: "core" | "plugin", label: string): HTMLButtonElement {
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>(`.backend-api-${kind}-toggle`) ?? [])
    .find((candidate) => candidate.querySelector(`.backend-api-${kind}-label`)?.textContent === label);
  if (!button) throw new Error(`missing ${kind} disclosure for ${label}`);
  return button;
}

function coreGroup(category: string): ApiCatalogGroup {
  return { label: category, entries: [entry(`/${category.toLowerCase()}`, category, category)] };
}

function group(pluginId: string): ApiCatalogGroup {
  return { label: pluginId, entries: [entry(`/plugins/${pluginId}`, "Plugin", pluginId)] };
}

function entry(path: string, category: string, summary: string): ApiCatalogEntry {
  return {
    method: "GET",
    path,
    summary,
    category,
    gate: "loopback",
    transport: "http",
  };
}
