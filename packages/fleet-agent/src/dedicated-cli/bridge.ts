import type { ProgrammaticInput } from "@sbluemin/fleet-tui/input";

let programmaticInput: ProgrammaticInput | undefined;

export function retainProgrammaticInput(input: ProgrammaticInput | undefined): void {
  programmaticInput = input;
}

export function getProgrammaticInput(): ProgrammaticInput | undefined {
  return programmaticInput;
}
