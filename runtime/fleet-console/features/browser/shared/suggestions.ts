export interface BrowserSuggestionSettings {
  readonly enabled: boolean;
  readonly prompted: boolean;
}

export const DEFAULT_BROWSER_SUGGESTION_SETTINGS: BrowserSuggestionSettings = { enabled: false, prompted: false };

/** Keep address-like input on the Console, including addresses embedded in a phrase. */
export function suggestionSkipReason(input: string): "invalid_query" | "address_like" | null {
  const query = input.trim();
  if (query.length < 2 || query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query)) return "invalid_query";
  // Conservative by design: punctuation that can identify hosts, paths, credentials or encoded addresses is not sent.
  const normalized = query.normalize("NFKC");
  if (/[.:/\\@%。｡]/u.test(normalized) || /\blocalhost\b/iu.test(normalized) || /^(?:\d+|0x[\da-f]+)$/iu.test(normalized)) return "address_like";
  return null;
}
