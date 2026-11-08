import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApprovalCore } from "@fleet-console/approval";
import { afterEach, expect, it } from "vitest";

import { APPROVAL_ANSWER_PATH, createApprovalRouter } from "../core/host/bootstrap/approval-routes.js";
import { bindDescriptionProposals } from "../features/commodore/host/description-proposals.js";
import { bindIntelProposals } from "../features/commodore/host/intel-proposals.js";
import { createCommodoreStore as createHostStore } from "../features/commodore/host/store.js";
import { createCommodoreTools } from "../features/commodore/host/tools.js";

/**
 * 설명·정보 제안의 저장·권한 경계 하나.
 * 승인 전에는 반영되지 않고, 사람 라우트가 아닌 곳(꺼진 인가·사령관 도구)은 승인하지 못한다.
 * 설명은 승인 전에 바뀌지 않고, 같은 대상의 새 제안이 이전 것을 밀어낸다.
 * 제안자는 자기 제안만 거두고, 남의 제안은 거절된다.
 * 정보 항목이 지워지면 그 제안은 그때 거둬지고, 항목이 없는데 승인하면 실패한다.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("does not apply a description until the person approves, and a new proposal replaces the open one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-approval-"));
  dirs.push(root);
  const ids = ["a", "b", "c"];
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

  const open = () => {
    const core = createApprovalCore({ filePath });
    const known = (id: string) => ids.includes(id);
    const binding = bindDescriptionProposals({ core, store, known });
    const intel = bindIntelProposals({ core, store, known });
    const router = createApprovalRouter({
      core,
      isAuthorized: () => authorized,
      readJsonBody: async () => body,
      writeJson: (_res, status, value) => { result = { status, value: value as typeof result.value }; },
    });
    return { core, binding, intel, router };
  };
  let opened = open();
  const answer = async (id: string, decision: "approve" | "reject") => {
    body = { id, decision };
    await opened.router({ req: { method: "POST" } as never, res: {} as never, pathname: APPROVAL_ANSWER_PATH });
    return result;
  };

  const tools = Object.fromEntries(createCommodoreTools({
    commodoreId: "a", theaterRoot: root, store, proposals: opened.binding.forCommodore("a"),
  }).map((tool) => [tool.name, tool]));
  expect(tools.description).toBeDefined();
  expect(Object.keys(tools)).not.toContain("propose_description");
  expect(Object.keys(tools).some((name) => name.includes("answer") || name.includes("approve"))).toBe(false);

  const propose = async (text: string) => ((await tools.description!.execute({ action: "propose", targetId: "b", text }, { cwd: root })) as { structuredContent: { id: string; status: string } }).structuredContent;
  const first = await propose("Ship the smaller fix.");
  expect(store.read("b")?.description).toMatchObject({ text: "", rev: 0 });
  const second = opened.binding.forCommodore("c").propose("b", "Ship the larger fix.");
  expect(store.read("b")?.description).toMatchObject({ text: "", rev: 0 });
  expect(opened.binding.forCommodore("a").list()).toEqual([]);
  expect(second.payload).toMatchObject({ replaced: true });
  expect(opened.binding.forCommodore("c").list().map((request) => request.id)).toEqual([second.id]);
  const refused = await tools.description!.execute({ action: "withdraw", id: second.id }, { cwd: root }) as { isError: boolean; structuredContent: { error?: string } };
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent.error).toBe("not_proposer");
  expect(opened.binding.forCommodore("c").list().map((request) => request.id)).toEqual([second.id]);

  store.setDescription("b", "The person wrote this.");
  authorized = false;
  expect((await answer(second.id, "approve")).status).toBe(401);
  expect(store.read("b")?.description.text).toBe("The person wrote this.");
  authorized = true;
  const approved = await answer(second.id, "approve");
  expect(approved.status).toBe(200);
  expect(approved.value.request?.status).toBe("approved");
  expect(store.read("b")?.description).toMatchObject({ text: "Ship the larger fix.", rev: 2 });
  expect((await answer(first.id, "approve")).status).toBe(404);
  expect((await answer(second.id, "approve")).value.error).toBe("unknown_request");

  const own = await propose("A later wording.");
  expect(store.read("b")?.description.text).toBe("Ship the larger fix.");
  const withdrawn = await tools.description!.execute({ action: "withdraw", id: own.id }, { cwd: root }) as { isError: boolean; structuredContent: { status?: string; reason?: string } };
  expect(withdrawn.isError).toBe(false);
  expect(withdrawn.structuredContent).toMatchObject({ status: "withdrawn", reason: "proposer" });
  expect(store.read("b")?.description.text).toBe("Ship the larger fix.");
  expect(opened.binding.forCommodore("a").list()).toEqual([]);

  const seeded = store.addIntel("b", { text: "alpha", source: "person" }).item;
  const edit = opened.intel.forCommodore("a").proposeEdit("b", seeded.id, "beta");
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)?.text).toBe("alpha");
  const notices: { type: string; status: string; reason?: string }[] = [];
  const stopNotices = opened.core.subscribeSettled((record) => { notices.push({ type: record.type, status: record.status, reason: record.reason }); });
  store.removeIntel("b", seeded.id);
  expect(notices).toEqual([{ type: "commodore.intel", status: "withdrawn", reason: "item-removed" }]);
  expect(opened.intel.forCommodore("a").list()).toEqual([]);
  expect((await answer(edit.id, "approve")).status).toBe(404);
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)).toBeUndefined();
  stopNotices();

  opened.intel.dispose();
  const again = store.addIntel("b", { text: "gamma", source: "person" }).item;
  const late = opened.intel.forCommodore("a").proposeEdit("b", again.id, "delta");
  store.removeIntel("b", again.id);
  expect(opened.intel.forCommodore("a").list().map((request) => request.id)).toEqual([late.id]);
  const failed = await answer(late.id, "approve");
  expect(failed.status).toBe(409);
  expect(failed.value.error).toBe("approval_failed");
  expect(opened.intel.forCommodore("a").list()).toEqual([]);

  opened.binding.dispose();
  opened.core.dispose();
});
