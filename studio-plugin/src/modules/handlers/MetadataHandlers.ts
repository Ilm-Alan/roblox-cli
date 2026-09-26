import { RunService } from "@rbxts/services";
import Utils from "../Utils";
import LuauExec from "../LuauExec";
import PeerRole from "../PeerRole";

const Selection = game.GetService("Selection");

const { getInstancePath, getInstanceByPath } = Utils;

// Outside the edit DataModel the player's camera controller re-aims a
// non-Scriptable camera on the next render step, so a framed client capture
// needs the camera to stay Scriptable until the screenshot is taken. The hold
// ends CAPTURE_GRACE_SECONDS after a successful capture (so the daemon's
// retries of a bad frame stay framed), or HOLD_SECONDS after framing when no
// capture follows; then the original CameraType, CFrame and Focus return.
const HOLD_SECONDS = 30;
const CAPTURE_GRACE_SECONDS = 3;

interface CameraHold {
	camera: Camera;
	cameraType: Enum.CameraType;
	cframe: CFrame;
	focus: CFrame;
	generation: number;
}

let cameraHold: CameraHold | undefined;

function releaseCameraHold(): void {
	const hold = cameraHold;
	if (!hold) return;
	cameraHold = undefined;
	pcall(() => {
		hold.camera.CameraType = hold.cameraType;
		hold.camera.CFrame = hold.cframe;
		hold.camera.Focus = hold.focus;
	});
}

function scheduleCameraRelease(hold: CameraHold, seconds: number): void {
	hold.generation += 1;
	const generation = hold.generation;
	task.delay(seconds, () => {
		if (cameraHold === hold && hold.generation === generation) releaseCameraHold();
	});
}

// Called by capture-begin once a screenshot of the held framing was taken.
function cameraCaptureCompleted(): void {
	if (cameraHold) scheduleCameraRelease(cameraHold, CAPTURE_GRACE_SECONDS);
}

// Aims the Studio camera at an instance and frames it from a sensible angle.
// This completes the screenshot loop capture_screenshot documents: build,
// focus, screenshot. Framing distance comes from the bounding box and the
// camera's own field of view so any subject fills a similar share of frame.
function focusViewport(requestData: Record<string, unknown>) {
	const instancePath = requestData.path;
	let instance: Instance;
	if (instancePath === undefined) {
		const selection = Selection.Get();
		if (selection.size() === 0) {
			return { error: "No objects selected. Select a BasePart or Model, or provide path." };
		}
		if (selection.size() !== 1) {
			return { error: "Select exactly one BasePart or Model to frame, or provide path." };
		}
		instance = selection[0];
	} else {
		if (!typeIs(instancePath, "string") || instancePath === "") {
			return { error: "path must be a non-empty instance path when provided" };
		}
		const resolved = getInstanceByPath(instancePath);
		if (!resolved) return { error: `Instance not found: ${instancePath}` };
		instance = resolved;
	}

	const workspace = game.GetService("Workspace");
	const camera = workspace.CurrentCamera;
	if (!camera) return { error: "Workspace.CurrentCamera is unavailable right now" };

	const padding = tonumber(requestData.padding as number) ?? 1;
	if (padding <= 0 || padding > 10) {
		return { error: "padding must be greater than 0 and at most 10" };
	}

	const compassOverride =
		requestData.from === undefined ? undefined : tonumber(requestData.from as number);
	if (requestData.from !== undefined && compassOverride === undefined) {
		return { error: "from must be a compass angle in degrees" };
	}

	const elevationOverride =
		requestData.angleY === undefined ? undefined : tonumber(requestData.angleY as number);
	if (
		requestData.angleY !== undefined &&
		(elevationOverride === undefined || elevationOverride < -89 || elevationOverride > 89)
	) {
		return { error: "angleY must be between -89 and 89" };
	}

	const holdForCapture = !RunService.IsEdit();
	if (holdForCapture && cameraHold !== undefined && cameraHold.camera !== camera) releaseCameraHold();
	if (holdForCapture && cameraHold === undefined) {
		cameraHold = { camera, cameraType: camera.CameraType, cframe: camera.CFrame, focus: camera.Focus, generation: 0 };
	}
	const originalCameraType = camera.CameraType;
	const [ok, err] = pcall(() => {
		let boundsCF: CFrame;
		let boundsSize: Vector3;
		if (instance.IsA("Model")) {
			[boundsCF, boundsSize] = instance.GetBoundingBox();
		} else if (instance.IsA("BasePart")) {
			boundsCF = instance.CFrame;
			boundsSize = instance.Size;
		} else {
			return error(
				`Cannot frame a ${instance.ClassName}: it has no 3D bounding box. Frame a part or model instead.`
			);
		}

		const center = boundsCF.Position;
		let direction = camera.CFrame.LookVector.mul(-1);

		const currentHorizontal = new Vector3(direction.X, 0, direction.Z);
		let horizontalDirection =
			currentHorizontal.Magnitude < 0.001 ? new Vector3(1, 0, 0) : currentHorizontal.Unit;
		if (compassOverride !== undefined) {
			const yaw = math.rad(compassOverride);
			horizontalDirection = new Vector3(math.cos(yaw), 0, math.sin(yaw));
		}

		let vertical = direction.Y;
		let horizontalMagnitude = math.sqrt(math.max(0, 1 - vertical * vertical));
		if (elevationOverride !== undefined) {
			const pitch = math.rad(elevationOverride);
			vertical = math.sin(pitch);
			horizontalMagnitude = math.cos(pitch);
		}
		direction = horizontalDirection
			.mul(horizontalMagnitude)
			.add(new Vector3(0, vertical, 0))
			.Unit;

		camera.CameraType = Enum.CameraType.Scriptable;
		camera.CFrame = CFrame.lookAt(center.add(direction.mul(math.max(boundsSize.Magnitude, 1))), center);
		camera.Focus = new CFrame(center);
		camera.ZoomToExtents(boundsCF, boundsSize);

		if (padding !== 1) {
			const fittedOffset = camera.CFrame.Position.sub(center);
			camera.CFrame = CFrame.lookAt(center.add(fittedOffset.mul(padding)), center);
		}
		camera.Focus = new CFrame(center);
	});
	if (holdForCapture) {
		if (!ok) {
			releaseCameraHold();
			return { error: `focus failed: ${tostring(err)}` };
		}
		scheduleCameraRelease(cameraHold!, HOLD_SECONDS);
	} else {
		const [restored, restoreError] = pcall(() => {
			camera.CameraType = originalCameraType;
		});
		if (!restored) {
			return {
				error: `${ok ? "focus completed" : `focus failed: ${tostring(err)}`}; failed to restore camera type: ${tostring(restoreError)}`,
			};
		}
		if (!ok) return { error: `focus failed: ${tostring(err)}` };
	}

	return {
		success: true,
		path: getInstancePath(instance),
		cameraPosition: {
			X: camera.CFrame.Position.X,
			Y: camera.CFrame.Position.Y,
			Z: camera.CFrame.Position.Z,
		},
		cameraHeldUntilCapture: holdForCapture ? true : undefined,
	};
}

function executeLuau(requestData: Record<string, unknown>) {
	const code = requestData.code as string;
	if (!code || code === "") return { error: "Code is required" };
	// All wrapping, print/warn capture, loadstring fallback, value encoding
	// and parse-error recovery live in LuauExec so the edit/server (this
	// handler) and the play-client (ClientBroker) take the same code path and
	// produce identical output shapes. Only the edit DataModel records undo.
	return LuauExec.execute(code, PeerRole.detect() === "edit");
}

export = {
	focusViewport,
	executeLuau,
	cameraCaptureCompleted,
};
