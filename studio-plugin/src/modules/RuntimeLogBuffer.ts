// Bounded capture for one Peer VM's LogService callbacks.
// Powers get_runtime_logs without parenting state to the DataModel.
//
// A Studio process can host several Peer VMs, and its LogService callbacks are
// delivered in those VM contexts. The connector reads every Peer buffer in an Instance
// and merges them into that process's log stream. Multiplayer Group Instances
// remain isolated and are returned independently.


import { LogService, RunService } from "@rbxts/services";
import PeerRole from "./PeerRole";

type LogLevel = "OUT" | "WARN" | "ERR" | "INFO";

interface RuntimeLogEntry {
	seq: number;
	ts: number; // wall-clock seconds via DateTime, coherent across peers
	level: LogLevel;
	message: string;
	data?: Record<string, unknown>;
}

const MAX_BYTES = 1024 * 1024;
const HARD_ENTRY_CAP = 50_000;

// Retained entries are exactly seqs oldestSeq..nextSeq-1, keyed by seq, so
// evicting the oldest entry is O(1).
const entries = new Map<number, RuntimeLogEntry>();
let oldestSeq = 1;
let totalBytes = 0;
let totalDropped = 0;
let nextSeq = 1;
let installed = false;

function levelTag(t: Enum.MessageType): LogLevel {
	if (t === Enum.MessageType.MessageWarning) return "WARN";
	if (t === Enum.MessageType.MessageError) return "ERR";
	if (t === Enum.MessageType.MessageInfo) return "INFO";
	return "OUT";
}

function nowSec(): number {
	return DateTime.now().UnixTimestampMillis / 1000;
}

// Studio occasionally exposes binary-bearing Output messages through
// LogService (for example, plugin hydration diagnostics containing raw CSG
// data). HttpService:JSONEncode rejects those strings outright. Preserve all
// valid UTF-8 verbatim and make only malformed bytes JSON-safe and visible.
function escapeInvalidUtf8(msg: string): string {
	const [valid] = utf8.len(msg);
	// Roblox currently returns nil (not the false declared by @rbxts/types)
	// when it encounters a malformed sequence. A numeric result is the only
	// portable success discriminator across both representations.
	if (typeIs(valid, "number")) return msg;

	const parts: string[] = [];
	let cursor = 1;
	while (cursor <= msg.size()) {
		const [suffixValid, invalidPosition] = utf8.len(msg, cursor);
		if (typeIs(suffixValid, "number")) {
			parts.push(string.sub(msg, cursor));
			break;
		}
		if (!typeIs(invalidPosition, "number")) break;

		if (invalidPosition > cursor) {
			parts.push(string.sub(msg, cursor, invalidPosition - 1));
		}
		const [invalidByte] = string.byte(msg, invalidPosition);
		parts.push(string.format("\\x%02X", invalidByte));
		cursor = invalidPosition + 1;
	}
	return parts.join("");
}

function dropOldestUntilFits(incomingBytes: number): void {
	while (
		oldestSeq < nextSeq &&
		(totalBytes + incomingBytes > MAX_BYTES || nextSeq - oldestSeq >= HARD_ENTRY_CAP)
	) {
		const dropped = entries.get(oldestSeq)!;
		entries.delete(oldestSeq);
		oldestSeq += 1;
		totalBytes -= dropped.message.size();
		totalDropped += 1;
	}
}

function pushEntry(
	msg: string,
	t: Enum.MessageType,
	ts = nowSec(),
	data?: Record<string, unknown>,
): void {
	const safeMessage = escapeInvalidUtf8(msg);
	const bytes = safeMessage.size();
	dropOldestUntilFits(bytes);
	entries.set(nextSeq, {
		seq: nextSeq,
		ts,
		level: levelTag(t),
		message: safeMessage,
		data,
	});
	nextSeq += 1;
	totalBytes += bytes;
}

interface LogHistoryEntry {
	message: string;
	messageType: Enum.MessageType;
	timestamp: number;
}

function seedRuntimeHistory(): void {
	const [ok, history] = pcall(() => LogService.GetLogHistory() as LogHistoryEntry[]);
	if (!ok) return;
	const isEdit = PeerRole.detect() === "edit";
	// GetLogHistory timestamps and DateTime.now() share Unix time, while
	// os.clock() is elapsed time for this Studio process. Their difference is
	// therefore the process launch boundary. Edit-mode history is filtered to
	// that boundary so startup errors from this launch are recovered without
	// importing history left by an earlier Studio process.
	const processStartedAt = nowSec() - os.clock();

	for (const entry of history) {
		if (!typeIs(entry.message, "string")) continue;
		const timestamp = typeIs(entry.timestamp, "number") ? entry.timestamp : undefined;
		if (isEdit && (timestamp === undefined || timestamp < processStartedAt - 1)) continue;
		pushEntry(entry.message, entry.messageType, timestamp);
	}
}

function install(): void {
	if (installed) return;
	if (!RunService.IsStudio()) return;
	installed = true;
	// Every peer can emit startup logs before the plugin finishes loading.
	// Seed from per-DataModel LogHistory so get_runtime_logs can still see them;
	// edit history is bounded to the current Studio process above.
	seedRuntimeHistory();
	LogService.MessageOut.Connect((msg, t, context?: Record<string, unknown>) => {
		pushEntry(msg, t, undefined, context);
	});
}


interface QueryOptions {
	since?: number;
	tail?: number;
	filter?: string; // Plain substring match, applied to message
}

// oldestSeq is the oldest retained seq (nextSeq when empty). droppedSinceCursor
// counts evicted entries newer than `since` (all evictions without a cursor);
// omittedByTail counts matching entries skipped by `tail`.
interface QueryResult {
	entries: RuntimeLogEntry[];
	nextSince: number;
	totalDropped: number;
	oldestSeq: number;
	droppedSinceCursor: number;
	omittedByTail: number;
}

function query(opts: QueryOptions): QueryResult {
	const since = opts.since;
	const needle = opts.filter;
	const matched: RuntimeLogEntry[] = [];
	const first = since !== undefined ? math.max(oldestSeq, since + 1) : oldestSeq;
	for (let seq = first; seq < nextSeq; seq++) {
		const entry = entries.get(seq)!;
		// Plain substring search (4th arg = true). Pattern matching here was
		// surprising in practice - Lua magic chars in messages would silently
		// not match (e.g. filter="MARK-EDIT" against "MARK-EDIT-001" fails
		// because '-' means "0+" in Lua patterns). Substring search matches
		// most users' mental model of "filter messages containing this text".
		if (needle !== undefined && string.find(entry.message, needle, 1, true)[0] === undefined) continue;
		matched.push(entry);
	}

	let result = matched;
	let omittedByTail = 0;
	if (opts.tail !== undefined && matched.size() > opts.tail) {
		omittedByTail = matched.size() - opts.tail;
		result = [];
		for (let i = omittedByTail; i < matched.size(); i++) {
			result.push(matched[i]);
		}
	}

	return {
		entries: result,
		nextSince: nextSeq > oldestSeq ? nextSeq - 1 : (since ?? 0),
		totalDropped,
		oldestSeq,
		droppedSinceCursor: since !== undefined ? math.max(0, oldestSeq - since - 1) : totalDropped,
		omittedByTail,
	};
}

export = {
	install,
	query,
};
