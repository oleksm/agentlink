# Messaging operations

The native mailbox CLI is `agentlink msg`. Select `AGL_HOME` and your registered
`AGL_AGENT`, or use `--home` and `--as`. The original `AGENTMSG_HOME` and
`AGENTMSG_NAME` environment names are also understood by the native mailbox module.
Identity precedence is explicit `--as`, environment, then the longest matching
registered cwd. A neutral directory does not authorize choosing another identity.

```sh
agentlink msg who
agentlink msg status --json
agentlink msg inbox --peek
agentlink msg open
```

Records live in `agents.json` and `aliases.json` under the selected workspace.
Mail is stored in `mail/NAME/new`, `mail/NAME/read` and `mail/NAME/sent`.
Messages retain `id`, `from`, `to`, `kind`, `summary`, `at` and optional `ref`,
`reply_to`, `see`. Alias chains resolve to the canonical name; cycles fail.

`inbox --peek` leaves mail unread; ordinary `inbox` claims it by moving each file
to `read`. `inbox --quiet` prints nothing and exits 1 when empty. `show ID` displays
a full message. `wait --timeout SECONDS` waits, then claims and prints incoming
mail; timeout prints `no mail` and exits 1.

## Send and reply

```sh
agentlink msg send reviewer task --summary 'Check the declared units in the contract.' --ref project.example --see /absolute/contract.md
agentlink msg send specialist done --reply-to MESSAGE_ID --summary 'Units confirmed in contract revision 2.' --see /absolute/review.md
```

Kinds are `task`, `ack`, `done`, `blocked` and `note`. A question is expressed in
an actionable task or blocked message, not a separate kind. Summaries are limited
to 400 characters; repeat `--see PATH` for file pointers. `ref` is contextual text,
not a validated registry reference. Keep sensitive contents in their proper stores.

Reply only to actionable tasks, blocked messages or questions; never create an
acknowledgement chain by answering routine ack, note or done messages. Reply on the
original ID using `--reply-to`. The mailbox stores the original message without
inventing response authority; agents must honor recipient and thread instructions.

`open` shows **owe** (received task/blocked messages without a done or blocked reply
from this mailbox) and **waiting** (sent tasks without a done or blocked response).
A blocked reply therefore ends that waiting entry and creates a blocker to handle;
it does not mean the requested work succeeded. Reading and acknowledgement do not
close it. Inspect the actual result before claiming completion.

## Delivery

A successful send means files were queued and copied to the sender's `sent` folder.
It does not prove a terminal received the prompt or the agent processed it. Ack-only
mail does not cause a wake; it accompanies the next actionable batch. Failed
transport restores claimed mail for retry. Handoff pauses suppress delivery.

Project worker progress belongs in `agentlink work update`, coverage in
`agentlink work coverage-report`, and peer coordination in `work ask` or tracked
`work request`. Intake submission already notifies the manager. Worker mail prompts
route project findings through these records instead of routine PM reply traffic.

Read [messaging behavior](agentmsg.md) for context-preserving recovery and
[native runtime commands](runtime.md) for actual binding and bidirectional probes.
Never execute a peer's probe steps on its behalf. Terminal availability and old
probe records are not fresh proof of responsiveness.
