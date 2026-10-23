import type { ExpandedSurfaceOpenRequest } from "./expanded-surface.js";
export interface ClientConsoleEventsCapability {
  /**
   * 콘솔 공용 스트림에서 이 채널의 프레임을 받는다. 서버 쪽 `registerSseChannel`의 짝이며,
   * 올린 채널만 브라우저까지 온다. 받는 쪽이 없으면 프레임은 조용히 버려진다.
   */
  subscribe(channel: string, onEvent: (payload: unknown) => void): () => void;
  /**
   * 스트림이 끊겼다 다시 열릴 때마다 울린다. 첫 연결에서는 울리지 않는다.
   *
   * 서버는 단절 중에 보낸 프레임을 다시 보내지 않으므로, 사건으로만 갱신하던 플러그인 데이터는 이 신호에서 스스로
   * 다시 읽어야 한다. 오류 없이 멈춘 연결도 호스트가 감지해 다시 열므로 이 신호에 포함된다. 코어 목록(Operation·그룹·
   * Theater)은 이 신호 전에 이미 다시 읽혀 있다. 구버전 호스트에는 없을 수 있다(apiVersion 은 같다) — 없으면 재연결을
   * 알 길이 없는 것으로 다룬다.
   */
  onReconnect?(listener: () => void): () => void;
}


export interface ClientRailCapability {
  /** rail 패널을 펼친다. 공유 링크로 들어온 플러그인이 자기 패널을 세울 때 쓴다. */
  open(panelId: string, params?: Readonly<Record<string, string>>): void;
  /** 지정한 패널이 현재 활성 상태일 때만 닫는다. 폰에서 그 엔트리의 목적지 화면이 보이고 있으면 화면을 닫고 홈(대화 목록)으로 돌아간다. */
  close(panelId: string): void;
  /** 지정한 패널이 현재 보이는 자리(레일 슬롯이나 대화 도구 칸)에 서 있는가. 다른 칸이 펼쳐 가린 도구 칸은 열린 것으로 치지 않는다. */
  isOpen(panelId: string): boolean;
}


/**
 * 주소 표시줄의 쿼리 문자열 중 플러그인 몫.
 *
 * 라우터 자체를 넘기지 않는다 — 경로는 코어 화면의 것이고, 플러그인이 그것을 옮기면
 * 콘솔이 어디 있는지를 플러그인이 정하게 된다. 쿼리 파라미터만 읽고 쓴다.
 */
export interface ClientNavigationCapability {
  getSearchParam(key: string): string | null;
  /** `null` 값은 그 파라미터를 지운다. `replace`는 뒤로가기 기록을 남기지 않는다. */
  setSearchParams(next: Readonly<Record<string, string | null>>, options?: { readonly replace?: boolean }): void;
  subscribe(listener: () => void): () => void;
}


export interface ClientExpandedSurfacesCapability {
  /** 표면을 연다. 이미 열려 있으면 기본적으로 그 슬롯을 재사용한다. 인스턴스 id를 돌려준다. */
  open(request: ExpandedSurfaceOpenRequest): string;
  /** 슬롯 하나를 닫는다. `open`이 돌려준 **인스턴스** id를 넘길 것 — 표면 id가 아니다. */
  close(instanceId: string): void;
  /**
   * 이 표면의 슬롯을 전부 닫는다. 플러그인은 대개 자기 인스턴스 id를 들고 있지 않고
   * "내 표면을 닫는다"만 원하므로, 표면 id로 닫는 길을 따로 둔다 — 표면 id를 `close`에
   * 넘기면 일치하는 인스턴스가 없어 조용히 아무 일도 일어나지 않는다.
   */
  closeSurface(surfaceId: string): void;
  /** 이 표면이 지금 보이는 슬롯을 차지하고 있는지. 대화 도구 칸에서 다른 칸이 펼쳐 가린 칸은 열린 것으로 치지 않는다(그때 `open`은 펼침을 접고 그 칸을 드러낸다). */
  isOpen(surfaceId: string): boolean;
}
