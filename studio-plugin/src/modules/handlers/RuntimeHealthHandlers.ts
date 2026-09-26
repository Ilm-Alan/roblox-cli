import { RunService } from "@rbxts/services";
import * as RenderMonitor from "../RenderMonitor";
import CaptureHandlers from "./CaptureHandlers";
import PeerRole from "../PeerRole";

const Workspace = game.GetService("Workspace");
const DEFAULT_READINESS_ATTRIBUTE = "OpeningReady";

function safeReadinessValue(value: unknown): boolean | number | string | undefined {
	if (typeIs(value, "boolean") || typeIs(value, "number") || typeIs(value, "string")) return value;
	return undefined;
}

function readinessAttribute(requestData: Record<string, unknown>): string {
	const requested = requestData.readinessAttribute ?? requestData.readiness_attribute;
	return typeIs(requested, "string") && requested !== "" ? requested : DEFAULT_READINESS_ATTRIBUTE;
}

// This is a diagnostic endpoint, not a second command surface. It reports the
// facts the plugin can observe in its own DataModel so the daemon can attach
// them to status and test evidence without guessing from peer connectivity.
function getRuntimeHealth(requestData: Record<string, unknown>): unknown {
	const attribute = readinessAttribute(requestData);
	const rawReadiness = Workspace.GetAttribute(attribute);
	const value = safeReadinessValue(rawReadiness);
	const render = RenderMonitor.snapshot();
	const capture = requestData.probeCapture === true
		? CaptureHandlers.probeCapture()
		: {
			probeRequested: false,
			serviceAvailable: true,
			usable: undefined,
		};

	return {
		success: true,
		peer: PeerRole.detect(),
		isRunning: RunService.IsRunning(),
		isEditMode: RunService.IsEdit(),
		isRunMode: RunService.IsRunMode(),
		render,
		capture,
		readiness: {
			attribute,
			present: rawReadiness !== undefined,
			value,
			fired: rawReadiness === true,
		},
	};
}

export = {
	getRuntimeHealth,
};
