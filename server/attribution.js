// Attribution: how much of a merged diff the agent actually wrote.
//
// The question is the one nobody here could answer: of the lines that
// landed on the default branch, how many came out of an agent's session,
// and how many did the person write - or rewrite - on the way. Git AI
// answers it with a daemon on the developer's machine that diffs the
// working tree at every tool call. This app will not put a daemon on
// anybody's laptop: what reaches a machine is the handful of hook lines
// `setup.sh` writes, and every count is worked out here, on the server,
// from what those hooks already send plus the diff GitHub already has.
//
// So the match is made on line content, not on positions. As the session
// runs, every line it *writes* (`linesOfEdit` over the `tool_input` of an
// editing call) is reduced to a 32-bit fingerprint and kept as a set on the
// session record. When the pull request merges, the added lines of its diff
// are fingerprinted the same way, and a line is the agent's when its
// fingerprint is in some linked session's set.
//
// ## Fingerprints, because the record is counts
//
// A session record is counts, ids and names - never a tool's input, never a
// line of code (sessions.js). A set of 32-bit hashes is a count-shaped
// thing: it says "a line that looks like this was written" and cannot be
// read back into the line. That is the only reason this is a hash and not
// the text; it is not a compression trick.
//
// The line is trimmed first, so re-indenting a block does not make it
// somebody else's, and a line whose trimmed form is shorter than four
// characters has no fingerprint at all. `}`, `});`, `else`, a blank - those
// occur in every file of every repository, and counting them would make
// every session match every diff. Losing them costs almost nothing: they
// are not the lines anyone means by "who wrote this".
//
// ## What this cannot see, and must not be reported as if it could
//
//   - **A line the person rewrote is not the agent's.** That is the point
//     of the measure, not a flaw in it: the figure is how much of what the
//     agent wrote survived to the merge.
//   - **A line the agent wrote and the person only moved is still the
//     agent's.** Content matching has no idea where a line sits, so a
//     refactor that shuffles blocks does not cost the agent anything.
//   - **Two sessions that wrote the same line both get it.** The line is
//     counted once in `agent`, and once in each of their `matched` - so
//     the per-session numbers can sum to more than the diff.
//   - **A harness whose hooks carry no tool input has an empty set and
//     matches nothing.** Codex today, and an ACP session that reports tool
//     titles without inputs. Zero matched lines there means "not measured",
//     and the page must say that rather than "0% agent-written", which is a
//     different and false claim.
//   - **A file with no patch** - binary, or too large for GitHub to send
//     one - contributes no lines to either half, even though its
//     `additions` are real.
import { Buffer } from "node:buffer";

/** Splits text into lines. A trailing newline ends the last line; it does not start another. */
function linesOf(text) {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const push = (into, text) => { for (const line of linesOf(text)) into.push(line); };

/**
 * The lines an editing tool call wrote and unwrote, from the `tool_input`
 * the `done` hook carries - Claude Code's names and Gemini CLI's, which are
 * the same shapes under different names (telemetry-ingest.js
 * `EDITING_TOOLS`).
 *
 *   Write / write_file      `content`                     all added
 *   Edit / replace / edit   `new_string` / `old_string`   added / removed
 *   MultiEdit               `edits[]`                     both, summed
 *   NotebookEdit            `new_source`                  added
 *
 * `replace_all` counts its lines once. The hook says what was written, not
 * how many places it landed in, and inflating the count by a number this
 * side cannot check would put the session's own denominator out.
 *
 * A tool that is not one of these, or an input of the wrong shape, is no
 * lines - never a guess.
 *
 * @returns {{added: string[], removed: string[]}}
 */
export function linesOfEdit(tool, input) {
  const args = input && typeof input === "object" ? input : {};
  const added = [];
  const removed = [];
  switch (String(tool ?? "")) {
    case "Write":
    case "write_file":
      push(added, args.content);
      break;
    case "Edit":
    case "replace":
    case "edit":
      push(added, args.new_string);
      push(removed, args.old_string);
      break;
    case "MultiEdit":
      for (const edit of Array.isArray(args.edits) ? args.edits : []) {
        push(added, edit?.new_string);
        push(removed, edit?.old_string);
      }
      break;
    case "NotebookEdit":
      push(added, args.new_source);
      break;
    default:
      break;
  }
  return { added, removed };
}

/** FNV-1a, 32 bits: the offset basis and the prime are the algorithm's own constants. */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** The shortest trimmed line worth fingerprinting - see the top of this file. */
export const MIN_LINE = 4;

/**
 * A line's fingerprint: FNV-1a over the UTF-8 bytes of the trimmed line, as
 * an unsigned 32-bit number - or null when the trimmed line is shorter than
 * `MIN_LINE`, which is not a hash of nothing but "this line does not count".
 *
 * Zero is a possible fingerprint, so callers test `=== null`, never falsy.
 * FNV-1a is not a security hash and is not used as one: nothing here is
 * defended by the difficulty of finding a collision. It is used because it
 * is four lines, has no dependency, and gives the same answer on every
 * machine and every version of Node - which a fingerprint stored on a
 * record for a month has to.
 */
export function fingerprint(line) {
  const text = String(line ?? "").trim();
  if (text.length < MIN_LINE) return null;
  const bytes = Buffer.from(text, "utf8");
  let hash = FNV_OFFSET;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, FNV_PRIME);
  return hash >>> 0;
}

/** The fingerprints of some lines, deduplicated; lines too short to count are not in it. */
export function hashesOf(lines) {
  const set = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    const hash = fingerprint(line);
    if (hash !== null) set.add(hash);
  }
  return set;
}

/**
 * How many fingerprints a session's record will hold. Twenty thousand
 * distinct lines is 80KB packed and about 107KB as base64 - large for a
 * record that is otherwise counts, and small beside a session that wrote a
 * generated file into the repository.
 *
 * Past the cap the session is measured on a *sample* of its lines: `pack`
 * keeps the 20 000 lowest fingerprints, which is an arbitrary but stable
 * and order-independent slice of the set (the same lines however the edits
 * arrived, and a line once kept stays kept unless a lower one displaces
 * it). The cost is that such a session's `accepted` is a floor rather than
 * the figure - the diff's lines outside the sample cannot match - so a page
 * showing acceptance for a session at the cap should say it is measured on
 * part of the work.
 */
export const MAX_HASHES = 20_000;

/**
 * A set of fingerprints as base64, for the record: sorted ascending,
 * deduplicated and capped, written little-endian so the same set packs to
 * the same string on any machine.
 */
export function pack(hashes) {
  const clean = [...(hashes ?? [])].filter((hash) => Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff);
  const unique = [...new Set(clean)].sort((a, b) => a - b).slice(0, MAX_HASHES);
  const bytes = Buffer.alloc(unique.length * 4);
  unique.forEach((hash, index) => bytes.writeUInt32LE(hash, index * 4));
  return bytes.toString("base64");
}

/**
 * The set `pack` wrote. Anything that is not a packed set - a truncated
 * string, a field that used to hold something else, a null - is an empty
 * set, because a session whose hashes cannot be read matched no lines and
 * that is exactly what an empty set says. It never throws: this runs on the
 * merge path, and an unreadable field must not lose the merge.
 */
export function unpack(packed) {
  const set = new Set();
  if (typeof packed !== "string" || !packed) return set;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) return set;
  const bytes = Buffer.from(packed, "base64");
  if (!bytes.length || bytes.length % 4 !== 0) return set;
  for (let index = 0; index < bytes.length; index += 4) set.add(bytes.readUInt32LE(index));
  return set;
}

/**
 * Files whose added lines say nothing about who writes the code: lockfiles,
 * build output, vendored trees, snapshots and anything generated. The same
 * idea as git-ai's default ignore list, and for the same reason - a
 * `package-lock.json` regenerated by an agent's `npm install` is five
 * thousand added lines that would make the pull request read as almost
 * entirely agent-written, and a person's own lockfile churn would make the
 * next one read as almost entirely theirs. Neither is a fact about the
 * work.
 *
 * `*.svg` is on the list whole, at any size: an icon is either one very
 * long line or a few hundred generated ones, and nobody reviews it as code.
 * The cost is that a hand-drawn diagram in a pull request is invisible to
 * this measure, which is the right way round.
 *
 * A pattern with no slash matches the file's name anywhere in the tree; a
 * pattern with one matches the path, at the root or under any directory -
 * so `dist/**` is *any* `dist` directory, not only the top one. `*` stops
 * at a slash, `**` does not.
 */
export const IGNORED = [
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "*.min.*",
  "dist/**",
  "build/**",
  "vendor/**",
  "node_modules/**",
  "**/__snapshots__/**",
  "*.generated.*",
  "*.snap",
  "*.svg",
];

// A glob as a regular expression: `*` stops at a slash, `**` crosses them,
// and a `**` followed by a slash may match nothing at all - so the
// any-depth prefix below still catches a `dist` at the root.
function globRe(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += /[a-zA-Z0-9_-]/.test(char) ? char : `\\${char}`;
  }
  return new RegExp(`^${source}$`);
}

// A pattern with no slash is a file name, so it is looked for at any depth;
// one with a slash is a path, and is looked for at the root and under any
// directory.
const IGNORED_RES = IGNORED.map((pattern) => globRe(`**/${pattern}`));

/**
 * Whether a path's lines are not counted - see `IGNORED`. A file with no
 * path at all is ignored too: there is nothing to count and nothing to say
 * where it came from.
 */
export function ignored(path) {
  const clean = String(path ?? "").replace(/^\.?\/+/, "");
  if (!clean) return true;
  return IGNORED_RES.some((re) => re.test(clean));
}

/**
 * The added lines of a unified diff, as GitHub sends one on
 * `pulls/{n}/files[].patch`: the `+` lines without their marker. The
 * `+++ b/path` header starts with a `+` and is not a line of code; the
 * `\ No newline at end of file` marker is not one either.
 */
export function addedLinesOf(patch) {
  if (typeof patch !== "string" || !patch) return [];
  const added = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    added.push(line.slice(1));
  }
  return added;
}

/**
 * The added lines of a patch with the number each has in the file *after*
 * the change - what a reader needs to find the line in the repository, and
 * what git-ai's own notes are written against (`git-ai-notes.js` ranges).
 *
 * The count comes off each hunk header (`@@ -12,7 +12,9 @@`) and then
 * walks: an added line takes the number and advances it, a context line
 * advances it, a removed line does not, and `\ No newline at end of file`
 * is not a line at all. A patch with no header is no lines - GitHub sends
 * one for every file it sends a patch for, and guessing from one would put
 * every number out.
 */
export function addedLinesAt(patch) {
  const out = [];
  if (typeof patch !== "string" || !patch) return out;
  let at = null;
  for (const line of patch.split("\n")) {
    const hunk = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      at = Number(hunk[1]);
      continue;
    }
    if (at === null) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      out.push({ n: at, text: line.slice(1) });
      at += 1;
      continue;
    }
    at += 1;
  }
  return out;
}

const setOf = (hashes) => (hashes instanceof Set ? hashes : unpack(hashes));

/** How much of one merged diff the line-by-line view reads. See `blame`. */
export const BLAME_FILES = 50;
export const BLAME_LINES = 4000;

/**
 * The same match as `attribute`, kept line by line instead of counted:
 * every added line of the diff, in the file and at the number it landed
 * at, with the session that wrote it or null.
 *
 * This is the view behind "which lines", and it is deliberately the same
 * arithmetic as the figure beside it - one fingerprint function, one
 * ignore list - so a reader who counts the coloured lines gets the
 * percentage the page already showed them. Two places that computed it
 * separately would disagree the first time either changed.
 *
 * One difference from `attribute`, and it is the only one: a line two
 * sessions both wrote is drawn in the *first* of them, because a line has
 * one gutter. `attribute` gives it to both, so a session's `matched` here
 * can be lower than the one on the pull record. The panel says which
 * sessions matched, not how the percentage was arrived at, and a line
 * drawn twice is not a thing a gutter can do.
 *
 * Capped, because this is drawn in a browser rather than counted: at
 * `maxFiles` files and `maxLines` lines in all. What was left out is
 * `cut`, in files and in lines, so the page can say the view is partial
 * rather than quietly showing less than merged. Lines left out of a file
 * that *is* drawn are counted exactly; lines of a file that is not drawn
 * at all come from GitHub's own `additions`, which counts the short lines
 * this view does not fingerprint.
 *
 * @returns {{files: {path: string, additions: number, lines: {n: number, text: string, by: string|null}[]}[],
 *   sessions: {id: string, matched: number}[], cut: {files: number, lines: number}|null}}
 */
export function blame({ files = [], sessions = [], maxFiles = BLAME_FILES, maxLines = BLAME_LINES } = {}) {
  const linked = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.id != null)
    .map((session) => ({ id: String(session.id), hashes: setOf(session.hashes), matched: 0 }));
  const out = [];
  let drawn = 0;
  let cutFiles = 0;
  let cutLines = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const name = file?.filename ?? file?.path ?? null;
    // The same files the figure ignores, and for the same reason: a
    // lockfile drawn line by line is the whole panel.
    if (!name || ignored(name)) continue;
    const added = addedLinesAt(file?.patch);
    if (!added.length) continue;
    if (out.length >= maxFiles || drawn >= maxLines) {
      cutFiles += 1;
      cutLines += file?.additions ?? added.length;
      continue;
    }
    const room = Math.min(added.length, maxLines - drawn);
    cutLines += added.length - room;
    const lines = added.slice(0, room).map(({ n, text }) => {
      const hash = fingerprint(text);
      const by = hash === null ? null : linked.find((session) => session.hashes.has(hash)) ?? null;
      if (by) by.matched += 1;
      return { n, text, by: by?.id ?? null };
    });
    drawn += lines.length;
    out.push({ path: name, additions: file?.additions ?? added.length, lines });
  }
  return {
    files: out,
    sessions: linked.map(({ id, matched }) => ({ id, matched })),
    cut: cutFiles || cutLines ? { files: cutFiles, lines: cutLines } : null,
  };
}

/**
 * Who wrote the added lines of a diff.
 *
 * `files` is GitHub's `pulls/{n}/files` - `{filename, patch, additions,
 * deletions, status}` - and `sessions` the sessions linked to the pull
 * request, each with the fingerprints it wrote (`{id, hashes}`, a Set or
 * the packed string off the record).
 *
 * A line counts when it is in a file nobody ignores and is long enough to
 * have a fingerprint; it is the agent's when any linked session wrote a
 * line that looks like it. `bySession[i].matched` is that one session's
 * count, and two sessions that wrote the same line each get it - see the
 * top of this file for what this measure cannot see.
 *
 * @returns {{added: number, agent: number, share: number|null, bySession: {id: string, matched: number, share: number|null}[]}}
 */
export function attribute({ files = [], sessions = [] } = {}) {
  const linked = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.id != null)
    .map((session) => ({ id: String(session.id), hashes: setOf(session.hashes), matched: 0 }));
  let added = 0;
  let agent = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const name = file?.filename ?? file?.path ?? null;
    if (!name || ignored(name)) continue;
    for (const line of addedLinesOf(file?.patch)) {
      const hash = fingerprint(line);
      if (hash === null) continue;
      added += 1;
      let mine = false;
      for (const session of linked) {
        if (!session.hashes.has(hash)) continue;
        session.matched += 1;
        mine = true;
      }
      if (mine) agent += 1;
    }
  }
  const share = added ? agent / added : null;
  return {
    added,
    agent,
    share,
    bySession: linked.map((session) => ({ id: session.id, matched: session.matched, share: added ? session.matched / added : null })),
  };
}

/**
 * What share of the lines a session wrote survived to the merge - its
 * `accepted` over its `linesAdded`. Null when the session wrote nothing to
 * take a share of, which the page says as a dash and not as nought.
 *
 * Capped at 1: a session that wrote one distinct line the diff repeats can
 * match more lines than it wrote, and a ratio above 100% reads as a bug
 * rather than as the true thing it is.
 */
export function acceptanceOf({ linesAdded, accepted } = {}) {
  const wrote = Number(linesAdded);
  const kept = Number(accepted);
  if (!Number.isFinite(wrote) || wrote <= 0) return null;
  if (!Number.isFinite(kept) || kept < 0) return 0;
  return Math.min(1, kept / wrote);
}
