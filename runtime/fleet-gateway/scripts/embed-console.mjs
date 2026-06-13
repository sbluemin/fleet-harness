// fleet-console 빌드 산출물(dist/client)을 gateway의 dist/client로 복사(embed)한다.
// gateway는 런타임에 ../dist/client/ 경로에서 Fleet Console 정적 자산을 서빙한다.
//
// fleet-console이 gateway에 prod 의존하므로(콘솔 CLI 런처), gateway가 fleet-console을
// 워크스페이스 의존성으로 선언하면 순환이 생겨 `pnpm -r build`의 위상 정렬이 깨진다.
// 따라서 모노레포 상대 경로로만 해석하고, 클린 빌드에서 gateway가 fleet-console보다
// 먼저 빌드되는 경우(산출물 부재)는 경고 후 건너뛴다 — fleet-console 빌드의 마지막
// 단계가 이 스크립트를 다시 호출해 embed를 완성한다.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sourceDir = fileURLToPath(new URL("../../fleet-console/dist/client/", import.meta.url));
const destinationDir = fileURLToPath(new URL("../dist/client/", import.meta.url));

if (!fs.existsSync(sourceDir)) {
  process.stdout.write(
    `embed-console: ${sourceDir} not found — skipping.\n` +
    "The fleet-console build re-runs this embed step after producing dist/client.\n",
  );
  process.exit(0);
}

fs.rmSync(destinationDir, { recursive: true, force: true });
fs.cpSync(sourceDir, destinationDir, { recursive: true });
process.stdout.write(`embed-console: copied ${sourceDir} -> ${destinationDir}\n`);
