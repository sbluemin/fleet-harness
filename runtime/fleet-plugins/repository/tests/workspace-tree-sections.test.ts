// @vitest-environment jsdom

import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => {
  let cursor = 0;
  let values: unknown[] = [];
  return {
    beginRender(): void {
      cursor = 0;
    },
    reset(): void {
      cursor = 0;
      values = [];
    },
    useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        values[index] as T,
        (next) => {
          const current = values[index] as T;
          values[index] = typeof next === "function" ? (next as (value: T) => T)(current) : next;
        },
      ];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: hookHarness.useState };
});

import { getT } from "../client/i18n/index.js";
import { WorkspaceTree } from "../client/rail-panel.js";

type ElementProps = Record<string, unknown> & { readonly children?: ReactNode };

function isElement(node: ReactNode): node is ReactElement<ElementProps> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function childrenOf(node: ReactNode): readonly ReactNode[] {
  if (!isElement(node)) return [];
  const children = node.props.children;
  return Array.isArray(children) ? children : [children];
}

function elementsByClass(node: ReactNode, className: string): ReactElement<ElementProps>[] {
  const matches: ReactElement<ElementProps>[] = [];
  if (isElement(node)) {
    if (typeof node.props.className === "string" && node.props.className.split(" ").includes(className)) matches.push(node);
    for (const child of childrenOf(node)) matches.push(...elementsByClass(child, className));
  } else if (Array.isArray(node)) {
    for (const child of node) matches.push(...elementsByClass(child, className));
  }
  return matches;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return childrenOf(node).map(textOf).join("");
}

function renderWorkspaceTree(): ReactElement<ElementProps> {
  hookHarness.beginRender();
  return WorkspaceTree({
    t: getT("en"),
    refs: {
      branches: [{ label: "canary", ref: "refs/heads/canary", current: true }],
      remotes: [],
      tags: [{ label: "v1.0.0", ref: "refs/tags/v1.0.0", current: false }],
      stashes: [{ name: "stash@{0}", subject: "WIP" }],
    },
    refsError: false,
    source: "history",
    refFilter: null,
    onReloadState: vi.fn(),
    onRetryRefs: vi.fn(),
    onRef: vi.fn(),
    onCompare: vi.fn(),
    onStashInspect: vi.fn(),
  });
}

function sectionState(tree: ReactElement<ElementProps>): Map<string, { readonly expanded: boolean; readonly count: string; readonly hasBody: boolean; readonly toggle: () => void }> {
  return new Map(elementsByClass(tree, "repository-ws-section").map((section) => {
    const [header, ...body] = childrenOf(section);
    if (!isElement(header) || header.type !== "button") throw new Error("Expected a section header button");
    const label = textOf(childrenOf(header)[1]).toLowerCase();
    const toggle = header.props.onClick;
    if (typeof toggle !== "function") throw new Error(`Missing toggle for ${label}`);
    return [label, {
      expanded: header.props["aria-expanded"] === true,
      count: textOf(childrenOf(header)[2]),
      hasBody: body.some((child) => child !== false && child !== null && child !== undefined),
      toggle: toggle as () => void,
    }];
  }));
}

beforeEach(() => hookHarness.reset());

describe("WorkspaceTree section collapse", () => {
  it("starts with tags and stashes collapsed while preserving every count badge", () => {
    const state = sectionState(renderWorkspaceTree());
    expect([...state.keys()]).toEqual(["branches", "tags", "stashes"]);
    expect(Object.fromEntries([...state].map(([id, section]) => [id, section.expanded]))).toEqual({
      branches: true,
      tags: false,
      stashes: false,
    });
    expect(Object.fromEntries([...state].map(([id, section]) => [id, section.count]))).toEqual({
      branches: "1",
      tags: "1",
      stashes: "1",
    });
    expect(state.get("tags")?.hasBody).toBe(false);
    expect(state.get("stashes")?.hasBody).toBe(false);
  });

  it("toggles expanded state and conditionally renders section bodies", () => {
    const initial = sectionState(renderWorkspaceTree());
    initial.get("tags")?.toggle();

    const toggled = sectionState(renderWorkspaceTree());
    expect(toggled.get("tags")).toMatchObject({ expanded: true, hasBody: true, count: "1" });
  });
});
