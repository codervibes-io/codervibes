// Friction: what got in the agents' way, and what would stop it.
//
// The charts above this panel say which option works best; the table below
// says which session did what. Neither answers the question a team has on a
// Friday, which is not about a session at all: what keeps happening? The
// answer is a short list - "no such file ×14, tests failed ×9, permission
// denied ×6" - and every line of it has an owner and a fix. A fixture
// nobody committed. A command the CLAUDE.md does not mention. A permission
// nobody granted.
//
// So: the kinds most-common first, with a bar for the shape of it, what
// each usually means, the one line of what usually fixes it, and up to
// three sessions to go and read. Beside them the two things that stop an
// agent that did not fail - the turns it handed back to a person, and the
// commands it ran over and over.
//
// The fold - by repository, by executor, by week - switches with no
// request: the server hands back all three (index.js
// `/api/performance/friction`), because it is one set of counts read three
// ways and a spinner between them is a spinner between a person and the
// same question asked again.
//
// The counts come from the session records, so this panel says nothing the
// server did not already count (server/friction.js): a kind, never the
// failing line. What that cannot see is under the panel, in the caveat,
// because a number a reader trusts too far is worse than one they do not
// read at all.
import { el, metric, metrics, problem } from "./console-dom.js";
import { filterPicker, filterRow } from "./console-filters.js";

/** The folds, in the order the picker offers them. */
export const FOLDS = [
  { key: "repo", label: "By repository" },
  { key: "executor", label: "By executor" },
  { key: "week", label: "By week" },
];

/**
 * What each kind is called on the page. Short, because it is a row label
 * beside a bar; the sentence that says what it means is the server's
 * (`kinds[kind].means`) and sits under the fix.
 */
export const KIND_LABELS = {
  "not-found": "Not found",
  permission: "Permission",
  "tests-failed": "Tests failed",
  "type-or-syntax": "Type or syntax",
  timeout: "Timed out",
  network: "Network",
  dependency: "Dependency",
  git: "Git",
  other: "Something else",
};

/** How many groups are drawn before the rest are named in a line. */
export const MAX_GROUPS = 5;

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const labelOf = (kind) => KIND_LABELS[kind] ?? kind;

/**
 * One repeated command, as a row can say it. The record keeps a
 * fingerprint rather than the command line (server/friction.js), and the
 * server puts the words back only for a reader who may read that session's
 * words - so a row for anybody else says how many times, which is the part
 * that was ever the point.
 */
const ranAgain = (repeat) => (repeat.title ? `${repeat.title} ×${repeat.times}` : `a command ×${repeat.times}`);

/**
 * One group: what it is called, what its kinds were, and the two counts
 * that are not errors. The bar is against the group's own worst kind, not
 * the page's, so a quiet repository's shape is still readable next to a
 * loud one - the numbers beside the bars are what compares them.
 */
function groupBlock(group, { kinds = {}, onOpen, pathFor }) {
  const box = el("section", "friction-group");
  const head = el("h4", "friction-group-head");
  head.append(el("span", "friction-group-name", group.name));
  head.append(el("span", "friction-group-n", plural(group.sessions, "session")));
  box.append(head);

  const most = Math.max(1, ...group.errors.map((error) => error.count));
  if (!group.errors.length) box.append(el("p", "console-hint", "No failed tool call in the range."));
  const list = el("ol", "friction-kinds");
  for (const error of group.errors) {
    const item = el("li", `friction-kind friction-${error.kind}`);
    const line = el("div", "friction-kind-line");
    line.append(el("span", "friction-kind-name", labelOf(error.kind)));
    const track = el("span", "friction-track");
    const bar = el("span", "friction-bar");
    bar.style.width = `${Math.max(2, (error.count / most) * 100)}%`;
    track.append(bar);
    line.append(track, el("span", "friction-count", `×${error.count}`));
    item.append(line);
    // What it means, then what usually fixes it - and the fix only for a
    // kind that came up more than once, since the server withholds it for
    // a one-off (friction.js `whatToFix`) and a hint under a count of one
    // teaches people to skim the panel.
    const means = error.means ?? kinds[error.kind]?.means ?? null;
    if (means) item.append(el("p", "friction-means", means));
    if (error.fix) item.append(el("p", "friction-fix", `Usually: ${error.fix}`));
    if (error.examples?.length) {
      const links = el("p", "friction-examples");
      links.append(el("span", "friction-examples-label", "Sessions:"));
      error.examples.forEach((id, at) => {
        const path = pathFor("activity", id);
        const link = el("a", "friction-example");
        link.href = path;
        link.textContent = id;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          onOpen(path);
        });
        links.append(link);
        if (at < error.examples.length - 1) links.append(el("span", "friction-sep", "·"));
      });
      item.append(links);
    }
    list.append(item);
  }
  box.append(list);

  const asides = [];
  if (group.handBacks) asides.push(`${plural(group.handBacks, "turn")} handed back to a person`);
  if (group.refusals) asides.push(`${plural(group.refusals, "refusal")} by a permission`);
  if (asides.length) box.append(el("p", "friction-aside", asides.join(" · ")));
  if (group.repeats?.length) {
    box.append(el("p", "friction-aside friction-repeats", `Run over and over: ${group.repeats.map(ranAgain).join(" · ")}`));
  }
  return box;
}

/**
 * The panel.
 *
 * @param {object} args
 * @param {object|null} args.data what /api/performance/friction said
 * @param {string|null} args.failed
 * @param {{by: string}} args.state which fold is showing
 * @param {(state: object) => void} args.onState told the new fold; must not redraw
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 */
export function frictionView({ data, failed, state = { by: "repo" }, onState = () => {}, onOpen = () => {}, pathFor = (page, id) => `/${page}/${id ?? ""}` }) {
  const box = el("section", "console-panel friction-panel");
  box.append(el("h3", "panel-heading", "Friction"));
  if (failed) {
    box.append(problem(`Could not read the friction report - ${failed}`));
    return box;
  }
  if (!data) {
    box.append(el("p", "console-hint", "Reading…"));
    return box;
  }
  const by = FOLDS.some((fold) => fold.key === state.by) ? state.by : data.by ?? "repo";
  const fold = data.folds?.[by] ?? null;
  const totals = fold?.totals ?? null;

  const body = el("div", "friction-body");
  const draw = (picked) => {
    const chosen = data.folds?.[picked] ?? fold;
    body.replaceChildren();
    if (!chosen || !chosen.groups.length) {
      body.append(el("p", "console-hint", "Nothing got in the way in this range - no failed tool call, no turn handed back, no refusal."));
      return;
    }
    for (const group of chosen.groups.slice(0, MAX_GROUPS)) body.append(groupBlock(group, { kinds: data.kinds ?? {}, onOpen, pathFor }));
    const rest = chosen.groups.slice(MAX_GROUPS);
    if (rest.length) {
      body.append(el("p", "console-caveat", `And ${plural(rest.length, "more")}: ${rest.map((group) => group.name).join(", ")}.`));
    }
  };

  // The picker is drawn again with the fold it was set to: it takes what it
  // says on its face from the value it was built with, so redrawing only
  // the body below would leave it saying "By repository" over a page of
  // weeks.
  const head = el("div", "friction-head");
  const pick = (picked) => {
    head.replaceChildren(
      filterRow(
        filterPicker({
          label: "Fold",
          entries: FOLDS,
          picked,
          all: null,
          onPick: (next) => {
            const chosen = next ?? "repo";
            onState({ ...state, by: chosen });
            pick(chosen);
            draw(chosen);
          },
        }),
      ),
    );
  };
  box.append(head);

  if (totals) {
    box.append(
      metrics(
        metric(totals.total, "failed tool calls", totals.errors.length ? `${plural(totals.errors.length, "kind")}, worst is ${labelOf(totals.errors[0].kind)}` : "nothing failed"),
        metric(totals.handBacks, "handed back", "turns that ended asking the person something"),
        metric(totals.refusals, "refused", "a permission said no"),
        metric(totals.repeats.length, "commands repeated", totals.repeats.length ? ranAgain(totals.repeats[0]) : "nothing run three times"),
      ),
    );
  }
  box.append(body);
  pick(by);
  draw(by);
  box.append(
    el(
      "p",
      "console-caveat",
      "Counted from what the harnesses reported, by a fixed list of kinds matched on the failing line - the same rule every week, so the weeks can be compared. A failure the agent recovered from by itself is still counted here: it cost the time either way. A turn handed back may have been exactly the right call; the number is context, not blame. Work whose harness says nothing about how a call ended contributes nothing, which reads as a clean week rather than an unmeasured one. This panel covers the whole range and is not narrowed by the filter above.",
    ),
  );
  return box;
}
