/* eslint-disable */
// Shared execute_luau machinery for edit/server (MetadataHandlers.executeLuau),
// the play-client peer (ClientBroker) and the runtime eval bridges
// (EvalRuntimeHandlers). Things this module owns:
//
//   1. The IIFE wrapper that captures print/warn, wraps require() so nested
//      ModuleScript load failures can recover the real LogService diagnostic,
//      runs user code in xpcall, and always returns one wrapper table so the
//      ModuleScript itself always returns exactly one value.
//
//   2. Value encoding. Every returned value (table.pack, so trailing nils
//      count) is encoded inside the executing VM into plain JSON-safe data
//      before it crosses any BindableFunction/RemoteFunction boundary.
//
//   3. Traceback and compile-error remapping from wrapper-relative lines to
//      user-relative `user_code:N` lines.
//
//   4. The loadstring-then-ModuleScript-require fallback, with the parse-error
//      recovery hack that pulls the real diagnostic from LogService.
//
//   5. Optional ChangeHistoryService recording around edit-DataModel runs.

const LogService = game.GetService("LogService");
const ChangeHistoryService = game.GetService("ChangeHistoryService");

// Shape returned by the Luau wrapper. On success `values`/`valueTypes` hold
// one entry per returned value; on failure `value` holds the remapped error.
interface WrapperResult {
	ok?: boolean;
	value?: unknown;
	values?: unknown[];
	valueTypes?: string[];
	output?: string[];
}

type UndoStatus = "recorded" | "reverted" | "unavailable";

interface ExecuteResult {
	success: boolean;
	values?: unknown[];
	valueTypes?: string[];
	output?: string[];
	error?: string;
	message?: string;
	undo?: UndoStatus;
}

const PAYLOAD_INSTANCE_NAME = "__RobloxCliExecLuauPayload";
const REQUIRE_GENERIC_ERROR = "Requested module experienced an error while loading";
const UNDO_RECORDING_NAME = "roblox-cli eval";

// Count source lines so the wrapper can classify traceback frames against
// the user code range.
function countLines(s: string): number {
	let n = 1;
	const size = s.size();
	for (let i = 1; i <= size; i++) {
		if (string.sub(s, i, i) === "\n") n++;
	}
	return n;
}

function luaPatternEscape(s: string): string {
	const [escaped] = string.gsub(s, "([^%w])", "%%%1");
	return escaped;
}

// Everything the wrapper emits BEFORE the first line of user code. Its line
// count is independent of the interpolated numbers, so WRAPPER_LINE_OFFSET is
// derived from it instead of being maintained by hand.
function wrapperPrefix(lineOffset: number, userLines: number): string {
	return `return ((function()
	local __studio_agent_LINE_OFFSET = ${lineOffset}
	local __studio_agent_USER_LINES = ${userLines}
	local __studio_agent_LogService = game:GetService("LogService")
	local __studio_agent_REQUIRE_GENERIC = "${REQUIRE_GENERIC_ERROR}"
	local __studio_agent_output = {}
	local __studio_agent_real_print = print
	local __studio_agent_real_warn = warn
	local __studio_agent_real_require = require
	local print = function(...)
		__studio_agent_real_print(...)
		local args = table.pack(...)
		local parts = table.create(args.n)
		for i = 1, args.n do parts[i] = tostring(args[i]) end
		table.insert(__studio_agent_output, table.concat(parts, "\\t"))
	end
	local warn = function(...)
		__studio_agent_real_warn(...)
		local args = table.pack(...)
		local parts = table.create(args.n)
		for i = 1, args.n do parts[i] = tostring(args[i]) end
		table.insert(__studio_agent_output, "[warn] " .. table.concat(parts, "\\t"))
	end
	local function __studio_agent_is_stack_noise(msg)
		return msg == "Stack Begin" or msg == "Stack End" or string.sub(msg, 1, 8) == "Script '"
	end
	local function __studio_agent_is_actionable_require_log(entry)
		if not entry or entry.messageType ~= Enum.MessageType.MessageError then return false end
		local msg = tostring(entry.message)
		return msg ~= __studio_agent_REQUIRE_GENERIC and not __studio_agent_is_stack_noise(msg)
	end
	local function __studio_agent_entry_mentions_module(entry, module_path)
		if not entry or not module_path or module_path == "" then return false end
		return string.find(tostring(entry.message), module_path, 1, true) ~= nil
	end
	local function __studio_agent_prior_module_error(hist, module_path)
		if not module_path or module_path == "" then return nil end
		for i = #hist, 1, -1 do
			local entry = hist[i]
			if __studio_agent_entry_mentions_module(entry, module_path) then
				if __studio_agent_is_actionable_require_log(entry) then
					return tostring(entry.message)
				end
				for j = i - 1, math.max(1, i - 6), -1 do
					local previous = hist[j]
					if __studio_agent_is_actionable_require_log(previous) then
						return tostring(previous.message)
					end
				end
			end
		end
		return nil
	end
	local function __studio_agent_recover_require_error(err, history_start, module)
		local err_msg = tostring(err)
		if err_msg ~= __studio_agent_REQUIRE_GENERIC then return err_msg end
		local module_path
		if typeof(module) == "Instance" then
			local ok_path, path = pcall(function()
				return module:GetFullName()
			end)
			if ok_path then module_path = path end
		end
		task.wait(0.05)
		local hist = __studio_agent_LogService:GetLogHistory()
		for i = #hist, history_start + 1, -1 do
			local entry = hist[i]
			if __studio_agent_is_actionable_require_log(entry) then
				return tostring(entry.message)
			end
		end
		local prior = __studio_agent_prior_module_error(hist, module_path)
		if prior then return prior end
		return err_msg
	end
	local function require(module)
		local history_start = #__studio_agent_LogService:GetLogHistory()
		local ok, value = pcall(__studio_agent_real_require, module)
		if ok then return value end
		error(__studio_agent_recover_require_error(value, history_start, module), 0)
	end
	local function __studio_agent_run()
`;
}

// Number of wrapper lines before the first line of user code; payload line
// P is user line P - WRAPPER_LINE_OFFSET.
const WRAPPER_LINE_OFFSET = countLines(wrapperPrefix(0, 1)) - 1;

// Value encoding, evaluated inside the executing VM. Encodes packed[first..n]
// and returns (values, valueTypes), both with exactly one entry per value.
// Roblox JSONEncode and Bindable/Remote serialization cannot carry nil array
// holes, so a top-level nil is sent as {"$type":"nil"} (its valueTypes entry
// is "nil"); nested nils cannot occur because table values are never nil.
// A string-keyed table that has its own "$type" key uses the entries form so
// user data cannot be mistaken for a marker.
const ENCODER_SOURCE = `	local function __studio_agent_encode_values(packed, first)
		local MAX_DEPTH = 10
		local MAX_NODES = 2000
		local nodes = 0
		local path = {}
		local function size_marker()
			return { ["$type"] = "truncated", reason = "size" }
		end
		local function num(x)
			if x ~= x then return { ["$type"] = "number", value = "nan" } end
			if x == math.huge then return { ["$type"] = "number", value = "inf" } end
			if x == -math.huge then return { ["$type"] = "number", value = "-inf" } end
			return x
		end
		local function udim(u)
			return { scale = num(u.Scale), offset = u.Offset }
		end
		local encode
		local function encode_table(t, depth)
			if path[t] then return { ["$type"] = "cycle" }, false end
			if depth > MAX_DEPTH then return { ["$type"] = "truncated", reason = "depth" }, false end
			local count, max_index = 0, 0
			local all_strings, all_indices = true, true
			for k in next, t do
				count += 1
				if type(k) ~= "string" or k == "$type" then all_strings = false end
				if type(k) == "number" and k >= 1 and k % 1 == 0 then
					if k > max_index then max_index = k end
				else
					all_indices = false
				end
			end
			if count == 0 then return {}, false end
			path[t] = true
			local out, stop = {}, false
			if all_indices and max_index == count then
				for i = 1, count do
					out[i], stop = encode(rawget(t, i), depth + 1)
					if stop then break end
				end
			elseif all_strings then
				for k, v in next, t do
					out[k], stop = encode(v, depth + 1)
					if stop then break end
				end
			else
				local entries = {}
				for k, v in next, t do
					local ek, ev
					ek, stop = encode(k, depth + 1)
					if stop then
						ev = size_marker()
					else
						ev, stop = encode(v, depth + 1)
					end
					table.insert(entries, { ek, ev })
					if stop then break end
				end
				out = { ["$type"] = "table", entries = entries }
			end
			path[t] = nil
			return out, stop
		end
		encode = function(v, depth)
			nodes += 1
			if nodes > MAX_NODES then return size_marker(), true end
			local t = typeof(v)
			if t == "boolean" or t == "string" then return v, false end
			if t == "number" then return num(v), false end
			if t == "table" then return encode_table(v, depth) end
			if t == "Instance" then
				return { ["$type"] = "Instance", class = v.ClassName, name = v.Name, path = v:GetFullName() }, false
			end
			if t == "Vector3" then return { ["$type"] = "Vector3", x = num(v.X), y = num(v.Y), z = num(v.Z) }, false end
			if t == "Vector2" then return { ["$type"] = "Vector2", x = num(v.X), y = num(v.Y) }, false end
			if t == "CFrame" then
				local c = table.pack(v:GetComponents())
				local components = table.create(12)
				for i = 1, 12 do components[i] = num(c[i]) end
				return { ["$type"] = "CFrame", position = { num(c[1]), num(c[2]), num(c[3]) }, components = components }, false
			end
			if t == "Color3" then
				return { ["$type"] = "Color3", r = num(v.R), g = num(v.G), b = num(v.B), hex = v:ToHex() }, false
			end
			if t == "UDim" then return { ["$type"] = "UDim", scale = num(v.Scale), offset = v.Offset }, false end
			if t == "UDim2" then return { ["$type"] = "UDim2", x = udim(v.X), y = udim(v.Y) }, false end
			if t == "EnumItem" then
				return { ["$type"] = "EnumItem", enum = tostring(v.EnumType), name = v.Name, value = v.Value }, false
			end
			if t == "BrickColor" then return { ["$type"] = "BrickColor", name = v.Name, number = v.Number }, false end
			local ok_s, s = pcall(tostring, v)
			return { ["$type"] = t, tostring = ok_s and s or "<tostring failed>" }, false
		end
		local values, types = {}, {}
		for i = first, packed.n do
			local v = packed[i]
			local index = i - first + 1
			types[index] = typeof(v)
			if v == nil then
				values[index] = { ["$type"] = "nil" }
			else
				local ok_enc, encoded = pcall(encode, v, 1)
				if ok_enc then
					values[index] = encoded
				else
					path = {}
					local ok_s, s = pcall(tostring, v)
					values[index] = { ["$type"] = typeof(v), tostring = ok_s and s or "<tostring failed>" }
				end
			end
		end
		return values, types
	end
`;

// Traceback frame format this relies on (Luau debug.traceback): one frame per
// line, innermost first, each `<chunk>:<line> function <name>` for named
// functions or `<chunk>:<line>` for anonymous/top-level code. Our payload's
// chunk is `<Parent path>.<payload name>` when run as a ModuleScript and
// `[string "<first source line>..."]` when run via loadstring. Payload frames
// are classified by line: inside the user range they are user frames; in the
// prefix (require/print helpers, the traceback handler) they are dropped; the
// first frame in the postamble is the xpcall call site, where the user's stack
// ends, so it and everything outside it (plus any non-payload frame between it
// and the last user frame, e.g. xpcall itself) are dropped.
function buildWrapper(code: string, payloadInstanceName = PAYLOAD_INSTANCE_NAME): string {
	const payloadPattern = luaPatternEscape(payloadInstanceName);
	return `${wrapperPrefix(WRAPPER_LINE_OFFSET, countLines(code))}${code}
	end
	local function __studio_agent_frame_line(s)
		local num = string.match(s, "${payloadPattern}:(%d+)") or string.match(s, '%[string "[^"]*"%]:(%d+)')
		return num and tonumber(num)
	end
	local function __studio_agent_user_line(payload_n)
		local user_n = payload_n - __studio_agent_LINE_OFFSET
		if user_n < 1 then return "1" end
		if user_n > __studio_agent_USER_LINES then return tostring(__studio_agent_USER_LINES) .. " (at end of input)" end
		return tostring(user_n)
	end
	local function __studio_agent_remap(s)
		local function to_user(num)
			return "user_code:" .. __studio_agent_user_line(tonumber(num))
		end
		s = string.gsub(s, "[%w_%.]*${payloadPattern}:(%d+)", to_user)
		s = string.gsub(s, '%[string "[^"]*"%]:(%d+)', to_user)
		return s
	end
	local function __studio_agent_traceback(err)
		local user_end = __studio_agent_LINE_OFFSET + __studio_agent_USER_LINES
		local frames = {}
		local last_user = 0
		for line in string.gmatch(debug.traceback("", 2), "[^\\n]+") do
			local n = __studio_agent_frame_line(line)
			if n and n > user_end then break end
			if not n or n > __studio_agent_LINE_OFFSET then
				table.insert(frames, line)
				if n then last_user = #frames end
			end
		end
		local kept = { __studio_agent_remap(tostring(err)) }
		for i = 1, last_user do
			local frame = string.gsub(frames[i], " function __studio_agent_run$", "")
			table.insert(kept, __studio_agent_remap(frame))
		end
		return table.concat(kept, "\\n")
	end
${ENCODER_SOURCE}	local __studio_agent_packed = table.pack(xpcall(__studio_agent_run, __studio_agent_traceback))
	if not __studio_agent_packed[1] then
		return { ok = false, value = __studio_agent_packed[2], output = __studio_agent_output }
	end
	local __studio_agent_values, __studio_agent_types = __studio_agent_encode_values(__studio_agent_packed, 2)
	return { ok = true, values = __studio_agent_values, valueTypes = __studio_agent_types, output = __studio_agent_output }
end)())`;
}

// TS-side mirror of the Luau __studio_agent_remap, for compile errors that
// never pass through the wrapper (loadstring's compile error, or the
// ModuleScript diagnostic recovered from LogService). Unclosed user constructs
// let the parser consume wrapper postamble, so the raw payload line can be
// past user EOF — clamp to [1, userLines] and annotate.
function remapPayloadLines(s: string, userLines: number, payloadInstanceName = PAYLOAD_INSTANCE_NAME): string {
	const toUser = (num: string): string => {
		const u = (tonumber(num) as number) - WRAPPER_LINE_OFFSET;
		if (u < 1) return "user_code:1";
		if (u > userLines) return `user_code:${tostring(userLines)} (at end of input)`;
		return `user_code:${tostring(u)}`;
	};
	const [a] = string.gsub(s, `[%w_%.]*${luaPatternEscape(payloadInstanceName)}:(%d+)`, toUser);
	const [b] = string.gsub(a, '%[string "[^"]*"%]:(%d+)', toUser);
	return b;
}

interface UndoRecording {
	id: string;
	settled: boolean;
}

function finishUndoRecording(recording: UndoRecording, commit: boolean): UndoStatus {
	if (recording.settled) return "unavailable";
	recording.settled = true;
	const [finished] = pcall(() =>
		ChangeHistoryService.FinishRecording(
			recording.id,
			commit ? Enum.FinishRecordingOperation.Commit : Enum.FinishRecordingOperation.Cancel,
		),
	);
	if (!finished) return "unavailable";
	return commit ? "recorded" : "reverted";
}

// Begins a recording owned by the calling thread. If that thread is killed
// before it finishes the recording (the transport task.cancel()s handlers
// that outlive their deadline), the watcher cancels the recording so Studio's
// undo system is not left with a dangling recording and partial edits revert.
function beginUndoRecording(): UndoRecording | undefined {
	const [began, id] = pcall(() => ChangeHistoryService.TryBeginRecording(UNDO_RECORDING_NAME));
	if (!began || id === undefined) return undefined;
	const recording: UndoRecording = { id, settled: false };
	const owner = coroutine.running();
	task.spawn(() => {
		while (!recording.settled) {
			task.wait(0.25);
			if (!recording.settled && coroutine.status(owner) === "dead") finishUndoRecording(recording, false);
		}
	});
	return recording;
}

// The payload ModuleScript is parented before `run` and destroyed after it,
// so when `run` records undo history the payload is never part of it.
function runViaModuleScript(wrapped: string, userLines: number, run: (invoke: () => unknown) => WrapperResult): WrapperResult {
	const m = new Instance("ModuleScript");
	m.Name = PAYLOAD_INSTANCE_NAME;
	const [okSet, setErr] = pcall(() => {
		(m as unknown as { Source: string }).Source = wrapped;
	});
	if (!okSet) {
		m.Destroy();
		// error(..., 0) suppresses the generated plugin module path that error()
		// would otherwise prepend, keeping the visible
		// message focused on the user-actionable error rather than our path.
		error(`ModuleScript Source set failed: ${tostring(setErr)}`, 0);
	}
	m.Parent = game.GetService("Workspace");
	const [okReq, reqResult] = pcall(() => run(() => require(m)));
	m.Destroy();
	if (!okReq) {
		// Compile errors reference the payload module's line number directly
		// — remap + clamp to user-relative line numbers so `local x = 1 +`
		// reports :1: instead of the payload line, and reports the clamp
		// annotation when the parser ran off the end of user code.
		error(recoverPayloadRequireError(reqResult, userLines, PAYLOAD_INSTANCE_NAME), 0);
	}
	return reqResult;
}

function isLoadstringUnavailable(err: unknown): boolean {
	const errStr = tostring(err);
	const [matchStart] = string.find(errStr, "not available", 1, true);
	return matchStart !== undefined;
}

function recoverPayloadRequireError(
	err: unknown,
	userLines: number,
	payloadInstanceName = PAYLOAD_INSTANCE_NAME,
	historyStart = 0,
): string {
	let errMsg = tostring(err);
	// pcall(require, m) collapses parse/compile failures into the canned
	// engine string. The real diagnostic is emitted to LogService on the
	// next engine frame — give it ~50ms to land then scan backward.
	if (errMsg === REQUIRE_GENERIC_ERROR) {
		task.wait(0.05);
		const payloadPathPrefix = `Workspace.${payloadInstanceName}:`;
		const hist = LogService.GetLogHistory();
		const start = math.max(0, historyStart);
		for (let i = hist.size() - 1; i >= start; i--) {
			const e = hist[i];
			if (
				e.messageType === Enum.MessageType.MessageError &&
				string.sub(e.message, 1, payloadPathPrefix.size()) === payloadPathPrefix
			) {
				errMsg = e.message;
				break;
			}
		}
	}
	return remapPayloadLines(errMsg, userLines, payloadInstanceName);
}

// recordUndo (edit DataModel only) wraps the user code in a ChangeHistoryService
// recording: committed when the code succeeds, cancelled (reverting its edits)
// when it fails. `undo` is reported whenever the user code started.
function execute(code: string, recordUndo = false): ExecuteResult {
	if (!code || code === "") {
		return { success: false, error: "code is required" };
	}
	const wrapped = buildWrapper(code);
	const userLines = countLines(code);

	let started = false;
	let undo: UndoStatus | undefined;
	const run = (invoke: () => unknown): WrapperResult => {
		started = true;
		const recording = recordUndo ? beginUndoRecording() : undefined;
		if (recordUndo) undo = "unavailable";
		const [ok, value] = pcall(invoke);
		if (recording) {
			undo = finishUndoRecording(recording, ok && typeIs(value, "table") && (value as WrapperResult).ok === true);
		}
		if (!ok) error(value, 0);
		return value as WrapperResult;
	};

	let [success, result] = pcall(() => {
		const [fn, compileError] = loadstring(wrapped);
		if (!fn) {
			if (isLoadstringUnavailable(compileError)) {
				return runViaModuleScript(wrapped, userLines, run);
			}
			error(`Compile error: ${remapPayloadLines(tostring(compileError), userLines)}`, 0);
		}
		return run(fn);
	});

	// loadstring can throw (not return nil) when ServerScriptService.
	// LoadStringEnabled is false; treat that as a second-chance fallback.
	if (!success && !started && isLoadstringUnavailable(result)) {
		[success, result] = pcall(() => runViaModuleScript(wrapped, userLines, run));
	}

	if (!success) {
		return {
			success: false,
			error: tostring(result),
			output: [],
			message: "Code execution failed",
			undo,
		};
	}

	const r = result as WrapperResult;
	const output = r.output ?? [];
	if (r.ok === true) {
		return {
			success: true,
			values: r.values ?? [],
			valueTypes: r.valueTypes ?? [],
			output,
			message: "Code executed successfully",
			undo,
		};
	}
	return {
		success: false,
		error: r.value !== undefined ? tostring(r.value) : "(unknown error)",
		output,
		message: "Code execution failed",
		undo,
	};
}

export = {
	buildWrapper,
	countLines,
	execute,
	recoverPayloadRequireError,
};
