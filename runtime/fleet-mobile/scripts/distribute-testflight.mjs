#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fail } from "./lib/android-tools.mjs";
import { requireAscCredentials, runCombined } from "./lib/ios-tools.mjs";
import { artifactPaths, repoRoot, verifyPromotedIpa } from "./lib/ios-promote.mjs";

// distribute-firebase.mjs의 iOS 대응. 승격된 release IPA를 재검증한 뒤 App Store Connect API
// 키로 TestFlight에 업로드한다. CI는 `firebase login`처럼 대화형 로그인을 할 수 없으므로
// ASC API 키(.p8)로 인증한다. 키 파일 경로는 CI가 FLEET_ASC_KEY_PATH로 넘긴다
// (FLEET_ASC_KEY_BASE64를 디코드해 RUNNER_TEMP에 쓴 AuthKey_<KEYID>.p8).

function keyPath(env) {
  const explicit = env.FLEET_ASC_KEY_PATH;
  if (explicit) {
    if (!path.isAbsolute(explicit)) fail("FLEET_ASC_KEY_PATH must be absolute");
    return explicit;
  }
  return fail("FLEET_ASC_KEY_PATH must point to the AuthKey .p8 (CI writes it from FLEET_ASC_KEY_BASE64)");
}

/** altool은 JSON 앞뒤로 비-JSON 줄을 섞기도 한다. 가장 바깥 객체만 떼어 읽는다. */
function parseAltoolJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

function main() {
  const asc = requireAscCredentials();
  const key = keyPath(process.env);

  // 디스크를 믿지 않고 항상 승격된 release IPA를 재검증한다.
  verifyPromotedIpa("release");
  const paths = artifactPaths("release");
  const sha256 = readFileSync(paths.sha256, "utf8").trim().split(/\s+/)[0];
  process.stdout.write(`Uploading ${paths.name} (sha256 ${sha256}) to TestFlight\n`);

  // altool은 업로드가 거부돼도 0으로 끝나는 경우가 있다 — 그러면 잡은 초록인데 TestFlight에는
  // 아무것도 없다. JSON으로 받아 product-errors를 직접 확인하고, 파싱조차 안 되면 실패로 본다.
  const output = runCombined("xcrun", [
    "altool", "--upload-app",
    "--type", "ios",
    "--file", paths.ipa,
    "--apiKey", asc.keyId,
    "--apiIssuer", asc.issuerId,
    "--output-format", "json",
  ], { cwd: repoRoot, env: { ...process.env, API_PRIVATE_KEYS_DIR: path.dirname(key) } });

  const parsed = parseAltoolJson(output);
  if (!parsed) {
    fail(`altool did not return parseable JSON; treating the upload as failed:\n${output.trim().slice(0, 2000)}`);
  }
  const errors = parsed["product-errors"] ?? [];
  if (errors.length > 0) {
    const detail = errors.map((e) => e.message ?? JSON.stringify(e)).join("; ");
    fail(`TestFlight upload was rejected: ${detail}`);
  }
  process.stdout.write("Upload accepted. The build still has to finish processing in App Store Connect before testers can install it.\n");
}

main();
