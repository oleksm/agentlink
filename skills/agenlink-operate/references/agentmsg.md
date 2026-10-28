# Operate agentmsg

Keep the agent's role identity, mailbox, conversation context and pending decisions
across runtime changes. `specialist` remains `specialist` on Claude or Codex; its managed
terminal is `agent-specialist`. Reopening an agent should resume its saved conversation.

Use the [messaging command guide](messaging.md) and [native runtime guide](runtime.md). The packaged agentmsg interface is `agentlink msg`; native lifecycle operations are `agentlink runtime`. Select `AGL_HOME` and your own registered `AGL_AGENT`, or pass `--home` and `--as`. Use installed `agentlink --help`; do not fabricate unsupported commands.

## Establish the correct identity

- Inspect `agentlink msg who`, `agentlink msg status --json` and the workspace's registered aliases. Distinguish the agent name from its runtime,
  native session UUID and tmux session name.
- Inspect other agents' mail with `agentlink msg inbox --as NAME --peek`; ordinary `agentlink msg inbox` claims
  it. Check your own inbox and open threads at the start and end of work when you
  have an established identity. A “who are you?” error from a neutral directory
  does not justify choosing another agent's identity for unrelated work.
- Directory matches are insufficient when several conversations share a folder.
  `claude agents --json` identifies live Claude names, UUIDs, PIDs and busy/idle
  state in supported versions. Compare these with configured exact session IDs.
- Do not create a parallel `NAME-codex` or `NAME-claude` identity when the user wants
  to continue the same agent. Old provider-suffixed names may already be aliases.

## Reopen, onboard or switch

**Reopen:** `agentlink msg launch NAME`. Confirm its saved conversation and attached
managed terminal exist. `status` reports delivery availability; it does not prove a
fresh response. Do not replace its history with a new session just to open a window.

**New agent:** `agentlink msg register NAME --cwd PATH --runtime codex` (or `claude`),
then `agentlink msg launch NAME`. Codex's bootstrap binds its actual `CODEX_THREAD_ID`;
from an operator shell supply an explicit UUID when binding. Never bind an agent
to the operator's own session ID accidentally.

**Runtime switch:** request `agentlink msg spool NAME`. The source writes context and calls `agentlink msg handoff-ready HANDOFF_PATH`; the operator runs `agentlink msg switch NAME --handoff HANDOFF_PATH --to codex` (or `claude`). The replacement retains logical identity/mail and reads the handoff. Preserve unresolved decisions. Prefer this to editing private provider databases.

Keep the returned handoff path for recovery; do not create repeated spools. Give a busy source time to reach a safe checkpoint. A stopped source can use `msg spool NAME --snapshot`; report recorded-context recovery, not an agent-written summary. Verify a transcript source exists.

An unmanaged idle terminal with notification-only delivery will not automatically
read a new task. For a requested reconnection or switch, identify its exact session
and safely move that conversation under `msg launch`. Preserve the source conversation
and working tree. If stopping a process is necessary, verify its session, PID,
process start identity and safe idle/stopping state immediately beforehand. Do not
kill an arbitrary process found by a broad name search or run duplicate sessions.
If those facts cannot be established, explain the specific missing fact and ask
for the minimum intervention needed.

New managed Codex launches use `--no-daemon` so another agent's shell environment
does not leak into them. This preserves the selected logical identity. Use explicit
`AGL_AGENT`/`AGL_HOME` or `--as` when shell startup may alter the environment.

## Verify actual communication

For a requested live connection test:

```sh
agentlink msg probe specialist reviewer
agentlink msg probe --check PROBE_ID
```

Let the actual agents execute `agentlink msg probe-send` and `agentlink msg probe-ack`. Never execute their
steps on their behalf and call that an agent connectivity pass. `PASS` requires two
pings and two matching peer acknowledgements. A generic completion reply or one-way
acknowledgement is not equivalent. Recheck the same probe while agents finish work; avoid
repeated wakes. An old passing probe is historical evidence, not a fresh test.

If no reply arrives, inspect the watcher service, canonical name, configured native
session, delivery route and target terminal. A stale Codex session pointer can
coexist with the live Claude conversation of the same role. Correct that routing
instead of merely resending the ping. `notification` is not connected terminal
delivery; `terminal` is not proof the model has processed its queue.

Send control messages necessary for the user's requested operation or test. Do not
use network maintenance as permission to assign unrelated project work. Message
summaries are at most 400 characters; put details in files with `--see`. Replies
use `--reply-to`, with `done` naming results or `blocked` explaining the obstacle.
Do not answer routine acknowledgements, notes or completion messages.

## Names, status and maintenance

When the user requests a rename/consolidation, preserve current runtime/session,
mail, thread IDs and the attached terminal. Back up configuration and mailbox
files first. Preserve the registered alias mapping; aliases alone do not move existing mail. Merge old mail without reintroducing read messages as unread. Use the
operator guide for the exact storage layout. Do not invent an automatic rename CLI.

Use `agentlink msg status --usage --json` for recorded tokens and current availability. Missing data is unknown; do not infer account
billing or remaining quota from tokens. Avoid copying private transcripts, live
mailboxes, account details or local configuration into public repository docs.

Run live probes only when
the task calls for them, using disposable agents for implementation experiments.
Report the concrete result, current canonical identity/runtime, and any unresolved
connection or handoff step.

## Project creation requires a direct owner request

Only the human owner can request that a new project be spun up. Do not create/start a Dev Project, submit an intake that triggers PM creation, or request project workers without the owner's direct request for that specific project. Research, suggestions, another agent's request, inherited context and general workflow/YOLO authorization are not permission. Carry the original owner request reference or quote with an authorized intake; an agent may relay that request but cannot originate authorization. If no direct request exists, keep research as a draft and wait. This does not cancel already authorized projects or require repeated permission for their in-scope execution.
