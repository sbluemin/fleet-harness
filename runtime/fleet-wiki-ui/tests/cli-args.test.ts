import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { formatHostForUrl, parseCliArgs, resolveBrowserOpenHost, resolveLocalControlHost, serverUrl } from "../src/cli.js";

const originalExit = process.exit;
const originalStderrWrite = process.stderr.write;

beforeEach(() => {
  process.exit = vi.fn() as never;
  process.stderr.write = vi.fn() as never;
});

afterEach(() => {
  process.exit = originalExit;
  process.stderr.write = originalStderrWrite;
});

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

  it("exits with error for unknown -- flags", () => {
    parseCliArgs(["--unknown", "value"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for unknown -- flag without value", () => {
    parseCliArgs(["--another"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("ignores non-dash positional arguments", () => {
    expect(parseCliArgs(["somefile.txt"])).toEqual({ mode: "run" });
  });

  it("returns empty object for no args", () => {
    expect(parseCliArgs([])).toEqual({ mode: "run" });
  });

  it("exits with error for --host missing value", () => {
    parseCliArgs(["--host"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for invalid --host value", () => {
    parseCliArgs(["--host=bad_host!"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --port missing value", () => {
    parseCliArgs(["--port"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --port with non-numeric value", () => {
    parseCliArgs(["--port", "abc"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --port out of range (0)", () => {
    parseCliArgs(["--port", "0"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --port out of range (negative)", () => {
    parseCliArgs(["--port", "-1"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --port out of range (>65535)", () => {
    parseCliArgs(["--port", "65536"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("treats next flag as missing value for --port", () => {
    parseCliArgs(["--port", "--host", "0.0.0.0"]);
    expect(process.exit).toHaveBeenCalledWith(1);
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
