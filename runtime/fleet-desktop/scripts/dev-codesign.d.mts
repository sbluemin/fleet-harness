export interface DevCodesignIdentity { hash: string; name: string }
export interface DevCodesignChoice { identity: string; label: string; reason: "requested" | "requested_identity_missing" | "none" | "found" | "first_of_many" }
export const DEV_CODESIGN_IDENTITY_ENV: "FLEET_DEV_CODESIGN_IDENTITY";
export function parseCodesignIdentities(output: string): DevCodesignIdentity[];
export function selectDevCodesignIdentity(identities: readonly DevCodesignIdentity[], requested: string | undefined): DevCodesignChoice;
export function signingEnv(env?: NodeJS.ProcessEnv, account?: string): NodeJS.ProcessEnv;
export function resolveDevCodesignIdentity(env?: NodeJS.ProcessEnv, run?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>): Promise<DevCodesignChoice>;
export function describeDevCodesignIdentity(subject: string, choice: DevCodesignChoice, failed?: boolean, advice?: boolean): string;
export function codesignWithFallback(subject: string, choice: DevCodesignChoice, sign: (identity: string) => Promise<void>, log: (message: string) => void, options?: { advice?: boolean }): Promise<string>;
