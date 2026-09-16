// Handing somebody a secret, and the panel that hands them the one that
// matters.
//
// These helpers used to live in the New agent wizard, because the only time
// this app gave anybody a token was at the end of one. That is no longer
// true and is now backwards: this app does not start agents, so the token
// and the file are not the last step of making something - they are the
// whole of what a person comes here to get.
//
// So `setupPanel` is the top of the Executors page, always: the line with
// the token in it, on the page a bare address opens. What it says comes from
// the server (harnesses.js `connectYourOwn`), so the words a person copies
// and the words the ingest actually accepts cannot drift apart.
import { api } from "./api.js";
import { el, button, detailHead, chips, ago, metric, metrics, copyLine } from "./console-dom.js";

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** The harnesses the setup script looks for, by the name it finds them under. */
const HARNESS_WORDS = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

/**
 * A list of things to do, each with a command or a block to copy.
 *
 * The shape the server's `connect` answers in - `{title, note, snippet}` per
 * step - and what the invited agent's credentials below are built from, so
 * every page that hands somebody a secret reads the same. The snippet
 * first, because it is the answer to the question being asked; a step with
 * no snippet is a sentence to read.
 */
export function connectSteps(steps, { numbered = false, startAt = 1 } = {}) {
  const wrap = el("div", "modal-stack connect-steps");
  steps.forEach((step, index) => {
    const field = el("div", "modal-field connect-step");
    field.append(el("span", "modal-label", numbered ? `${index + startAt}. ${step.title}` : step.title));
    if (step.snippet) field.append(copyLine(step.snippet));
    if (step.note) field.append(el("span", "cap-hint", step.note));
    wrap.append(field);
  });
  return wrap;
}

/**
 * The token, once, with something somebody can actually do with it.
 *
 * The command first, because it is the answer to the question being asked.
 * This dialog used to hand over a URL and a token and stop, which is complete
 * and is not helpful: nobody's next move is "point an MCP client at /mcp",
 * it is `claude mcp add`, and everybody had to go and look that up while
 * holding a secret that is shown exactly once.
 *
 * The URL and the token stay underneath for everything that is not Claude
 * Code - Cursor and the rest take them in their own settings.
 */
export function credentials(minted) {
  const command =
    `claude mcp add --transport http codervibes ${minted.url} ` +
    `--header "Authorization: Bearer ${minted.token}"`;
  return connectSteps([
    { title: "In Claude Code", snippet: command, note: "Run it on the machine you want the agent to work from, then start Claude Code there." },
    { title: "URL", snippet: minted.url },
    { title: "Token", snippet: minted.token },
  ]);
}

/**
 * One setup's page: a machine of yours that reports here.
 *
 * There is nothing to configure and nothing to stop, because this app did
 * not start it - so the page is what it has done and where, and the way to
 * see the work itself is Search, narrowed to this machine
 * (`/search?machine=<id>`). That link is the whole of the way out of this
 * page: it said "1 session" and named the repository in plain text, with
 * nothing to press, so a person who wanted to see the session it had run
 * had nowhere to go from the page that told them it existed. A setup that
 * has gone quiet keeps its page for a month and then stops being listed:
 * it is built from its sessions, so it lasts exactly as long as they do.
 *
 * @param {object} setup a row from /api/executors of kind "setup"
 * @param {object} args
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 * @param {boolean} [args.sessions] whether to offer the way to its sessions
 *   - Search, narrowed to this machine. True in both editions, which both
 *   have that page; false for a shell whose page set has none, since a
 *   button that goes nowhere is worse than no button.
 * @param {(() => Promise|void)|null} [args.onForget] what Forget does, for an
 *   installation that seats a fixed number of machines and where forgetting
 *   one is how a place comes free (edition.js `MAX_EXECUTORS`). Null - the
 *   default - draws no such button: on an installation with no cap there is
 *   nothing to free and a row that came back the moment the machine reported
 *   again would read as a delete that did not work.
 */
export function setupDetail(setup, { onOpen, pathFor, sessions = true, onForget = null }) {
  const pane = el("div", "detail");
  const where = setup.machine?.host === "laptop" ? "on your own machine" : `on ${setup.machine?.host}`;
  pane.append(
    detailHead(
      setup.name,
      chips(
        el("span", "chip", "your setup"),
        el("span", "chip chip-none", where),
        setup.live ? el("span", "chip chip-ok", "busy") : null,
      ),
    ),
  );
  pane.append(
    el(
      "p",
      "console-hint",
      // Not "on your ingest token": an installation that authenticates
      // nobody has none, and the sentence was a page telling somebody they
      // hold a credential they do not. What it is actually saying - that
      // this row is a machine that turned up rather than a thing anybody
      // made here - is true either way, and is the half worth saying.
      "Found, not made: this reported here and became a row. " +
        "There is nothing here to start or stop - it runs where you run it, and " +
        "this page is what it has told us.",
    ),
  );
  if (setup.setUp) {
    const found = setup.setUp.harnesses?.length ? setup.setUp.harnesses.map((name) => HARNESS_WORDS[name] ?? name).join(", ") : null;
    pane.append(
      el(
        "p",
        "console-hint",
        `Set up ${ago(Date.parse(setup.setUp.at))}` +
          (setup.setUp.os ? ` on ${setup.setUp.os}` : "") +
          (found ? `, with ${found} there` : ", with none of Claude Code, Codex or Gemini CLI installed yet") +
          (setup.sessions ? "." : ". Nothing has run on it yet: start a session and it appears here."),
      ),
    );
  }

  const facts = el("section", "console-panel");
  facts.append(el("h3", "panel-heading", "What it has done"));
  facts.append(
    metrics(
      metric(setup.sessions, plural(setup.sessions, "session"), setup.live ? "one live now" : null),
      metric(setup.filesTouched, plural(setup.filesTouched, "file"), "changed"),
      metric(setup.repos.length, plural(setup.repos.length, "repository", "repositories"), "worked in"),
    ),
  );
  if (setup.repos.length) {
    const list = el("ul", "setup-repos");
    for (const repo of setup.repos) list.append(el("li", null, repo.name));
    facts.append(list);
  }
  facts.append(el("p", "console-hint", setup.lastAt ? `Last heard from ${ago(setup.lastAt)}.` : "Never heard from."));
  pane.append(facts);

  const actions = el("div", "detail-actions");
  // Its sessions, and nothing else's: the button used to open the whole
  // listing, which on an installation with more than one machine is the
  // work of every machine there is and the reader's own job to find this
  // one's in.
  if (sessions && setup.machine?.id) {
    actions.append(button("ghost-btn", "See its sessions", () => onOpen(`${pathFor("search")}?machine=${encodeURIComponent(setup.machine.id)}`)));
  }
  if (onForget) {
    // It asks, because it is not undoable from here and because the row it
    // removes is a month of a machine's history on the page. What it does
    // not do is delete any of that history: the sessions that ran there
    // happened, and stay in Search.
    const forget = button("ghost-btn", "Forget", async () => {
      if (!window.confirm(`Forget ${setup.name}? Its row goes and its place comes free. The sessions that ran on it stay.`)) return;
      forget.disabled = true;
      try {
        await onForget();
      } catch (err) {
        forget.disabled = false;
        pane.append(el("p", "console-error", err.message));
      }
    });
    actions.append(forget);
  }
  if (actions.childElementCount) pane.append(actions);
  return pane;
}

/**
 * The setup line, on the page.
 *
 * It was a button and a dialog, and before that a dialog that asked where
 * this would run and which agent it was for, with a grid of their marks.
 * Every one of those was a thing between a person who had just signed in
 * and the one line they came for - and the line needs none of it: the
 * script works out where it is and what is installed there. So the panel
 * is the line, the sentence that says what it does, the link to read the
 * script first, and the way to take a new token. It is on the Executors
 * page whether or not anything has reported yet, since the page a bare
 * address opens is this one and its first job is getting the first thing
 * onto it.
 *
 * `ingest` is `/api/ingest` as the console holds it: `{token, mintedAt,
 * connect: {command, scriptUrl, places, steps}}`. `steps` is the machine's
 * - the plain setup, the only one offered here; the other places the
 * server describes are for a client that asks. The token is real: it is
 * kept, so the line can be handed over on every visit rather than once,
 * and rotating it redraws the line in place. Except in the demo, where
 * `demo: true` says the token is a sample (ingest-token.js `DEMO_TOKEN`):
 * the line is drawn the same, the panel says what the token is, and there
 * is no New token, since there is nothing to rotate.
 *
 * `failed` is why there is no `ingest`, when the read failed: drawn in
 * place of the line, because "Reading your token…" over a refusal is a
 * panel that waits for good - which is what the demo showed until it had
 * a token to show.
 *
 * @param {{ingest: object|null, failed?: string|null, onChanged: (ingest?: object) => void}} args
 */
export function setupPanel({ ingest, failed = null, onChanged }) {
  const panel = el("section", "console-panel setup-panel");
  let current = ingest;
  const draw = () => {
    panel.replaceChildren();
    panel.append(el("h3", "panel-heading", "Connect your setup"));
    panel.append(
      el(
        "p",
        "console-hint",
        "Run one line where your coding agent runs - your laptop, a sandbox - and its sessions, " +
          "the files it touched and the pull requests it opened show up here as they happen.",
      ),
    );
    if (!current) {
      panel.append(failed ? el("p", "console-error", `Could not read your token - ${failed}`) : el("p", "console-hint", "Reading your token…"));
      return;
    }
    panel.append(connectSteps(current.connect.steps));
    if (current.demo) {
      panel.append(
        el(
          "p",
          "console-hint",
          "The token in that line is a sample, so you can see what you would get: it is not a credential and " +
            "reports nothing. Sign in and the line here carries your own.",
        ),
      );
    }
    const script = el("p", "console-hint connect-script");
    script.append("It reports counts, file paths and what your agent was asked - never anything else on the machine. ");
    const link = el("a", null, "Read the script");
    link.href = current.connect.scriptUrl;
    link.target = "_blank";
    link.rel = "noopener";
    script.append(link, " before you run it.");
    panel.append(script);
    // Nothing to rotate on a sample, and nothing to rotate where there is
    // no token at all (edition.js): a New token on a line that carries none
    // is a button that mints a credential nothing uses, which is worse than
    // no button - it reads as the line having had a secret in it all along.
    if (current.demo || !current.token) return;
    const actions = el("div", "detail-actions");
    const rotate = button("ghost-btn", "New token", async () => {
      // Rotating is not undoable and silently breaks every machine already
      // reporting, so it asks - a mis-click here is a day of missing work
      // that looks like nothing happening.
      if (!window.confirm("Take a new token? Every machine set up with the old one stops being heard until it runs the new line.")) return;
      rotate.disabled = true;
      try {
        current = await api.rotateIngest();
        await onChanged(current);
        draw();
      } catch (err) {
        rotate.disabled = false;
        panel.append(el("p", "console-error", err.message));
      }
    });
    actions.append(rotate);
    panel.append(actions);
  };
  draw();
  return panel;
}
