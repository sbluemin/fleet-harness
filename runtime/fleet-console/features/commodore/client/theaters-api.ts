import type { CommodoreDeletePreview, CommodoreDeleteResult } from "../shared/contracts/deletion.js";
import { COMMODORE_ROUTES, type CommodoreCreateInput, type CommodoreCreateResponse, type CommodoreListResponse, type CommodoreOrderInput, type CommodoreOrderResponse, type CommodoreTheaterInput, type CommodoreTheaterResponse } from "../shared/contracts/theaters.js";

async function post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result?.error ?? "commodore_failed"), { status: response.status });
  return result as T;
}
export const previewCommodoreDeletion = (input: { readonly commodoreId: string; readonly language: "en" | "ko" }, signal?: AbortSignal): Promise<CommodoreDeletePreview> => post("/api/v1/commodore/delete-preview", input, signal);
export const deleteCommodore = (input: { readonly commodoreId: string; readonly language: "en" | "ko"; readonly alias: string; readonly confirm: true }): Promise<CommodoreDeleteResult> => post("/api/v1/commodore/delete", input);
export const fetchCommodores = (signal?: AbortSignal): Promise<CommodoreListResponse> => post(COMMODORE_ROUTES.list, {}, signal);
export const createCommodore = (input: CommodoreCreateInput, signal?: AbortSignal): Promise<CommodoreCreateResponse> => post(COMMODORE_ROUTES.create, input, signal);
export const addCommodoreTheater = (input: CommodoreTheaterInput, signal?: AbortSignal): Promise<CommodoreTheaterResponse> => post(COMMODORE_ROUTES.addTheater, input, signal);
export const removeCommodoreTheater = (input: CommodoreTheaterInput, signal?: AbortSignal): Promise<CommodoreTheaterResponse> => post(COMMODORE_ROUTES.removeTheater, input, signal);
export const saveCommodoreOrder = (input: CommodoreOrderInput, signal?: AbortSignal): Promise<CommodoreOrderResponse> => post(COMMODORE_ROUTES.order, input, signal);
