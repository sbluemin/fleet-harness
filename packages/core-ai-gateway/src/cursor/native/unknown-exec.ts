import type { UnknownField } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

const EXECUTE_HOOK_FIELD_NUMBER = 27;
const EXEC_CLIENT_MESSAGE_FIELD_NUMBER = 2;
const EXEC_CLIENT_CONTROL_MESSAGE_FIELD_NUMBER = 5;
const SUPPORTED_HOOK_CASES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);

type ExecMessage = Record<string, unknown>;

export interface CursorUnknownExecReply {
  readonly payloads: readonly Uint8Array[];
  readonly replyKind: string;
}

/**
 * Cursor adds native exec variants independently of the vendored protobuf descriptor cadence.
 * Unknown protobuf fields retain their wire bytes, which lets the gateway acknowledge lifecycle
 * hooks without executing them and reject every other future variant through Cursor's control
 * channel instead of leaving the server waiting forever.
 */
export function cursorUnknownExecReply(
  exec: ExecMessage,
  unknownFields: readonly UnknownField[],
): CursorUnknownExecReply {
  const executeHook = unknownFields.find(
    (field) => field.no === EXECUTE_HOOK_FIELD_NUMBER
      && field.wireType === WireType.LengthDelimited,
  );
  if (executeHook) {
    const hookCase = executeHookRequestCase(executeHook);
    if (hookCase !== undefined && SUPPORTED_HOOK_CASES.has(hookCase)) {
      return {
        payloads: [executeHookReply(exec, hookCase)],
        replyKind: "exec.policy.executeHookArgs",
      };
    }
  }

  const caseName = cursorUnknownExecCaseName(unknownFields);
  return {
    payloads: unsupportedExecReplies(
      exec,
      `Fleet AI Gateway cannot handle Cursor native exec ${caseName}; retry with an advertised client tool.`,
    ),
    replyKind: `exec.control.${caseName}`,
  };
}

/** Payload-free label used by diagnostics. */
export function cursorUnknownExecCaseName(unknownFields: readonly UnknownField[]): string {
  const fieldNumbers = [...new Set(
    unknownFields
      .filter((field) => field.wireType === WireType.LengthDelimited)
      .map((field) => field.no),
  )].sort((left, right) => left - right);
  if (fieldNumbers.includes(EXECUTE_HOOK_FIELD_NUMBER)) return "executeHookArgs";
  return fieldNumbers.length > 0 ? `unknownField${fieldNumbers.join("-")}` : "unknown";
}

function executeHookRequestCase(field: UnknownField): number | undefined {
  const args = lengthDelimitedPayload(field);
  if (!args) return undefined;
  const request = embeddedMessage(args, 1);
  if (!request) return undefined;

  try {
    const reader = new BinaryReader(request);
    while (reader.pos < reader.len) {
      const [fieldNumber, wireType] = reader.tag();
      if (wireType === WireType.LengthDelimited) return fieldNumber;
      reader.skip(wireType, fieldNumber);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lengthDelimitedPayload(field: UnknownField): Uint8Array | undefined {
  try {
    const reader = new BinaryReader(field.data);
    const payload = reader.bytes();
    return reader.pos === reader.len ? payload : undefined;
  } catch {
    return undefined;
  }
}

function embeddedMessage(message: Uint8Array, wantedFieldNumber: number): Uint8Array | undefined {
  try {
    const reader = new BinaryReader(message);
    while (reader.pos < reader.len) {
      const [fieldNumber, wireType] = reader.tag();
      if (fieldNumber === wantedFieldNumber && wireType === WireType.LengthDelimited) {
        return reader.bytes();
      }
      reader.skip(wireType, fieldNumber);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function executeHookReply(exec: ExecMessage, hookCase: number): Uint8Array {
  const response = encodeMessage((writer) => {
    writer.tag(hookCase, WireType.LengthDelimited).bytes(new Uint8Array());
  });
  const result = encodeMessage((writer) => {
    writer.tag(1, WireType.LengthDelimited).bytes(response);
  });
  const execClientMessage = encodeMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(uint32Value(exec.id));
    const execId = stringValue(exec.execId);
    if (execId) writer.tag(15, WireType.LengthDelimited).string(execId);
    writer.tag(EXECUTE_HOOK_FIELD_NUMBER, WireType.LengthDelimited).bytes(result);
  });
  return encodeMessage((writer) => {
    writer.tag(EXEC_CLIENT_MESSAGE_FIELD_NUMBER, WireType.LengthDelimited).bytes(execClientMessage);
  });
}

function unsupportedExecReplies(exec: ExecMessage, error: string): readonly Uint8Array[] {
  const id = uint32Value(exec.id);
  const execThrow = encodeMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(id);
    writer.tag(2, WireType.LengthDelimited).string(error);
  });
  const streamClose = encodeMessage((writer) => {
    writer.tag(1, WireType.Varint).uint32(id);
  });
  return [
    encodeControlMessage(2, execThrow),
    encodeControlMessage(1, streamClose),
  ];
}

function encodeControlMessage(caseNumber: number, value: Uint8Array): Uint8Array {
  const control = encodeMessage((writer) => {
    writer.tag(caseNumber, WireType.LengthDelimited).bytes(value);
  });
  return encodeMessage((writer) => {
    writer.tag(EXEC_CLIENT_CONTROL_MESSAGE_FIELD_NUMBER, WireType.LengthDelimited).bytes(control);
  });
}

function encodeMessage(write: (writer: BinaryWriter) => void): Uint8Array {
  const writer = new BinaryWriter();
  write(writer);
  return writer.finish();
}

function uint32Value(value: unknown): number {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 0xffff_ffff
  ) {
    return value;
  }
  return 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
