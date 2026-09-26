// Detects whether the Studio window is actually rendering, so virtual input
// and screenshot tools can surface a clear reason instead of silently failing.
//
// When a Studio window is MINIMIZED, the engine suspends the render loop AND
// input processing, but keeps running scripts (Heartbeat keeps firing). That's
// why simulate_*_input would return success while having zero effect, and
// CaptureService:CaptureScreenshot would time out. Validated live: during a 3s
// minimize, RenderStepped's max inter-frame gap was 5.08s while Heartbeat's was
// 0.10s. So RenderStepped freshness is the reliable "is this window rendering?"
// signal; Heartbeat is not.

import { RunService } from "@rbxts/services";

let lastFrame = 0;
let frameCount = 0;
let connected = false;
const frameTimes: number[] = [];

// Above this many seconds since the last rendered frame, we treat the window
// as not rendering. RenderStepped normally fires every ~16ms; a multi-second
// gap only happens when minimized/suspended, so 1s cleanly avoids false
// positives from ordinary frame hitches while still catching the real case.
const STALE_THRESHOLD = 1.0;

export function start(): void {
	if (connected) return;
	if (RunService.IsServer()) return;
	// RenderStepped can only be connected from a client/edit render loop; it
	// throws in the play-server DM. pcall so a server-DM call is a safe no-op
	// (connected stays false → notRenderingReason() returns undefined there).
	const [ok] = pcall(() => {
		RunService.RenderStepped.Connect((deltaTime) => {
			frameTimes.push(deltaTime * 1000);
			if (frameTimes.size() > 120) frameTimes.shift();
			lastFrame = tick();
			frameCount += 1;
		});
	});
	if (ok) {
		connected = true;
		lastFrame = tick();
	}
}

export function secondsSinceFrame(): number {
	if (!connected) return 0;
	return math.max(0, tick() - lastFrame);
}

// Return a compact, JSON-safe snapshot for diagnostics. The monitor is not
// available in a server DataModel, so callers must distinguish "not
// monitored" from a monitored window that has gone stale.
export function snapshot(): Record<string, unknown> {
	if (!connected) {
		return {
			available: false,
			state: "not_monitored",
			frameCount: frameCount,
		};
	}

	const gap = secondsSinceFrame();
	const sorted = [...frameTimes];
	sorted.sort();
	let total = 0;
	for (const ms of sorted) total += ms;
	const count = sorted.size();
	return {
		available: true,
		rendering: gap <= STALE_THRESHOLD,
		state: gap <= STALE_THRESHOLD ? "rendering" : "stale",
		secondsSinceFrame: gap,
		lastFrameAt: lastFrame,
		frameCount,
		frameTimeMs: count > 0 ? {
			samples: count,
			p50: sorted[math.ceil(count * 0.5) - 1],
			p95: sorted[math.ceil(count * 0.95) - 1],
			max: sorted[count - 1],
			mean: total / count,
			fps: total > 0 ? count * 1000 / total : 0,
		} : undefined,
	};
}

// CaptureService is sensitive to the render loop. Give a pending request one
// chance to cross a real rendered frame before it attempts a capture. This is
// deliberately fail-open when the monitor is unavailable (for example in the
// server DataModel); the actual capture handler still reports its own error.
export function waitForRenderedFrame(timeoutSeconds = 2): boolean {
	if (!connected) return true;
	const initialFrameCount = frameCount;
	const deadline = tick() + math.max(0, timeoutSeconds);
	while (frameCount <= initialFrameCount && tick() < deadline) {
		task.wait(0.05);
	}
	return frameCount > initialFrameCount;
}

// Returns a human-readable reason if the window appears minimized / not
// rendering (so input + screenshots won't work), else undefined. Fail-open:
// when the monitor isn't active in this DM (server peer, or connect failed) it
// returns undefined so we never block on a false signal.
export function notRenderingReason(): string | undefined {
	if (!connected) return undefined;
	const gap = secondsSinceFrame();
	if (gap > STALE_THRESHOLD) {
		return string.format(
			"Studio window appears minimized or not rendering (no frame in %.1fs). " +
				"Virtual input and screenshots only work while the window is visible — " +
				"restore/un-minimize the Studio window and retry.",
			gap,
		);
	}
	return undefined;
}
