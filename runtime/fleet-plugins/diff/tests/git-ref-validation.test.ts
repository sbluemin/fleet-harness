import { describe, expect, it } from "vitest";

import { isSafeGitRef } from "../server/diff.js";

describe("isSafeGitRef", () => {
  it("accepts short SHA (7 hex)", () => {
    expect(isSafeGitRef("abc1234")).toBe(true);
  });

  it("accepts full SHA (40 hex)", () => {
    expect(isSafeGitRef("a".repeat(40))).toBe(true);
  });

  it("accepts simple branch name", () => {
    expect(isSafeGitRef("main")).toBe(true);
  });

  it("accepts branch with slash", () => {
    expect(isSafeGitRef("feature/my-branch")).toBe(true);
  });

  it("accepts semver-style tag", () => {
    expect(isSafeGitRef("v1.2.3")).toBe(true);
  });

  it("accepts tag with tilde (ancestry)", () => {
    expect(isSafeGitRef("v1.0.0~1")).toBe(true);
  });

  it("rejects leading dash (option injection)", () => {
    expect(isSafeGitRef("-foo")).toBe(false);
  });

  it("rejects --option style", () => {
    expect(isSafeGitRef("--output=/etc/passwd")).toBe(false);
  });

  it("rejects --no-index", () => {
    expect(isSafeGitRef("--no-index")).toBe(false);
  });

  it("rejects ref with shell metacharacter", () => {
    expect(isSafeGitRef("main; rm -rf /")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSafeGitRef("")).toBe(false);
  });

  it("rejects ref exceeding 251 characters", () => {
    expect(isSafeGitRef("a" + "b".repeat(251))).toBe(false);
  });
});
