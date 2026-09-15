# CoderVibes, local edition

Watch what your coding agents actually do.

Claude Code, Codex, Gemini CLI and OpenCode each run in a terminal and
leave nothing behind but scrollback. This reads what they did - every
session, every prompt, every tool call and what came of it, what each one
cost and how long you spent waiting on it - and puts it on five pages you
can open in a browser.

It runs on your laptop, answers on your laptop, and stores its records in
`~/.codervibes/data` - beside your home directory rather than beside the
checkout, so a `git clean` or a second clone is not a month of work gone.
There is no sign-in because there is nobody else: it refuses any request
that did not come from this machine.

## Start it

```sh
git clone https://github.com/codervibes-io/codervibes
cd codervibes
npm install
npm start
```

Then connect this machine:

```sh
curl -fsSL http://127.0.0.1:3592/setup.sh | sh
```

That configures whichever harnesses are installed to export here and to
report each session as it happens. Run a session in any of them and it
shows up. Run the line again after installing another harness; it replaces
what it wrote and nothing else.

It does not touch which model your harness calls, or where it sends it.
That is yours to set, in the harness, and this has no opinion about it.

## Three tools for your agent

The same line gives every harness it finds an MCP server named
`codervibes`, with three tools - so your agent can read the record it has
been filling:

- **`discover`** - search every session this installation has seen, in
  words. Each hit says who did it, when, what they reached for, and quotes
  the lines that matched.
- **`open_session`** - read one of those in full: the ask, every call, what
  was answered.
- **`name_session`** - say what the current session is for, in a few words.
  That is its name on the Executors page and in Search.

**Tell your agent to ask `discover` before working something out from
scratch.** "How do I trigger a deploy", "where does the rotation script
live" - if one of your agents did it last week, the session that did it is
the answer.

No token on it, and none needed: `/mcp` answers this machine only, the same
way the console does.

## The five pages

**Executors** - the machines reporting here, what runs on each, and when
each last did anything. A machine's page shows its sessions and lets you
forget it. Three machines at a time; `CODERVIBES_MAX_EXECUTORS` changes
that.

**Performance** - what the work cost and how it went, over whatever range
you pick: spend by model, tokens, how much of the clock was the agent
working and how much was it waiting on you, how often a turn ended on a
question. Compare two harnesses, or two weeks.

**Search** - one box over every session this installation has seen. Ask
"how did I get the deploy working" and get the session that did it, with
the matching lines quoted, and open it whole - the prompt, each tool call,
what the agent answered. Keyword search runs in the process and needs
nothing configured; with a model key set, it also explains what it found
and matches on meaning rather than words.

**Tools** - which tools your agents actually reach for, how often each
one fails, and which skills got used.

**Connectors** - the git host your work is on: GitHub, GitLab or
Bitbucket, connected by pasting a token. The pull requests you open there
are then followed until they merge or close, and Performance counts them
rather than only counting the ones it saw opened. GitHub wants a personal
access token that can read pull requests; GitLab wants one with `read_api`;
Bitbucket wants your username and an app password with Pull requests:
Read. Nothing here writes, and the token stays on this machine - it is
kept with your own records and sent nowhere but the host it belongs to.
Connected hosts are asked once every five minutes, or when you press Check
now; nothing is asked of a host you have not connected.

## What you can set

| Variable | What it does |
|---|---|
| `PORT` | the port to listen on (default 3592) |
| `CODERVIBES_DATA_DIR` | where the records are written (default: `~/.codervibes/data`) |
| `CODERVIBES_MAX_EXECUTORS` | how many machines may report here (default 3) |
| `ANTHROPIC_API_KEY` | enables Explain on the Search page, and semantic matching |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | use a proxy for the above instead of a key |
| `CODERVIBES_TOKEN_SECRET` | encrypts a connected git host's token where it is written |

Nothing here reaches the network unless you set one of the model
variables, or connect a git host on the Connectors page.

## What it does not do

- **Pull requests are counted as opened until you connect a git host.**
  Knowing that one merged means asking the host, and asking means a token.
  Paste one on the Connectors page and the counting changes; until then
  Performance says "opened" and means it.
- **It is one person's.** No workspaces, no sharing, no link you can send
  somebody. Putting a tunnel in front of it does not work either - the
  server checks the socket, not a header, and answers 403.
- **One per machine.** `~/.codervibes` and your harnesses' settings files
  hold one destination, so the last setup line you ran is the one that is
  reporting.

## Licence

MIT.

---

This is the local cut of [codervibes.io](https://codervibes.io), which is
the same thing with other people in it: workspaces, a room your agents can
talk in, tasks handed between them, and your connected services as tools
alongside the three above. The local edition is a strict subset - nothing
here is missing from it.
