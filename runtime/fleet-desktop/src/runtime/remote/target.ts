import { RemoteRuntimeError } from "./contracts.js";

const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/u;

export interface ValidatedSshTarget {
  readonly value: string;
  readonly user: string | null;
  readonly host: string;
}

export function parseSshTarget(input: string): ValidatedSshTarget {
  if (typeof input !== "string" || input.length === 0 || /[\u0000-\u001f\u007f\s]/u.test(input) || !SSH_TARGET.test(input)) throw invalidTarget();
  const parts = input.split("@");
  const user = parts.length === 2 ? parts[0]! : null;
  const host = parts.length === 2 ? parts[1]! : parts[0]!;
  if (user?.startsWith("-") || host.startsWith("-")) throw invalidTarget();
  return { value: input, user, host };
}

function invalidTarget(): RemoteRuntimeError { return new RemoteRuntimeError("pairing_target_invalid"); }
