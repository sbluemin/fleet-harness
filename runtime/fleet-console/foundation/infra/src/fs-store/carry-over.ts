import * as fs from "node:fs";

/**
 * 저장 자리를 옮긴 파일의 승계 판정기.
 *
 * 옮기기는 한 번뿐이고, 그 한 번이 실패하면 사용자가 잃는 것은 되돌릴 수 없는 값
 * (모델 선별·자격증명)이다. 그래서 이 판정기는 두 가지를 보장한다.
 *
 *   1. **목적지 파일이 곧 "승계 끝"의 표식이다.** 정규형이 비었는지로 판정하면 사용자가
 *      의도적으로 비운 상태를 과거 값으로 되살린다. 존재 여부만 본다.
 *   2. **조사에 결론이 나기 전에는 쓰지 않는다.** 일시적 I/O 실패를 "승계할 것 없음"으로
 *      굳히면, 그 뒤의 어떤 쓰기든 목적지 파일을 만들어 승계를 영구히 막는다. 결론이 날
 *      때까지 매 접근이 다시 조사하고, 호출자는 `settled()`가 거짓인 동안 쓰기를 거절해야
 *      한다 — 조용히 잃는 것보다 실패를 보이는 편이 낫다.
 */
export interface CreateStoreCarryOverDeps<T> {
  /**
   * 승계가 이미 끝났는가. 파일 하나를 통째로 옮기는 경우는 목적지 파일의 존재가 그 표식이고
   * (`jsonFileExists`), 이미 존재하는 문서의 한 섹션으로 옮기는 경우는 그 섹션의 존재가
   * 표식이다. 값이 비었는지로 판정하면 사용자가 의도적으로 비운 상태를 과거 값으로 되살린다.
   */
  readonly adopted: () => boolean;
  /**
   * 옛 자리 후보들. 앞에서부터 보고 값이 있는 첫 자리를 승계한다 — 가장 최근에 살던 자리를
   * 앞에 둔다. 앞자리를 읽지 못하면 뒷자리로 넘어가지 않는다: 읽히지 않은 앞자리에 더 새로운
   * 값이 있을 수 있고, 그 경우 뒷자리 승계는 사용자의 최신 값을 옛 값으로 덮는다.
   */
  readonly sourcePaths: readonly string[];
  /** 읽어 낸 JSON에서 승계할 값을 고른다. 옮길 것이 없으면 `undefined`. */
  readonly adopt: (parsed: unknown) => T | undefined;
}

export interface StoreCarryOver<T> {
  /** 결론이 날 때까지 매 접근마다 다시 조사한다. 이미 결론이 났으면 아무것도 하지 않는다. */
  readonly probe: () => void;
  /** 조사에 결론이 났는가. 거짓인 동안 호출자는 목적지에 쓰지 않아야 한다. */
  readonly settled: () => boolean;
  /** 승계할 값이 있고 목적지가 아직 비었는가. */
  readonly pending: () => boolean;
  /** 조사로 찾아낸 승계 대상. 아직 조사 전이거나 옮길 것이 없으면 `undefined`. */
  readonly carried: () => T | undefined;
  /** 잠금 안에서 이번 갱신의 시작점을 고른다. */
  readonly base: (current: T) => T;
  readonly sourcePaths: readonly string[];
}

/**
 * 다시 읽어도 결과가 달라지지 않는 실패들. 그 자리에 읽을 수 있는 과거 파일이 **없다**는
 * 결론이므로 재시도 대상이 아니다. 이걸 미결로 두면 승계를 기다리느라 저장이 영구히 막히는데,
 * 그건 원래 막으려던 손실보다 나쁘다.
 */
const CONCLUSIVE_READ_ERRORS = new Set(["ENOENT", "EISDIR", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

type SourceProbe<T> =
  /** 옮길 값이 있다. */
  | { readonly kind: "adopt"; readonly value: T }
  /** 부재하거나 손상됐거나 비어 있다 — 옮길 것이 없다는 결론. */
  | { readonly kind: "nothing" }
  /** 읽지 못했다. 결론이 아니므로 다음 접근이 다시 조사해야 한다. */
  | { readonly kind: "unavailable" };

export function createStoreCarryOver<T>(deps: CreateStoreCarryOverDeps<T>): StoreCarryOver<T> {
  let carried: T | undefined;
  // 후보가 없으면 승계할 과거 자체가 없다. 조사는 처음부터 끝나 있다.
  let settled = deps.sourcePaths.length === 0;

  const probe = (): void => {
    if (settled) return;
    for (const sourcePath of deps.sourcePaths) {
      const probed = readSource<T>(sourcePath, deps.adopt);
      // 결론 보류 — 다음 접근이 다시 조사한다.
      if (probed.kind === "unavailable") return;
      if (probed.kind === "adopt") {
        carried = probed.value;
        settled = true;
        return;
      }
    }
    carried = undefined;
    settled = true;
  };

  return {
    probe,
    settled: () => settled,
    pending: () => carried !== undefined && !deps.adopted(),
    carried: () => carried,
    base: (current) => (carried !== undefined && !deps.adopted() ? carried : current),
    sourcePaths: deps.sourcePaths,
  };
}

function readSource<T>(sourcePath: string, adopt: (parsed: unknown) => T | undefined): SourceProbe<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(sourcePath, "utf-8");
  } catch (error) {
    // 권한·I/O 실패는 결론이 아니다 — 지금 못 읽었을 뿐 값은 그대로 있을 수 있다.
    return CONCLUSIVE_READ_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")
      ? { kind: "nothing" }
      : { kind: "unavailable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "nothing" };
  }
  const value = adopt(parsed);
  return value === undefined ? { kind: "nothing" } : { kind: "adopt", value };
}

/** 승계 완료 표식으로 쓰는 목적지 파일 존재 검사. 심볼릭 링크는 파일로 세지 않는다. */
export function jsonFileExists(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}
