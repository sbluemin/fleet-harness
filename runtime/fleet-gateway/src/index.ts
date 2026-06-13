export type {
	GatewayConsumerClient,
	GatewayConsumerClientConnectionState,
	GatewayConsumerClientDeps,
	GatewayHealth,
	GatewayLockPayload,
	GatewayQueuedToolCall,
	GatewayRegisterTenantResponse,
	GatewayToolCallResult,
	GatewayToolExecutionPort,
	GatewayToolSnapshot,
} from "./api-types.js";
export { createGatewayConsumerClient } from "./consumer-client.js";
export { createGatewayDaemonLifecycle } from "./cli.js";
