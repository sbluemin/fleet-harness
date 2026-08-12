import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * 액세스 링크를 광학 채널에 싣는 심볼.
 *
 * 링크를 폰으로 옮기는 수단이 클립보드뿐이면, "신뢰하는 경로로만 보내라"는 경고를 읽은 사람이
 * 곧바로 메신저에 그 자격을 붙여넣게 된다. 카메라는 같은 방 안에서만 성립하는 경로라 그
 * 경고와 어긋나지 않는다 — 이 컴포넌트가 존재하는 이유다.
 *
 * 색은 테마를 따르지 않는다. QR은 밝은 바탕에 어두운 모듈이라는 전제로 읽히고, 반전 심볼은
 * 규격 밖이라 읽히는 스캐너가 많을 뿐 보장이 없다. 자격을 옮기는 한 번의 시도가 테마 설정에
 * 따라 실패하면 안 되므로 --qr-* 토큰은 테마 오버라이드 밖에 고정한다(Scuttlebutt QK와 같은
 * 불변색 예외이며, instrument-design-contract가 그 고정을 지킨다).
 */
export function QrCode({ value, size, label }: {
  readonly value: string;
  /**
   * 목표 변 길이(CSS 픽셀). 실제로는 이 값을 넘지 않는 모듈 정수배로 내려 맞춘다 — 아래 주석 참조.
   */
  readonly size: number;
  readonly label: string;
}) {
  const symbol = useMemo(() => encode(value), [value]);
  if (symbol === null) return null;

  /**
   * 모듈이 정수 픽셀에 떨어지지 않으면 셀 경계가 반 픽셀에 걸려 흐려지고, 그 흐린 경계에서
   * 디코딩이 실패한다(실측으로 잡힌 결함 — 2.1px/모듈에서 화면 캡처가 읽히지 않았다).
   * 심볼 버전은 링크 길이를 따라 움직이므로 크기를 상수로 박을 수 없다. 대신 목표 크기를
   * 넘지 않는 가장 큰 정수배로 내려 맞춘다.
   */
  const scale = Math.max(MIN_MODULE_PX, Math.floor(size / symbol.span));
  const rendered = scale * symbol.span;

  return (
    <div className="qr-plate" style={{ width: rendered, height: rendered }}>
      <svg
        className="qr-symbol"
        viewBox={`0 0 ${symbol.span} ${symbol.span}`}
        width={rendered}
        height={rendered}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <path d={symbol.path} />
      </svg>
    </div>
  );
}

/**
 * 화면의 심볼을 카메라로 읽으려면 모듈 하나가 최소 몇 픽셀은 되어야 한다. 목표 크기가 작아
 * 정수배가 이 아래로 떨어지면 크기를 줄이는 대신 판을 키운다 — 읽히지 않는 QR은 자리만 차지한다.
 */
const MIN_MODULE_PX = 3;

/** 조용한 여백은 규격이 4모듈을 요구한다 — 좁히면 스캐너가 심볼의 끝을 찾지 못한다. */
const QUIET_ZONE = 4;

interface QrSymbol {
  /** 여백을 포함한 한 변의 모듈 수. viewBox의 단위가 곧 모듈이다. */
  readonly span: number;
  readonly path: string;
}

/**
 * 버전은 자동으로 고른다. 액세스 링크는 라벨과 엔드포인트 길이에 따라 늘고 줄어서, 고정 버전을
 * 박아 두면 라벨이 긴 콘솔에서 인코딩이 통째로 실패한다.
 *
 * 정정 수준은 M이다. 화면에 그리는 심볼은 인쇄물처럼 훼손되지 않으므로 H까지 올릴 이유가 없고,
 * 올린 만큼 모듈이 촘촘해져 오히려 작은 화면에서 읽기 어려워진다.
 */
function encode(value: string): QrSymbol | null {
  if (value.length === 0) return null;
  let qr;
  try {
    qr = qrcode(0, "M");
    qr.addData(value, "Byte");
    qr.make();
  } catch {
    // 용량을 넘긴 링크는 그릴 수 없다. 링크 문자열 자체는 화면에 남아 있으므로 여기서는
    // 조용히 물러나고, 붙여넣기라는 경로를 그대로 둔다.
    return null;
  }

  const count = qr.getModuleCount();
  const span = count + QUIET_ZONE * 2;
  // 어두운 모듈을 행 단위 런으로 묶어 path 하나로 그린다 — 모듈마다 rect를 만들면 큰 심볼에서
  // 수천 개의 노드가 생기고, 그 비용은 다이얼로그가 열리는 순간에 그대로 드러난다.
  let path = "";
  for (let row = 0; row < count; row += 1) {
    let column = 0;
    while (column < count) {
      if (!qr.isDark(row, column)) {
        column += 1;
        continue;
      }
      let run = 1;
      while (column + run < count && qr.isDark(row, column + run)) run += 1;
      path += `M${column + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`;
      column += run;
    }
  }
  return { span, path };
}
