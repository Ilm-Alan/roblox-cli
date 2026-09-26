import { RunService } from "@rbxts/services";
import State from "./State";
import UI from "./UI";
import { cleanupEditBridgeArtifacts } from "./EvalBridges";
import MetadataHandlers from "./handlers/MetadataHandlers";
import TestHandlers from "./handlers/TestHandlers";
import CaptureHandlers from "./handlers/CaptureHandlers";
import InputHandlers from "./handlers/InputHandlers";
import LogHandlers from "./handlers/LogHandlers";
import EvalRuntimeHandlers from "./handlers/EvalRuntimeHandlers";
import RuntimeHealthHandlers from "./handlers/RuntimeHealthHandlers";
import ClientBroker from "./ClientBroker";
import ServerUrlSettings from "./ServerUrlSettings";
import PluginSession from "./PluginSession";
import StudioWebSocket from "./StudioWebSocket";
import type {
	RequestPayload,
	ReadyResponse,
	StudioRequestContext,
	StudioRequestEvent,
	StudioStatusEvent,
	TransportUpdate,
} from "../types";

let assignedRole: string | undefined;
let lastReadyPlaceKey: string | undefined;

const initialRole = PluginSession.getRole();

type Handler = (data: Record<string, unknown>, context: StudioRequestContext) => unknown;

const routeMap: Record<string, Handler> = {
	"/api/focus-viewport": MetadataHandlers.focusViewport,
	"/api/execute-luau": MetadataHandlers.executeLuau,
	"/api/eval-runtime": EvalRuntimeHandlers.evalRuntime,

	"/api/start-playtest": TestHandlers.startPlaytest,
	"/api/stop-playtest": TestHandlers.stopPlaytest,
	"/api/multiplayer-test-start": TestHandlers.multiplayerTestStart,
	"/api/multiplayer-test-state": TestHandlers.multiplayerTestState,
	"/api/multiplayer-test-add-players": TestHandlers.multiplayerTestAddPlayers,
	"/api/multiplayer-test-leave-client": TestHandlers.multiplayerTestLeaveClient,
	"/api/multiplayer-test-end": TestHandlers.multiplayerTestEnd,
	"/api/capture-screenshot": CaptureHandlers.captureScreenshot,
	"/api/capture-studio-screenshot": CaptureHandlers.captureStudioScreenshot,
	"/api/capture-begin": CaptureHandlers.captureBegin,
	"/api/capture-read": CaptureHandlers.captureRead,
	"/api/simulate-mouse-input": InputHandlers.simulateMouseInput,
	"/api/simulate-keyboard-input": InputHandlers.simulateKeyboardInput,

	"/api/get-runtime-logs": LogHandlers.getRuntimeLogs,
	"/api/runtime-health": RuntimeHealthHandlers.getRuntimeHealth,
};

function processRequest(request: RequestPayload, context: StudioRequestContext): unknown {
	const endpoint = request.endpoint;
	const data = request.data ?? {};

	const handler = routeMap[endpoint];
	if (handler) {
		return handler(data as Record<string, unknown>, context);
	} else {
		return { error: `Unknown endpoint: ${endpoint}` };
	}
}

function getConnectionStatus(): string {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return "disconnected";
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) return "error";
	if (conn.lastHttpOk) return "connected";
	return "connecting";
}

function dispatchSocketRequest(request: StudioRequestEvent, context: StudioRequestContext): unknown {
	if (request.peerId !== PluginSession.peerId) {
		return ClientBroker.dispatchClientRequest(
			request.peerId,
			request.target,
			request.endpoint,
			request.data,
		);
	}
	const localRole = assignedRole ?? PluginSession.getRole();
	if (request.target !== localRole) {
		return {
			error: `Transport peer is registered as ${localRole}, not ${request.target}.`,
		};
	}
	return processRequest({ endpoint: request.endpoint, data: request.data }, context);
}

function handleReady(response: ReadyResponse): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	assignedRole = response.assignedRole;
	lastReadyPlaceKey = PluginSession.getPlaceKey();
	ServerUrlSettings.rememberServerUrl(conn.serverUrl);
	ClientBroker.refreshAllProxyRegistrations();
}

function handleStatus(status: StudioStatusEvent): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	conn.lastHttpOk = true;
	conn.lastConnectorOk = status.connectorConnected;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	if (status.connectorConnected) {
		conn.connectorWaitStartTime = undefined;
	} else if (conn.connectorWaitStartTime === undefined) {
		conn.connectorWaitStartTime = tick();
	}


	UI.updateUIState();
	UI.updateToolbarIcon();
}

function handleHeartbeat(_timestamp: number): void {
	if (!State.getActiveConnection().isActive) return;
	UI.updateUIState();
}

function handleTransportUpdate(update: TransportUpdate): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;

	if (update.state === "open") {
		conn.lastHttpOk = true;
		conn.lastConnectorOk = false;
		conn.consecutiveFailures = 0;
		conn.currentRetryDelay = 0.5;
		conn.connectorWaitStartTime = tick();
	} else {
		conn.lastHttpOk = false;
		conn.lastConnectorOk = false;
		conn.consecutiveFailures = update.attempt;
		if (update.retryDelay > 0) conn.currentRetryDelay = update.retryDelay;
		conn.connectorWaitStartTime = undefined;
	}

	UI.updateUIState();
	UI.updateToolbarIcon();
	if (update.state === "waiting-duplicate") {
		const ui = UI.getElements();
		ui.statusLabel.Text = "Waiting for previous instance";
		ui.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
		ui.detailStatusLabel.Text = update.detail ?? "The previous plugin instance is still active.";
		ui.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
	}
}

let nameChangeConn: RBXScriptConnection | undefined;
let placeIdChangeConn: RBXScriptConnection | undefined;

function ensureIdentityWatchers(): void {
	if (!nameChangeConn) {
		const [signalOk, signal] = pcall(() => game.GetPropertyChangedSignal("Name"));
		if (signalOk && signal) {
			nameChangeConn = signal.Connect(() => StudioWebSocket.refresh());
		}
	}
	if (!placeIdChangeConn) {
		const [signalOk, signal] = pcall(() => game.GetPropertyChangedSignal("PlaceId"));
		if (signalOk && signal) {
			placeIdChangeConn = signal.Connect(() => {
				PluginSession.invalidatePlaceName();
				lastReadyPlaceKey = PluginSession.getPlaceKey();
				StudioWebSocket.refresh();
			});
		}
	}
}

function disconnectIdentityWatchers(): void {
	if (nameChangeConn) {
		nameChangeConn.Disconnect();
		nameChangeConn = undefined;
	}
	if (placeIdChangeConn) {
		placeIdChangeConn.Disconnect();
		placeIdChangeConn = undefined;
	}
}


function activatePlugin() {
	const conn = State.getActiveConnection();
	if (conn.isActive) return;
	const ui = UI.getElements();

	conn.isActive = true;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	conn.lastHttpOk = false;
	conn.lastConnectorOk = false;
	conn.connectorWaitStartTime = undefined;

	const normalizedUrl = ServerUrlSettings.normalizeServerUrl(ui.urlInput.Text);
	conn.serverUrl = normalizedUrl !== "" ? normalizedUrl : conn.serverUrl;
	if (conn.serverUrl === "") conn.serverUrl = ClientBroker.DEFAULT_CONNECTOR_URL;
	ui.urlInput.Text = conn.serverUrl;
	const port = ServerUrlSettings.extractPort(conn.serverUrl);
	if (port !== undefined) conn.port = port;
	ClientBroker.setServerUrl(conn.serverUrl);
	lastReadyPlaceKey = PluginSession.getPlaceKey();
	UI.updateUIState();

	StudioWebSocket.start({
		serverUrl: conn.serverUrl,
		dispatchRequest: dispatchSocketRequest,
		onStatus: handleStatus,
		onHeartbeat: handleHeartbeat,
		onReady: handleReady,
		onTransportUpdate: handleTransportUpdate,
	});

	if (!conn.heartbeatConnection) {
		conn.heartbeatConnection = RunService.Heartbeat.Connect(() => {
			if (initialRole === "server" && !RunService.IsRunning()) {
				ClientBroker.disconnectAllProxies();
				deactivatePlugin();
				return;
			}
			const currentPlaceKey = PluginSession.getPlaceKey();
			if (lastReadyPlaceKey !== undefined && currentPlaceKey !== lastReadyPlaceKey) {
				lastReadyPlaceKey = currentPlaceKey;
				PluginSession.invalidatePlaceName();
				StudioWebSocket.refresh();
			}
		});
	}

	if (initialRole === "edit") {
		task.spawn(cleanupEditBridgeArtifacts);
	}
	ensureIdentityWatchers();
}

function deactivatePlugin() {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	conn.isActive = false;
	conn.lastHttpOk = false;
	conn.lastConnectorOk = false;
	conn.connectorWaitStartTime = undefined;

	StudioWebSocket.stop();
	disconnectIdentityWatchers();
	if (initialRole === "server") ClientBroker.disconnectAllProxies();
	if (conn.heartbeatConnection) {
		conn.heartbeatConnection.Disconnect();
		conn.heartbeatConnection = undefined;
	}

	lastReadyPlaceKey = undefined;
	assignedRole = undefined;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	UI.updateUIState();
}

function deactivateAll() {
	const conn = State.getActiveConnection();
	if (conn.isActive) {
		deactivatePlugin();
	}
}


export = {
	getConnectionStatus,
	activatePlugin,
	deactivatePlugin,
	deactivateAll,
};
