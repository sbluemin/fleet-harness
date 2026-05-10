/**
 * _shared/cli-tool-types — ACP SDK tool 이벤트 타입 wrapper.
 *
 * unified-agent에서 re-export하는 AcpToolCall/AcpToolCallUpdate를
 * fleet-core 도메인에서 CLI tool 타입으로 사용하기 위한 별칭 파일.
 * Acp 명칭은 이 파일에서만 등장하며, admiral/agent 하위에서는
 * Cli 명칭만 사용합니다.
 */

import type { AcpToolCall, AcpToolCallUpdate } from "@sbluemin/fleet-unified-agent";

/** CLI tool call 이벤트 데이터 (ACP SDK re-alias) */
export type { AcpToolCall as CliToolCall, AcpToolCallUpdate as CliToolCallUpdate };
