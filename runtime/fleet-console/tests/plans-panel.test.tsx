// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanListItem, PlanReadResult } from "../core/client/src/api.js";

const mocks = vi.hoisted(() => ({
  deletePlan: vi.fn(),
  fetchPlanRead: vi.fn(),
  fetchPlansList: vi.fn(),
  subscribeToPlanChanges: vi.fn(),
}));

vi.mock("../core/client/src/api.js", () => ({
  deletePlan: mocks.deletePlan,
  fetchPlanRead: mocks.fetchPlanRead,
  fetchPlansList: mocks.fetchPlansList,
}));
vi.mock("../core/client/src/rail/plans-events.js", () => ({
  subscribeToPlanChanges: mocks.subscribeToPlanChanges,
}));
vi.mock("@fleet-console/markdown/core", () => ({
  renderMarkdown: vi.fn((content: string) => ({ html: `<p>${content}</p>`, toc: [] })),
}));
vi.mock("@fleet-console/markdown/mermaid", () => ({
  installDiagramHydrator: vi.fn(),
}));

import { plansPanel } from "../core/client/src/rail/plans-panel.js";
import {
  activatePlansSearchTarget,
  consumePlansSearchTarget,
  getPlansSearchTargetForTest,
} from "../core/client/src/rail/plans-search-navigation.js";

let container: HTMLDivElement;
let root: Root;
let invalidatePlans: (() => void) | null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  invalidatePlans = null;
  mocks.deletePlan.mockReset();
  mocks.deletePlan.mockResolvedValue(undefined);
  mocks.fetchPlanRead.mockReset();
  mocks.fetchPlansList.mockReset();
  mocks.subscribeToPlanChanges.mockReset();
  mocks.subscribeToPlanChanges.mockImplementation((_theaterId: string, onInvalidate: () => void) => {
    invalidatePlans = onInvalidate;
    return vi.fn();
  });
});

afterEach(() => {
  act(() => root.unmount());
  const target = getPlansSearchTargetForTest();
  if (target) consumePlansSearchTarget(target);
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("Plans panel reader revalidation", () => {
  it("keeps a deferred foreground read when list invalidation returns the same signature", async () => {
    const plan = listPlan();
    const read = deferred<PlanReadResult>();
    mocks.fetchPlansList.mockResolvedValue({ plans: [plan] });
    mocks.fetchPlanRead.mockReturnValue(read.promise);

    await renderPanel();
    await selectPlan();
    expect(mocks.fetchPlanRead).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Loading plan…");

    await invalidate();

    expect(mocks.fetchPlanRead).toHaveBeenCalledOnce();
    read.resolve(readPlan("Initial plan"));
    await flush();
    expect(container.textContent).toContain("Initial plan");
    expect(container.textContent).not.toContain("Loading plan…");
  });

  it("replaces an in-flight read once for a changed signature and ignores its duplicate revalidation", async () => {
    const initialRead = deferred<PlanReadResult>();
    const replacementRead = deferred<PlanReadResult>();
    mocks.fetchPlansList
      .mockResolvedValueOnce({ plans: [listPlan()] })
      .mockResolvedValue({ plans: [listPlan({ updatedAt: "2026-07-23T01:00:00.000Z" })] });
    mocks.fetchPlanRead
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(replacementRead.promise);

    await renderPanel();
    await selectPlan();
    await invalidate();
    expect(mocks.fetchPlanRead).toHaveBeenCalledTimes(2);

    await invalidate();
    expect(mocks.fetchPlanRead).toHaveBeenCalledTimes(2);

    initialRead.resolve(readPlan("Stale plan"));
    await flush();
    expect(container.textContent).toContain("Loading plan…");
    expect(container.textContent).not.toContain("Stale plan");

    replacementRead.resolve(readPlan("Updated plan"));
    await flush();
    expect(container.textContent).toContain("Updated plan");
  });

  it("releases a failed reader reservation so the same signature can retry on later invalidation", async () => {
    const failedRead = deferred<PlanReadResult>();
    const retryRead = deferred<PlanReadResult>();
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });
    mocks.fetchPlanRead
      .mockReturnValueOnce(failedRead.promise)
      .mockReturnValueOnce(retryRead.promise);

    await renderPanel();
    await selectPlan();
    failedRead.reject(new Error("read failed"));
    await flush();
    expect(container.textContent).toContain("Unable to load plan.");

    await invalidate();
    expect(mocks.fetchPlanRead).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Loading plan…");

    retryRead.resolve(readPlan("Recovered plan"));
    await flush();
    expect(container.textContent).toContain("Recovered plan");
  });

  it("keeps one deletion read when duplicate invalidations report the selected Plan absent", async () => {
    const initialRead = deferred<PlanReadResult>();
    const deletionRead = deferred<PlanReadResult>();
    const duplicateDeletionRead = deferred<PlanReadResult>();
    mocks.fetchPlansList
      .mockResolvedValueOnce({ plans: [listPlan()] })
      .mockResolvedValue({ plans: [] });
    mocks.fetchPlanRead
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(deletionRead.promise)
      .mockReturnValueOnce(duplicateDeletionRead.promise);

    await renderPanel();
    await selectPlan();
    await invalidate();
    expect(mocks.fetchPlanRead).toHaveBeenCalledTimes(2);

    initialRead.resolve(readPlan("Deleted plan"));
    await flush();
    await invalidate();
    expect(mocks.fetchPlanRead).toHaveBeenCalledTimes(2);

    deletionRead.reject(new Error("plan deleted"));
    await flush();
    expect(container.textContent).toContain("Unable to load plan.");
  });
});

describe("Plans palette target reveal", () => {
  it("clears active filters before selecting and scrolling the target, then consumes it", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    mocks.fetchPlansList.mockResolvedValue({
      plans: [
        listPlan(),
        listPlan({ name: "beta.md", title: "Beta", tasksDone: 1, tasksTotal: 1 }),
      ],
    });
    mocks.fetchPlanRead.mockResolvedValue({
      ...readPlan("Beta"),
      name: "beta.md",
    });

    await renderPanel();
    const search = container.querySelector<HTMLInputElement>(".plans-search");
    const inProgress = [...container.querySelectorAll<HTMLButtonElement>(".plans-filter")]
      .find((button) => button.textContent === "IN PROGRESS");
    await act(async () => {
      setInputValue(search, "alpha");
      inProgress?.click();
    });
    expect(container.textContent).not.toContain("beta.md");

    await act(async () => {
      activatePlansSearchTarget("theater-1", "beta.md");
    });
    await flush();

    expect(search?.value).toBe("");
    expect(container.querySelector(".plans-filter.is-active")?.textContent).toBe("ALL");
    expect(container.querySelector(".plans-row.is-selected .plans-row-name")?.textContent).toBe("beta.md");
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.instances[0]).toBe(
      [...container.querySelectorAll<HTMLButtonElement>(".plans-row-select")]
        .find((button) => button.textContent?.includes("beta.md")),
    );
    expect(getPlansSearchTargetForTest()).toBeNull();
  });
});

describe("Plans row deletion", () => {
  it("arms on the first click without deleting", async () => {
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });

    await renderPanel();
    const button = deleteButton();
    await act(async () => button.click());

    expect(button.textContent).toBe("DELETE?");
    expect(button.classList.contains("is-armed")).toBe(true);
    expect(mocks.deletePlan).not.toHaveBeenCalled();
  });

  it("deletes on the second click and refreshes the list", async () => {
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });

    await renderPanel();
    const button = deleteButton();
    await act(async () => button.click());
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.deletePlan).toHaveBeenCalledOnce();
    expect(mocks.deletePlan).toHaveBeenCalledWith("theater-1", "alpha.md");
    expect(mocks.fetchPlansList).toHaveBeenCalledTimes(2);
  });

  it("ignores repeated delete activation until the request settles", async () => {
    const deletion = deferred<void>();
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });
    mocks.deletePlan.mockReturnValue(deletion.promise);

    await renderPanel();
    const button = deleteButton();
    await act(async () => button.click());
    await act(async () => button.click());

    expect(mocks.deletePlan).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);

    await act(async () => {
      button.click();
      container.querySelector<HTMLButtonElement>(".plans-row-select")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(mocks.deletePlan).toHaveBeenCalledOnce();
    expect(button.classList.contains("is-armed")).toBe(false);

    await act(async () => {
      deletion.resolve(undefined);
      await deletion.promise;
    });
    await flush();
    expect(mocks.deletePlan).toHaveBeenCalledOnce();
  });

  it("disarms a missing row so the same name does not reappear pre-armed", async () => {
    mocks.fetchPlansList
      .mockResolvedValueOnce({ plans: [listPlan()] })
      .mockResolvedValueOnce({ plans: [] })
      .mockResolvedValueOnce({ plans: [listPlan()] });

    await renderPanel();
    await act(async () => deleteButton().click());
    expect(deleteButton().classList.contains("is-armed")).toBe(true);

    await invalidate();
    expect(container.querySelector(".plans-delete")).toBeNull();

    await invalidate();
    expect(deleteButton().classList.contains("is-armed")).toBe(false);
    expect(deleteButton().textContent).not.toBe("DELETE?");
    expect(mocks.deletePlan).not.toHaveBeenCalled();
  });

  it("automatically disarms after 1500ms without deleting", async () => {
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });
    await renderPanel();
    vi.useFakeTimers();
    try {
      const button = deleteButton();
      await act(async () => button.click());

      act(() => vi.advanceTimersByTime(1_500));

      expect(button.textContent).not.toBe("DELETE?");
      expect(button.classList.contains("is-armed")).toBe(false);
      expect(mocks.deletePlan).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms when a mouse pointer leaves the row", async () => {
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });

    await renderPanel();
    const button = deleteButton();
    await act(async () => button.click());
    expect(button.classList.contains("is-armed")).toBe(true);

    await act(async () => {
      container.querySelector(".plans-row")?.dispatchEvent(pointerLeave("mouse"));
    });

    expect(button.classList.contains("is-armed")).toBe(false);
    expect(mocks.deletePlan).not.toHaveBeenCalled();
  });

  it("keeps the arm when a touch pointer leaves after the first tap", async () => {
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });

    await renderPanel();
    const button = deleteButton();
    await act(async () => button.click());
    expect(button.classList.contains("is-armed")).toBe(true);

    await act(async () => {
      container.querySelector(".plans-row")?.dispatchEvent(pointerLeave("touch"));
    });

    expect(button.classList.contains("is-armed")).toBe(true);
    expect(button.textContent).toBe("DELETE?");
  });

  it("closes the reader when its open Plan is deleted", async () => {
    mocks.fetchPlansList.mockResolvedValue({ plans: [listPlan()] });
    mocks.fetchPlanRead.mockResolvedValue(readPlan("Open plan"));

    await renderPanel();
    await selectPlan();
    expect(container.querySelector(".plans-reader-pane")).not.toBeNull();

    const button = deleteButton();
    await act(async () => button.click());
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.deletePlan).toHaveBeenCalledWith("theater-1", "alpha.md");
    expect(container.querySelector(".plans-reader-pane")).toBeNull();
  });
});

async function renderPanel(): Promise<void> {
  await act(async () => {
    root.render(plansPanel.render({
      theaterId: "theater-1",
      pathContext: { kind: "root", relPath: null, label: "Theater" },
      api: {} as never,
      requestExtraWidth: vi.fn(),
    }));
  });
  expect(invalidatePlans).not.toBeNull();
  expect(container.querySelector(".plans-row-select")).not.toBeNull();
}

async function selectPlan(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".plans-row-select")?.click();
  });
}

async function invalidate(): Promise<void> {
  await act(async () => {
    invalidatePlans?.();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function listPlan(overrides: Partial<PlanListItem> = {}): PlanListItem {
  return {
    name: "alpha.md",
    title: "Alpha",
    executionMode: "sequential",
    waveCount: 1,
    tasksDone: 0,
    tasksTotal: 1,
    updatedAt: "2026-07-23T00:00:00.000Z",
    sizeBytes: 100,
    ...overrides,
  };
}

function readPlan(title: string): PlanReadResult {
  return {
    name: "alpha.md",
    title,
    executionMode: "sequential",
    updatedAt: "2026-07-23T01:00:00.000Z",
    content: title,
    waves: [],
    tasksDone: 0,
    tasksTotal: 1,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (!input) throw new Error("plans search input not found");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function deleteButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".plans-delete");
  if (!button) throw new Error("plans delete button not found");
  return button;
}

// React는 onPointerLeave를 네이티브 pointerout에서 합성한다 — jsdom에는 PointerEvent가 없어
// 일반 Event에 pointerType을 심어 발행한다.
function pointerLeave(pointerType: string): Event {
  const event = new Event("pointerout", { bubbles: true });
  Object.assign(event, { pointerType });
  return event;
}
