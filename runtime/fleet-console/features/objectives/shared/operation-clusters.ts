import type { ReactNode } from "react";
import type { LocalizedText } from "@fleet-console/i18n";
/** 구성원(단계)의 진행 — 세션 활동이 아니라 구조 안의 자리다. 막힘은 선행이 안 끝난 것, 열림은 시작을 기다리는 것. */
export type OperationClusterProgress = "blocked" | "open" | "running" | "awaiting" | "done";


export interface OperationClusterMember {
  /**
   * 구성원의 Operation id. `pending` 이면 아직 Operation 이 없는 자리표시 id 다(플러그인 안에서 안정적이면 된다) —
   * 호스트는 띠(단계 사각)·진행 셈에만 쓰고 행·패널·본문 선택에는 세우지 않는다.
   */
  readonly operationId: string;
  readonly pending?: boolean;
  /** 묶음 안에서 제목 대신 부르는 짧은 이름("1. package.json name 읽기"). */
  readonly label: string;
  /** 실제 임무 칸의 표시 번호(1부터 시작). 임무 없는 구성원 칸에는 없다. */
  readonly missionNumber?: number;
  /**
   * 지휘관 패널의 노드 줄에 서는 이름("조사") — 이 세션이 누구인지 한 낱말로. 없으면 호스트가 선언 순서로 「N 노드」라 부른다.
   * `label`(무엇을 하는지)은 말풍선·낭독에 그대로 남는다. 지휘관 패널이 이 구성원의 본문을 보일 때 캡션 제목 뒤 「› 이름」도 이것이다.
   */
  readonly name?: string;
  /**
   * 이 구성원의 정체성 톤(`--id-<key>` 의 key, 예: "moss") — 지휘관 캡션 제목 뒤 「› 이름」의 잉크. 플러그인이 자기 화면의 구성원
   * 표식과 같은 톤을 준다. 없으면 구성원 Operation 의 강조색, 그것도 없으면 제목의 중립 잉크다.
   */
  readonly tone?: string;
  /** 명단(roster) 순서(0부터 시작). 세션 줄에서 명단 순서로 정렬할 때 사용한다. */
  readonly order?: number;
  /** 선행 구성원의 operationId. 전부 끝나야 이 구성원이 열린다. */
  readonly after: readonly string[];
  readonly progress: OperationClusterProgress;
  /** 살아 있는 구성원 세션의 입력·결정 대기. 임무 진행(done/blocked)과 별개이며, 생략 시 옛 progress awaiting만 사용한다. */
  readonly awaitingInput?: boolean;
  /** 끝난 구성원이 남긴 산출 요약 한 줄. */
  readonly result?: string;
}


export interface OperationCluster {
  /** 플러그인 안에서 유일한 id. 호스트가 `<pluginId>:` 를 앞에 붙인다. */
  readonly id: string;
  readonly theaterId: string;
  /** 묶음의 제목(목표 제목) — 툴팁에 선다. */
  readonly title: string;
  /**
   * 뿌리(조율자) operationId. 뿌리는 구성원 목록에 들지 않는다. 아직 Operation 이 없는 묶음(시작 전 목표)은 뿌리가 없다 —
   * 그런 묶음은 `row` 로만 서고, 캡션 띠·노드 줄에는 서지 않는다.
   */
  readonly root?: string;
  /**
   * 뿌리가 아직 없는 묶음의 얼굴이 될 Operation id — 곧 뿌리가 될 그 Operation 이다. 호스트는 뿌리 없는 줄의 지휘관 아바타를 이
   * id 의 키로 그려, 같은 사람을 그리는 플러그인 표면과 같은 모습이 선다. 없으면 묶음 id 로 그린다.
   */
  readonly avatarOperationId?: string;
  readonly members: readonly OperationClusterMember[];
  /** 띠·위치 표시를 누르면 — 플러그인의 표면으로 간다. 구성원 id 가 오면 그 구성원을 집는다. */
  readonly open?: (operationId?: string) => void;
  /**
   * 뿌리가 사람에게 답을 청한 결정 요청이 있고 사람이 답할 차례다(플러그인이 정한 맡은 이가 다루는 요청은 아니다) — 호스트는 뿌리
   * 행·칩·얼굴에 전용 표식을 세운다. 도구 허용 대기(활동
   * `awaiting`)와 별개의 사실이라 활동 축을 바꾸지 않는다. 답은 플러그인 표면(`open`)에서 한다.
   */
  readonly decisionRequest?: boolean;
  /** 그룹 대화에서 읽는 명부·결정·보드 사건. 플러그인 구현을 호스트가 import하지 않는다. */
  readonly conversation?: import("../../execution/shared/conversation/types.js").OperationClusterConversation;
  /**
   * 사이드바 그룹 트리에 서는 한 줄 — 있으면 호스트는 뿌리 칩과 `fold` 의 칩을 이 줄 하나로 접어 그린다. 줄의 뜻(오늘·기한·
   * 검토 대기·진행)은 플러그인이 계산해 넘기고, 호스트는 칩 문법으로 그리기만 한다. 줄을 누르면 칩처럼 그 Operation(뿌리, 없으면
   * `fold` 의 첫 칩)으로 포커스하고 `onMapOperationSelected` 를 알린다. 열 Operation 이 없는 줄만 `open()` 이 불린다.
   */
  readonly row?: OperationClusterRow;
}


/**
 * 묶음 줄의 원형 글리프를 플러그인이 정할 때 — 없으면 호스트가 뿌리·`fold` 가운데 가장 급한 활동으로 그린다.
 * `fresh`(시작 전) 줄은 「오늘」·「결정 요청」 구역에 올라가거나 맡은 이가 처리 중(`delegated`)이지 않는 한 그룹 맨 아래 「시작 전 N」 접기 안에 선다.
 */
export type OperationClusterRowGlyph = "fresh" | "review" | "done";


export interface OperationClusterRow {
  /** 줄이 서는 사이드바 그룹. null 이면 미분류. */
  readonly groupId: string | null;
  /** 같은 Theater 안에서의 순서 — 뿌리가 없는 줄이 뿌리 있는 줄 사이에 끼는 자리를 정한다. */
  readonly order: number;
  /** 이 줄로 접혀 따로 서지 않는 Operation id(뿌리 포함). */
  readonly fold: readonly string[];
  readonly glyph?: OperationClusterRowGlyph;
  /** 「오늘」 구역에 올라간다 — 오늘 표시했거나 기한이 지났다. */
  readonly today?: boolean;
  /** 둘째 줄의 기한 — `date` 는 YYYY-MM-DD, 호스트가 자기 로케일로 적는다. 지남 판정은 플러그인이 한다. */
  readonly due?: { readonly date: string; readonly overdue: boolean };
  /**
   * 사람의 결정을 기다리기 시작한 시각(ms). 있으면 「내 결정」 구역에 그 시각순으로 선다. 사람이 답할 차례인 줄만 낸다 —
   * 플러그인이 정한 맡은 이가 다루는 요청은 `delegated` 로 낸다.
   */
  readonly decisionRequestedAt?: number;
  /** 기다리는 것이 결정 요청이면 그 질문 수. 없으면 둘째 줄에 결정 수를 적지 않는다(넘겨받은 검토·후보처럼 요청이 아닌 것). */
  readonly decisionQuestions?: number;
  /**
   * 「내 결정」 줄이 사람의 차례가 된 까닭 한마디(예: 「사령관이 넘김」). 둘째 줄의 결정 수 뒤에 서고, 대화 중심 화면에서는 줄의
   * 상태 문구(「내 결정을 기다립니다」) 대신 선다. `decisionRequestedAt` 이 없으면 무시한다.
   */
  readonly decisionNote?: LocalizedText;
  /**
   * 이 줄은 목표 묶음이 아니라 Theater 의 사령관(자율 운영자)이 사람에게 직접 묻는 일이다 — 호스트는 지휘관 대신 그 Theater 사령관의
   * 아바타로 그린다. 뿌리(`root`)가 없는 줄에만 뜻이 있다.
   */
  readonly commodore?: true;
  /**
   * 사람 대신 플러그인이 정한 맡은 이(예: Theater 의 자율 운영자)가 다루는 결정 요청 — 줄은 구역으로 올라가지 않고 그룹 안 제자리에
   * 선다. 처리 중인 동안 호스트는 둘째 줄의 상태 문구(대화 미리보기 포함) 자리에 `status`(예: 「사령관이 답하는 중」)를 무채색 명도
   * 물결로 적는다. 뿌리 없는 시작 전 줄이라도 「시작 전」 접기에 묻지 않는다. `decisionRequestedAt` 이 함께 있으면 그 줄은 「내 결정」에 선다.
   */
  readonly delegated?: { readonly questions: number; readonly status: LocalizedText };
  readonly progress?: { readonly done: number; readonly total: number };
  /** 다른 목표의 후속으로 태어난 줄. `originTitle` 이 null 이면 원래 목표를 더는 찾을 수 없다. */
  readonly followup?: { readonly originTitle: string | null };
  /**
   * 둘째 줄의 출처 — 누가 이 줄을 더했고 누가 마지막으로 손댔는지, 한 토막씩. 호스트가 `followup` 뒤·`notes` 앞에 같은 크기로
   * 적는다. 사람(기본 주인)의 손은 플러그인이 넣을 때만 선다.
   */
  readonly provenance?: readonly OperationClusterRowProvenance[];
  /**
   * 줄 오른쪽 끝의 표식 — 플러그인이 정한 맡은 이(예: Theater 의 자율 운영자)가 다루는 줄. 맡은 이의 스위치와 같은 문법이라
   * 줄이 자리를 옮기지 않고 켬·끔만 바뀐다. 구역으로 올라간 줄의 그룹 점보다 앞에 선다.
   */
  readonly mark?: OperationClusterRowMark;
  /**
   * 둘째 줄 끝에 붙는 짧은 사실 — 지금 누가 이 줄을 맡고 있는지, 멈췄는지처럼 진행 셈으로는 말할 수 없는 것. 호스트가
   * 다른 메타 뒤에 같은 크기로 적고 `tone` 으로만 칠한다(`accent` 는 맡은 이, `warn` 은 주의).
   */
  readonly notes?: readonly OperationClusterRowNote[];
  /**
   * 플러그인 표면이 지금 이 줄을 보고 있다. 호스트는 Operation 이 없는 줄만 이 값으로 하이라이트한다 — 뿌리가 선 줄은 칩처럼
   * 그 Operation 이 캔버스에서 활성일 때 하이라이트한다.
   */
  readonly selected?: boolean;
  /** `glyph: "review"` 를 눌렀을 때 — 글리프가 버튼이 되는 유일한 경우다. */
  readonly review?: (language: "en" | "ko") => void;
  /** 뿌리가 없는 줄을 다른 그룹으로 끌어 놓았을 때. 뿌리가 있으면 호스트가 뿌리 Operation 의 그룹을 바꾼다. */
  readonly moveToGroup?: (groupId: string | null) => void;
  /** 줄 제목을 그 자리에서 고쳤을 때 — 있으면 호스트가 메뉴 「이름 변경」·F2·제목 더블클릭으로 줄 제목 자리에 인라인 편집을 연다. 제목은 플러그인의 것이라 확정도 플러그인이 한다. */
  readonly rename?: (title: string) => void;
  /**
   * 뿌리가 없는 줄(시작 전 목표)을 보관함으로 보낸다 — 있으면 호스트가 그 줄의 우클릭 메뉴 맨 끝에 뿌리 있는 줄과 같은 「보관」을 싣는다.
   * 보관함에서 복원할 수 있어야 한다(영구 삭제가 아니다). 뿌리가 있으면 호스트가 뿌리 Operation 을 보관하므로 읽지 않는다.
   */
  readonly archive?: () => void;
}


export interface OperationClusterRowNote {
  readonly text: LocalizedText;
  readonly tone?: "accent" | "warn";
}


/** `filled` 는 맡은 이가 지금 돈다(스위치 켬), `hollow` 는 멈췄다(끔). */
export type OperationClusterRowSquare = "filled" | "hollow";


export interface OperationClusterRowProvenance {
  readonly text: LocalizedText;
  /** `accent` 는 맡은 이의 brass 잉크(줄 메모의 `accent` 와 같다) — 맡은 이의 손은 글자색으로만 말한다. */
  readonly tone?: "accent";
}


export interface OperationClusterRowMark {
  readonly square: OperationClusterRowSquare;
  /**
   * 맡은 이의 정체성 글리프 — 맡은 이의 스위치가 그리는 그 모양. `currentColor` 로 그리면 호스트가 `square` 를 따라 켬은 brass,
   * 끔은 가라앉은 잉크로 칠한다. 없으면 호스트의 기본 사각을 그린다.
   */
  readonly renderGlyph?: () => ReactNode;
  /** 맡은 이의 줄에 머무는 동안 — 같은 표식들이 함께 밝아져 어느 줄을 다루는지 한눈에 보인다. */
  readonly emphasized?: boolean;
  /** 사각만으로는 뜻이 전해지지 않는다 — 줄의 접근 이름과 사각의 제목에 들어간다. 토글이 있으면 토글의 제목(지금 상태)만 된다. */
  readonly label: LocalizedText;
  /**
   * 표식 자체를 누르는 스위치로 — 있으면 호스트가 표식을 `aria-pressed` 버튼으로 그린다. 꺼진 표식은 줄에 올리거나 초점이 올
   * 때만 보이고(터치 기기는 흐리게 늘), 켠 표식만 평소에 선다. 꺼짐의 모양은 `renderGlyph` 가 정한다.
   */
  readonly toggle?: OperationClusterRowMarkToggle;
}


export interface OperationClusterRowMarkToggle {
  readonly pressed: boolean;
  /** 버튼의 접근 이름 — 켬·끔과 상관없이 같은 말이다. 켬·끔은 `aria-pressed` 가 말한다. */
  readonly label: LocalizedText;
  readonly onToggle: (language: "en" | "ko") => void;
}


export interface OperationClusterSource {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: () => readonly OperationCluster[];
}
