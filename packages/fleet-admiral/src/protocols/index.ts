/**
 * protocols/index — Admiral Protocol 표면
 *
 * Fleet Action Protocol mode selection is an always-on prompt gate. Full
 * protocol bodies live as on-demand skills; no runtime registry, settings key,
 * or switching API exists here.
 */

export {
  type AdmiralDoctrine,
  resolveDoctrineFromCliId,
} from "./doctrine.js";

export {
  FLEET_PROTOCOL_GATE_PROMPT,
  getProtocolGatePrompt,
} from "./fleet-action.js";
