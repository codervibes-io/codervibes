# The local edition

CoderVibes runs on one person's laptop, for that person, and nobody else
can reach it. No sign-in, no token, no account: the console opens on the
address you started it at, everything on it is yours, and the records are
files in a directory you can read.

It is the same program as the hosted product, cut down rather than forked.
Everything the local edition can do, codervibes.io does too; what it
leaves out is everything that only makes sense with other people in it -
workspaces, repo chat, tasks handed between agents, connectors, sandbox
agents, pull request tracking. Four pages remain: **Executors**,
**Performance**, **Search** and **Tools**. What it is for is the thing
those four answer, which is the thing you cannot see from inside a
terminal: what your coding agents actually did, what it cost, and how you
worked with them.

## Running it

```sh
git clone https://github.com/<you>/codervibes
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
product serves, with two things dialled off: it takes no token, because
there is nobody to authenticate, and it configures no MCP server, because
a local installation has no connected services to hand an agent. It does
not touch which model a harness calls or where it sends it; that is yours
to set, in the harness.

Start a session in any of them and it appears on the Executors page.

## What you can set

| Variable | What it does | Default |
|---|---|---|
| `PORT` | the port to listen on; it binds to loopback and nothing else | 3592 |
| `CODERVIBES_DATA_DIR` | the directory the `.codervibes-*.json` documents are written to | the checkout itself |
| `CODERVIBES_MAX_EXECUTORS` | how many machines may be seated at once | 3 |
| `ANTHROPIC_API_KEY` | a key for Explain on the Search page | unset; Explain is off without one |
| `LITELLM_URL`, `LITELLM_KEY` | a proxy to reach a model and an embeddings model through, instead of the key above | unset |

The last two are the only ones that reach the network at all, and only
when you set them: without a model, Search still works - the keyword half
is in-process - and it just cannot explain what it found or match on
meaning rather than words.

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

## What it cannot do

**Performance counts opened pull requests, not merged ones.** "Merged" is
a fact GitHub holds, and reading it means a GitHub App, an installation
and a person signing in - all of which are the hosted product. Locally, a
session that ran `gh pr create` is a session that opened a pull request,
and that is as far as it goes. The number is still useful; it is just a
different number, and the page says which it is showing.

**One CoderVibes per machine.** `~/.codervibes` holds the env file, the
hook script, the shipper and the spool, and the harnesses each have one
settings file that says where to export. The setup line replaces what it
wrote last time, so running the hosted product's line and then the local
one points the machine at the local one, and vice versa. Pick one per
machine, or accept that the last line you ran is the one that is reporting.

**Nothing is shared and nothing is backed up.** The store is files under
`CODERVIBES_DATA_DIR`. Back that directory up if what is in it matters,
because nothing else will.
