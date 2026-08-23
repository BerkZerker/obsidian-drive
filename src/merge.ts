/**
 * Line-based three-way merge (diff3-style). Given the common ancestor of a
 * file and the two divergent versions, combines non-overlapping edits from
 * both sides. Returns null when both sides changed the same region
 * differently — the caller falls back to a conflict copy.
 */

interface RawHunk {
	baseStart: number;
	baseLen: number;
	sideStart: number;
	sideLen: number;
}

/**
 * LCS-based diff of base vs side, returned as changed regions. Common
 * prefix/suffix are trimmed first so typical note edits stay cheap. Returns
 * null when the middle section is too large to diff (caller falls back).
 */
function diffHunks(base: string[], side: string[]): RawHunk[] | null {
	let prefix = 0;
	while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < base.length - prefix &&
		suffix < side.length - prefix &&
		base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
	)
		suffix++;

	const b = base.slice(prefix, base.length - suffix);
	const s = side.slice(prefix, side.length - suffix);
	const n = b.length;
	const m = s.length;
	if (n * m > 9_000_000) return null; // ~36MB DP table cap

	if (n === 0 && m === 0) return [];
	if (n === 0 || m === 0) {
		return [{ baseStart: prefix, baseLen: n, sideStart: prefix, sideLen: m }];
	}

	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				b[i] === s[j]
					? dp[(i + 1) * width + j + 1] + 1
					: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}

	const hunks: RawHunk[] = [];
	let i = 0;
	let j = 0;
	let hunkI = -1;
	let hunkJ = -1;
	const flush = (endI: number, endJ: number) => {
		if (hunkI >= 0) {
			hunks.push({
				baseStart: hunkI + prefix,
				baseLen: endI - hunkI,
				sideStart: hunkJ + prefix,
				sideLen: endJ - hunkJ,
			});
			hunkI = hunkJ = -1;
		}
	};
	while (i < n && j < m) {
		if (b[i] === s[j]) {
			flush(i, j);
			i++;
			j++;
		} else {
			if (hunkI < 0) {
				hunkI = i;
				hunkJ = j;
			}
			if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
			else j++;
		}
	}
	if (i < n || j < m) {
		if (hunkI < 0) {
			hunkI = i;
			hunkJ = j;
		}
	}
	flush(n, m);
	return hunks;
}

type SideHunk = RawHunk & { side: 0 | 1 };

export function mergeThreeWay(baseText: string, localText: string, remoteText: string): string | null {
	const base = baseText.split("\n");
	const local = localText.split("\n");
	const remote = remoteText.split("\n");

	const localHunks = diffHunks(base, local);
	const remoteHunks = diffHunks(base, remote);
	if (!localHunks || !remoteHunks) return null;

	const hunks: SideHunk[] = [
		...localHunks.map((h) => ({ ...h, side: 0 as const })),
		...remoteHunks.map((h) => ({ ...h, side: 1 as const })),
	].sort((a, b) => a.baseStart - b.baseStart || a.baseLen - b.baseLen);

	const out: string[] = [];
	let basePos = 0;
	let k = 0;

	while (k < hunks.length) {
		const gStart = hunks[k].baseStart;
		let gEnd = gStart + hunks[k].baseLen;
		let k2 = k + 1;
		// Group hunks whose base ranges overlap; two insertions at the exact
		// same point (zero-length ranges) also overlap.
		while (
			k2 < hunks.length &&
			(hunks[k2].baseStart < gEnd || (hunks[k2].baseStart === gStart && gEnd === gStart))
		) {
			gEnd = Math.max(gEnd, hunks[k2].baseStart + hunks[k2].baseLen);
			k2++;
		}
		const group = hunks.slice(k, k2);

		for (let x = basePos; x < gStart; x++) out.push(base[x]);

		// Reconstruct what each side looks like across the group's base span.
		const sideSegment = (side: 0 | 1): string[] => {
			const sideLines = side === 0 ? local : remote;
			const own = group.filter((h) => h.side === side).sort((a, b) => a.baseStart - b.baseStart);
			const seg: string[] = [];
			let pos = gStart;
			for (const h of own) {
				for (let x = pos; x < h.baseStart; x++) seg.push(base[x]);
				for (let x = h.sideStart; x < h.sideStart + h.sideLen; x++) seg.push(sideLines[x]);
				pos = h.baseStart + h.baseLen;
			}
			for (let x = pos; x < gEnd; x++) seg.push(base[x]);
			return seg;
		};

		const key = (lines: string[]) => lines.join("\u0000");
		const localSeg = sideSegment(0);
		const remoteSeg = sideSegment(1);
		const baseSeg = base.slice(gStart, gEnd);

		let chosen: string[];
		if (key(localSeg) === key(remoteSeg)) chosen = localSeg; // both made the same edit
		else if (key(baseSeg) === key(localSeg)) chosen = remoteSeg; // only remote changed here
		else if (key(baseSeg) === key(remoteSeg)) chosen = localSeg; // only local changed here
		else return null; // overlapping different edits — real conflict

		for (const line of chosen) out.push(line);
		basePos = gEnd;
		k = k2;
	}

	for (let x = basePos; x < base.length; x++) out.push(base[x]);
	return out.join("\n");
}

const TEXT_EXTENSIONS = new Set([
	"md", "markdown", "txt", "text", "org", "tex", "canvas", "json", "csv", "tsv",
	"yml", "yaml", "xml", "html", "htm", "css", "js", "ts", "ini", "cfg", "log",
]);

export function isMergeableTextPath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot < path.lastIndexOf("/")) return false;
	return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
