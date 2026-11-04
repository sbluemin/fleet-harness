import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApprovalCore } from "@fleet-console/approval";
import { APPROVAL_ANSWER_ROUTE } from "@fleet-console/approval/contract";
import { afterEach, expect, it } from "vitest";

import { bindDescriptionProposals } from "../features/commodore/host/description-proposals.js";
import { bindIntelProposals } from "../features/commodore/host/intel-proposals.js";
import { createCommodoreRoutes, type CommodoreRouteContext } from "../features/commodore/host/routes.js";
import { createCommodoreStore as createHostStore } from "../features/commodore/host/store.js";
import { createCommodoreTools } from "../features/commodore/host/tools.js";

/**
 * 설명·정보 제안의 저장·권한 경계 하나.
 * 승인 전에는 반영되지 않고, 사람 라우트가 아닌 곳(꺼진 인가·사령관 도구)은 승인하지 못한다.
 * 설명을 하나 승인하면 같은 기준의 나머지는 stale 이라 승인되지 않는다.
 * 정보 고침도 같다. 하나를 반영한 뒤 나머지는 승인을 시도할 때 stale 이 되고 항목은 그대로다.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("keeps a description unchanged until the person approves, then blocks a stale proposal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-approval-"));
  dirs.push(root);
  const ids = ["a", "b"];
  for (const id of ids) fs.mkdirSync(path.join(root, id));
  const store = createHostStore({
    dirOf: (id) => ids.includes(id) ? path.join(root, id) : null,
    theatersOf: () => [{ path: root }],
    theaterIdsOf: () => ["t"],
    emit: () => {},
  });
  const filePath = path.join(root, "approvals", "requests.json");
  let body: unknown;
  let result = { status: 0, value: {} as { request?: { status?: string }; error?: string } };
  let authorized = true;
  const ctx = {
    host: {
      http: { readJsonBody: async () => body, writeJson: (_res: unknown, status: number, value: unknown) => { result = { status, value: value as typeof result.value }; } },
      security: { isTerminalAuthorized: () => authorized },
    },
  } as unknown as CommodoreRouteContext;

  const open = () => {
    const core = createApprovalCore({ filePath });
    const known = (id: string) => ids.includes(id);
    const binding = bindDescriptionProposals({ core, store, known });
    const intel = bindIntelProposals({ core, store, known });
    const routes = createCommodoreRoutes(ctx, store, { approvals: binding.desk });
    return { core, binding, intel, routes };
  };
  let opened = open();
  const answer = async (id: string, decision: "approve" | "reject") => {
    body = { id, decision };
    const route = opened.routes.find((candidate) => candidate.name === APPROVAL_ANSWER_ROUTE)!;
    await route.handler({ req: { method: "POST" } as never, res: {} as never, pathname: `/api/v1/${APPROVAL_ANSWER_ROUTE}` });
    return result;
  };

  const tools = Object.fromEntries(createCommodoreTools({
    commodoreId: "a", theaterRoot: root, store, proposals: opened.binding.forCommodore("a"),
  }).map((tool) => [tool.name, tool]));
  expect(tools.propose_description).toBeDefined();
  expect(tools.description_proposals).toBeDefined();
  expect(Object.keys(tools).some((name) => name.includes("answer") || name.includes("approve"))).toBe(false);

  const propose = async (text: string) => ((await tools.propose_description!.execute({ targetId: "b", text }, { cwd: root })) as { structuredContent: { id: string; status: string } }).structuredContent;
  const first = await propose("Ship the smaller fix.");
  const second = await propose("Ship the larger fix.");
  expect(store.read("b")?.description).toMatchObject({ text: "", rev: 0 });
  expect(first.status).toBe("pending");
  expect(second.status).toBe("pending");

  authorized = false;
  expect((await answer(first.id, "approve")).status).toBe(401);
  expect(store.read("b")?.description).toMatchObject({ text: "", rev: 0 });
  authorized = true;

  opened.intel.dispose();
  opened.binding.dispose();
  opened.core.dispose();
  opened = open();
  expect(opened.binding.forCommodore("a").list().map((request) => request.status)).toEqual(["pending", "pending"]);

  const approved = await answer(first.id, "approve");
  expect(approved.status).toBe(200);
  expect(approved.value.request?.status).toBe("approved");
  expect(store.read("b")?.description).toMatchObject({ text: "Ship the smaller fix.", rev: 1 });
  expect(opened.binding.forCommodore("a").list().find((request) => request.id === second.id)?.status).toBe("stale");

  const blocked = await answer(second.id, "approve");
  expect(blocked.status).toBe(409);
  expect(blocked.value.error).toBe("already_settled");
  expect(store.read("b")?.description).toMatchObject({ text: "Ship the smaller fix.", rev: 1 });

  const repeated = await answer(first.id, "approve");
  expect(repeated.status).toBe(409);
  expect(store.read("b")?.description.rev).toBe(1);

  const seeded = store.addIntel("b", { text: "alpha", source: "person" }).item;
  const intelTools = Object.fromEntries(createCommodoreTools({
    commodoreId: "a", theaterRoot: root, store, intelProposals: opened.intel.forCommodore("a"),
  }).map((tool) => [tool.name, tool]));
  expect(intelTools.propose_intel).toBeDefined();
  expect(intelTools.intel_proposals).toBeDefined();
  expect(Object.keys(intelTools).some((name) => name.includes("answer") || name.includes("approve"))).toBe(false);
  const proposeEdit = async (text: string) => ((await intelTools.propose_intel!.execute({ kind: "edit", targetId: "b", intelId: seeded.id, text }, { cwd: root })) as { structuredContent: { id: string; status: string } }).structuredContent;
  const beta = await proposeEdit("beta");
  const gamma = await proposeEdit("gamma");
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)).toMatchObject({ text: "alpha", source: "person" });
  authorized = false;
  expect((await answer(beta.id, "approve")).status).toBe(401);
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)?.text).toBe("alpha");
  authorized = true;
  const applied = await answer(beta.id, "approve");
  expect(applied.status).toBe(200);
  expect(applied.value.request?.status).toBe("approved");
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)).toMatchObject({ id: seeded.id, text: "beta", source: "person" });
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)?.editedAt).toEqual(expect.any(Number));
  const staleEdit = await answer(gamma.id, "approve");
  expect(staleEdit.status).toBe(200);
  expect(staleEdit.value.request?.status).toBe("stale");
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)?.text).toBe("beta");

  opened.intel.dispose();
  opened.binding.dispose();
  opened.core.dispose();
});
