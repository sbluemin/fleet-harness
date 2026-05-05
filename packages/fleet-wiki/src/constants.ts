export const KNOWLEDGE_ROOT_DIRNAME = ".fleet/knowledge";
export const RAW_DIRNAME = "raw";
export const WIKI_DIRNAME = "wiki";
export const SCHEMA_DIRNAME = "schema";
export const QUEUE_DIRNAME = "queue";
export const ARCHIVE_DIRNAME = "archive";
export const CONFLICTS_DIRNAME = "conflicts";
export const INDEX_FILENAME = "index.json";
export const INDEX_MD_FILENAME = "index.md";
export const LOG_MD_FILENAME = "log.md";
export const PATCH_FILENAME = "patch.md";
export const PATCH_META_FILENAME = "meta.json";

export const REQUIRED_WIKI_FRONTMATTER_KEYS = [
  "id",
  "title",
  "tags",
  "created",
  "updated",
  "version",
] as const;
