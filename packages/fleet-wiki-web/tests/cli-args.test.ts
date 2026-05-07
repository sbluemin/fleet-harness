import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { formatHostForUrl, parseCliArgs, resolveClientHost, serverUrl } from "../src/cli.js";

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
  it("parses --host with space-separated value", () => {
    expect(parseCliArgs(["--host", "0.0.0.0"])).toEqual({ mode: "run", host: "0.0.0.0" });
  });

  it("parses --host with equals syntax", () => {
    expect(parseCliArgs(["--host=192.168.1.1"])).toEqual({ mode: "run", host: "192.168.1.1" });
  });

  it("parses --port with space-separated value", () => {
    expect(parseCliArgs(["--port", "8080"])).toEqual({ mode: "run", port: 8080 });
  });

  it("parses --port with equals syntax", () => {
    expect(parseCliArgs(["--port=9090"])).toEqual({ mode: "run", port: 9090 });
  });

  it("parses both --host and --port together", () => {
    expect(parseCliArgs(["--host", "0.0.0.0", "--port", "4000"])).toEqual({
      mode: "run",
      host: "0.0.0.0",
      port: 4000,
    });
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

  it("exits with error for --host with empty value", () => {
    parseCliArgs(["--host="]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --host with whitespace", () => {
    parseCliArgs(["--host", "  "]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with error for --host with control character", () => {
    parseCliArgs(["--host", "127.0.0.1\x00"]);
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

  it("treats next flag as missing value for --host", () => {
    parseCliArgs(["--host", "--port", "8080"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("treats next flag as missing value for --port", () => {
    parseCliArgs(["--port", "--host", "0.0.0.0"]);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("last flag wins when specified multiple times", () => {
    expect(parseCliArgs(["--host", "0.0.0.0", "--host", "127.0.0.1"])).toEqual({
      mode: "run",
      host: "127.0.0.1",
    });
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

describe("resolveClientHost", () => {
  it("maps 0.0.0.0 to 127.0.0.1", () => {
    expect(resolveClientHost("0.0.0.0")).toBe("127.0.0.1");
  });

  it("maps :: to ::1", () => {
    expect(resolveClientHost("::")).toBe("::1");
  });

  it("maps 0:0:0:0:0:0:0:0 to ::1", () => {
    expect(resolveClientHost("0:0:0:0:0:0:0:0")).toBe("::1");
  });

  it("passes through 127.0.0.1 unchanged", () => {
    expect(resolveClientHost("127.0.0.1")).toBe("127.0.0.1");
  });

  it("passes through LAN IP unchanged", () => {
    expect(resolveClientHost("192.168.1.10")).toBe("192.168.1.10");
  });

  it("passes through ::1 unchanged", () => {
    expect(resolveClientHost("::1")).toBe("::1");
  });
});

describe("serverUrl with resolveClientHost integration", () => {
  it("produces http://127.0.0.1:3737 for 0.0.0.0 wildcard", () => {
    expect(serverUrl(resolveClientHost("0.0.0.0"), 3737)).toBe("http://127.0.0.1:3737");
  });

  it("produces http://[::1]:3737 for :: wildcard", () => {
    expect(serverUrl(resolveClientHost("::"), 3737)).toBe("http://[::1]:3737");
  });
});
