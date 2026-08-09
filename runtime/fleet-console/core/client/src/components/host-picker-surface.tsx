import { HostSwitcher, type HostPickerContext } from "./command-band-system-cluster.js";

/**
 * 집이 자기 목록만 펼쳐 내주는 화면.
 *
 * 원격 콘솔을 보고 있는 동안에도 사용자가 고르는 목록은 언제나 자기 기계의 것이어야 하는데,
 * 그 목록은 집의 루프백에서만 읽을 수 있다. 그래서 이 화면은 집이 서빙하고, 셸이 보고 있던
 * 콘솔 위에 얹는다 — 목록이 원격 콘솔을 지나가지 않는 유일한 방법이다.
 *
 * 콘솔 한 벌을 통째로 띄우지 않는다. 여기 필요한 것은 호스트 박스 하나뿐이고, 그 뒤에 두 번째
 * 콘솔이 통째로 떠오르면 사용자는 자기가 어디에 서 있는지를 잃는다.
 */
export function HostPickerScreen({ surface }: { readonly surface: HostPickerContext }) {
  return (
    <div className="host-picker-surface">
      <HostSwitcher picker={surface} />
    </div>
  );
}
