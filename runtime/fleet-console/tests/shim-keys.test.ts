// 이 테스트는 dev 의존(workspace에 react 존재)에서만 동작하는 정상 경로이며 published 부팅과 무관하다.
// shim-keys.generated.ts가 실제 모듈 export와 동기화되었는지 검증해 stale 매니페스트를 차단한다.
// stale 시: pnpm --filter @dotobokuri/fleet-console generate:shim-keys 로 재생성한다.

import * as reactNs from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as sdkNotificationsBrowser from "@fleet-console/sdk/notifications/browser";
import * as sdkOperationsBrowser from "@fleet-console/sdk/operations/browser";
import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";
import * as sdkReactBrowser from "@fleet-console/sdk/react/browser";
import * as sdkSettingsBrowser from "@fleet-console/sdk/settings/browser";
import { describe, expect, it } from "vitest";

import { SHIM_NAMED_EXPORTS } from "../core/host/plugin-host/shim-keys.generated.js";

const JS_IDENTIFIER = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;

function extractKeys(ns: Record<string, unknown>): readonly string[] {
  return Object.keys(ns)
    .filter((key) => key !== "default" && JS_IDENTIFIER.test(key))
    .sort();
}

describe("shim-keys.generated.ts stale guard", () => {
  it("react 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["react"]).toEqual(extractKeys(reactNs as Record<string, unknown>));
  });

  it("react/jsx-runtime 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["react/jsx-runtime"]).toEqual(extractKeys(reactJsxRuntime as Record<string, unknown>));
  });

  it("@fleet-console/sdk/plugin/browser 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["@fleet-console/sdk/plugin/browser"]).toEqual(
      extractKeys(sdkPluginBrowser as Record<string, unknown>),
    );
  });

  it("@fleet-console/sdk/settings/browser 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["@fleet-console/sdk/settings/browser"]).toEqual(
      extractKeys(sdkSettingsBrowser as Record<string, unknown>),
    );
  });

  it("@fleet-console/sdk/operations/browser 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["@fleet-console/sdk/operations/browser"]).toEqual(
      extractKeys(sdkOperationsBrowser as Record<string, unknown>),
    );
  });

  it("@fleet-console/sdk/notifications/browser 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["@fleet-console/sdk/notifications/browser"]).toEqual(
      extractKeys(sdkNotificationsBrowser as Record<string, unknown>),
    );
  });

  it("@fleet-console/sdk/react/browser 키가 SHIM_NAMED_EXPORTS와 일치한다", () => {
    expect(SHIM_NAMED_EXPORTS["@fleet-console/sdk/react/browser"]).toEqual(
      extractKeys(sdkReactBrowser as Record<string, unknown>),
    );
  });
});
