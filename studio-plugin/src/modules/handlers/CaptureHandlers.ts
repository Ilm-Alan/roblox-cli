import { RunService } from "@rbxts/services";
import * as RenderMonitor from "../RenderMonitor";
import MetadataHandlers from "./MetadataHandlers";

const CaptureService = game.GetService("CaptureService");
const AssetService = game.GetService("AssetService");

const MAX_TILE_SIZE = 1024;
const MAX_RAW_PIXEL_BYTES = 36 * 1024 * 1024;
const MAX_CREATED_IMAGE_DIM = 2048;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_BYTE = string.byte("=")[0];
// The runtime-health probe samples PROBE_GRID x PROBE_GRID pixels instead of
// reading the whole frame.
const PROBE_GRID = 4;

// Studio 714+ exposes a plugin-only capture path that returns the rendered
// Studio view directly. Keep the local shape here so this package remains
// buildable with older @rbxts type definitions; the runtime capability is
// discovered with pcall below and the existing CaptureService path remains the
// compatibility fallback. Members are declared with method syntax so roblox-ts
// emits `:` calls; a property-typed function compiles to a `.` call, which
// Luau rejects for these engine methods ("Expected ':' not '.'").
type StudioScreenshotCaptureLike = {
	BufferFormat: unknown;
	BufferStatus: unknown;
	Resolution: Vector2;
	GetBuffer(): buffer;
	GetErrors(): defined[];
};

type StudioCaptureServiceLike = {
	CanCaptureScreenshot(): boolean;
	CaptureScreenshot(options: Record<string, unknown>): StudioScreenshotCaptureLike;
	RequestScreenshotPermissionAsync(): boolean;
};

const B64: number[] = [];
for (let i = 0; i < 64; i++) {
	B64[i] = string.byte(BASE64_CHARS, i + 1)[0];
}

function encodeBase64(buf: buffer): string {
	const len = buffer.len(buf);
	const fullTriples = math.floor(len / 3);
	const remaining = len - fullTriples * 3;
	const outLen = (fullTriples + (remaining > 0 ? 1 : 0)) * 4;
	const out = buffer.create(outLen);

	let si = 0;
	let di = 0;

	for (let t = 0; t < fullTriples; t++) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		const b2 = buffer.readu8(buf, si + 2);

		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))]);
		buffer.writeu8(out, di + 3, B64[bit32.band(b2, 63)]);

		si += 3;
		di += 4;
	}

	if (remaining === 2) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.lshift(bit32.band(b1, 15), 2)]);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	} else if (remaining === 1) {
		const b0 = buffer.readu8(buf, si);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.lshift(bit32.band(b0, 3), 4)]);
		buffer.writeu8(out, di + 2, PAD_BYTE);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	}

	return buffer.tostring(out);
}

function studioCaptureError(capture: StudioScreenshotCaptureLike): string {
	const errors = capture.GetErrors();
	if (errors.size() > 0) {
		return (errors as defined[]).map((item) => tostring(item)).join("; ");
	}
	return `StudioCaptureService returned buffer status ${tostring(capture.BufferStatus)}.`;
}

// Preferred edit-side capture. Unlike the older experience CaptureService
// bridge, this API reads the actual Studio viewport buffer and does not create
// an rbxtemp:// texture that can degrade into a solid-magenta placeholder.
function captureStudioScreenshotData(): unknown {
	if (!RunService.IsEdit()) {
		return { error: "StudioCaptureService is only available in the edit peer." };
	}

	const [serviceOk, serviceResult] = pcall(() => {
		const gameWithUnknownServices = game as unknown as { GetService(name: string): Instance };
		return gameWithUnknownServices.GetService("StudioCaptureService") as unknown as StudioCaptureServiceLike;
	});
	if (!serviceOk) {
		return { error: `StudioCaptureService is unavailable: ${tostring(serviceResult)}` };
	}
	const service = serviceResult as StudioCaptureServiceLike;

	const [canCaptureOk, canCaptureResult] = pcall(() => service.CanCaptureScreenshot());
	if (!canCaptureOk) {
		return { error: `StudioCaptureService permission check failed: ${tostring(canCaptureResult)}` };
	}
	if (canCaptureResult !== true) {
		const [permissionOk, permissionResult] = pcall(() => service.RequestScreenshotPermissionAsync());
		if (!permissionOk || permissionResult !== true) {
			return {
				error:
					"StudioCaptureService screenshot permission is unavailable. " +
					"Allow Studio screenshot capture, then retry.",
			};
		}
	}

	const [captureOk, captureResult] = pcall(() => service.CaptureScreenshot({}));
	if (!captureOk) {
		return { error: `StudioCaptureService capture failed: ${tostring(captureResult)}` };
	}
	const capture = captureResult as StudioScreenshotCaptureLike;
	const deadline = tick() + 5;
	while (tostring(capture.BufferStatus) === "Enum.StudioCaptureBufferStatus.NotStarted" ||
		tostring(capture.BufferStatus) === "Enum.StudioCaptureBufferStatus.Pending") {
		if (tick() >= deadline) {
			return { error: "StudioCaptureService capture timed out while waiting for its buffer." };
		}
		task.wait(0.05);
	}
	if (tostring(capture.BufferStatus) !== "Enum.StudioCaptureBufferStatus.Ready") {
		return { error: studioCaptureError(capture) };
	}
	if (tostring(capture.BufferFormat) !== "Enum.StudioCaptureScreenshotFormat.RGBA8") {
		return {
			error: `StudioCaptureService returned unsupported buffer format ${tostring(capture.BufferFormat)}; expected RGBA8.`,
		};
	}

	const resolution = capture.Resolution;
	const nativeWidth = math.floor(resolution.X);
	const nativeHeight = math.floor(resolution.Y);
	const [bufferOk, bufferResult] = pcall(() => capture.GetBuffer());
	if (!bufferOk) {
		return { error: `StudioCaptureService buffer read failed: ${tostring(bufferResult)}` };
	}
	const nativePixels = bufferResult as buffer;
	if (nativeWidth <= 0 || nativeHeight <= 0 || buffer.len(nativePixels) < nativeWidth * nativeHeight * 4) {
		return {
			error: `StudioCaptureService returned an invalid ${nativeWidth}x${nativeHeight} RGBA8 buffer (${buffer.len(nativePixels)} bytes).`,
		};
	}
	const [width, height] = cappedSize(nativeWidth, nativeHeight);
	const pixels = width === nativeWidth && height === nativeHeight
		? nativePixels
		: downscaleNearest(nativePixels, nativeWidth, nativeHeight, width, height);

	return {
		success: true,
		width,
		height,
		nativeWidth,
		nativeHeight,
		data: encodeBase64(pixels),
		solidMagenta: isSolidMagentaBuffer(pixels, width, height),
		captureSource: "StudioCaptureService",
	};
}

// Transfer budget shared by both capture paths: frames above
// MAX_RAW_PIXEL_BYTES are scaled down to fit it and MAX_CREATED_IMAGE_DIM.
function cappedSize(nativeW: number, nativeH: number): [number, number] {
	if (nativeW * nativeH * 4 <= MAX_RAW_PIXEL_BYTES) return [nativeW, nativeH];
	const scale = math.min(
		math.sqrt(MAX_RAW_PIXEL_BYTES / (nativeW * nativeH * 4)),
		MAX_CREATED_IMAGE_DIM / math.max(nativeW, nativeH),
	);
	return [math.max(1, math.floor(nativeW * scale)), math.max(1, math.floor(nativeH * scale))];
}

// Nearest-neighbour RGBA8 resample. The Studio buffer can exceed the size an
// EditableImage accepts, so this path resamples the buffer directly.
function downscaleNearest(src: buffer, srcW: number, srcH: number, w: number, h: number): buffer {
	const out = buffer.create(w * h * 4);
	const columnOffsets: number[] = [];
	for (let x = 0; x < w; x++) {
		columnOffsets[x] = math.floor(((x + 0.5) * srcW) / w) * 4;
	}
	for (let y = 0; y < h; y++) {
		const srcRow = math.floor(((y + 0.5) * srcH) / h) * srcW * 4;
		const outRow = y * w * 4;
		for (let x = 0; x < w; x++) {
			buffer.writeu32(out, outRow + x * 4, buffer.readu32(src, srcRow + columnOffsets[x]));
		}
	}
	return out;
}

function readPixelsTiled(img: EditableImage, w: number, h: number): buffer {
	const BYTES_PER_PIXEL = 4;
	const fullBuf = buffer.create(w * h * BYTES_PER_PIXEL);
	const fullRowBytes = w * BYTES_PER_PIXEL;

	for (let ty = 0; ty < h; ty += MAX_TILE_SIZE) {
		const tileH = math.min(MAX_TILE_SIZE, h - ty);
		for (let tx = 0; tx < w; tx += MAX_TILE_SIZE) {
			const tileW = math.min(MAX_TILE_SIZE, w - tx);
			const tileBuf = img.ReadPixelsBuffer(new Vector2(tx, ty), new Vector2(tileW, tileH));
			const tileRowBytes = tileW * BYTES_PER_PIXEL;
			for (let row = 0; row < tileH; row++) {
				buffer.copy(fullBuf, (ty + row) * fullRowBytes + tx * BYTES_PER_PIXEL, tileBuf, row * tileRowBytes, tileRowBytes);
			}
		}
	}
	return fullBuf;
}

// Triggers CaptureService:CaptureScreenshot and waits for the temporary
// content id. Works in any DM, including the play CLIENT (where reading the
// pixels back is blocked, but capturing is not). The returned rbxtemp:// id is
// a process-scoped handle: it can be dereferenced from a DIFFERENT, more
// privileged DM (the edit DM) — see captureRead.
function doCaptureScreenshot(timeoutSeconds = 10): { contentId: string } | { error: string } {
	// CaptureScreenshot can return a successful-looking placeholder when the
	// request races the renderer. Cross one real frame before asking Roblox for
	// pixels; the Node side also retries suspicious frames below the transport.
	RenderMonitor.waitForRenderedFrame(math.min(timeoutSeconds, 2));

	// Fast-fail with a clear reason if the window isn't rendering — otherwise
	// CaptureScreenshot's callback never fires and we'd block for the full 10s.
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined) return { error: notRendering };

	let contentId: string | undefined;

	const [captureOk, captureError] = pcall(() => CaptureService.CaptureScreenshot((id: string) => {
		contentId = id;
	}));
	if (!captureOk) return { error: `CaptureService:CaptureScreenshot failed: ${tostring(captureError)}` };

	const startTime = tick();
	while (contentId === undefined) {
		if (tick() - startTime > timeoutSeconds) {
			return {
				error: "Screenshot capture timed out (CaptureScreenshot callback never fired). The Studio window is likely minimized or the display is asleep — restore the window or wake the display so the viewport renders. (Known Roblox bug: capture can also fail if the viewport renders a solid color.)",
			};
		}
		task.wait(0.1);
	}

	return { contentId };
}

function isSolidMagentaBuffer(pixelBuffer: buffer, width: number, height: number): boolean {
	const expectedBytes = width * height * 4;
	if (width <= 0 || height <= 0 || expectedBytes <= 0 || buffer.len(pixelBuffer) < expectedBytes) return false;
	for (let offset = 0; offset < expectedBytes; offset += 4) {
		if (
			buffer.readu8(pixelBuffer, offset) !== 255 ||
			buffer.readu8(pixelBuffer, offset + 1) !== 0 ||
			buffer.readu8(pixelBuffer, offset + 2) !== 255 ||
			buffer.readu8(pixelBuffer, offset + 3) !== 255
		) {
			return false;
		}
	}
	return true;
}

function loadCapturedImage(contentId: string): EditableImage | string {
	const [editableOk, editableResult] = pcall(() => {
		return AssetService.CreateEditableImageAsync(Content.fromUri(contentId));
	});
	if (!editableOk) {
		return `Failed to create EditableImage from screenshot. Enable EditableImage API: Game Settings > Security > 'Allow Mesh / Image APIs'. (${tostring(editableResult)})`;
	}
	return editableResult;
}

// Promotes a CaptureScreenshot content id into an EditableImage and reads its
// RGBA pixels. MUST run in the edit/plugin context: the running game VM lacks
// the privilege to create an EditableImage from a temporary texture id (errors
// "cannot currently create editable image from temporary texture id"), while
// the edit DM can — even for an id captured in the play client DM.
function readContentToBase64(contentId: string): unknown {
	const loaded = loadCapturedImage(contentId);
	if (typeIs(loaded, "string")) return { error: loaded };

	let sourceImage = loaded;
	const imgSize = sourceImage.Size;
	const nativeW = math.floor(imgSize.X);
	const nativeH = math.floor(imgSize.Y);
	const [w, h] = cappedSize(nativeW, nativeH);

	if (w !== nativeW || h !== nativeH) {
		const [scaleOk, scaledResult] = pcall(() => {
			const target = AssetService.CreateEditableImage({ Size: new Vector2(w, h) });
			target.DrawImageTransformed(new Vector2(0, 0), new Vector2(w / nativeW, h / nativeH), 0, sourceImage, {
				CombineType: Enum.ImageCombineType.AlphaBlend,
				SamplingMode: Enum.ResamplerMode.Default,
				PivotPoint: new Vector2(0, 0),
			});
			return target;
		});
		sourceImage.Destroy();
		if (!scaleOk) {
			return {
				error: `Screenshot is ${nativeW}x${nativeH} (too large to transfer raw) and downscaling failed: ${tostring(scaledResult)}`,
			};
		}
		sourceImage = scaledResult as EditableImage;
	}

	const [readOk, pixelBuffer] = pcall(() => {
		return readPixelsTiled(sourceImage, w, h);
	});

	sourceImage.Destroy();

	if (!readOk) {
		return { error: `Failed to read pixel data: ${tostring(pixelBuffer)}` };
	}

	const solidMagenta = isSolidMagentaBuffer(pixelBuffer as buffer, w, h);
	const base64Data = encodeBase64(pixelBuffer as buffer);

	return {
		success: true,
		width: w,
		height: h,
		data: base64Data,
		nativeWidth: nativeW,
		nativeHeight: nativeH,
		solidMagenta,
	};
}

// Edit-mode single shot: capture and read back in the same (edit) context.
function captureScreenshotData(): unknown {
	const cap = doCaptureScreenshot();
	if ("error" in cap) return cap;
	return readContentToBase64(cap.contentId);
}

function captureScreenshot(): unknown {
	return captureScreenshotData();
}

function captureStudioScreenshot(): unknown {
	return captureStudioScreenshotData();
}

// Play-mode step 1 (run on the CLIENT): capture only, return the temp id. A
// successful capture ends any camera hold left by focus-viewport.
function captureBegin(): unknown {
	const result = doCaptureScreenshot();
	if (!("error" in result)) MetadataHandlers.cameraCaptureCompleted();
	return result;
}

// Play-mode step 2 (run on EDIT): read pixels from a temp id captured elsewhere.
function captureRead(requestData: Record<string, unknown>): unknown {
	const contentId = requestData.contentId as string | undefined;
	if (!contentId) return { error: "contentId is required" };
	return readContentToBase64(contentId);
}

// Status probing intentionally returns only a summary. In edit mode it samples
// a grid of pixels so a solid-magenta placeholder is reported as an unusable
// capture without reading or encoding the whole frame. Runtime client VMs can
// prove that CaptureService produced a content id, but Roblox does not allow
// them to promote that id to pixels; the edit-side capture-read remains the
// authoritative pixel check.
function probeCapture(): unknown {
	if (RunService.IsServer()) {
		return {
			success: true,
			serviceAvailable: true,
			probeRequested: false,
			pixelProbe: "not_applicable_to_server_peer",
		};
	}

	const cap = doCaptureScreenshot(1.5);
	if ("error" in cap) {
		return {
			success: false,
			probeRequested: true,
			serviceAvailable: true,
			callbackFired: false,
			usable: false,
			error: cap.error,
		};
	}

	if (!RunService.IsEdit()) {
		return {
			success: true,
			probeRequested: true,
			serviceAvailable: true,
			callbackFired: true,
			pixelsReadable: false,
			usable: true,
			pixelProbe: "deferred_to_edit_peer",
		};
	}

	const loaded = loadCapturedImage(cap.contentId);
	if (typeIs(loaded, "string")) {
		return {
			success: false,
			probeRequested: true,
			serviceAvailable: true,
			callbackFired: true,
			pixelsReadable: false,
			usable: false,
			error: loaded,
		};
	}
	const width = math.floor(loaded.Size.X);
	const height = math.floor(loaded.Size.Y);
	const [sampleOk, sampleResult] = pcall(() => {
		for (let gy = 0; gy < PROBE_GRID; gy++) {
			for (let gx = 0; gx < PROBE_GRID; gx++) {
				const position = new Vector2(
					math.floor(((gx + 0.5) * width) / PROBE_GRID),
					math.floor(((gy + 0.5) * height) / PROBE_GRID),
				);
				if (!isSolidMagentaBuffer(loaded.ReadPixelsBuffer(position, new Vector2(1, 1)), 1, 1)) return false;
			}
		}
		return true;
	});
	loaded.Destroy();
	if (!sampleOk) {
		return {
			success: false,
			probeRequested: true,
			serviceAvailable: true,
			callbackFired: true,
			pixelsReadable: false,
			usable: false,
			error: `Failed to sample capture pixels: ${tostring(sampleResult)}`,
		};
	}
	return {
		success: true,
		probeRequested: true,
		serviceAvailable: true,
		callbackFired: true,
		pixelsReadable: true,
		usable: sampleResult !== true,
		solidMagenta: sampleResult === true,
		width,
		height,
	};
}

export = {
	captureScreenshotData,
	captureScreenshot,
	captureStudioScreenshot,
	captureBegin,
	captureRead,
	probeCapture,
};
