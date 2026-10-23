export type ConsoleLocale = "en" | "ko";
export type MessageValues = Readonly<Record<string, string | number>>;
export type MessageCatalog<K extends string> = Readonly<Record<ConsoleLocale, Readonly<Record<K, string>>>>;
export type Translate<K extends string> = (key: K, values?: MessageValues) => string;
export type LocalizedText = string | ((locale: ConsoleLocale) => string);
