import { useEffect, useState } from "react";
import type { HostTransport } from "@fleet-console/sdk/host-context";
import { readHostJson } from "@fleet-console/sdk/host-context/browser";
import { objectiveTextFromPrompt, type QuickLaunchHostPort, type QuickLaunchHostSession, type QuickLaunchHostTheater } from "../../../../features/execution/client/quick-launch-host.js";
import type { HostWorkspaceBinding } from "./use-host-workspace.js";

const CREATE_TIMEOUT_MS = 15_000;

export interface HostQuickLaunch extends QuickLaunchHostPort {
  /** 지금 선택된 원격 컴퓨터·세대에 회차를 연다. 쓰기 권한이 없거나 로컬이면 열지 않는다. */
  readonly open: () => boolean;
  readonly dispose: () => void;
}

interface OpenSession {
  view: QuickLaunchHostSession;
  readonly generation: number;
  readonly transport: HostTransport;
  readonly abort: AbortController;
  inFlight: boolean;
}

/** 원격 Quick Launch 회차의 유일한 소유자다. host·수명·선택 세대가 바뀌면 회차와 진행 중 생성 요청을 함께 끝낸다. */
export function createHostQuickLaunch(binding: HostWorkspaceBinding): HostQuickLaunch {
  const listeners = new Set<() => void>();
  // 같은 컴퓨터에 대한 미발사 문면. 로컬 초안 슬롯과 다른 컴퓨터로 새지 않는다.
  const drafts = new Map<string, string>();
  let session: OpenSession | null = null;
  let nextId = 0;
  let disposed = false;

  const publish = () => { for (const listener of listeners) listener(); };

  function theatersOf(hostKey: string): readonly QuickLaunchHostTheater[] {
    const host = binding.workspace.getSnapshot().hosts.find((candidate) => candidate.hostKey === hostKey);
    return Object.freeze((host?.theaters ?? []).map((theater) => Object.freeze({ id: theater.id, label: theater.alias || theater.label })));
  }

  function current(open: OpenSession): boolean {
    const snapshot = binding.workspace.getSnapshot();
    return !disposed && session === open && !open.abort.signal.aborted && !open.transport.scope.signal.aborted
      && snapshot.selectionGeneration === open.generation && snapshot.selection.hostKey === open.view.hostKey
      && snapshot.foreground !== null && snapshot.canWrite && binding.getSelectedTransport() === open.transport;
  }

  function end(open: OpenSession): void {
    if (session !== open) return;
    session = null;
    open.abort.abort();
    publish();
  }

  const offWorkspace = binding.workspace.subscribe(() => {
    const open = session;
    if (!open) return;
    if (!current(open)) { end(open); return; }
    const theaters = theatersOf(open.view.hostKey);
    const same = theaters.length === open.view.theaters.length && theaters.every((theater, index) => theater.id === open.view.theaters[index]?.id && theater.label === open.view.theaters[index]?.label);
    if (same) return;
    open.view = Object.freeze({ ...open.view, theaters, theaterId: theaters.some((theater) => theater.id === open.view.theaterId) ? open.view.theaterId : null });
    publish();
  });

  return {
    getSnapshot: () => session?.view ?? null,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open: () => {
      if (disposed) return false;
      const snapshot = binding.workspace.getSnapshot();
      const selection = snapshot.selection;
      const transport = binding.getSelectedTransport();
      const host = snapshot.hosts.find((candidate) => candidate.hostKey === selection.hostKey);
      if (selection.hostKey === "local" || snapshot.foreground === null || !snapshot.canWrite || !transport || !host
        || transport.scope.hostKey !== host.hostKey || transport.scope.epoch !== host.epoch || transport.scope.signal.aborted) return false;
      if (session && current(session)) return true;
      if (session) end(session);
      const theaters = theatersOf(host.hostKey);
      session = {
        view: Object.freeze({
          id: ++nextId, hostKey: host.hostKey, hostLabel: host.label, theaters,
          theaterId: theaters.some((theater) => theater.id === selection.theaterId) ? selection.theaterId : theaters[0]?.id ?? null,
          draft: drafts.get(host.hostKey) ?? "",
        }),
        generation: snapshot.selectionGeneration, transport, abort: new AbortController(), inFlight: false,
      };
      publish();
      return true;
    },
    close: (draft) => {
      const open = session;
      if (!open) return;
      if (draft.trim().length > 0) drafts.set(open.view.hostKey, draft);
      else drafts.delete(open.view.hostKey);
      end(open);
    },
    create: async (view, input) => {
      const open = session;
      if (!open || open.view.id !== view.id || !current(open)) return "stale";
      if (open.inFlight) throw new Error("quick_launch_busy");
      if (!open.view.theaters.some((theater) => theater.id === input.theaterId)) throw new Error("theater_missing");
      const { title, note } = objectiveTextFromPrompt(input.text);
      if (title.length === 0) throw new Error("title_required");
      open.inFlight = true;
      try {
        const scope = open.transport.scope;
        const response = await open.transport.request("/plugins/objectives/objective/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theaterId: input.theaterId, title, ...(note !== null ? { note } : {}), language: input.language }),
          signal: AbortSignal.any([open.abort.signal, scope.signal, AbortSignal.timeout(CREATE_TIMEOUT_MS)]),
        });
        const body = await readHostJson<{ readonly objective?: unknown; readonly error?: unknown }>(scope, response);
        // 늦은 응답은 그사이 바뀐 선택을 되돌리지 않는다. 만든 목표는 그 컴퓨터의 목록에 남는다.
        if (!current(open)) return "stale";
        if (!response.ok) throw new Error(typeof body.error === "string" && body.error.length > 0 ? body.error : "objective_create_failed");
        const created = readCreated(body.objective, input.theaterId);
        if (!created) throw new Error("invalid_objective_response");
        drafts.delete(open.view.hostKey);
        end(open);
        // 선택은 workspace가 같은 고정 transport로 목표를 다시 확인한 뒤에만 바뀐다. 실행 중 Operation으로 꾸미지 않는다.
        // 확인 실패는 workspace가 오류 상태로 알리므로 여기서 다시 던지지 않는다.
        await binding.workspace.activateObjective({ hostKey: open.view.hostKey, theaterId: created.theaterId, role: "commander", operationId: created.id }).catch(() => undefined);
        return "created";
      } catch (cause) {
        if (!current(open)) return "stale";
        throw cause;
      } finally {
        open.inFlight = false;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offWorkspace();
      const open = session;
      session = null;
      open?.abort.abort();
      drafts.clear();
      publish();
      listeners.clear();
    },
  };
}

/** app 조립용. binding 수명과 같이 만들고 버린다. */
export function useHostQuickLaunch(binding: HostWorkspaceBinding | null): HostQuickLaunch | null {
  const [port, setPort] = useState<HostQuickLaunch | null>(null);
  useEffect(() => {
    if (!binding) { setPort(null); return; }
    const created = createHostQuickLaunch(binding);
    setPort(created);
    return () => created.dispose();
  }, [binding]);
  return port;
}

function readCreated(value: unknown, theaterId: string): { readonly id: string; readonly theaterId: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.theaterId !== theaterId) return null;
  return { id: record.id, theaterId };
}
