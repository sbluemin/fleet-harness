import type { CommodoreRunStatus } from "./types.js";

/** Browser projection. Filesystem coordinates stay on the host. */
export interface CommodoreTheaterSummary {
  readonly theaterId: string;
  readonly label: string;
  readonly status: "available" | "missing" | "unregistered";
}
export interface ConsoleCommodoreSummary {
  readonly commodoreId: string;
  readonly alias?: string;
  readonly label: string;
  readonly theaters: readonly CommodoreTheaterSummary[];
  readonly active: boolean;
  readonly run: CommodoreRunStatus;
}
export interface CommodoreListResponse { readonly commodores: readonly ConsoleCommodoreSummary[] }
export interface CommodoreOrderInput { readonly commodoreIds: readonly string[] }
export type CommodoreOrderResponse = CommodoreListResponse;
export interface CommodoreCreateInput { readonly alias: string }
export interface CommodoreCreateResponse { readonly commodoreId: string; readonly commodore: ConsoleCommodoreSummary }
export interface CommodoreTheaterInput { readonly commodoreId: string; readonly theaterId: string }
export interface CommodoreTheaterResponse { readonly commodore: ConsoleCommodoreSummary }
export interface CommodoreResolveResponse { readonly commodoreIds: readonly string[]; readonly commodoreId: string | null }
export const COMMODORE_ROUTES = {
  list: "/api/v1/commodore/list",
  order: "/api/v1/commodore/order",
  create: "/api/v1/commodore/create",
  addTheater: "/api/v1/commodore/theaters/add",
  removeTheater: "/api/v1/commodore/theaters/remove",
  resolve: "/api/v1/commodore/resolve",
} as const;
