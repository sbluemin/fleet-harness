#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fail } from "./lib/android-tools.mjs";
import { BUNDLE_ID, requireAscCredentials, runCombined } from "./lib/ios-tools.mjs";
import { artifactPaths, readAppVersion, repoRoot, verifyPromotedIpa } from "./lib/ios-promote.mjs";
import { ASC_GROUPS_ENV, createAscClient, parseGroupNames } from "./lib/asc-api.mjs";

// distribute-firebase.mjs의 iOS 대응. 승격된 release IPA를 재검증한 뒤 App Store Connect API
// 키로 TestFlight에 업로드하고, 그 빌드를 테스터 그룹에 배정하며 "What to Test" 노트를 싣는다.
// CI는 `firebase login`처럼 대화형 로그인을 할 수 없으므로 ASC API 키(.p8)로 인증한다. 키 파일
// 경로는 CI가 FLEET_ASC_KEY_PATH로 넘긴다(FLEET_ASC_KEY_BASE64를 디코드해 RUNNER_TEMP에 쓴
// AuthKey_<KEYID>.p8).
//
// 업로드만으로는 배포가 아니다 — altool은 바이너리를 올릴 뿐 그룹도 노트도 모른다. Android가
// Firebase에서 그룹과 릴리스 노트를 함께 보내는 것과 같은 결과를 만들려면 업로드 뒤 REST API로
// 배정과 노트를 마저 해야 한다. 그래서 이 스크립트는 빌드가 처리(Processing)를 마칠 때까지
// 기다린다: 처리 중인 빌드는 그룹에 붙일 수 없다.

/** 처리 대기 상한. Apple의 처리 시간은 보통 5~15분이고, 넘기면 배정 없이 끝났음을 알린다. */
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;

function keyPath(env) {
  const explicit = env.FLEET_ASC_KEY_PATH;
  if (explicit) {
    if (!path.isAbsolute(explicit)) fail("FLEET_ASC_KEY_PATH must be absolute");
    return explicit;
  }
  return fail("FLEET_ASC_KEY_PATH must point to the AuthKey .p8 (CI writes it from FLEET_ASC_KEY_BASE64)");
}

function readNotesArgument(argv) {
  const index = argv.indexOf("--notes");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail("--notes requires a value");
  return value;
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

function upload(paths, asc, key) {
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
}

async function waitForProcessedBuild(client, appId, versionName, buildNumber, deadline) {
  for (;;) {
    const build = await client.findBuild(appId, versionName, buildNumber);
    const state = build?.attributes?.processingState;
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID") {
      fail(`App Store Connect rejected build ${versionName} (${buildNumber}) while processing: ${state}`);
    }
    if (Date.now() >= deadline) {
      const minutes = PROCESSING_TIMEOUT_MS / 60000;
      // 두 경우의 다음 행동이 다르다. 빌드가 보이는데 처리 중이면 재실행이 업로드를 건너뛰고
      // 배정만 마치지만, 아예 보이지 않으면 건너뛸 근거가 없어 재실행은 다시 업로드한다.
      if (state) {
        fail(
          `Build ${versionName} (${buildNumber}) was still ${state} after ${minutes} minutes. ` +
            "The upload was accepted — re-running this job skips the upload and finishes the tester assignment.",
        );
      }
      fail(
        `Build ${versionName} (${buildNumber}) never appeared in App Store Connect within ${minutes} minutes. ` +
          "altool reported the upload as accepted, so check App Store Connect before re-running: with no build to find, " +
          "the next run uploads again.",
      );
    }
    process.stdout.write(`  build ${versionName} (${buildNumber}) is ${state ?? "not visible yet"}; waiting…\n`);
    await delay(POLL_INTERVAL_MS);
  }
}

async function main() {
  const asc = requireAscCredentials();
  const key = keyPath(process.env);

  // 아무도 받지 못하는 업로드는 배포가 아니다 — Android가 그룹/테스터 없이 실패하는 것과 같은 자리.
  const groupNames = parseGroupNames(process.env[ASC_GROUPS_ENV]);
  if (groupNames.length === 0) {
    fail(`Set ${ASC_GROUPS_ENV} to the TestFlight group names that receive this build; an upload nobody receives is not a distribution`);
  }

  // 디스크를 믿지 않고 항상 승격된 release IPA를 재검증한다.
  verifyPromotedIpa("release");
  const paths = artifactPaths("release");
  const { versionName, buildNumber } = readAppVersion();
  const sha256 = readFileSync(paths.sha256, "utf8").trim().split(/\s+/)[0];
  const notes = readNotesArgument(process.argv.slice(2)) ?? `Fleet Mobile ${versionName} (build ${buildNumber})\nsha256 ${sha256}`;

  const client = createAscClient({ keyId: asc.keyId, issuerId: asc.issuerId, keyPath: key });
  const appId = await client.appId(BUNDLE_ID);

  // 같은 버전·빌드 번호가 이미 올라가 있으면 다시 올리지 않는다. 배정이나 노트에서 실패해 잡을
  // 다시 돌릴 때, 중복 업로드로 거절당하는 대신 남은 단계만 이어서 끝내기 위한 것이다.
  const already = await client.findBuild(appId, versionName, buildNumber);
  if (already) {
    process.stdout.write(`Build ${versionName} (${buildNumber}) is already in App Store Connect; skipping the upload\n`);
  } else {
    process.stdout.write(`Uploading ${paths.name} (sha256 ${sha256}) to TestFlight\n`);
    upload(paths, asc, key);
    process.stdout.write("Upload accepted. Waiting for App Store Connect to finish processing the build.\n");
  }

  const build = await waitForProcessedBuild(client, appId, versionName, buildNumber, Date.now() + PROCESSING_TIMEOUT_MS);

  const localization = await client.setWhatsNew(build.id, notes);
  process.stdout.write(`What to Test ${localization} for build ${versionName} (${buildNumber})\n`);

  const groups = await client.resolveGroupIds(appId, groupNames);
  for (const group of groups) {
    await client.assignToGroup(group.id, build.id);
    process.stdout.write(`Assigned build ${versionName} (${buildNumber}) to TestFlight group "${group.name}"\n`);
  }

  process.stdout.write(`Distributed ${paths.name} (${sha256}) to ${groups.length} TestFlight group(s)\n`);
}

await main();
