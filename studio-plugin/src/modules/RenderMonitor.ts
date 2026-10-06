// Detects whether the Studio window is actually rendering, and how fast, so
// capture tools can surface a clear reason instead of silently failing and
// receipts can report the real frame rate of a run.
//
// When a Studio window is MINIMIZED, or the display sleeps, the engine stops
// its render loop but keeps running scripts (Heartbeat keeps firing), and
// CaptureService:CaptureScreenshot times out. Validated live: during a 3s
// minimize, RenderStepped's max inter-frame gap was 5.08s while Heartbeat's was
// 0.10s. So RenderStepped freshness is the reliable "is this window rendering?"
// signal; Heartbeat is not. A window behind another app keeps rendering, but
// Studio throttles it to about 15 fps; frameCount over time measures that.

import { RunService } from "@rbxts/services";

let lastFrame = 0;
let frameCount = 0;
let connected = false;
const frameTimes: number[] = [];

// Above this many seconds since the last rendered frame, we treat the window
// as not rendering. RenderStepped fires every ~16ms in front and ~66ms behind
// another app; a multi-second gap only happens when minimized or the display
// sleeps, so 1s avoids false positives from frame hitches.
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
		// The clock frameCount was read at: two samples give the frame rate
		// over a whole run without trusting the caller's round-trip timing.
		sampledAt: tick(),
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

// Returns a human-readable reason if the window has stopped rendering, else
// undefined. Fail-open: when the monitor isn't active in this DM (server peer,
// or connect failed) it returns undefined so we never block on a false signal.
// A background window still renders (Studio throttles it to ~15 fps); a stale
// render loop means the window is minimized or the display is asleep.
export function notRenderingReason(): string | undefined {
	if (!connected) return undefined;
	const gap = secondsSinceFrame();
	if (gap > STALE_THRESHOLD) {
		return string.format(
			"Studio is not rendering (no frame in %.1fs): its window is minimized or the display is asleep. " +
				"Restore the window or wake the display, then retry.",
			gap,
		);
	}
	return undefined;
}
