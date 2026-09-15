// The Connectors page: the git host a person's pull requests live on.
//
// Three rows, one per host, and each is in one of two states - not
// connected, which is a box and a Connect; connected, which is who it is
// connected as and a way out. That is the whole page, and it is deliberately
// the whole page: what it buys is the one thing this edition could not do
// otherwise, which is to know that a pull request *merged*. Everything else
// on Performance is measured from what a harness reported here; whether a
// person merged the work is a fact only the host holds.
//
// Built from the shared vocabulary rather than its own: `listHead`,
// `listTable` and `listRow` are what every other list page here is made of
// (console-list.js), which is also how it gets its phone layout for free -
// the 860px block drops every cell but the kept one, and the kept one here
// is the status chip that says connected or not.
import { el, button, ago, problem } from "./console-dom.js";
import { listTable, listRow, listHead } from "./console-list.js";

/** What each host's token has to be able to do - the thing people get wrong. */
const TOKEN_NEEDS = {
  github: "A personal access token (classic, or fine-grained) that can read pull requests.",
  gitlab: "A personal access token with the read_api scope.",
  bitbucket: "Your username, and an app password with Pull requests: Read.",
};

/** Where each host hands one out, so nobody has to go looking. */
const TOKEN_PAGE = {
  github: "github.com/settings/tokens",
  gitlab: "gitlab.com/-/user_settings/personal_access_tokens",
  bitbucket: "bitbucket.org/account/settings/app-passwords/",
};

/**
 * The form that connects one: a password box, a username box where the host
 * wants one, and Connect.
 *
 * `type="password"` because a token is a credential and a person pasting one
 * is often on a call with their screen shared. Nothing here remembers it:
 * the field is cleared by the redraw that follows a connection.
 */
function connectForm(row, { onConnect }) {
  const form = el("form", "focus-form git-host-form");
  let username = null;
  if (row.needsUsername) {
    username = el("input", "text-input");
    username.type = "text";
    username.placeholder = "username";
    username.setAttribute("aria-label", `${row.label} username`);
    form.append(username);
  }
  const token = el("input", "text-input");
  token.type = "password";
  token.placeholder = row.needsUsername ? "app password" : "token";
  token.setAttribute("aria-label", `${row.label} token`);
  form.append(token);

  const go = el("button", "ghost-btn", "Connect");
  go.type = "submit";
  form.append(go);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    go.textContent = "Checking…";
    try {
      await onConnect({ token: token.value, ...(username ? { username: username.value } : {}) });
    } catch (err) {
      // Under the form, where the box that was typed into is: the host's
      // own sentence about the token, which is the only thing that says
      // what to do next.
      form.after(problem(err.message));
      go.disabled = false;
      go.textContent = "Connect";
    }
  });
  return form;
}

/**
 * One host's row: the name and whether it is connected, then the one thing
 * to do about it.
 *
 * The chip goes *in* the name rather than in a cell of its own, which is
 * not where this console usually puts one. The reason is the phone: a row
 * keeps exactly one cell below 860px (console.css), and the cell that has
 * to survive here is the form - a page whose only control is hidden at
 * 390px is a page that reads as broken rather than as narrow. So the fact
 * moves into the name, where nothing drops it, and the cell is the doing.
 */
function hostRow(row, { onConnect, onDisconnect, onCheck }) {
  const name = el("span", "list-name-line");
  name.append(row.label);
  name.append(el("span", `chip ${row.connected ? "chip-ok" : "chip-none"}`, row.connected ? "connected" : "not connected"));
  return listRow({
    name,
    note: row.connected
      ? `connected as ${row.account ?? "you"}${row.at ? ` · since ${ago(Date.parse(row.at))}` : ""}`
      : TOKEN_NEEDS[row.host] ?? row.hint ?? null,
    // Where the token comes from, said under the name - it is the question
    // everybody has the first time, and a page that only says what the
    // token needs leaves them looking for the page that makes one.
    aside: row.connected ? null : TOKEN_PAGE[row.host] ? `Make one at ${TOKEN_PAGE[row.host]}` : null,
    live: row.connected,
    cells: [
      { keep: true, node: row.connected ? connectedActions(row, { onDisconnect, onCheck }) : connectForm(row, { onConnect }) },
    ],
    onOpen: null,
  });
}

/** What a connected host offers: ask it now, and stop asking. */
function connectedActions(row, { onDisconnect, onCheck }) {
  const wrap = el("span", "git-host-actions");
  const check = button("ghost-btn", "Check now", async () => {
    check.disabled = true;
    check.textContent = "Checking…";
    try {
      await onCheck(row);
    } finally {
      check.disabled = false;
      check.textContent = "Check now";
    }
  });
  wrap.append(check);
  wrap.append(
    button("danger-btn", "Disconnect", () => {
      // The token goes and the records stay, which is worth saying before
      // somebody presses it.
      if (!window.confirm(`Forget the ${row.label} token? The pull requests already followed stay; nothing new is asked for.`)) return;
      return onDisconnect(row);
    }),
  );
  return wrap;
}

/**
 * The page, wired up.
 *
 * The same `{ draw, read, reread }` every other page module here answers
 * with, so the shell hangs it exactly like the other four
 * (public/local.js).
 */
export function gitHostsPage({ state, api, refresh }) {
  let loading = null;

  const wants = () => state.page === "connectors";

  function load() {
    if (loading) return loading;
    loading = api
      .gitHosts()
      .then(
        (answer) => {
          state.gitHosts = { hosts: answer.hosts ?? [], failed: null };
        },
        (err) => {
          state.gitHosts = { hosts: [], failed: err.message };
        },
      )
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /**
   * After anything that changed a connection: forget what was read and
   * refresh, which reads it again on the way to redrawing. Null rather than
   * an empty list, because "nothing read yet" and "no hosts" would
   * otherwise be the same thing on screen.
   */
  const changed = () => {
    state.gitHosts = null;
    return refresh();
  };

  function draw(pane) {
    const held = state.gitHosts ?? { hosts: [], failed: null };

    const connected = held.hosts.filter((row) => row.connected).length;
    const page = listHead(
      "Connectors",
      held.failed
        ? null
        : `${connected} of ${held.hosts.length} connected`,
      [],
    );

    page.append(
      el(
        "p",
        "console-hint",
        "Connect the git host your work is on and the pull requests you open there are " +
          "followed until they merge or close, and Performance counts them. " +
          "The token stays on this machine: it is kept with your own records, " +
          "it is never sent anywhere but the host it belongs to, and nothing here " +
          "writes - it reads your own pull requests and nothing else.",
      ),
    );

    if (held.failed) {
      page.append(problem(held.failed));
      pane.append(page);
      return;
    }

    if (!held.hosts.length) {
      page.append(el("p", "console-hint", "Reading…"));
      pane.append(page);
      return;
    }

    const table = listTable({ head: ["Host", ""] });
    table.classList.add("git-hosts-table");
    for (const row of held.hosts) {
      table.append(
        hostRow(row, {
          onConnect: async (credential) => {
            await api.connectGitHost(row.host, credential);
            await changed();
          },
          onDisconnect: async () => {
            await api.disconnectGitHost(row.host);
            await changed();
          },
          onCheck: async () => {
            await api.syncGitHost(row.host);
            return refresh();
          },
        }),
      );
    }
    page.append(table);
    page.append(
      el(
        "p",
        "console-hint",
        "Every five minutes, whichever of these is connected is asked what changed. " +
          "Nothing is asked of a host you have not connected.",
      ),
    );
    pane.append(page);
  }

  return {
    draw,
    load,
    // Read on arrival, once. The answer only changes when somebody on this
    // page changes it - a token pasted, a host disconnected - and `changed`
    // forgets it when they do, so a refresh reads it again. Re-reading on
    // every tick of the event stream would be a request per tool call an
    // agent makes, for an answer that cannot have moved.
    read: () => (wants() && !state.gitHosts ? load() : null),
    reread: () => (wants() && !state.gitHosts ? load() : null),
  };
}
