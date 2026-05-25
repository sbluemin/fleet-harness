export interface UpdateCommandIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export const UPDATE_HELP_TEXT = `fleet update — Update Fleet

Usage:
  fleet update
`;

export async function dispatchUpdateCommand(
  argv: readonly string[],
  io: UpdateCommandIo,
): Promise<number> {
  const command = argv[1];
  if (command === "--help" || command === "-h") {
    io.stdout.write(UPDATE_HELP_TEXT);
    return 0;
  }
  if (command !== undefined) {
    io.stderr.write(`Unknown fleet update command: ${command}\n`);
    io.stdout.write(UPDATE_HELP_TEXT);
    return 1;
  }
  const { runFleetUpdate } = await import("./installer.js");
  return runFleetUpdate(io);
}
