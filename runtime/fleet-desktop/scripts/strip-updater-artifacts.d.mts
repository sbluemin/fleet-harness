// electron-builder가 .mjs 훅을 런타임에 직접 로드하므로 로직은 .mjs로 두되, TS 소비자(테스트)를 위한 타입 선언을 둔다.
export default function stripUpdaterArtifacts(buildResult: { outDir?: string; artifactPaths?: string[] } | undefined): Promise<string[]>;
export function isUpdaterArtifact(fileName: string): boolean;
export function removeUpdaterArtifacts(outDir: string): Promise<string[]>;
