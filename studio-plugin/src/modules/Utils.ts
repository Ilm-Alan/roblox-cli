const LUAU_KEYWORDS = new Set<string>([
	"and", "break", "continue", "do", "else", "elseif", "end", "export",
	"false", "for", "function", "if", "in", "local", "nil", "not", "or",
	"repeat", "return", "then", "true", "type", "until", "while",
]);

function isSimplePathSegment(segment: string): boolean {
	return segment.match("^[%a_][%w_]*$")[0] !== undefined && !LUAU_KEYWORDS.has(segment);
}

function quotePathSegment(segment: string): string {
	let escaped = segment.gsub("\\", "\\\\")[0];
	escaped = escaped.gsub("\n", "\\n")[0];
	escaped = escaped.gsub("\r", "\\r")[0];
	escaped = escaped.gsub("\t", "\\t")[0];
	escaped = escaped.gsub('"', '\\"')[0];
	return `"${escaped}"`;
}

function unescapePathSegment(segment: string): string {
	const chars: string[] = [];
	let i = 1;
	while (i <= segment.size()) {
		const ch = segment.sub(i, i);
		if (ch === "\\" && i < segment.size()) {
			const nextChar = segment.sub(i + 1, i + 1);
			if (nextChar === "n") {
				chars.push("\n");
			} else if (nextChar === "r") {
				chars.push("\r");
			} else if (nextChar === "t") {
				chars.push("\t");
			} else {
				chars.push(nextChar);
			}
			i += 2;
		} else {
			chars.push(ch);
			i += 1;
		}
	}
	return chars.join("");
}

function isCanonicalBracketStart(path: string, index: number): boolean {
	const quote = path.sub(index + 1, index + 1);
	return (quote === '"' || quote === "'") && path.sub(index - 1, index - 1) !== ".";
}

function parseInstancePath(path: string): string[] | undefined {
	let i = 1;
	const len = path.size();
	const parts: string[] = [];
	let current = "";

	if (path === "" || path === "game") return parts;
	if (path.sub(1, 5) === "game.") {
		i = 6;
	} else if (path.sub(1, 5) === "game[") {
		i = 5;
	}

	while (i <= len) {
		const ch = path.sub(i, i);

		if (ch === ".") {
			if (current !== "") {
				parts.push(current);
				current = "";
				i += 1;
			} else if (i > 1 && path.sub(i - 1, i - 1) === "." && i < len && path.sub(i + 1, i + 1) !== "[") {
				// Back-compat for previously emitted paths such as
				// game.ServerScriptService..dir.ReproScript, where ".dir"
				// was an actual instance name.
				current = ".";
				i += 1;
			} else {
				i += 1;
			}
		} else if (ch === "[" && i < len && isCanonicalBracketStart(path, i)) {
			if (current !== "") {
				parts.push(current);
				current = "";
			}

			const quote = path.sub(i + 1, i + 1);
			if (quote !== '"' && quote !== "'") return undefined;
			let j = i + 2;
			let raw = "";
			while (j <= len) {
				const c = path.sub(j, j);
				if (c === "\\") {
					if (j >= len) return undefined;
					raw += c + path.sub(j + 1, j + 1);
					j += 2;
				} else if (c === quote) {
					break;
				} else {
					raw += c;
					j += 1;
				}
			}
			if (j > len || path.sub(j, j) !== quote || path.sub(j + 1, j + 1) !== "]") return undefined;
			parts.push(unescapePathSegment(raw));
			i = j + 2;
		} else {
			current += ch;
			i += 1;
		}
	}

	if (current !== "") parts.push(current);
	return parts;
}

function getRootSegment(instance: Instance): string {
	if (instance.Parent === game) {
		const [ok, service] = pcall(() => game.GetService(instance.ClassName as keyof Services));
		if (ok && service === instance) {
			return instance.ClassName;
		}
	}
	return instance.Name;
}

function getInstancePath(instance: Instance): string {
	if (!instance || instance === game) {
		return "game";
	}

	const pathParts: string[] = [];
	let current: Instance | undefined = instance;

	while (current && current !== game) {
		pathParts.unshift(getRootSegment(current));
		current = current.Parent as Instance | undefined;
	}

	let path = "game";
	for (const part of pathParts) {
		if (isSimplePathSegment(part)) {
			path += `.${part}`;
		} else {
			path += `[${quotePathSegment(part)}]`;
		}
	}
	return path;
}

function getRootInstance(segment: string): Instance | undefined {
	const [ok, service] = pcall(() => game.GetService(segment as keyof Services));
	if (ok && service) return service as Instance;
	return game.FindFirstChild(segment);
}

function getInstanceByPath(path: string): Instance | undefined {
	const parts = parseInstancePath(path);
	if (parts === undefined) return undefined;
	if (parts.size() === 0) return game;

	let current: Instance | undefined = getRootInstance(parts[0]);
	for (let i = 1; i < parts.size(); i++) {
		const part = parts[i];
		if (!current) return undefined;
		current = current.FindFirstChild(part);
	}

	return current;
}

export = {
	getInstancePath,
	getInstanceByPath,
};
