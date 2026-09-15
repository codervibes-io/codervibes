// Search: one box over what this installation has seen.
//
// Two things are searched, and the box says which (`in`). The sessions
// and the catalogue answer "how did we do X?" - asked by somebody who
// remembers that a deploy was triggered from a sandbox last week and
// wants the session that did it, or by somebody new wondering which
// connector does what: the best sessions, connectors, tools and skills
// for the words, each row saying why it is there (the words that matched,
// or that the meaning did - /api/search, server/search.js), with the
// model's reading of them when it is asked for. The access trail answers "who did what under
// which permission" - every call an agent made under one, every refusal,
// every ask and what the owner said - and is searched fuzzily and only
// that (/api/search/trail, server/access-trail.js): a person looking for
// `fly_deploy` who typed "fly deply" wants the row, not a guess.
//
// Above either list is the histogram of when the matches happened, the
// way a log tool draws one: the list says what, the bars say when, and a
// bar pressed narrows the list to that slice (`from`/`to` in the address).
// With nothing typed the page is everything, newest first, over all time:
// no words, no kind, no range: a filter nobody set is one nobody can see,
// and a first visit that shows a summary and no rows reads as an
// installation that has recorded nothing. All time is all the time there
// is: the index holds a month, because a session's events expire at
// thirty days. Under that listing is the usage
// of the range - sessions, calls, cost, the tools reached for most, the
// trail's sums, and the calls over time (/api/search/stats).
//
// The model's reading of a search is asked for, not given: AI assist,
// beside the Search button (or the account that always wants one), starts
// it, and from there it is a chat - each follow-up goes up with the turns
// before it, so it can be asked about what it just said. It is the only
// thing on this page that spends anything, which is why it is a button and
// not a box that sits there: until it is pressed the page is the list.
//
// The question is the address (`/search?q=...&in=trail&from=&to=`), so a
// search is a link that can be sent to somebody, and the back button is a
// way back to the last one. The kind filter, the provider filter and the
// range are not: they narrow the list on the page, and a refresh keeps
// them (console.js holds them), but a link carries the question and
// nothing else, because the question is what was meant.
//
// Two of those three narrow in different places, which is worth knowing
// when reading what follows. The kind is the page's own: the hits are in
// hand and it hides the ones it does not want. The provider goes back to
// the server, because a search answers with its best few and "the
// Anthropic ones among the fifty on screen" is a different list from the
// fifty best Anthropic ones - the second is what somebody asking whose
// models did the work means. So the counts beside the provider rows are
// of everything that matched, counted before the filter, and pressing one
// reads again.
//
// The words rule applies (the essay in sessions.js): a session the reader
// may see but not read comes back with no title and no quote, and the row
// says who was working and what they reached for; a trail entry on a repo
// the reader may not open comes back without the agent's own words.
import { el, button, ago, problem, detailHead, chips, metric, metrics, count, money } from "./console-dom.js";
import { OUTCOME_CHIPS } from "./console-tools.js";
import { RANGES, rangePicker } from "./console-performance.js";
import { whereFilter, whereChip } from "./console-where.js";
import { filterPicker, filterRow } from "./console-filters.js";

/** The two things searched, as the box names them. */
export const MODES = [
  ["sessions", "Sessions & catalogue"],
  ["trail", "Access trail"],
];

/**
 * How far back the page looks. All time first and by default: a filter
 * nobody set is one nobody can see, and a reader who has just arrived
 * should be shown everything before being shown a slice of it.
 */
export const SEARCH_RANGES = [{ key: "all", label: "All time" }, ...RANGES];

/** The four kinds, as the filter names them, after "everything". */
const KINDS = [
  ["all", "Everything"],
  ["session", "Sessions"],
  ["connector", "Connectors"],
  ["tool", "Tools"],
  ["skill", "Skills"],
];

const KIND_WORD = { session: "session", connector: "connector", tool: "tool", skill: "skill" };

/** The plurals the page says: "entries" and "matches", not "entrys" and "matchs". */
const PLURALS = { entry: "entries", match: "matches" };
const pluralOf = (word) => PLURALS[word] ?? `${word}s`;
const plural = (n, word) => `${count(n)} ${n === 1 ? word : pluralOf(word)}`;

// ------------------------------------------------------------- histogram

const HOUR = 60 * 60 * 1000;

/** A bucket's label: the hour over a day, the day and hour over a week, the day over a month. */
function bucketLabel(at, bucketMs) {
  const when = new Date(at);
  if (bucketMs < 6 * HOUR) return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (bucketMs < 24 * HOUR) return `${when.toLocaleDateString([], { month: "short", day: "numeric" })} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return when.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A bucket's span, for the line under the bars and the chip that says one is open. */
export function bucketSpan(from, bucketMs) {
  const end = from + bucketMs;
  if (bucketMs >= 24 * HOUR) return bucketLabel(from, bucketMs);
  return `${bucketLabel(from, bucketMs)} – ${new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The bars: one per bucket of the range, tallest at the busiest, each a
 * button that narrows the list to its slice. `series` names the stacked
 * parts (bottom first) and their classes, or nothing for one count. The
 * line under the bars says what the pointer is on; the legend says what
 * the parts are, when there are parts.
 */
export function histogramPanel(data, { unit = "match", series = null, selected = null, onBucket }) {
  const panel = el("section", "search-histogram");
  if (!data?.buckets?.length) return panel;
  const max = Math.max(1, ...data.buckets.map((bucket) => bucket.count));
  const total = data.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const head = el("div", "search-histogram-head");
  const title = el("span", "search-histogram-title", `${plural(total, unit)} over time`);
  head.append(title);
  if (series?.length) {
    const legend = el("div", "search-histogram-legend");
    for (const part of series) {
      const item = el("span", "search-histogram-key");
      item.append(el("i", `search-histogram-swatch ${part.className}`), part.label);
      legend.append(item);
    }
    head.append(legend);
  }
  panel.append(head);

  const readout = el("p", "search-histogram-readout");
  const bars = el("div", "search-histogram-bars");
  bars.setAttribute("role", "list");
  for (const bucket of data.buckets) {
    const isOpen = selected?.from === bucket.at;
    const bar = button(`search-histogram-bar${isOpen ? " is-open" : ""}${bucket.count ? "" : " is-empty"}`, "", () => onBucket(isOpen ? null : { from: bucket.at, to: bucket.at + data.bucketMs }));
    bar.setAttribute("role", "listitem");
    const parts = series?.length ? series.map((part) => ({ ...part, n: bucket.by?.[part.key] ?? 0 })) : [{ key: "count", className: "", n: bucket.count }];
    const said = parts.filter((part) => part.n).map((part) => (part.label ? `${count(part.n)} ${part.label}` : plural(part.n, unit)));
    const line = `${bucketSpan(bucket.at, data.bucketMs)} · ${bucket.count ? said.join(", ") : `no ${pluralOf(unit)}`}`;
    bar.title = line;
    bar.setAttribute("aria-label", line);
    const stack = el("span", "search-histogram-stack");
    stack.style.height = `${Math.round((bucket.count / max) * 100)}%`;
    for (const part of parts) {
      if (!part.n) continue;
      const piece = el("span", `search-histogram-piece ${part.className}`.trim());
      piece.style.flexBasis = `${(part.n / bucket.count) * 100}%`;
      stack.append(piece);
    }
    bar.append(stack);
    bar.addEventListener("mouseenter", () => (readout.textContent = line));
    bar.addEventListener("focus", () => (readout.textContent = line));
    bars.append(bar);
  }
  bars.addEventListener("mouseleave", () => (readout.textContent = selected ? `Showing ${bucketSpan(selected.from, data.bucketMs)}` : ""));
  panel.append(bars);

  const axis = el("div", "search-histogram-axis");
  const last = data.buckets.length - 1;
  for (const index of [0, Math.floor(last / 2), last]) axis.append(el("span", null, bucketLabel(data.buckets[index].at, data.bucketMs)));
  panel.append(axis);

  if (selected) {
    readout.textContent = `Showing ${bucketSpan(selected.from, data.bucketMs)}`;
    const clear = button("chip chip-ok search-bucket-chip", `${bucketSpan(selected.from, data.bucketMs)} ×`, () => onBucket(null));
    clear.setAttribute("aria-label", "Show the whole range again");
    head.append(clear);
  }
  panel.append(readout);
  return panel;
}

/** The trail's two lines on the histogram, bottom first. */
const TRAIL_SERIES = [
  { key: "allowed", label: "allowed", className: "is-allowed" },
  { key: "stopped", label: "stopped", className: "is-stopped" },
  { key: "open", label: "waiting", className: "is-open-ask" },
];

// ----------------------------------------------------- sessions & catalogue

/** Where a hit's page is. */
function pageOf(hit, pathFor) {
  if (hit.kind === "session") return pathFor("activity", hit.session.id);
  if (hit.kind === "connector") return pathFor("connectors", hit.name);
  if (hit.kind === "tool") return pathFor("tools", hit.name);
  return pathFor("tools");
}

/** A row's name: the title when the reader may read it; else who was working. */
function nameOf(hit) {
  if (hit.kind !== "session") return hit.title || hit.name;
  if (hit.title) return hit.title;
  const who = hit.session?.actor?.name || hit.session?.actor?.id;
  return who ? `A session of ${who}` : "A session";
}

/** What a provider is called, by the id the filter holds. */
const providerLabel = (data, id) => (data.providers ?? []).find((entry) => entry.id === id)?.label ?? id;

/** Why the row is there, in a few words. */
function whyOf(hit) {
  const parts = [];
  if (hit.why?.terms?.length) parts.push(`matched ${hit.why.terms.slice(0, 4).join(", ")}`);
  if (hit.why?.semantic) parts.push("close in meaning");
  return parts.join(" · ");
}

function hitRow(hit, { onOpen, pathFor }) {
  const row = el("article", `row-stacked search-hit search-hit-${hit.kind}`);
  const head = el("div", "row-head");
  const name = button("row-name search-name", nameOf(hit), () => onOpen(pageOf(hit, pathFor)));
  const marks = [el("span", "chip chip-none", KIND_WORD[hit.kind] ?? hit.kind)];
  if (hit.kind === "session") {
    const [label, className] = OUTCOME_CHIPS[hit.session?.outcome] ?? [];
    if (label && hit.session.outcome !== "none") marks.push(el("span", `chip ${className}`, label));
    // The repo here if there is one, else the repository the harness
    // reported - a hit in a repository nobody connected here still has a
    // name, and the mark beside it says nobody connected it.
    const named = hit.session?.repoName ?? hit.session?.repository ?? null;
    if (named) marks.push(el("span", "chip chip-none", named));
    const mark = whereChip(hit.session?.where);
    if (mark) marks.push(mark);
    // Whose models it ran on. On the row because a filtered list has to
    // show what it was filtered on - otherwise "Anthropic" is a word on a
    // button and nothing on screen agrees with it - and on every row
    // because a session that switched vendors mid-way says so here and
    // nowhere else.
    for (const provider of hit.providers ?? []) marks.push(el("span", "chip chip-none", provider.label));
    if (hit.session?.state === "live") marks.push(el("span", "chip chip-ok", "working now"));
  }
  head.append(name, chips(...marks));
  const note = el("span", "row-note");
  if (hit.kind === "session") {
    const who = hit.session?.actor?.name || hit.session?.actor?.id;
    note.textContent = [who, hit.at ? ago(hit.at) : null].filter(Boolean).join(" · ");
  } else {
    note.textContent = whyOf(hit);
  }
  head.append(note);
  row.append(head);

  const body = el("div", "row-body");
  // Model- and person-written text: set as text, never as markup.
  if (hit.snippet) {
    const quote = el("p", "search-snippet");
    quote.textContent = hit.snippet;
    body.append(quote);
  } else if (hit.kind === "session") {
    body.append(el("p", "console-hint", "You are not on this session's repo, so its words are not shown; who was working and what they reached for is."));
  }
  const reached = [...(hit.tools ?? []), ...(hit.connectors ?? []), ...(hit.skills ?? [])];
  if (hit.kind === "session" && reached.length) {
    body.append(chips(...reached.slice(0, 10).map((name) => el("span", "chip chip-none row-id", name))));
  }
  if (hit.kind === "session" && whyOf(hit)) body.append(el("p", "search-why", whyOf(hit)));
  row.append(body);
  return row;
}

/** Where a citation's page is - the same places as a hit's. */
function citePage(cite, pathFor) {
  if (cite.kind === "session") return pathFor("activity", cite.name);
  if (cite.kind === "connector") return pathFor("connectors", cite.name);
  if (cite.kind === "tool") return pathFor("tools", cite.name);
  return pathFor("tools");
}

/**
 * One turn's prose, with each [kind:id] marker the model wrote turned
 * into a link to the page it read. The prose is the model's words and
 * goes in as text; only the markers become elements, and only markers the
 * server kept - one it did not see was dropped there, and shows here as
 * the words that were around it.
 */
function answerProse(data, { onOpen, pathFor }) {
  const byId = new Map((data.citations ?? []).map((cite) => [cite.id, cite]));
  const text = el("p", "search-answer-text");
  const parts = String(data.answer).split(/(\[(?:session|tool|connector|skill):[^\]\s]+\])/);
  for (const part of parts) {
    const marker = part.match(/^\[((?:session|tool|connector|skill):[^\]\s]+)\]$/);
    const cite = marker ? byId.get(marker[1]) : null;
    if (cite) {
      const label = cite.kind === "session" ? (cite.title || `session ${cite.name}`) : cite.name;
      text.append(button("search-cite", label, () => onOpen(citePage(cite, pathFor))));
    } else if (marker) {
      // A marker the server dropped (nothing seen by that id): the id, as text.
      text.append(document.createTextNode(marker[1].split(":").slice(1).join(":")));
    } else {
      text.append(document.createTextNode(part));
    }
  }
  return text;
}

/** What answering took, as the line under a turn. */
function answerNote(data) {
  const read = (data.steps ?? []).filter((step) => step.tool === "open_session").length;
  const searched = (data.steps ?? []).filter((step) => step.tool === "search").length;
  return [
    read ? `read ${read} session${read === 1 ? "" : "s"} in full` : null,
    searched ? `searched ${searched} more time${searched === 1 ? "" : "s"}` : null,
    data.model ? `${data.model}` : null,
    data.cached ? "from a minute ago" : null,
  ].filter(Boolean).join(" · ");
}

/** One exchange: what was asked, and what came back - or why nothing did. */
function turnBlock(turn, { onOpen, pathFor }) {
  const block = el("article", "search-turn");
  const asked = el("p", "search-turn-question");
  // A person's words, and the model's: text, never markup.
  asked.textContent = turn.question;
  block.append(asked);
  if (turn.asking) {
    block.append(el("p", "console-hint", "Reading what was found…"));
    return block;
  }
  if (turn.failed) {
    block.append(problem(`Could not answer - ${turn.failed}`));
    return block;
  }
  const { data } = turn;
  if (!data?.answer) {
    block.append(el("p", "console-hint", data?.why ?? "No answer."));
    return block;
  }
  block.append(answerProse(data, { onOpen, pathFor }));
  const note = answerNote(data);
  if (note) block.append(el("p", "search-answer-note", note));
  return block;
}

/**
 * The model's half of the page, once it has said something: the answer to
 * the search, and a chat that carries on from it.
 *
 * It is drawn only when there is a turn to draw. An answer is a model call
 * - it costs this installation money and the reader a few seconds - and
 * most searches are answered by the list below, so nothing of this is on
 * screen until AI assist is pressed (or the reader has said on their
 * Account page that they always want one). After that it is a
 * conversation: each follow-up goes up with the turns before it, so
 * "which of those was fastest?" is a question and not a fragment.
 */
function assistPanel({ chat, onAsk, onOpen, pathFor }) {
  const turns = chat?.turns ?? [];
  const panel = el("section", "search-answer");
  const head = el("div", "search-answer-head");
  head.append(el("h3", "panel-heading", "AI assist"));
  panel.append(head);
  for (const turn of turns) panel.append(turnBlock(turn, { onOpen, pathFor }));

  // The box that carries the chat on, under the last answer.
  const form = el("form", "search-chat-form");
  const input = el("input", "text-input search-chat-input");
  input.type = "text";
  input.name = "follow-up";
  input.placeholder = "Ask a follow-up";
  input.setAttribute("aria-label", "Ask a follow-up");
  input.autocomplete = "off";
  const send = button("explain-btn search-chat-send", "Ask", () => {});
  send.type = "submit";
  form.append(input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const said = input.value.trim();
    if (!said || turns.some((turn) => turn.asking)) return;
    input.value = "";
    onAsk(said);
  });
  panel.append(form);
  return panel;
}

/** The sessions-and-catalogue half of the page, once the hits are in. */
// `onKind` is in this list because it was not, and the kind filter has
// been dead since it shipped: the chips drew, and pressing one threw
// `onKind is not defined` into the pane instead of narrowing anything.
// Nothing caught it because there is no DOM in the suite and the throw
// was on the press, not on the draw.
function sessionsResults({ ask, kind, provider, data, onKind, onProvider, onBucket, onOpen, pathFor }) {
  const out = [];
  out.push(histogramPanel(data.histogram, { unit: "session", selected: ask.from ? { from: ask.from, to: ask.to } : null, onBucket }));

  // The filter: which of the four kinds. A dropdown like every other
  // filter here, and each row keeps its count, which is the reason these
  // were chips - the counts are what tell a reader whether narrowing to
  // skills is worth the press. So the count follows the pick onto the
  // button: "Sessions 12" is what the closed control says.
  const counts = { all: data.hits.length };
  for (const hit of data.hits) counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
  const kinds = KINDS.filter(([id]) => id === "all" || counts[id]).map(([id, label]) => ({ key: id, label, note: String(counts[id] ?? 0) }));
  // And beside it, whose models the work was done on. Only when there is
  // something to choose between: one vendor is not a choice, and a filter
  // whose only option is what is already on screen is a control that can
  // never do anything.
  const vendors = (data.providers ?? []).map((entry) => ({ key: entry.id, label: entry.label, note: count(entry.count) }));
  out.push(
    filterRow(
      filterPicker({ label: "Showing", entries: kinds, picked: kind, onPick: onKind, all: null }),
      vendors.length > 1
        ? filterPicker({ label: "Provider", entries: vendors, picked: provider, onPick: onProvider, all: "Every provider", find: "Type to narrow" })
        : null,
    ),
  );

  const shown = kind === "all" ? data.hits : data.hits.filter((hit) => hit.kind === kind);
  if (!shown.length) {
    out.push(
      el(
        "p",
        "console-hint",
        data.hits.length
          ? "Nothing of that kind matched; the other kinds did."
          : ask.from
            ? "Nothing matched in that slice of the range; the bars say where the matches are."
            : provider
              ? `Nothing here was done on ${providerLabel(data, provider)}. Every provider shows the rest.`
              : !ask.q
                ? "Nothing has been recorded here yet. A session appears as soon as an executor reports one."
                : `Nothing matched "${ask.q}"${data.semantic ? "" : " by its words"}. ${data.semantic ? "Try other words, or fewer." : data.semantic === false && data.semantic_why ? data.semantic_why : "Try other words, or fewer."}`,
      ),
    );
  } else {
    const list = el("div", "search-list");
    for (const hit of shown) list.append(hitRow(hit, { onOpen, pathFor }));
    out.push(list);
  }

  // What the index holds, and whether the meaning is searched - the one
  // line that explains an answer that looks thin.
  const indexed = data.indexed ?? {};
  const foot = el("p", "console-hint search-foot");
  const why = data.semantic?.why;
  foot.textContent =
    `Searched ${indexed.session ?? 0} session${indexed.session === 1 ? "" : "s"} and ${(indexed.connector ?? 0) + (indexed.tool ?? 0) + (indexed.skill ?? 0)} catalogue entries by their words` +
    (data.semantic?.on ? ` and by meaning (${data.semantic.model}).` : why ? `. ${why}` : ".");
  out.push(foot);
  return out;
}

// ------------------------------------------------------------ the trail

/** What a state is worth as a chip. */
const STATE_CHIPS = {
  ok: ["ran", "chip-ok"],
  done: ["approved and run", "chip-ok"],
  approved: ["approved", "chip-ok"],
  open: ["waiting", "chip-warn"],
  failed: ["failed", "chip-err"],
  refused: ["refused", "chip-err"],
  denied: ["denied", "chip-err"],
  lapsed: ["lapsed", "chip-none"],
};

/** What happened, as the row's name: who did what. */
export function entryName(entry) {
  const who = entry.agent?.name || entry.agent?.id || "An agent";
  switch (entry.kind) {
    case "call":
      return `${who} called ${entry.tool ?? entry.permission}`;
    case "refusal":
      return `${who} was refused ${entry.tool ?? entry.permission}`;
    case "request":
      return `${who} asked for ${entry.label ?? entry.permission}`;
    case "approval":
      return `${who} asked to run ${entry.tool ?? entry.permission}`;
    default:
      return who;
  }
}

/** The decision, when there was one: who said what, and for how long. */
function decisionOf(entry) {
  if (!entry.by && !entry.decidedAt) return null;
  const verdict = entry.state === "denied" ? "denied" : "approved";
  const until = entry.until ? ` until ${new Date(entry.until).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
  return `${verdict}${entry.by ? ` by ${entry.by}` : ""}${entry.decidedAt ? ` ${ago(entry.decidedAt)}` : ""}${until}`;
}

/** One entry of the trail: who did what under which permission, how it went, and the session it happened in. */
function trailRow(entry, { onOpen, pathFor }) {
  const row = el("article", `row-stacked search-entry search-entry-${entry.kind} search-entry-${entry.state}`);
  const head = el("div", "row-head");
  head.append(el("span", "row-name", entryName(entry)));
  const [stateLabel, stateClass] = STATE_CHIPS[entry.state] ?? [entry.state, "chip-none"];
  const marks = [el("span", `chip ${stateClass}`, stateLabel)];
  marks.push(el("span", "chip chip-none row-id", entry.permission));
  if (entry.sensitive) marks.push(el("span", "chip chip-warn", "sensitive"));
  if (entry.repoName) marks.push(el("span", "chip chip-none", entry.repoName));
  head.append(chips(...marks));
  head.append(el("span", "row-note", entry.at ? ago(entry.at) : ""));
  row.append(head);

  const body = el("div", "row-body");
  // The agent's own words to its owner, and the owner's back: text, never markup.
  if (entry.words) {
    const said = el("p", "search-snippet");
    said.textContent = entry.words;
    body.append(said);
  }
  const decision = decisionOf(entry);
  if (decision) body.append(el("p", "search-entry-decision", decision));
  const links = el("div", "row-chips search-entry-links");
  if (entry.sessionId) links.append(button("chip chip-link", "session", () => onOpen(pathFor("activity", entry.sessionId))));
  if (entry.agent?.id) links.append(button("chip chip-link", "agent", () => onOpen(pathFor("executors", entry.agent.id))));
  if (entry.tool) links.append(button("chip chip-link", "tool", () => onOpen(pathFor("tools", entry.tool))));
  if (entry.taskId) links.append(el("span", "chip chip-none row-id", `task ${entry.taskId}`));
  body.append(links);
  if (entry.matched?.length) body.append(el("p", "search-why", `matched ${[...new Set(entry.matched)].slice(0, 4).join(", ")}`));
  row.append(body);
  return row;
}

/** A list of names with a count each and a bar for the count against the largest. */
function topList(title, rows, { name, note = () => null, onOpen = null, empty = "Nothing in this range." }) {
  const panel = el("section", "search-top");
  panel.append(el("h3", "panel-heading", title));
  if (!rows?.length) {
    panel.append(el("p", "console-hint", empty));
    return panel;
  }
  const max = Math.max(1, ...rows.map((row) => row.count));
  const list = el("ol", "search-top-list");
  for (const row of rows) {
    const item = el("li", "search-top-row");
    const label = onOpen ? button("search-top-name", name(row), () => onOpen(row)) : el("span", "search-top-name", name(row));
    const bar = el("span", "search-top-bar");
    const fill = el("i", "search-top-fill");
    fill.style.width = `${Math.round((row.count / max) * 100)}%`;
    bar.append(fill);
    const figure = el("span", "search-top-count", count(row.count));
    const said = note(row);
    item.append(label, bar, figure);
    if (said) item.append(el("span", "search-top-note", said));
    list.append(item);
  }
  panel.append(list);
  return panel;
}

/** The trail's sums: how much of it was allowed, who reached for what, who decided. */
function trailStats(stats, { onOpen, pathFor }) {
  const wrap = el("div", "search-stats");
  wrap.append(
    metrics(
      metric(count(stats.total), "entries", `${plural(stats.sessions, "session")}, ${plural(stats.repos, "repo")}`),
      metric(count(stats.allowed), "allowed", `${count(stats.byKind.call)} ran, ${count(stats.byState.approved + stats.byState.done)} approved`),
      metric(count(stats.stopped), "stopped", `${count(stats.byState.refused)} refused, ${count(stats.byState.denied)} denied, ${count(stats.byState.failed)} failed`, stats.stopped ? "metric-warn" : ""),
      metric(count(stats.open), "waiting", `${plural(stats.byKind.request, "ask")} for a permission, ${count(stats.byKind.approval)} to run a call`),
    ),
  );
  const grid = el("div", "search-top-grid");
  grid.append(
    topList("Permissions reached for", stats.permissions, {
      name: (row) => row.label ?? row.permission,
      note: (row) => (row.stopped ? `${count(row.stopped)} stopped` : null),
    }),
    topList("Agents", stats.agents, {
      name: (row) => row.name ?? row.id,
      note: (row) => (row.stopped ? `${count(row.stopped)} stopped` : null),
      onOpen: (row) => onOpen(pathFor("executors", row.id)),
    }),
    topList("Decided by", stats.deciders, {
      name: (row) => row.who,
      note: (row) => `${count(row.approved)} approved, ${count(row.denied)} denied`,
      empty: "Nobody was asked to decide anything in this range.",
    }),
  );
  wrap.append(grid);
  return wrap;
}

/** The trail half of the page, once the entries are in. */
function trailResults({ ask, data, onBucket, onOpen, pathFor }) {
  const out = [];
  out.push(histogramPanel(data.histogram, { unit: "entry", series: TRAIL_SERIES, selected: ask.from ? { from: ask.from, to: ask.to } : null, onBucket }));
  if (data.stats) out.push(trailStats(data.stats, { onOpen, pathFor }));
  if (!data.hits.length) {
    out.push(
      el(
        "p",
        "console-hint",
        ask.from
          ? "Nothing in that slice of the range; the bars say where the entries are."
          : ask.q
            ? `Nothing on the trail is near "${ask.q}". A tool's name, a permission, an agent, a person or a state - "refused", "denied" - are what the trail is made of.`
            : "Nothing on the trail in this range: no agent has called a tool under a permission, been refused one, or asked for one.",
      ),
    );
  } else {
    out.push(el("h3", "panel-heading", ask.q ? `${plural(data.total, "match")}, best first` : `${plural(data.total, "entry")}, newest first`));
    const list = el("div", "search-list");
    for (const entry of data.hits) list.append(trailRow(entry, { onOpen, pathFor }));
    out.push(list);
    if (data.total > data.hits.length) out.push(el("p", "console-hint", `The first ${count(data.hits.length)} of ${count(data.total)}. Press a bar, or add a word, to see the rest.`));
  }
  const foot = el("p", "console-hint search-foot");
  foot.textContent = `Searched ${plural(data.indexed?.entries ?? 0, "entry")} of the trail by their words, fuzzily${data.indexed?.reach ? `; the calls reach back to ${new Date(data.indexed.reach).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}.`;
  out.push(foot);
  return out;
}

// -------------------------------------------------------------- usage

/** What the range was used for: the page before anything is typed. */
function usagePanel(stats, { onBucket, onOpen, pathFor, onSearch }) {
  const wrap = el("div", "search-usage");
  if (!stats) return wrap;
  if (stats.failed) {
    wrap.append(problem(`Could not add up the range - ${stats.failed}`));
    return wrap;
  }
  if (!stats.data) {
    wrap.append(el("p", "console-hint", "Adding up the range…"));
    return wrap;
  }
  const { data } = stats;
  wrap.append(histogramPanel(data.histogram, { unit: "tool call", series: [{ key: "allowed", label: "ran", className: "is-allowed" }, { key: "stopped", label: "failed", className: "is-stopped" }], onBucket }));
  const kinds = Object.entries(data.sessions.byKind ?? {}).sort((x, y) => y[1] - x[1]).map(([kind, n]) => `${count(n)} ${kind}`).join(", ");
  wrap.append(
    metrics(
      metric(count(data.sessions.total), "sessions", [data.sessions.live ? `${count(data.sessions.live)} working now` : null, kinds].filter(Boolean).join(" · ") || "none in the range"),
      metric(count(data.sessions.agents), "agents", `${plural(data.sessions.people, "person")} behind them`),
      metric(count(data.calls.tools), "tool calls", data.calls.toolsFailed ? `${count(data.calls.toolsFailed)} failed` : "none failed"),
      metric(count(data.calls.models), "model calls", `${count(data.calls.tokens)} tokens`),
      metric(money(data.calls.cost), "spent", "on the sessions' own keys"),
      metric(count(data.trail.total), "on the access trail", `${count(data.trail.stopped)} stopped, ${count(data.trail.open)} waiting`, data.trail.stopped ? "metric-warn" : ""),
    ),
  );
  const grid = el("div", "search-top-grid");
  grid.append(
    topList("Tools reached for", data.tools, {
      name: (row) => row.name,
      note: (row) => (row.failed ? `${count(row.failed)} failed` : null),
      onOpen: (row) => onOpen(pathFor("tools", row.name)),
      empty: "No tool was called in this range.",
    }),
    topList("Connectors used", data.connectors, {
      name: (row) => row.id,
      note: (row) => (row.writes ? `${count(row.writes)} writes` : null),
      onOpen: (row) => onOpen(pathFor("connectors", row.id)),
      empty: "No connector was called in this range.",
    }),
    topList("Permissions reached for", data.trail.permissions, {
      name: (row) => row.label ?? row.permission,
      note: (row) => (row.stopped ? `${count(row.stopped)} stopped` : null),
      onOpen: (row) => onSearch(row.permission, "trail"),
      empty: "No permission was reached for in this range.",
    }),
    topList("Agents on the trail", data.trail.agents, {
      name: (row) => row.name ?? row.id,
      note: (row) => (row.stopped ? `${count(row.stopped)} stopped` : null),
      onOpen: (row) => onSearch(row.name ?? row.id, "trail"),
      empty: "No agent reached for a permission in this range.",
    }),
  );
  wrap.append(grid);
  return wrap;
}

// ---------------------------------------------------------------- the page

/**
 * The page. `ask` is what the address says - the question, which thing
 * to search (`mode`) and the bar pressed (`from`, `to`); `data` and
 * `failed` are the answer to it, or null while it is on its way; `kind`
 * and `provider` are what the reader has narrowed to; `chat`
 * is the exchange with the model, which happens only when somebody asks
 * for it; `stats` is the range's usage, shown under the listing.
 */
export function searchView({ ask, kind = "all", provider = null, range = "all", data = null, failed = null, chat = null, stats = null, onSearch, onMode, onKind, onProvider, onRange, onReread = () => {}, onBucket, onExplain, onAsk, onOpen, pathFor }) {
  const pane = el("div", "detail detail-wide");
  pane.append(
    detailHead(
      "Search",
      el("p", "detail-summary", "How did we do that, and who did what under which permission? Ask in words and find the session that did it, or the row on the access trail; the bars say when."),
    ),
  );

  // The box. A form, so Enter searches; the question goes to the address
  // and the page reads it back from there, the way every page here does.
  const form = el("form", "search-form");
  const input = el("input", "text-input search-input");
  input.type = "search";
  input.name = "q";
  input.placeholder = ask.mode === "trail" ? "fly_deploy, merge, refused, an agent's name" : "how do I trigger a deploy";
  input.value = ask.q;
  input.setAttribute("aria-label", "What to find");
  input.autocomplete = "off";
  const submit = button("ghost-btn search-submit", "Search", () => {});
  submit.type = "submit";
  form.append(input, submit);
  // And beside it, the other way to ask the same question: the model reads
  // the best of what the search finds, so that the reader does not have to
  // read the list. Amber, because it is the one control here that spends
  // something; beside Search rather than in a panel of its own, because it
  // is a second button for what is already typed and not a second place to
  // type. The trail is words and nothing else, so it has none.
  if (ask.mode === "sessions") {
    const assist = button("explain-btn search-assist", "AI assist", () => onExplain(input.value.trim()));
    // Nothing to read with nothing asked: the button says so rather than
    // being pressed for no answer.
    assist.disabled = !input.value.trim();
    input.addEventListener("input", () => {
      assist.disabled = !input.value.trim();
    });
    form.append(assist);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSearch(input.value.trim(), ask.mode);
  });
  pane.append(form);

  // Which thing is searched, and how far back. The mode is in the
  // address (a trail search is a different link); the range is the page's.
  const controls = el("div", "search-controls");
  const modes = el("div", "list-filters search-modes");
  modes.setAttribute("role", "tablist");
  for (const [id, label] of MODES) {
    const chip = button("filter-chip", label, () => onMode(id));
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-pressed", String(ask.mode === id));
    chip.setAttribute("aria-selected", String(ask.mode === id));
    modes.append(chip);
  }
  controls.append(modes, rangePicker(SEARCH_RANGES, range, onRange));
  pane.append(controls);
  // And which work is searched at all: this workspace's own repos, and -
  // pressed for - repositories nobody connected here and work in none
  // (console-where.js). A search that cannot reach the repository the
  // work was actually done in is a search that answers "we have never
  // done that" about something done last week.
  pane.append(filterRow(whereFilter(onReread)));

  // What the model has said, if it has been asked - under the box, over
  // the list. Nothing stands here before that: most searches are answered
  // by the list, and a panel that is only ever a button reads as a page
  // half-loaded.
  if (ask.mode === "sessions" && chat?.turns?.length) pane.append(assistPanel({ chat, onAsk, onOpen, pathFor }));

  if (failed) {
    pane.append(problem(`Could not search - ${failed}`));
    return pane;
  }
  if (!data) {
    pane.append(el("p", "console-hint", ask.q ? "Searching…" : "Reading what has been done here…"));
    return pane;
  }

  const parts = ask.mode === "trail"
    ? trailResults({ ask, data, onBucket, onOpen, pathFor })
    : sessionsResults({ ask, kind, provider, data, onKind, onProvider, onBucket, onOpen, pathFor });
  pane.append(...parts);

  // With nothing typed the list is everything this installation has done,
  // newest first, and under it what the range came to - the numbers that
  // were the whole of this page when it was asked nothing.
  if (!ask.q && ask.mode === "sessions") {
    pane.append(usagePanel(stats, { onOpen, pathFor, onSearch, onBucket: (bucket) => onBucket(bucket, "trail") }));
    pane.append(
      el(
        "p",
        "console-hint",
        "Ask what you would ask a colleague: \"how do I trigger a deploy\", \"who set up the LiteLLM proxy\", \"which sessions used the Linear connector\". " +
          "The words are searched always; the meaning too when the installation has a LiteLLM proxy with an embeddings model behind it. " +
          "The access trail is searched by its words alone: a tool, a permission, an agent, a person, \"refused\".",
      ),
    );
  }
  return pane;
}
