// Virtual input via UserInputService:CreateVirtualInput().
//
// We deliberately do NOT use VirtualInputManager:Send*Event — those methods
// are gated behind RobloxScriptSecurity ("lacking capability RobloxScript")
// in every context a plugin can reach (edit DM, play server/client DMs), so
// they silently never worked. CreateVirtualInput() is callable without that
// capability and drives the REAL input pipeline: SendKey feeds
// UserInputService.InputBegan/Ended and the control modules (so WASD walks the
// character at full WalkSpeed with controls intact, no Humanoid hijack),
// SendMouseButton feeds UIS and activates GUI buttons (and hit-tests against
// CoreGui), and SendTextInput types into the focused TextBox.
//
// Current VirtualInput supports absolute pointer movement as well as buttons.
// Coordinates are native viewport pixels. macOS window captures include Studio
// chrome and are explicitly not the same coordinate space. GUI-targeted clicks
// are resolved separately by the command service.

import * as RenderMonitor from "../RenderMonitor";

const UserInputService = game.GetService("UserInputService");

interface VirtualInput {
	SendKey(isDown: boolean, keyCode: Enum.KeyCode): void;
	SendMouseButton(position: Vector2, inputType: Enum.UserInputType, isDown: boolean): void;
	SendMousePosition(position: Vector2): void;
	SendTextInput(text: string): void;
}

// One VirtualInput per plugin VM, reused across calls so that a key held down
// in one call (action="press") and released in a later call (action="release")
// share the same input source.
let cachedVI: VirtualInput | undefined;

function getVI(): VirtualInput | undefined {
	if (cachedVI) return cachedVI;
	const [ok, vi] = pcall(() => {
		return (UserInputService as unknown as { CreateVirtualInput(): unknown }).CreateVirtualInput();
	});
	if (ok && vi !== undefined) {
		cachedVI = vi as VirtualInput;
		return cachedVI;
	}
	return undefined;
}

const MOUSE_TYPE_MAP: Record<string, Enum.UserInputType> = {
	Left: Enum.UserInputType.MouseButton1,
	Right: Enum.UserInputType.MouseButton2,
	Middle: Enum.UserInputType.MouseButton3,
};

function simulateMouseInput(requestData: Record<string, unknown>) {
	const action = requestData.action as string;
	const x = requestData.x as number | undefined;
	const y = requestData.y as number | undefined;
	const button = (requestData.button as string) ?? "Left";

	if (!action) return { error: "action is required" };
	if (x === undefined || y === undefined) {
		return { error: "x and y are required" };
	}

	// Input is silently dropped by the engine when the window isn't rendering
	// (e.g. minimized). Surface that instead of returning a false success.
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined && action !== "mouseUp") return { error: notRendering };

	const vi = getVI();
	if (!vi) {
		return { error: "UserInputService:CreateVirtualInput() is not available in this context" };
	}

	const inputType = MOUSE_TYPE_MAP[button] ?? Enum.UserInputType.MouseButton1;
	const pos = new Vector2(x, y);

	const [success, err] = pcall(() => {
		if (action === "move") {
			vi.SendMousePosition(pos);
		} else if (action === "click") {
			vi.SendMousePosition(pos);
			task.wait();
			vi.SendMouseButton(pos, inputType, true);
			task.wait(0.05);
			vi.SendMouseButton(pos, inputType, false);
		} else if (action === "mouseDown") {
			vi.SendMouseButton(pos, inputType, true);
		} else if (action === "mouseUp") {
			vi.SendMouseButton(pos, inputType, false);
		} else {
			error(
				`Unsupported action "${action}". CreateVirtualInput supports move, click, mouseDown, mouseUp. Scroll is not exposed by this command.`,
			);
		}
	});

	if (action === "click" || !success) pcall(() => vi.SendMouseButton(pos, inputType, false));
	if (success) {
		return { success: true, action, x, y, button };
	}
	return { error: `Failed to simulate mouse input: ${err}` };
}

function simulateKeyboardInput(requestData: Record<string, unknown>) {
	const action = (requestData.action as string) ?? "tap";
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined && action !== "release") return { error: notRendering };

	const vi = getVI();
	if (!vi) {
		return { error: "UserInputService:CreateVirtualInput() is not available in this context" };
	}

	// Text mode: type a string into the focused TextBox.
	const text = requestData.text as string | undefined;
	if (text !== undefined) {
		const [ok, err] = pcall(() => vi.SendTextInput(text));
		if (ok) return { success: true, text };
		return { error: `Failed to send text input: ${err}` };
	}

	const keyCodeName = requestData.keyCode as string;
	if (!keyCodeName) return { error: "keyCode (or text) is required" };

	const duration = (requestData.duration as number) ?? 0.1;

	const [enumOk, keyCode] = pcall(() => {
		return (Enum.KeyCode as unknown as Record<string, Enum.KeyCode>)[keyCodeName];
	});
	if (!enumOk || !keyCode) {
		return {
			error: `Unknown keyCode: ${keyCodeName}. Use Enum.KeyCode names like "W", "Space", "E", "LeftShift", etc.`,
		};
	}

	const [success, err] = pcall(() => {
		if (action === "press") {
			vi.SendKey(true, keyCode);
		} else if (action === "release") {
			vi.SendKey(false, keyCode);
		} else if (action === "tap") {
			vi.SendKey(true, keyCode);
			task.wait(duration);
			vi.SendKey(false, keyCode);
		} else {
			error(`Unknown action: ${action}`);
		}
	});

	if (action === "tap" || !success) pcall(() => vi.SendKey(false, keyCode));
	if (success) {
		return { success: true, keyCode: keyCodeName, action };
	}
	return { error: `Failed to simulate keyboard input: ${err}` };
}

export = {
	simulateMouseInput,
	simulateKeyboardInput,
};
