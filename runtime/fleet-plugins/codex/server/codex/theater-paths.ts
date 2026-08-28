/**
 * Theater 경로 정규화와 식별자. 호스트가 소유한 사실이므로 플러그인은 주입받는다 —
 * 사본을 두면 같은 프로젝트가 호스트와 다른 id로 갈려 워크스페이스가 둘이 된다.
 */
export interface TheaterPathResolver {
  canonicalize: (cwd: string) => Promise<string> | string;
  hash: (canonicalCwd: string) => string;
}

/** 워크스페이스 라우터가 보는 Theater의 최소 형태. */
export interface TheaterRef {
  readonly id: string;
  readonly realpath: string;
}
