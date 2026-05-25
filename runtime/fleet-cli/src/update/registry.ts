export type UpdateChannel = "latest" | "canary";

interface NpmPackageMetadata {
  readonly "dist-tags"?: Partial<Record<UpdateChannel, string>>;
}

const FLEET_CLI_REGISTRY_URL = "https://registry.npmjs.org/@dotobokuri%2ffleet-cli";
const REGISTRY_TIMEOUT_MS = 3_000;
const MAX_REGISTRY_RESPONSE_BYTES = 1024 * 1024;

export async function fetchLatestFleetCliVersion(channel: UpdateChannel): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(FLEET_CLI_REGISTRY_URL, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const metadata = await readJsonWithByteLimit(response, controller);
    if (metadata === undefined) {
      return undefined;
    }
    const latest = metadata["dist-tags"]?.[channel];
    return typeof latest === "string" && latest.length > 0 ? latest : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonWithByteLimit(response: Response, controller: AbortController): Promise<NpmPackageMetadata | undefined> {
  const body = response.body;
  if (body === null) {
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REGISTRY_RESPONSE_BYTES) {
        controller.abort();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(joinChunks(chunks, totalBytes))) as NpmPackageMetadata;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function joinChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
