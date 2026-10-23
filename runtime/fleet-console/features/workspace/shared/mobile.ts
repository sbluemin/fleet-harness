
/** 모바일 Objective 화면의 호스트 창구 — ⋮ 메뉴에 항목을 끼우고, 호스트 시트 문법의 확인을 띄운다. */
export interface ClientMobileObjectiveCapability {
  /**
   * 이 Objective의 ⋮에 끼울 항목. 마지막 호출이 이긴다. 순서는 호스트가 [이름 변경, …이 항목들…, 보관]으로 둔다.
   * 본문이 내려갈 때 빈 목록으로 거두는 것은 본문의 몫이다.
   */
  setMenuItems(items: readonly import("./pane.js").MobileBarMenuItem[]): void;
  /** 호스트 시트 문법의 확인 시트. 확정이면 true, 취소·닫기·뒤로면 false. */
  confirm(spec: MobileConfirmSpec): Promise<boolean>;
}


export interface MobileConfirmSpec {
  readonly title: string;
  readonly body: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
}
