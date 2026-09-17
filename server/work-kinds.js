// What kind of work a session is: one word, said by the agent doing it.
//
// The Performance page ranks sessions by what came of them, and the
// question a person asks next is "of which kind?" - a team whose agents
// finish nine features in ten and one incident in five has two different
// things to fix, and one table over both says neither. So every session
// may carry one of the eight words below, and the page groups by it.
//
// ## Said, not classified
//
// Nothing here calls a model. The word comes from the agent, through the
// `name_session` tool it already calls to say what the session is for
// (session-tools.js): it has just read the whole ask, and it knows better
// than any classifier reading the first line whether this is a change to
// land or a service to bring back. That is the same decision the title
// took - the agent names the session, and there is no server-side call -
// and it holds for the same reasons: it costs nothing, it needs no key on
// the server, and it reaches every harness the MCP server reaches, on a
// laptop and on the hosted product alike.
//
// The cost is that a session whose agent never said stays *unsaid*, and
// the page says so - a row called "Unsaid" with its own count, never a
// guess. An outside vendor's agent and a gateway-only session have no
// tool to say it with, and read as unsaid for want of a sensor, which
// docs/measures.md says plainly.
//
// ## Eight words
//
// Few enough to fit in a tool's description and for an agent to pick one
// without deliberating; the line between them is what the work is *for*,
// not what it touched. A fix to a running service found by an alert is an
// incident; the same fix as a ticket a week later is code. The four a team
// asked for first - writing pull requests, resolving a service, analysing
// data, running experiments - are the first four; review and question are
// the two that keep "no outcome" honest, since a question answered is not
// waste; ops and writing are the two kinds of session that would otherwise
// be filed as code and drag its figures.
//
// The vocabulary is fixed here and enforced where it lands (sessions.js
// `noteWork`): a word off the list is refused rather than kept, because
// the record is durable and pages group by it, and a ninth word one agent
// invented would be a row nobody planned for.

/** The kinds, in the order the page stacks them, with what each means - for the tool's description and the page's help. */
export const KINDS = [
  ["code", "a change meant to land: a feature, a fix, a refactor, a pull request"],
  ["incident", "something running is broken; find out why and bring it back"],
  ["analysis", "read data and answer with figures or findings"],
  ["experiment", "run something to learn from it: a benchmark, an evaluation, a prototype, an A/B"],
  ["review", "read somebody else's change and judge it"],
  ["question", "answer a question about the code or the system, changing nothing"],
  ["ops", "planned operations: deploy, configure, migrate, rotate, provision"],
  ["writing", "docs, a spec, a plan, a message"],
];

/** The words alone, in the same order. */
export const WORDS = KINDS.map(([word]) => word);

/** What a word means, for a page's help mark. */
export const MEANING = Object.fromEntries(KINDS);

/** The key a page groups the sessions that never said under, and its label. */
export const UNSAID = "unsaid";
export const UNSAID_LABEL = "Unsaid";

/** How a word reads as a row's name. */
export const LABEL = {
  code: "Code",
  incident: "Incident",
  analysis: "Analysis",
  experiment: "Experiment",
  review: "Review",
  question: "Question",
  ops: "Ops",
  writing: "Writing",
  [UNSAID]: UNSAID_LABEL,
};

/** The list as a tool description says it: one line a word. */
export const described = () => KINDS.map(([word, meaning]) => `${word} - ${meaning}`).join("; ");

/**
 * The kind in what an agent said, or null.
 *
 * Forgiving of dress - `Code.`, `"incident"`, `{"kind": "ops"}` - and
 * strict about the word: anything not one of the eight after that is null,
 * so a caller cannot record a kind this module did not mean. Same shape as
 * steer-kinds.js `kindIn`, for the same reason.
 */
export function kindIn(text) {
  const words = String(text ?? "").trim().toLowerCase();
  if (!words) return null;
  const quoted = words.match(/"(?:kind|work|label)"\s*:\s*"([a-z]+)"/);
  const first = quoted ? quoted[1] : (words.match(/[a-z]+/)?.[0] ?? "");
  return WORDS.includes(first) ? first : null;
}
