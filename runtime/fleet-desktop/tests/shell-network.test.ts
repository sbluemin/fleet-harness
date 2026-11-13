import { describe, expect, it } from "vitest";

import { createShellNetwork, type ShellNetworkSession } from "../src/shell-network.js";

describe("shell network cookies", () => {
  it("copies only the cookies whose names end with this origin's port", async () => {
    const copied: string[] = [];
    const windowSession = sessionStub(async () => [
      { name: "fleet_console_pairing_4310", value: "own" },
      { name: "fleet_console_pairing_9999", value: "sibling" },
      { name: "fleet_console_pairing_310", value: "suffix" },
      { name: "plain", value: "other" },
    ]);
    const shellSession = sessionStub(async () => []);
    shellSession.cookies.set = async (cookie) => { copied.push(cookie.name); };
    const network = createShellNetwork({
      windowSession,
      shellSession,
      isRemote: () => true,
    });

    await network.fetch("https://127.0.0.1:4310/api/v1/console-roster");

    expect(copied).toEqual(["fleet_console_pairing_4310"]);
  });
});

function sessionStub(get: ShellNetworkSession["cookies"]["get"]): ShellNetworkSession {
  return {
    setCertificateVerifyProc: () => undefined,
    fetch: async () => new Response(null, { status: 200 }),
    cookies: { get, set: async () => undefined },
  };
}
