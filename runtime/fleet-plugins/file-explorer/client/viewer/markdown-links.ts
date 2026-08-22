const MARKDOWN_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const ALLOWED_EXTERNAL_IMAGE_HOSTS = new Set(["img.shields.io"]);
const EXTERNAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export function resolveMarkdownFileRef(rawRef: string, currentRelativePath: string): string | null {
  const trimmed = rawRef.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || EXTERNAL_REF_PATTERN.test(trimmed)) return null;

  const pathOnly = stripQueryAndHash(trimmed);
  if (!pathOnly) return null;

  const decoded = decodeMarkdownPath(pathOnly);
  if (decoded === null) return null;

  return normalizeRelativePath(decoded, currentRelativePath);
}

export function isSupportedMarkdownImagePath(relativePath: string): boolean {
  const lower = stripQueryAndHash(relativePath).toLowerCase();
  return [...MARKDOWN_IMAGE_EXTENSIONS].some((extension) => lower.endsWith(extension));
}

export function buildFileExplorerImageSrc(theaterId: string, relativePath: string): string {
  return `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(relativePath)}`;
}

export function isAllowedExternalMarkdownImageSrc(rawSrc: string): boolean {
  try {
    const url = new URL(rawSrc);
    return url.protocol === "https:" && ALLOWED_EXTERNAL_IMAGE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function stripQueryAndHash(value: string): string {
  const markerIndex = value.search(/[?#]/);
  return markerIndex === -1 ? value : value.slice(0, markerIndex);
}

function decodeMarkdownPath(value: string): string | null {
  try {
    return decodeURI(value);
  } catch {
    return null;
  }
}

function normalizeRelativePath(rawPath: string, currentRelativePath: string): string | null {
  const normalizedInput = rawPath.replace(/\\/g, "/");
  const normalizedCurrentPath = currentRelativePath.replace(/\\/g, "/");
  const baseDir = normalizedCurrentPath.includes("/")
    ? normalizedCurrentPath.slice(0, normalizedCurrentPath.lastIndexOf("/"))
    : "";
  const candidate = normalizedInput.startsWith("/")
    ? normalizedInput
    : `${baseDir}/${normalizedInput}`;
  const segments: string[] = [];

  for (const segment of candidate.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join("/") : null;
}
