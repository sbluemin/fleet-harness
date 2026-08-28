import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "..", "core", "host", "server.ts"), "utf8");

/**
 * 플러그인이 코어 SSE 스트림에 채널을 얹는 계약.
 *
 * `registerSseChannel`은 오래 빈 스텁(`() => () => undefined`)이었다. 그래서 브라우저에
 * 무언가를 밀려면 플러그인이 자기 EventSource를 따로 열어야 했고, 연결이 둘이면
 * 재접속·순서·생명주기도 둘이 된다.
 *
 * 이 파일은 소스 계약만 못 박는다 — 능력 객체가 `createConsoleServer` 클로저 안에서만
 * 만들어져 픽스처 플러그인 없이는 행동을 부를 수 없다. 그 통합 테스트는 아직 없다.
 */
describe("plugin SSE channel wiring", () => {
  it("is no longer a no-op stub", () => {
    expect(SERVER).not.toContain("registerSseChannel: () => () => undefined");
    expect(SERVER).toMatch(/registerSseChannel: \(channel: string\) => \{/);
  });

  it("forwards only channels a plugin explicitly registered", () => {
    // 모든 in-process 이벤트를 흘리면 서버 내부 채널이 그대로 브라우저 계약이 되고,
    // 그중 하나는 언젠가 민감한 필드를 싣는다.
    expect(SERVER).toMatch(/if \(!pluginSseChannels\.has\(channel\)/);
  });

  it("rides the existing operations stream rather than opening a second one", () => {
    const publish = SERVER.slice(SERVER.indexOf("function publishPluginEvent"));
    expect(publish.slice(0, 600)).toContain("operationSseSubscribers");
    expect(publish.slice(0, 600)).toContain("encodeSseData(channel, payload)");
  });

  it("releases the channel when the registration is disposed", () => {
    expect(SERVER).toMatch(/pluginSseChannels\.delete\(channel\)/);
  });
});
