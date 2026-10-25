import { COMMODORE_ROUTES, type CommodoreCreateInput, type CommodoreCreateResponse, type CommodoreListResponse, type CommodoreTheaterInput, type CommodoreTheaterResponse } from "../shared/contracts/theaters.js";

async function post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result?.error ?? "commodore_failed"), { status: response.status });
  return result as T;
}
export const fetchCommodores = (signal?: AbortSignal): Promise<CommodoreListResponse> => post(COMMODORE_ROUTES.list, {}, signal);
export const createCommodore = (input: CommodoreCreateInput, signal?: AbortSignal): Promise<CommodoreCreateResponse> => post(COMMODORE_ROUTES.create, input, signal);
export const addCommodoreTheater = (input: CommodoreTheaterInput, signal?: AbortSignal): Promise<CommodoreTheaterResponse> => post(COMMODORE_ROUTES.addTheater, input, signal);
export const removeCommodoreTheater = (input: CommodoreTheaterInput, signal?: AbortSignal): Promise<CommodoreTheaterResponse> => post(COMMODORE_ROUTES.removeTheater, input, signal);
