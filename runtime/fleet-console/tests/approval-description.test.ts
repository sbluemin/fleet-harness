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
 * 정보 고침은 대상 항목이 없으면 승인에 실패하고 제안은 끝난다.
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
  expect(tools.propose_description).toBeDefined();
  expect(tools.description_proposals).toBeDefined();
  expect(Object.keys(tools).some((name) => name.includes("answer") || name.includes("approve"))).toBe(false);

  const propose = async (text: string) => ((await tools.propose_description!.execute({ targetId: "b", text }, { cwd: root })) as { structuredContent: { id: string; status: string } }).structuredContent;
  const first = await propose("Ship the smaller fix.");
  expect(store.read("b")?.description).toMatchObject({ text: "", rev: 0 });
  const second = opened.binding.forCommodore("c").propose("b", "Ship the larger fix.");
  expect(store.read("b")?.description).toMatchObject({ text: "", rev: 0 });
  expect(opened.binding.forCommodore("a").list()).toEqual([]);
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

  const seeded = store.addIntel("b", { text: "alpha", source: "person" }).item;
  const edit = opened.intel.forCommodore("a").proposeEdit("b", seeded.id, "beta");
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)?.text).toBe("alpha");
  store.removeIntel("b", seeded.id);
  const failed = await answer(edit.id, "approve");
  expect(failed.status).toBe(409);
  expect(failed.value.error).toBe("approval_failed");
  expect(store.read("b")?.intel.find((item) => item.id === seeded.id)).toBeUndefined();
  expect(opened.intel.forCommodore("a").list()).toEqual([]);

  opened.intel.dispose();
  opened.binding.dispose();
  opened.core.dispose();
});
