import { matchesKey } from "../controls/index.js";

import type { RenameState } from "./overlay-types.js";
import type { OverlayState } from "./types.js";

export interface CarrierStatusInputController {
  readonly cancelEdit: () => void;
  readonly confirmBatchCliFromEdit: () => void;
  readonly confirmBatchCliToEdit: () => void;
  readonly confirmCliTypeEdit: () => void;
  readonly confirmEffortEdit: () => void;
  readonly confirmModelEdit: () => void;
  readonly done: () => void;
  readonly handleRenameInput: (data: string) => void;
  readonly moveEditCursor: (delta: number) => void;
  readonly moveSelection: (delta: number) => void;
  readonly openTaskForce: () => void;
  readonly resetCliTypesToDefault: () => void;
  readonly startBatchCliFromEdit: () => void;
  readonly startCliTypeEdit: () => void;
  readonly startModelEdit: () => void;
  readonly startRenameEdit: () => void;
  readonly toggleDetails: () => void;
}

export interface CarrierStatusInputState {
  readonly renameState: RenameState | null;
  readonly state: OverlayState;
}

export function handleCarrierStatusOverlayInput(
  data: string,
  inputState: CarrierStatusInputState,
  controller: CarrierStatusInputController,
): void {
  if (inputState.state.kind === "saving") return;

  if (inputState.renameState) {
    controller.handleRenameInput(data);
    return;
  }

  if (matchesKey(data, "escape") || matchesKey(data, "alt+o")) {
    if (inputState.state.kind === "browse") {
      controller.done();
    } else {
      controller.cancelEdit();
    }
    return;
  }

  if (matchesKey(data, "up")) {
    if (inputState.state.kind === "browse") controller.moveSelection(-1);
    else controller.moveEditCursor(-1);
    return;
  }

  if (matchesKey(data, "down")) {
    if (inputState.state.kind === "browse") controller.moveSelection(1);
    else controller.moveEditCursor(1);
    return;
  }

  if (inputState.state.kind === "browse" && data === "\t") {
    controller.toggleDetails();
    return;
  }

  if (inputState.state.kind === "browse" && matchesKey(data, "t")) {
    controller.openTaskForce();
    return;
  }

  if (inputState.state.kind === "browse" && data === "c") {
    controller.startCliTypeEdit();
    return;
  }

  if (inputState.state.kind === "browse" && data === "N") {
    controller.startRenameEdit();
    return;
  }

  if (inputState.state.kind === "browse" && data === "C") {
    controller.startBatchCliFromEdit();
    return;
  }

  if (inputState.state.kind === "browse" && data === "R") {
    controller.resetCliTypesToDefault();
    return;
  }

  if (!matchesKey(data, "enter")) return;
  switch (inputState.state.kind) {
    case "browse":
      controller.startModelEdit();
      return;
    case "model":
      controller.confirmModelEdit();
      return;
    case "effort":
      controller.confirmEffortEdit();
      return;
    case "cliType":
      controller.confirmCliTypeEdit();
      return;
    case "batchFrom":
      controller.confirmBatchCliFromEdit();
      return;
    case "batchTo":
      controller.confirmBatchCliToEdit();
      return;
  }
}
