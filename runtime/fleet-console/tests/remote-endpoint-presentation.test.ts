import { describe, expect, it } from "vitest";

import {
  buildRemoteEndpointPresentation,
  isValidRemoteAdvertisedHost,
  isValidRemoteListenAddress,
  remoteAccessStateEquals,
  remoteEffectiveEndpoint,
  remoteEndpointImpact,
  remoteEndpointRequirements,
  isValidRemoteAccessPort,
  REMOTE_AUTO_PORT_MIN,
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
});

describe("remote endpoint impact", () => {

  it("calls switching endpoint mode an identity replacement", () => {
    const baseline = published();
    expect(remoteEndpointImpact(baseline, { ...baseline, publicEndpointEnabled: false })).toBe("identity");
  });
});
