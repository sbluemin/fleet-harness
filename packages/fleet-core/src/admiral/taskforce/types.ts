/**
 * fleet/shipyard/taskforce/types.ts — Task Force 도구 타입 정의
 *
 * BackendProgress, TaskForceResult, TaskForceState를 정의합니다.
 */

import { CLI_BACKENDS, type CliType } from "@sbluemin/fleet-unified-agent";

export type TaskForceCliType = CliType;

export interface BackendProgress {
  status: "queued" | "connecting" | "streaming" | "done" | "error";
  toolCallCount: number;
  lineCount: number;
}

export interface TaskForceResult {
  cliType: TaskForceCliType;
  displayName: string;
  status: "done" | "error" | "aborted";
  responseText: string;
  error?: string;
  thinking?: string;
  toolCalls?: { title: string; status: string }[];
}

export interface TaskForceState {
  carrierId: string;
  requestKey: string;
  backends: Map<TaskForceCliType, BackendProgress>;
  startedAt: number;
  finishedAt?: number;
}

export const TASKFORCE_CLI_TYPES = Object.keys(CLI_BACKENDS) as CliType[];
