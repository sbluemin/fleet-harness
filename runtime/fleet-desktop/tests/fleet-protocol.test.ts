import { describe, expect, it } from "vitest";

import { findAccessLinkArgument, FLEET_PROTOCOL, isFleetProtocolLink } from "../src/console-links.js";

const LINK = "fleet://join?code=eyJ2IjoxLCJlbmRwb2ludCI6Imh0dHBzOi8vYS50ZXN0OjQzMTAifQ";

describe("fleet protocol", () => {
  it("registers the scheme the console mints links for", () => {
    expect(FLEET_PROTOCOL).toBe("fleet");
    expect(LINK.startsWith(`${FLEET_PROTOCOL}://`)).toBe(true);
  });

  it("accepts our scheme however the OS cased it", () => {
    expect(isFleetProtocolLink(LINK)).toBe(true);
    expect(isFleetProtocolLink(LINK.replace("fleet://", "FLEET://"))).toBe(true);
  });

  it.each([
    ["an empty value", ""],
    ["another scheme", "other://pair?code=abc"],
    ["a web url", "https://a.test:4310/console/"],
    ["a file path", "/Applications/Fleet Console.app"],
    ["a flag", "--enable-logging"],
    ["a smuggled space", "fleet://join?code=a b"],
    ["a smuggled newline", "fleet://join?code=a\nb"],
    ["something absurdly long", `fleet://join?code=${"a".repeat(5000)}`],
  ])("refuses %s", (_label, value) => {
    expect(isFleetProtocolLink(value)).toBe(false);
  });

  it("finds the link among the arguments an OS actually hands over", () => {
    expect(findAccessLinkArgument(["/path/to/Fleet Console", "--enable-logging", LINK])).toBe(LINK);
    expect(findAccessLinkArgument(["/path/to/Fleet Console"])).toBeNull();
  });

  it("opens one console per launch even when several links arrive", () => {
    const second = `${LINK}Zz`;

    expect(findAccessLinkArgument(["app", LINK, second])).toBe(LINK);
  });
});
