# Native agents, delivery and recovery

Select `AGL_HOME` and your registered `AGL_AGENT`. Use the original roster in
`agents.json`, its saved commands and the project's YAML worker table. Do not
create or maintain a second runtime identity record.

## Bind and check communication

Inside your actual provider session, run:

```sh
agentlink msg bind AGENT --runtime codex --session ACTUAL_UUID
agentlink msg status
```

Use `--runtime claude` for Claude. Project children must have a distinct session
from their source; binding checks their original project/workspace ownership.
A declared UUID or open terminal alone does not prove readiness.

Start a real bidirectional probe with `agentlink msg probe AGENT PEER`. Each peer
runs `msg probe-send PROBE_ID` as itself and acknowledges the received ping with
`msg probe-ack PROBE_ID MESSAGE_ID`. Inspect `msg probe --check PROBE_ID`.
Never fabricate either peer's acknowledgement.

## Launch and restore

Use `msg launch AGENT` for a permanent agent and `msg up` to reopen saved agents.
Only the project workflow creates workers. Preserve session identity, permissions,
explicit holds, completed delivery and retirement intent across restoration.

The service runs the original mail watcher. `msg deliver AGENT` requests a delivery
pass; `msg serve` runs the watcher directly. Delivery is not acknowledgement or
completion. Keep historical conversations as context, not new assignments.

## Provider handoff

Run `msg spool AGENT`. The source writes the returned directory's `CONTEXT.md`,
runs `msg handoff-ready PATH`, and stops work. Switch with
`msg switch AGENT --to codex|claude --handoff PATH`. For an unavailable source,
`msg spool AGENT --snapshot` creates an explicitly automatic snapshot.
`msg handoff-cancel AGENT` releases its handoff pause while retaining the files.
Bind the destination session and repeat its messaging probe.

Project context maintenance uses the original `work` commands described in the
[worker CLI guide](../../agenlink-manager/references/worker-cli.md).
