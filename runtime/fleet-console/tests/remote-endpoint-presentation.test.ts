import { describe, expect, it } from "vitest";

import {
  buildRemoteEndpointPresentation,
  isValidRemoteAdvertisedHost,
  isValidRemoteListenAddress,
  remoteAccessStateEquals,
  remoteEffectiveEndpoint,
  remoteEndpointImpact,
  remoteEndpointRequirements,
  type RemoteAccessState,
} from "../core/client/src/types.js";

const BASE: RemoteAccessState = {
  enabled: false,
  publicEndpointEnabled: false,
  listenAddress: "",
  advertisedHost: "",
  listenPort: { mode: "auto", value: 50000 },
  advertisedPort: { mode: "auto", value: 50001 },
  acknowledgment: null,
};

function lan(overrides: Partial<RemoteAccessState> = {}): RemoteAccessState {
  return { ...BASE, listenAddress: "192.168.0.68", ...overrides };
}

function published(overrides: Partial<RemoteAccessState> = {}): RemoteAccessState {
  const state: RemoteAccessState = {
    ...lan(),
    publicEndpointEnabled: true,
    advertisedHost: "console.example.com",
    ...overrides,
  };
  return {
    ...state,
    acknowledgment: state.acknowledgment === null && overrides.acknowledgment === undefined
      ? {
        version: 1,
        listenAddress: state.listenAddress,
        listenPort: state.listenPort.value,
        advertisedHost: state.advertisedHost,
        advertisedPort: state.advertisedPort.value,
      }
      : state.acknowledgment,
  };
}

describe("remote listen address validity", () => {
  it("rejects the hosts that would fight the loopback listener for a port", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "0.0.0.0"]) {
      expect(isValidRemoteListenAddress(host)).toBe(false);
    }
    expect(isValidRemoteListenAddress("192.168.0.68")).toBe(true);
    expect(isValidRemoteListenAddress("")).toBe(false);
  });

  it("does not apply the bind-only exclusions to an advertised hostname", () => {
    // 공개 호스트 이름은 이 기계가 바인드하는 주소가 아니라 기기가 향하는 이름이다.
    expect(isValidRemoteAdvertisedHost("localhost")).toBe(true);
    expect(isValidRemoteAdvertisedHost("console.example.com")).toBe(true);
    expect(isValidRemoteAdvertisedHost("not a host")).toBe(false);
  });
});

describe("remote endpoint requirements", () => {
  it("names the listen address while it is missing", () => {
    expect(remoteEndpointRequirements(BASE)).toEqual(["listenAddress"]);
    expect(remoteEndpointRequirements(lan())).toEqual([]);
  });

  it("adds the public hostname and the acknowledgment only in public mode", () => {
    const missing = remoteEndpointRequirements({ ...lan(), publicEndpointEnabled: true });
    expect(missing).toEqual(["advertisedHost", "acknowledgment"]);
    expect(remoteEndpointRequirements(published())).toEqual([]);
  });

  it("treats an acknowledgment that no longer matches the endpoint as missing", () => {
    const stale = published();
    expect(remoteEndpointRequirements({ ...stale, advertisedPort: { mode: "custom", value: 8443 } }))
      .toEqual(["acknowledgment"]);
  });
});

describe("remote endpoint presentation", () => {
  it("emits no address until the required hosts are valid", () => {
    const presentation = buildRemoteEndpointPresentation(BASE);
    // 자리표시자를 주소처럼 보이면 기기에 그대로 옮겨 적힌다.
    expect(presentation.origin).toBeNull();
    expect(presentation.forward).toBeNull();
    expect(presentation.ready).toBe(false);
  });

  it("shows the LAN route as the single origin devices open", () => {
    const presentation = buildRemoteEndpointPresentation(lan());
    expect(presentation.origin).toBe("https://192.168.0.68:50000");
    // LAN 전용에는 전달할 라우터 규칙이 없다.
    expect(presentation.forward).toBeNull();
    expect(presentation.ready).toBe(true);
  });

  it("shows the published origin and the tuple NAT must forward to", () => {
    const presentation = buildRemoteEndpointPresentation(published());
    expect(presentation.origin).toBe("https://console.example.com:50001");
    // 라우터 칸 이름 그대로 나뉘어야 한다 — 외부와 내부 포트가 한 값으로 뭉치면 안 된다.
    expect(presentation.forward).toEqual({ externalPort: 50001, internalHost: "192.168.0.68", internalPort: 50000 });
  });

  it("still shows the route while only the acknowledgment is outstanding", () => {
    // 경로를 봐야 확인에 동의할 수 있으므로 확인 미완은 주소를 감추지 않는다.
    const presentation = buildRemoteEndpointPresentation({ ...published(), acknowledgment: null });
    expect(presentation.origin).toBe("https://console.example.com:50001");
    expect(presentation.ready).toBe(false);
    expect(presentation.missing).toEqual(["acknowledgment"]);
  });
});

describe("remote effective endpoint", () => {
  it("advertises the listen tuple in LAN mode and the public tuple otherwise", () => {
    expect(remoteEffectiveEndpoint(lan())).toEqual({ host: "192.168.0.68", port: 50000 });
    expect(remoteEffectiveEndpoint(published())).toEqual({ host: "console.example.com", port: 50001 });
  });
});

describe("remote endpoint impact", () => {
  it("calls a port mode change with an unchanged value a listener no-op", () => {
    const baseline = lan();
    const next = { ...baseline, listenPort: { mode: "custom" as const, value: baseline.listenPort.value } };
    expect(remoteEndpointImpact(baseline, next)).toBe("none");
  });

  it("calls a LAN listen change an identity replacement", () => {
    // LAN 전용에서는 수신 튜플이 곧 공표 튜플이라, 주소가 바뀌면 기기가 신뢰하던 이름이 사라진다.
    const baseline = lan();
    expect(remoteEndpointImpact(baseline, { ...baseline, listenAddress: "192.168.0.41" })).toBe("identity");
    expect(remoteEndpointImpact(baseline, { ...baseline, listenPort: { mode: "custom", value: 8443 } })).toBe("identity");
  });

  it("calls a public-mode local bind change a restart, not an identity replacement", () => {
    const baseline = published();
    const next = { ...baseline, listenAddress: "192.168.0.41" };
    expect(remoteEndpointImpact(baseline, next)).toBe("restart");
  });

  it("calls an advertised tuple change an identity replacement", () => {
    const baseline = published();
    expect(remoteEndpointImpact(baseline, { ...baseline, advertisedHost: "other.example.com" })).toBe("identity");
    expect(remoteEndpointImpact(baseline, { ...baseline, advertisedPort: { mode: "custom", value: 8443 } })).toBe("identity");
  });

  it("calls switching endpoint mode an identity replacement", () => {
    const baseline = published();
    expect(remoteEndpointImpact(baseline, { ...baseline, publicEndpointEnabled: false })).toBe("identity");
  });
});

describe("remote access state equality", () => {
  it("ignores object identity and compares every persisted field", () => {
    expect(remoteAccessStateEquals(lan(), lan())).toBe(true);
    expect(remoteAccessStateEquals(lan(), { ...lan(), enabled: true })).toBe(false);
    expect(remoteAccessStateEquals(lan(), { ...lan(), listenPort: { mode: "custom", value: 50000 } })).toBe(false);
  });

  it("compares the acknowledgment by value so a re-checked box is not a change", () => {
    const a = published();
    const b = published({ acknowledgment: { ...a.acknowledgment! } });
    expect(remoteAccessStateEquals(a, b)).toBe(true);
    expect(remoteAccessStateEquals(a, { ...a, acknowledgment: null })).toBe(false);
  });
});
