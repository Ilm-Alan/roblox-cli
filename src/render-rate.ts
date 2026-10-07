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

/** Below this Studio has, for practical purposes, stopped rendering. */
export const STALLED_FPS = 1;

/**
 * The plain warning for a view that stopped rendering. A sleeping display or a
 * minimized window stops Studio's render loop (not just throttles it), and
 * anything waiting on a frame (screenshots, recordings, render-driven game
 * code such as a camera tween) stops with it.
 */
export const RENDER_STALLED_WARNING = 'Studio is not rendering (display asleep or window minimized); steps that wait on rendering will stall.';

export interface RenderSample {
  role: string;
  frames: number;
  /** Plugin clock (`tick()`) seconds when the sample was read. */
  at: number;
  /** The plugin's RenderMonitor saw no frame within its stale threshold. */
  stalled: boolean;
  seconds_since_frame?: number;
}

export interface RenderReceipt {
  render_fps: number;
  /** Present (true) when the view stopped rendering during or by the end of the span. */
  render_stalled?: true;
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
    if (typeof frames === 'number' && typeof at === 'number' && Number.isFinite(frames) && Number.isFinite(at)) {
      const since = render.seconds_since_frame;
      return {
        role, frames, at,
        stalled: render.rendering === false || render.state === 'stale',
        ...(typeof since === 'number' && Number.isFinite(since) ? { seconds_since_frame: Math.round(since * 10) / 10 } : {}),
      };
    }
  }
  return undefined;
}

/**
 * `render_fps` over the span between two samples of the same DataModel, plus
 * a warning when it is below full rate. A view that had stopped rendering by
 * the end sample, or rendered under `STALLED_FPS` over the span, gets the
 * stalled warning instead of the background-throttle one: it is not slow, it
 * is not drawing at all. Undefined when the samples cannot be compared:
 * different DataModels, a restarted counter, or under a second apart.
 */
export function renderReceipt(start: RenderSample | undefined, end: RenderSample | undefined, foreground: boolean): RenderReceipt | undefined {
  if (!start || !end || start.role !== end.role) return undefined;
  const seconds = end.at - start.at;
  const frames = end.frames - start.frames;
  if (seconds < 1 || frames < 0) return undefined;
  const fps = Math.round(frames / seconds * 10) / 10;
  if (end.stalled || fps < STALLED_FPS) return { render_fps: fps, render_stalled: true, warning: RENDER_STALLED_WARNING };
  if (fps >= FULL_RATE_FPS) return { render_fps: fps };
  const rounded = Math.round(fps);
  return {
    render_fps: fps,
    warning: foreground
      ? `Studio rendered at ~${rounded} fps even as the frontmost window; a minimized window, a sleeping display or a heavy scene slows it.`
      : `Studio renders at ~${rounded} fps while it is not the frontmost window; pass --foreground for a full-rate video.`,
  };
}
