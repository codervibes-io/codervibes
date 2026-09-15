# The local edition

CoderVibes runs on one person's laptop, for that person, and nobody else
can reach it. No sign-in, no token, no account: the console opens on the
address you started it at, everything on it is yours, and the records are
files in a directory you can read.

It is the same program as the hosted product, cut down rather than forked.
Everything the local edition can do, codervibes.io does too; what it
leaves out is everything that only makes sense with other people in it -
workspaces, tasks handed between agents, the connected services
an agent is lent, sandbox agents. Five pages remain: **Executors**,
**Performance**, **Search**, **Tools** and **Connectors**. What it is for
is the thing those answer, which is the thing you cannot see from inside a
terminal: what your coding agents actually did, what it cost, how you
worked with them, and what became of the work.

## Running it

```sh
git clone https://github.com/codervibes-io/codervibes
cd codervibes && npm install
npm start
```

It prints the address; open it. Then connect the machine:

```sh
curl -fsSL http://127.0.0.1:3592/setup.sh | sh
```

That line configures whichever of Claude Code, Codex, Gemini CLI and
OpenCode is on the machine to export its OpenTelemetry to this process and
to report each session as it happens - the prompt, each tool call and what
came of it, what the agent said back. It is the same script the hosted
product serves, with one thing dialled off: it takes no token, because
there is nobody to authenticate. It does not touch which model a harness
calls or where it sends it; that is yours to set, in the harness.

Start a session in any of them and it appears on the Executors page.

## The three tools your agent gets

The same line writes an MCP server named `codervibes` into every harness it
finds, pointing at `/mcp` on this process. That is the other direction:
reporting is what your agent tells this app, and these are what it can ask
it.

- **`discover`** searches every session this installation has seen, in
  words - what was asked, what was reached for, what was said - and each hit
  says who did it, when, and quotes the lines that matched.
- **`open_session`** reads one of those in full by its id: the ask, the
  calls, the answers. A hit's quote is a fragment; this is how it was
  actually done.
- **`name_session`** says what the session doing the asking is for, in a few
  words. That is its name on the Executors page and in Search; until the
  agent says, it is named after the first line of the ask.

The first two are the point: **ask `discover` before working something out
from scratch.** "How do I trigger a deploy", "where does the rotation
script live" - if one of your agents did it last week, the session that did
it is the answer, and reading it is cheaper than deriving it again. Tell
your agent so in its own instructions file; an agent that never calls
`discover` will rediscover the same thing every Monday.

There is no token on any of it, and none is needed: `/mcp` is checked the
same way every other request here is, against the socket it arrived on, so
it answers this machine and nothing else (below). That is also why there is
no `Authorization` header in any of the config files the line writes.

Three tools and no more. The hosted product's endpoint also carries the repo
chat, tasks handed between agents, and your connected services as tools -
all of which need other people or somebody else's credential, and this
installation has neither.

## Connectors: the git host your work is on

**Connectors** is one page with three rows on it - GitHub, GitLab and
Bitbucket - and a box to paste a token into. Connect one and the pull
requests you open there are followed until they merge or close, which is
what turns "Performance counted an opened pull request" into "Performance
counted a merged one". Nothing else changes, and nothing else is
connected: there is no App to install, no OAuth application to register,
and no callback address a laptop does not have.

What each host's token needs, which is the part people get wrong:

| Host | What to paste | Where it comes from |
|---|---|---|
| GitHub | a personal access token that can read pull requests (classic, or fine-grained) | github.com/settings/tokens |
| GitLab | a personal access token with the `read_api` scope | gitlab.com/-/user_settings/personal_access_tokens |
| Bitbucket | your **username** and an app password with Pull requests: Read | bitbucket.org/account/settings/app-passwords/ |

Bitbucket wants both halves because it signs in with HTTP Basic, and the
username is as much of the credential as the password is.

The token is checked with the host before it is kept, so a wrong one is a
sentence on the page you pasted it into rather than a connection that
silently does nothing. **It stays on this machine**: it is written to your
own records under `CODERVIBES_DATA_DIR`, it is never in anything the
console reads back, and the only address it is ever sent to is the host it
belongs to. Set `CODERVIBES_TOKEN_SECRET` and it is encrypted there too;
without it the token sits in that file the way `~/.git-credentials` sits
in your home directory.

Every five minutes each connected host is asked one question - *my own
pull requests, updated since* - and what comes back is matched to your
sessions by repository and branch. Nothing has to have told this app that
a pull request was opened: a session says which branch its checkout was
on, the pull request says which branch it came from, and that is the whole
of the link. **Check now** asks straight away rather than waiting for the
clock.

Nothing here writes. It reads your own pull requests and nothing else - it
cannot open one, comment on one or merge one, and a token narrowed to read
is the right token for it. **Disconnect** forgets the token and stops the
asking; what was already followed is what happened, and stays.

Until you connect one, nothing on a timer reaches the network at all.

## What you can set

| Variable | What it does | Default |
|---|---|---|
| `PORT` | the port to listen on; it binds to loopback and nothing else | 3592 |
| `CODERVIBES_TOKEN_SECRET` | encrypts a connected git host's token where it is written | unset; the token is kept as it is |
| `CODERVIBES_DATA_DIR` | the directory the `.codervibes-*.json` documents are written to | `~/.codervibes/data` - beside your home directory, not beside the checkout, so a `git clean` or a second clone does not take the records with it |
| `CODERVIBES_MAX_EXECUTORS` | how many machines may be seated at once | 3 |
| `ANTHROPIC_API_KEY` | a key for Explain on the Search page | unset; Explain is off without one |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | a proxy to reach a model and an embeddings model through, instead of the key above - the address ends in `/v1` | unset |

The model variables are the only ones that reach the network, and only
when you set them: without a model, Search still works - the keyword half
is in-process - and it just cannot explain what it found or match on
meaning rather than words. The other thing that reaches the network is a
git host, and only once you connect one on the Connectors page.

## Only this machine

Two things keep it yours, and it needs both.

The process binds to `127.0.0.1`, and every request is checked against the
socket it arrived on: anything that is not `127.0.0.0/8` or `::1` is
answered 403 and logged. The second check is not redundant. Binding to
loopback is undone the moment somebody puts ngrok, Tailscale Funnel or an
nginx `proxy_pass` in front of it - usually to read the console from a
phone, which is a reasonable thing to want and a catastrophic thing to do
to a server with no sign-in. The proxy connects from off the machine, and
the peer address on the socket is the one thing it cannot rewrite.

So there is no way to share a local CoderVibes, on purpose. If you want
other people to see this, that is what the hosted product is for.

## Three executors, and forgetting one

An executor is a machine that reports here. The local edition seats three
of them, and the fourth is refused - the machine's setup is told so, with
a 409 and a sentence saying what the cap is; its hooks' events are dropped
rather than queued forever.

To make room, forget one: open the machine on the Executors page and press
Forget. That drops the machine's row and frees its place. It does not
delete the sessions that ran on it - those happened, and they stay on the
Activity list and in Search - and it is not a block list: the machine
comes back if it connects again and there is room.

Three is `CODERVIBES_MAX_EXECUTORS`, so raise it if a laptop, a desktop
and two sandboxes is what your week actually looks like.

## Carrying a session on

Open a session - from Search, or from a machine's page - and there is a
**Reconnect** button under the links at the top. It opens a dialog holding
the line that picks the conversation up where it stopped (`claude --resume
<id>` for Claude Code, its own for Codex and OpenCode) and, beside it, the
session id on its own with a Copy button, for a harness this app has no
line to type. Two things the dialog says, because both are how this goes
wrong: run it **on the machine the work was done on** - the harness files
the conversation there and the id means nothing anywhere else - and
reconnecting to a session that is still live *follows* the conversation
rather than taking it over. The button is there only when the harness has
told us an id it would recognise.

## What it cannot do

**Performance counts opened pull requests until you connect a git host.**
"Merged" is a fact the host holds, and until there is a token to ask with,
a session that ran `gh pr create` is a session that opened a pull request
and that is as far as it goes. Connect the host on the Connectors page
above and the same sessions start saying what became of the work.

**One CoderVibes per machine.** `~/.codervibes` holds the env file, the
hook script, the shipper and the spool, and the harnesses each have one
settings file that says where to export. The setup line replaces what it
wrote last time, so running the hosted product's line and then the local
one points the machine at the local one, and vice versa. Pick one per
machine, or accept that the last line you ran is the one that is reporting.

**Nothing is shared and nothing is backed up.** The store is the
`.codervibes-*.json` files in `~/.codervibes/data`, or wherever
`CODERVIBES_DATA_DIR` points instead - `npm start` prints the directory it
settled on. Back *that* directory up if what is in it matters, because
nothing else will; it is not under the checkout, so backing the checkout up
backs none of it up.
