/**
 * 이 문서가 어느 버전의 콘솔에서 서빙됐는가.
 *
 * 콘솔은 자기 dist를 서빙하므로, 첫 상태 응답의 버전이 곧 이 문서가 든 번들의 버전이다.
 * 업데이트로 콘솔이 갈아 끼워지면 스트림은 저절로 다시 붙지만 문서는 옛 번들 그대로다 —
 * 원격 콘솔이나 셸이 대신 갈아 끼운 콘솔처럼 이 창을 아무도 재시작해 주지 않는 곳에서
 * 특히 그렇다. 서버가 다른 버전을 말하는 순간이 이 문서가 낡았다는 유일한 증거이므로,
 * 그때 다시 불러온다.
 */
let servedVersion: string | null = null;

/** 서버가 보고한 버전. 처음 것은 기억하고, 달라진 것은 새 번들을 받으라는 뜻으로 읽는다. */
export function observeConsoleVersion(version: string, reload: () => void = () => location.reload()): boolean {
  if (!version) return false;
  if (servedVersion === null) {
    servedVersion = version;
    return false;
  }
  if (servedVersion === version) return false;
  reload();
  return true;
}

/** 이 문서가 서빙된 버전과 다른가. 아직 모르면 false — 모르는 것을 낡았다고 하지 않는다. */
export function hasConsoleVersionDrifted(version: string | null): boolean {
  return servedVersion !== null && version !== null && version !== "" && version !== servedVersion;
}
