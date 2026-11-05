export interface CommodoreBasePromptState { readonly commodoreId: string; readonly basePromptEnabled: boolean }
export interface CommodoreSubagentsState { readonly commodoreId: string; readonly subagentsKept: boolean }

async function request<T>(route: string, commodoreId: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/agent/${route}?commodoreId=${encodeURIComponent(commodoreId)}`, {
    ...(body === undefined ? {} : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal,
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result?.error ?? "commodore_settings_failed"), { status: response.status });
  if (result?.commodoreId !== commodoreId) throw new Error("invalid_commodore_settings");
  return result as T;
}
export const fetchCommodoreBasePrompt = (commodoreId: string, signal?: AbortSignal): Promise<CommodoreBasePromptState> => request("commodore-system-prompt", commodoreId, undefined, signal);
export const saveCommodoreBasePrompt = (commodoreId: string, basePromptEnabled: boolean, signal?: AbortSignal): Promise<CommodoreBasePromptState> => request("commodore-system-prompt", commodoreId, { basePromptEnabled }, signal);
export const fetchCommodoreSubagents = (commodoreId: string, signal?: AbortSignal): Promise<CommodoreSubagentsState> => request("commodore-subagents", commodoreId, undefined, signal);
export const saveCommodoreSubagents = (commodoreId: string, subagentsKept: boolean, signal?: AbortSignal): Promise<CommodoreSubagentsState> => request("commodore-subagents", commodoreId, { subagentsKept }, signal);
