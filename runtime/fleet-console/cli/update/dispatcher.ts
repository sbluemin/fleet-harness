import type { UpdateCommandIo } from "./types.js";

const UPDATE_HELP_TEXT = `fleet update — Update Fleet

Usage:
  fleet update
  fleet update --check
`;

export async function dispatchUpdateCommand(
  argv: readonly string[],
  io: UpdateCommandIo,
  options: { readonly siblingCliPath?: string } = {},
): Promise<number> {
  const command = argv[1];
  if (command === "--help" || command === "-h") {
    io.stdout.write(UPDATE_HELP_TEXT);
    return 0;
  }
  if (command === "--check") {
    if (argv[2] !== undefined) {
      io.stderr.write(`Unknown fleet update option: ${argv[2]}\n`);
      io.stdout.write(UPDATE_HELP_TEXT);
      return 1;
    }
    const { runFleetUpdateCheck } = await import("./check-report.js");
    return runFleetUpdateCheck(io);
  }
  if (command !== undefined) {
    io.stderr.write(`Unknown fleet update command: ${command}\n`);
    io.stdout.write(UPDATE_HELP_TEXT);
    return 1;
  }
  const { runFleetUpdate } = await import("./installer.js");
  return runFleetUpdate(io, options);
}
