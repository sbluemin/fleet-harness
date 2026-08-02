/**
 * provider-auth — subscription credential coordinates for gateway providers.
 *
 * These are provider access facts, not Fleet policy: the id a credential is
 * persisted under and the base URL its subscription API answers on. Callers that
 * read a provider's own usage or validate its key need the same coordinates as
 * the transport path, so they live beside the model catalog rather than in a
 * Fleet-domain package.
 */

// Keep the persisted provider id stable so existing Kimi keys remain usable
// after the retired direct Kimi backend is removed.
export const KIMI_AUTH_PROVIDER_ID = "Claude Code with Moonshot Kimi";
export const KIMI_CODE_API_BASE_URL = "https://api.kimi.com/coding";
export const KIMI_CODE_MODEL = "k3";
