# CoderVibes, local edition

Watch what your coding agents actually do.

Claude Code, Codex, Gemini CLI and OpenCode each run in a terminal and
leave nothing behind but scrollback. This reads what they did - every
session, every prompt, every tool call and what came of it, what each one
cost and how long you spent waiting on it - and puts it on four pages you
can open in a browser.

It runs on your laptop, answers on your laptop, and stores its records in
a directory beside the checkout. There is no sign-in because there is
nobody else: it refuses any request that did not come from this machine.

## Start it

```sh
git clone https://github.com/codervibes/codervibes-local
cd codervibes-local
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

## The four pages

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

## What you can set

| Variable | What it does |
|---|---|
| `PORT` | the port to listen on (default 3592) |
| `CODERVIBES_DATA_DIR` | where the records are written (default: the checkout) |
| `CODERVIBES_MAX_EXECUTORS` | how many machines may report here (default 3) |
| `ANTHROPIC_API_KEY` | enables Explain on the Search page, and semantic matching |
| `LITELLM_URL`, `LITELLM_KEY` | use a proxy for the above instead of a key |

Nothing here reaches the network unless you set one of the last two.

## What it does not do

- **Pull requests are counted as opened, not merged.** Knowing a pull
  request merged means asking GitHub, which means an app and a sign-in.
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
talk in, tasks handed between them, your connected services as tools, and
pull requests followed from opened to merged. The local edition is a
strict subset - nothing here is missing from it.
