import type { CommodoreRunStatus } from "./types.js";
import type { CommodoreSidebarLayout } from "./sidebar-layout.js";

/** Browser projection. Filesystem coordinates stay on the host. */
export interface CommodoreTheaterSummary {
  readonly theaterId: string;
  readonly label: string;
  readonly status: "available" | "missing";
}
/** The latest conversation line of a commodore — the phone home row shows its time and a one-line preview. */
export interface CommodoreLastMessage {
  readonly at: number;
  readonly text: string;
  readonly from: "person" | "commodore";
}
export interface ConsoleCommodoreSummary {
  readonly commodoreId: string;
  readonly alias?: string;
  readonly label: string;
  readonly theaters: readonly CommodoreTheaterSummary[];
  readonly active: boolean;
  readonly run: CommodoreRunStatus;
  readonly last?: CommodoreLastMessage;
  /** Latest commodore reply, independent of the person’s most recent message. */
  readonly lastResponse?: CommodoreLastMessage;
}
export interface CommodoreListResponse {
  readonly commodores: readonly ConsoleCommodoreSummary[];
  /** 좌측 목록 한 줄의 전체 순서 — 사령관과 TF id를 함께 든다. 두 목록을 이 순서로 섞어 그린다. */
  readonly order: readonly string[];
  readonly sidebarLayout?: CommodoreSidebarLayout;
}
export interface CommodoreSidebarResponse extends CommodoreListResponse { readonly createdSectionId?: string }
/** 좌측 목록 한 줄 전체의 저장 순서 — 사령관과 TF id를 함께 든다. 키 이름은 기존 저장과 호환을 위해 둔다. */
export interface CommodoreOrderInput { readonly commodoreIds: readonly string[] }
export type CommodoreOrderResponse = CommodoreListResponse;
export interface CommodoreCreateInput { readonly alias: string }
export interface CommodoreCreateResponse { readonly commodoreId: string; readonly commodore: ConsoleCommodoreSummary }
export interface CommodoreTheaterInput { readonly commodoreId: string; readonly theaterId: string }
export interface CommodoreTheaterAddInput { readonly commodoreId: string; readonly folderGrantId: string; readonly claudeTrustConsent?: boolean }
export interface CommodoreTheaterResponse { readonly commodore: ConsoleCommodoreSummary }
export const COMMODORE_ROUTES = {
  list: "/api/v1/commodore/list",
  order: "/api/v1/commodore/order",
  create: "/api/v1/commodore/create",
  addTheater: "/api/v1/commodore/theaters/add",
  removeTheater: "/api/v1/commodore/theaters/remove",
} as const;
