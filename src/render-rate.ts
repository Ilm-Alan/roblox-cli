/**
 * The rate Studio actually rendered at during a run, measured by the plugin's
 * RenderMonitor in the visible DataModel: frames counted between two samples
 * divided by the plugin clock between them. Studio throttles rendering to
 * about 15 fps when it is not the frontmost app, so a video of a background
 * run has that many distinct frames however fast the recorder samples; the
 * receipt says so instead of letting the video look like a capture bug.
 */

/** Below this a video visibly stutters; the receipt warns. */
export const FULL_RATE_FPS = 25;

export interface RenderSample {
  role: string;
  frames: number;
  /** Plugin clock (`tick()`) seconds when the sample was read. */
  at: number;
}

export interface RenderReceipt {
  render_fps: number;
  warning?: string;
  [key: string]: unknown;
}

/**
 * The visible DataModel's render counters from a public `runtime_health` map
 * (role -> health). The play client is the window a reviewer watches; with no
 * play client the edit view is.
 */
export function renderSample(runtimeHealth: unknown): RenderSample | undefined {
  if (!runtimeHealth || typeof runtimeHealth !== 'object' || Array.isArray(runtimeHealth)) return undefined;
  const peers = runtimeHealth as Record<string, unknown>;
  for (const role of ['client-1', 'edit']) {
    const render = (peers[role] as { render?: Record<string, unknown> } | undefined)?.render;
    if (render?.available !== true) continue;
    const frames = render.frame_count;
    const at = render.sampled_at;
    if (typeof frames === 'number' && typeof at === 'number' && Number.isFinite(frames) && Number.isFinite(at))
      return { role, frames, at };
  }
  return undefined;
}

/**
 * `render_fps` over the span between two samples of the same DataModel, plus
 * a warning when it is below full rate. Undefined when the samples cannot be
 * compared: different DataModels, a restarted counter, or under a second apart.
 */
export function renderReceipt(start: RenderSample | undefined, end: RenderSample | undefined, foreground: boolean): RenderReceipt | undefined {
  if (!start || !end || start.role !== end.role) return undefined;
  const seconds = end.at - start.at;
  const frames = end.frames - start.frames;
  if (seconds < 1 || frames < 0) return undefined;
  const fps = Math.round(frames / seconds * 10) / 10;
  if (fps >= FULL_RATE_FPS) return { render_fps: fps };
  const rounded = Math.round(fps);
  return {
    render_fps: fps,
    warning: foreground
      ? `Studio rendered at ~${rounded} fps even as the frontmost window; a minimized window, a sleeping display or a heavy scene slows it.`
      : `Studio renders at ~${rounded} fps while it is not the frontmost window; pass --foreground for a full-rate video.`,
  };
}
