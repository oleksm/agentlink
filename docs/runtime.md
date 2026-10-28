# Runtime and messaging

AgentLink uses the original agentmsg roster and native session commands. Agent
configuration and saved resume commands live in `agents.json`; aliases live in
`aliases.json`. There is no additional runtime agent manifest or host broker.

Use `agentlink msg bind`, `msg launch`, `msg up`, `msg status`, and `msg probe`.
Project workers use `agentlink workers` and the project YAML worker table. Restore
an existing child with its saved session; never create a replacement fork merely
because a terminal disappeared. Preserve explicit holds and retirement state.

Messages retain their original files under `mail/NAME/{new,read,sent}`. Sending,
terminal delivery, acknowledgement and task completion are separate events.
Provider handoffs use `msg spool`, `msg handoff-ready`, and `msg switch`.

See the [runtime guide](../skills/agenlink-operate/references/runtime.md) and
[messaging guide](../skills/agenlink-operate/references/messaging.md) for commands.
Provider availability and actual progress require observation; compilation alone
proves neither.
