export { pruneConsoleExitRecords, readConsoleExitRecord, writeConsoleExitRecord } from "./exit-record.js";
export { createConsoleHealthClient, toConsoleHealthEvidence, type ConsoleHealthAnswer, type ConsoleHealthDeps, type ConsoleHealthTarget, type ConsoleProbeOptions, type ConsoleProbeResult } from "./health.js";
export { observeConsoleInstance, runStopLadder, type ConsoleInstanceObservation, type ConsoleObservedLock, type ConsoleStopLadderInput, type ConsoleStopLadderResult, type ObserveConsoleInstanceInput } from "./instance.js";
export { captureProvenProcessStart, isLockAuthorReplaced, isPidAlive, readProcessStartTime } from "./process.js";
export { createOwnedProcessRegistry, createProcessTableSnapshot, killSameGroupDescendants, proveExitedLeaderGroup, selectSameGroupDescendants, type OwnedProcessGroup, type OwnedProcessKillInput, type OwnedProcessRegistry, type OwnedProcessSpawnRequest, type ProcessGroupRow, type ProcessTable, type ProcessTableRow, type ProcessTableSnapshot, type ProcessTreeRow } from "./owned-processes.js";
export { consoleNamespaceKey, isReclaimableNamespaceEntry, resolveRealPath } from "./temp-namespace.js";
