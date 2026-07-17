import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { CLI_BACKENDS } from '../config/CliConfigs.js';
import { CodexAppServerConnection } from '../connection/CodexAppServerConnection.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

/** Opaque, provider-neutral runtime contract for resolving an existing session title. */
export interface SessionIdentityResolver {
  resolve(providerSessionId: string): Promise<string | null>;
}

/** Spawn-time provider specialization used to construct an opaque resolver. */
export interface SessionIdentityResolverOptions {
  provider: 'claude' | 'codex';
  cwd: string;
  /** Spawn-resolved executable, for example a profile-specific CLI binary. */
  command?: string;
  /** Spawn-resolved arguments that must precede Codex's app-server arguments. */
  commandPrefixArgs?: readonly string[];
  /** Complete app-server argument list for isolated tests or custom callers. */
  args?: string[];
  env?: Record<string, string | undefined>;
}

/**
 * Creates the provider-specific identity adapter once at launch. Consumers retain
 * only SessionIdentityResolver and must not branch on provider after launch.
 */
export function createSessionIdentityResolver(
  options: SessionIdentityResolverOptions,
): SessionIdentityResolver {
  const cwd = options.cwd;
  if (options.provider === 'claude') {
    return {
      resolve: (sessionId) => withIdentityTimeout(
        async () => {
          const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
          const info: SDKSessionInfo | undefined = await getSessionInfo(sessionId, { dir: cwd });
          if (!info) {
            return null;
          }
          const customTitle = normalizeTitle(info.customTitle);
          if (customTitle) {
            return customTitle;
          }
          const summary = normalizeTitle(info.summary);
          return summary && summary !== normalizeTitle(info.firstPrompt) ? summary : null;
        },
      ),
    };
  }

  const backend = CLI_BACKENDS.codex;
  const command = options.command ?? backend.cliCommand;
  const args = options.args
    ? [...options.args]
    : [...(options.commandPrefixArgs ?? []), ...(backend.appServerArgs ?? [])];
  const env = options.env;
  return {
    resolve: (sessionId) => {
      let connection: CodexAppServerConnection | null = null;
      return withIdentityTimeout(
        async () => {
          connection = new CodexAppServerConnection({
            command,
            args,
            cwd,
            env,
            requestTimeout: SESSION_IDENTITY_TIMEOUT_MS,
            initTimeout: SESSION_IDENTITY_TIMEOUT_MS,
          });
          let rejectConnectionFailure: (error: Error) => void = () => {};
          const connectionFailure = new Promise<never>((_, reject) => {
            rejectConnectionFailure = reject;
          });
          const errorListener = (error: Error) => rejectConnectionFailure(error);
          // Keep this listener for the short-lived connection. Removing it before
          // or during child termination would recreate EventEmitter's fatal error
          // window for late spawn/protocol failures.
          connection.on('error', errorListener);
          try {
            return await Promise.race([
              (async () => {
                await connection!.connect({ skipThreadStart: true });
                const response = await connection!.readThread(sessionId);
                return normalizeTitle(response.thread.name);
              })(),
              connectionFailure,
            ]);
          } finally {
            await connection.disconnect().catch(() => {});
          }
        },
        () => {
          void connection?.disconnect().catch(() => {});
        },
      );
    },
  };
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function withIdentityTimeout(
  resolve: () => Promise<string | null>,
  onTimeout?: () => void,
): Promise<string | null> {
  const settled = Promise.resolve().then(resolve).catch(() => null);
  return new Promise((complete) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      complete(null);
    }, SESSION_IDENTITY_TIMEOUT_MS);
    void settled.then((value) => {
      clearTimeout(timer);
      complete(value);
    });
  });
}
