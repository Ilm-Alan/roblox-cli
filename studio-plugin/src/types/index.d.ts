/// <reference types="@rbxts/types/plugin" />

export interface Connection {
	port: number;
	serverUrl: string;
	isActive: boolean;
	consecutiveFailures: number;
	maxFailuresBeforeError: number;
	currentRetryDelay: number;
	lastHttpOk: boolean;
	lastConnectorOk: boolean;
	connectorWaitStartTime?: number;
	heartbeatConnection?: RBXScriptConnection;
}

export interface RequestData {
	[key: string]: unknown;
}

export interface RequestPayload {
	endpoint: string;
	data?: RequestData;
}

export interface ReadyResponse {
	success: true;
	assignedRole: string;
	peerId: string;
	instanceId: string;
	multiplayerGroupId?: string;
	protocolVersion: 2;
	transportToken: string;
}

export type StudioCancellationReason = "timeout" | "aborted" | "connection_closed";

export type StudioExecutionOutcome = "success" | "error" | "not_executed" | "unknown";

export interface StudioProgressEvent {
	kind: "progress";
	requestId: string;
	phase: "executing" | "response_delivery";
	outcome?: StudioExecutionOutcome;
}

export interface StudioRequestContext {
	requestId: string;
	/** os.clock() value at which the daemon stops waiting. */
	deadlineAt: number;
	isCancelled: () => boolean;
}

export interface StudioRequestEvent {
	kind: "request";
	requestId: string;
	peerId: string;
	target: string;
	endpoint: string;
	data?: RequestData;
	/** Unix epoch ms when the daemon stops waiting; compare with DateTime.now().UnixTimestampMillis. */
	deadlineAtMs: number;
}

export interface StudioCancelEvent {
	kind: "cancel";
	requestId: string;
	reason: StudioCancellationReason;
}

export interface StudioAckEvent {
	kind: "ack";
	requestId: string;
	disposition: "accepted" | "already_settled" | "unknown";
}

export interface StudioStatusEvent {
	kind: "status";
	knownPeer: boolean;
	connectorConnected: boolean;
	serverVersion?: string;
	pluginVersion?: string;
	pluginVariant?: string;
}

export interface TransportUpdate {
	state: "connecting" | "open" | "retrying" | "waiting-duplicate";
	attempt: number;
	retryDelay: number;
	detail?: string;
}

declare global {
	function loadstring(code: string): LuaTuple<[(() => unknown) | undefined, string?]>;
}
