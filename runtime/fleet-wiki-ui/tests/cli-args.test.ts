import { describe, expect, it } from "vitest";

import { formatHostForUrl, parseCliArgs, resolveBrowserOpenHost, resolveLocalControlHost, serverUrl } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("parses --port with space-separated value", () => {
    expect(parseCliArgs(["--port", "8080"])).toEqual({ mode: "run", port: 8080 });
  });

  it("parses --port with equals syntax", () => {
    expect(parseCliArgs(["--port=9090"])).toEqual({ mode: "run", port: 9090 });
  });

  it("parses --host with space-separated value", () => {
    expect(parseCliArgs(["--host", "0.0.0.0"])).toEqual({ mode: "run", host: "0.0.0.0" });
  });

  it("parses --host with equals syntax", () => {
    expect(parseCliArgs(["--host=wiki-share.local"])).toEqual({ mode: "run", host: "wiki-share.local" });
  });

  it("parses --stop mode", () => {
    expect(parseCliArgs(["--stop"])).toEqual({ mode: "stop" });
  });

  it("parses --help mode", () => {
    expect(parseCliArgs(["--help"])).toEqual({ mode: "help" });
  });

  it("throws for unknown -- flags", () => {
    expect(() => parseCliArgs(["--unknown", "value"])).toThrow("Unknown option: --unknown");
  });

  it("throws for unknown -- flag without value", () => {
    expect(() => parseCliArgs(["--another"])).toThrow("Unknown option: --another");
  });

  it("throws for non-dash positional arguments", () => {
    expect(() => parseCliArgs(["somefile.txt"])).toThrow("Unexpected positional argument: somefile.txt");
  });

  it("throws for fleet hook positional arguments", () => {
    expect(() => parseCliArgs(["hook", "subagents-context"])).toThrow("Unexpected positional argument: hook");
  });

  it("returns empty object for no args", () => {
    expect(parseCliArgs([])).toEqual({ mode: "run" });
  });

  it("throws for --host missing value", () => {
    expect(() => parseCliArgs(["--host"])).toThrow("--host requires a value");
  });

  it("throws for invalid --host value", () => {
    expect(() => parseCliArgs(["--host=bad_host!"])).toThrow("Invalid --host value: bad_host!");
  });

  it("throws for --port missing value", () => {
    expect(() => parseCliArgs(["--port"])).toThrow("--port requires a value");
  });

  it("throws for --port with non-numeric value", () => {
    expect(() => parseCliArgs(["--port", "abc"])).toThrow("Invalid --port value: abc");
  });

  it("throws for --port out of range (0)", () => {
    expect(() => parseCliArgs(["--port", "0"])).toThrow("Invalid --port value: 0");
  });

  it("throws for --port out of range (negative)", () => {
    expect(() => parseCliArgs(["--port", "-1"])).toThrow("Invalid --port value: -1");
  });

  it("throws for --port out of range (>65535)", () => {
    expect(() => parseCliArgs(["--port", "65536"])).toThrow("Invalid --port value: 65536");
  });

  it("treats next flag as missing value for --port", () => {
    expect(() => parseCliArgs(["--port", "--host", "0.0.0.0"])).toThrow("--port requires a value");
  });
});

describe("formatHostForUrl", () => {
  it("returns IPv4 host unchanged", () => {
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });

  it("returns hostname unchanged", () => {
    expect(formatHostForUrl("localhost")).toBe("localhost");
  });

  it("wraps IPv6 literal in brackets", () => {
    expect(formatHostForUrl("::1")).toBe("[::1]");
  });

  it("wraps full IPv6 address in brackets", () => {
    expect(formatHostForUrl("fe80::1")).toBe("[fe80::1]");
  });

  it("wraps IPv6 unspecified address in brackets", () => {
    expect(formatHostForUrl("::")).toBe("[::]");
  });

  it("wraps IPv6 full expanded address in brackets", () => {
    expect(formatHostForUrl("0:0:0:0:0:0:0:0")).toBe("[0:0:0:0:0:0:0:0]");
  });
});

describe("serverUrl", () => {
  it("produces the loopback daemon URL", () => {
    expect(serverUrl("127.0.0.1", 3737)).toBe("http://127.0.0.1:3737");
  });
});

describe("resolveLocalControlHost", () => {
  it("canonicalizes IPv4 wildcard binds to IPv4 loopback", () => {
    expect(resolveLocalControlHost("0.0.0.0")).toBe("127.0.0.1");
  });

  it("canonicalizes IPv6 wildcard binds to IPv6 loopback", () => {
    expect(resolveLocalControlHost("::")).toBe("::1");
    expect(resolveLocalControlHost("0:0:0:0:0:0:0:0")).toBe("::1");
  });

  it("canonicalizes non-loopback hosts to IPv4 loopback", () => {
    expect(resolveLocalControlHost("192.168.1.50")).toBe("127.0.0.1");
    expect(resolveLocalControlHost("wiki-share.local")).toBe("127.0.0.1");
    expect(resolveLocalControlHost("fe80::abcd")).toBe("127.0.0.1");
  });

  it("preserves loopback hosts", () => {
    expect(resolveLocalControlHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveLocalControlHost("::1")).toBe("::1");
    expect(resolveLocalControlHost("localhost")).toBe("localhost");
  });
});

describe("resolveBrowserOpenHost", () => {
  it("canonicalizes wildcard binds for browser open URLs", () => {
    expect(resolveBrowserOpenHost("0.0.0.0")).toBe("127.0.0.1");
    expect(resolveBrowserOpenHost("::")).toBe("::1");
    expect(resolveBrowserOpenHost("0:0:0:0:0:0:0:0")).toBe("::1");
  });

  it("preserves explicit non-wildcard hosts for browser open URLs", () => {
    expect(resolveBrowserOpenHost("192.168.1.50")).toBe("192.168.1.50");
    expect(resolveBrowserOpenHost("wiki-share.local")).toBe("wiki-share.local");
  });
});
