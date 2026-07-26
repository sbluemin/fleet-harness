import { beforeEach, describe, expect, it, vi } from "vitest";

import { getState, setConnectionState, setState } from "../core/client/src/store.js";

describe("console connection state", () => {
  beforeEach(() => {
    setState({ connection: "connecting", connectionLostAt: null });
    vi.restoreAllMocks();
  });

  it("records only the first offline timestamp until the connection is live again", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000);

    setConnectionState("offline");
    expect(getState()).toMatchObject({ connection: "offline", connectionLostAt: 1_000 });

    setConnectionState("offline");
    expect(getState()).toMatchObject({ connection: "offline", connectionLostAt: 1_000 });

    setConnectionState("live");
    expect(getState()).toMatchObject({ connection: "live", connectionLostAt: null });
  });

  it("keeps the lost timestamp while a reconnect attempt is connecting", () => {
    setState({ connection: "offline", connectionLostAt: 3_000 });

    setConnectionState("connecting");

    expect(getState()).toMatchObject({ connection: "connecting", connectionLostAt: 3_000 });
  });
});
