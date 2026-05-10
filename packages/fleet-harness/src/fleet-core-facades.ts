import { admiral, infra, metaphor } from "@sbluemin/fleet-core";

export const {
  ANIM_INTERVAL_MS,
  ANSI_RESET,
  BODY_H_STEP,
  BORDER,
  CARRIER_BG_COLORS,
  CARRIER_COLORS,
  CARRIER_DISPLAY_NAMES,
  CARRIER_RGBS,
  CLI_DISPLAY_NAMES,
  DEFAULT_BODY_H,
  MAX_BODY_H,
  MIN_BODY_H,
  PANEL_COLOR,
  PANEL_DETAIL_HINT,
  PANEL_DIM_COLOR,
  PANEL_RGB,
  SORTIE_SUMMARY_COLOR,
  SPINNER_FRAMES,
  SQUADRON_BADGE_COLOR,
  STREAMING_PREVIEW_LINES,
  SYM_INDICATOR,
  SYM_THINKING,
  TASKFORCE_BADGE_COLOR,
  THINKING_COLOR,
  TOOLS_COLOR,
  formatPanelMultiColHint,
} = admiral.constants;

export const {
  TASKFORCE_CLI_TYPES,
} = admiral.taskforce;

export const StatusOverlayController: any = admiral.carrier.StatusOverlayController;
export const getCarrierFrameworkState: any = admiral.carrier.getCarrierFrameworkState;

export const getConfiguredTaskForceBackends: any = admiral.store.getConfiguredTaskForceBackends;
export const getConfiguredTaskForceCarrierIds: any = admiral.store.getConfiguredTaskForceCarrierIds;
export const getPerCliSettings: any = admiral.store.getPerCliSettings;
export const getTaskForceModelConfig: any = admiral.store.getTaskForceModelConfig;
export const loadModels: any = admiral.store.loadModels;
export const resetTaskForceModelSelection: any = admiral.store.resetTaskForceModelSelection;
export const saveOfflineCarriers: any = admiral.store.saveOfflineCarriers;
export const savePerCliSettings: any = admiral.store.savePerCliSettings;
export const saveSquadronEnabled: any = admiral.store.saveSquadronEnabled;
export const updateCliTypeOverride: any = admiral.store.updateCliTypeOverride;
export const updateModelSelection: any = admiral.store.updateModelSelection;
export const updateTaskForceModelSelection: any = admiral.store.updateTaskForceModelSelection;

export const {
  getActiveBackgroundJobCount,
  onActiveJobCountChange,
} = infra.job;

export const composeOperationNameRequest: any = metaphor.operationName.composeOperationNameRequest;
export const loadOperationNameSettings: any = metaphor.operationName.loadSettings;
export const sanitizeOperationNameDisplay: any = metaphor.operationName.sanitizeOperationNameDisplay;
