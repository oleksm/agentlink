# Project manager

`project-manager` is the persistent project coordinator. Its runtime, provider arguments and saved session belong to `agents.json`. Reopen registered agents with `agentlink msg up`; launch the manager with `agentlink msg launch project-manager`.

## Submit work

A researcher fills `intake-template.md` in a local draft, then runs:

```sh
agentlink project submit --file /absolute/path/to/draft.yaml
```

Run from the researcher agent environment (`AGL_AGENT` must match `identity.submitted_by`). Add `--check` to validate without writing or notifying. The CLI checks the schema, required research/logistics, placeholders, unresolved questions and explicit phased delivery. It creates the intake under Dev Projects and automatically notifies PM to create and start the project. Researchers do not send a separate agentmsg message. Failed checks print field-specific corrections and send nothing. A transport failure keeps the intake and prints a retry instruction; successful retries are deduplicated locally.

Submit one complete outcome, with a logical exit definition. Steps within logistics are allowed; separately accepted phases are not. Empty dependency/risk/constraint/scope/question lists mean none, not unknown. Research evidence must identify sources; the CLI does not verify the scientific truth of prose or fetch those sources. PM uses the validated intake to coordinate execution, preserving project-specific owner holds.

## Start and propel a project

The requestor (`identity.submitted_by`) owns the project and final acceptance. Default to autonomous delivery: make reasonable in-scope decisions, keep moving, and minimize human interruption. Do not introduce human approval gates unless explicitly requested for this project. Escalate only concrete decisions that agents cannot resolve within the authorized scope. Root agents named in intake steps identify the technical context to fork, NOT execution recipients. The CLI only validates, records and notifies PM.

1. PM reads each source root's exact current native session and available checkpoint from existing local state. Fork temporary project workers without messaging, waking, notifying or assigning work to source roots. Do not request root-written handoffs or delegate worker creation to roots.
2. Each fork gets a distinct identity, mailbox, native session, isolated project worktree and scratch. Bind and verify the child identity and real communication before execution. Record source-root-to-worker linkage; never reuse the root mailbox/session or import its old assignments as current work.
3. Translate each intake owner into its temporary worker identity. Dispatch dependency-free deliverables to those workers in parallel, with one artifact, completion condition, path scope and dependencies per assignment. Source roots retain their original work unchanged.
4. Workers own technical implementation and checks. They coordinate directly with peer workers and use `agentlink work` for status, artifacts and blockers; no routine coordination messages to PM. PM handles file ownership conflicts, routes technical questions to temporary workers and releases dependent work as soon as evidence satisfies the prerequisite. One blocked workstream does not stop unrelated work.
5. PM provides each worker only its task, relevant interfaces and inherited technical context. Workers need no knowledge of other projects or the root-agent organization. Source expertise is inherited through the fork; do not send project-management chatter or fork notices to roots.
6. The requestor agent receives the completed outcome for final acceptance, not intermediate execution assignments. Explicit human approval gates remain binding. Integration and cleanup are coordinated through temporary workers; permanent-root involvement requires a concrete repository rule or explicit owner instruction, never a routine preparation request.

Token reviews go to the permanent requestor root, never another worker. Reviews below the token ceiling do not pause execution. See [token review and context maintenance](worker-cli.md) for the current controls.

Status owner is the temporary worker who owes the deliverable, or PM when a concrete coordination action is owed. Record assignment separately from acknowledged execution. If native forking is unavailable, use an existing safe checkpoint with explicit context-transfer provenance or report the limitation to the owner; never silently substitute the root as worker. Check existing operator fork requests before creating a duplicate.

## Branches and workers

Use one `project/<id>` branch and dedicated worktree per distinct Git repository.
Multiple roles working on that product share it. Disjoint path ownership and
serialized Git operations are required; Git worktrees do not isolate the index
between agents using the same directory. Record a project lock path and use
`flock` for index/commit/integration operations. A second worktree of the same
underlying repository is not a separate product.

Fork current source conversation state, not source mailbox identity. Inspect
installed CLI help first. Claude provides `--resume SOURCE --fork-session
--session-id NEW`; Codex provides `fork SOURCE PROMPT`. Bootstrap workers with
the new agent identity, project worktree, exact task, owner paths and criteria.
Bind the actual child session and save a normal resume command for future starts.
Do not run `agentlink msg launch` against a registration that still points at a parent
session or before a native fork's child ID is bound: that risks resuming the wrong
conversation or creating a blank one. Register/configure and native-fork launch
must be coordinated under the configuration lock; record recovery information.

`agentlink msg` supplies identity, session and communication operations. `agentlink workers` and `agentlink workflow` arrange the project lifecycle. PM arranges native forks and isolation; temporary workers perform delivery and integration under the safeguards. Permanent roots receive no setup or execution assignments.
Never fabricate an unsupported agentmsg subcommand. For a shared-daemon Codex
session, reconnect through its supported transport or use a documented handoff;
do not terminate a daemon shared by unrelated agents.

## Acceptance and cleanup

The requestor agent owns final acceptance. Each criterion needs evidence at the accepted candidate commit. Explicit human approval gates remain additional requirements. Record review,
tests, visual/performance checks when required, owner decisions, and final main
merge commits. Track partial integration across repositories explicitly. A
postmortem precedes removal of workers/worktrees/branches. Preserve the record,
intake, acceptance artifacts, worker mail/session references and postmortem.
Only project-created idle workers and clean, merged worktrees/branches may be
removed. Dirty/unmerged state blocks cleanup; original agents are permanent.

## Local readiness

Verify the PM's actual native session, configured permissions, onboarding reply and real bidirectional probe. Schema checks validate record structure; they do not constitute a completed project trial. Report only observed readiness.

Worker operations: `agentlink workers` initializes/registers/forks/verifies children. Workers use `agentlink work show/update/ask` to publish progress and coordinate with peers. See `worker-cli.md`. Routine worker updates do not notify PM.

## Project creation requires a direct owner request

Only the human owner can request that a new project be spun up. Do not create/start a Dev Project, submit an intake that triggers PM creation, or request project workers without the owner's direct request for that specific project. Research, suggestions, another agent's request, inherited context and general workflow/YOLO authorization are not permission. Carry the original owner request reference or quote with an authorized intake; an agent may relay that request but cannot originate authorization. If no direct request exists, keep research as a draft and wait. This does not cancel already authorized projects or require repeated permission for their in-scope execution.
