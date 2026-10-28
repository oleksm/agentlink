# Agenlink

Local agent management in Node.js and TypeScript: registry, project
manager, threaded messaging, native agent sessions and evidence-driven workflows.
Workspace data stays outside the installed package. Linux, Node.js 24+, Git and
tmux are required for managed native sessions. Bounded experiments also require a
systemd user manager with CPU and memory cgroup support; supported providers are Codex and
Claude Code with their own authentication.

## Installation

Build with `npm install` and `npm run build`, then install the package.
Initialize a workspace with `agentlink init --home PATH` and install the bundled
skills with `agentlink skills install --dest DIRECTORY`.

Use the original `agentlink msg register`, `msg bind`, `msg launch` and `msg up`
commands. Registry and project-manager must be registered in the workspace.
Start the registry and workflow service with `agentlink serve --workflow --home PATH`.

Manifest provisioning, named-installation `up`, bootstrap, doctor and custom hook
orchestration have been removed with the duplicate installation layer.

## Guides and skills

| Operation                                                  | Guide                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bootstrap, service and diagnostics                         | [Installation skill](skills/agenlink-install/SKILL.md)                                     |
| SME, manager, worker and requestor duties                  | [Operation skill](skills/agenlink-operate/SKILL.md)                                        |
| Permanent project-manager duties                           | [Manager skill](skills/agenlink-manager/SKILL.md)                                          |
| Permanent registry-keeper duties                           | [Registry skill](skills/agenlink-registry/SKILL.md)                                        |
| Threaded mail and reply semantics                          | [Messaging](skills/agenlink-operate/references/messaging.md)                               |
| Launch, fork, verify, handoff and usage                    | [Native runtime](skills/agenlink-operate/references/runtime.md)                            |
| Schemas, records, references and ownership                 | [Registry tooling](skills/agenlink-operate/references/registry.md)                         |
| Provisioning, checkpoints, recovery and retirement         | [Managed lifecycle](skills/agenlink-operate/references/lifecycle.md)                       |
| Researched intake, measurement evidence and final closeout | [Planning and closeout](skills/agenlink-operate/references/planning-and-closeout.md)       |
| Human decisions, named holds and follow-up                 | [Owner actions](skills/agenlink-operate/references/owner-actions.md)                       |
| Exact AC traces, input reuse and guarded merges            | [Coverage and integration](skills/agenlink-operate/references/coverage-and-integration.md) |

Install all four bundled skills into a client's configured directory:

```sh
agenlink skills install --dest "$HOME/.codex/skills"
# Or use the configured Claude skills directory.
```

Skill installation fills missing bundle files and rejects differing existing files.
Preserve customized instructions and reconcile changes before rerunning
`skills install --dest DIRECTORY`.

## Workflow

Select `AGL_HOME` and your registered `AGL_AGENT`, or pass `--home` and `--as`.
Project, intake and retrospective objects use the installation’s canonical YAML schemas unchanged.
The [intake template](skills/agenlink-manager/references/intake-template.md) describes
the required research, authorization, deliverables and feasibility evidence.

```sh
agentlink project submit --file draft.yaml --check
agentlink project submit --file draft.yaml
agentlink project list
agentlink project show PROJECT
agentlink project check PROJECT
```

Only the human owner's direct request authorizes a new project. An import registers
an existing original-schema record without starting execution:
`agentlink project import --file record.yaml`. Submission records the authorized
intake and notifies the manager; do not send a second notification.

The manager prepares distinct product worktrees and temporary workers:

```sh
agentlink workers workspace PROJECT PRODUCT
agentlink workers init PROJECT SOURCE --product PRODUCT
agentlink workers start PROJECT WORKER
agentlink workers verify PROJECT WORKER
agentlink workers status PROJECT
agentlink workflow enable PROJECT
agentlink workflow tick PROJECT
```

Workers inherit context from the exact source session while keeping separate
identities, mailboxes, sessions and scratch. Verify actual binding and bidirectional
communication before dispatch. Permanent roots are context sources, not fallback
workers. Workers sharing a product share its branch/worktree and serialize Git
operations under the recorded lock; file ownership changes require a handoff.

```sh
agentlink work show PROJECT
agentlink work update PROJECT C1 in-progress --detail 'Current findings and next checkpoint'
agentlink work update PROJECT C1 completed --artifact /absolute/result --evidence /absolute/check.log --detail 'Measured outcome and candidate commit'
agentlink work coverage-plan PROJECT --file plan.yaml
agentlink work coverage-report PROJECT --file report.yaml
agentlink work coverage-status PROJECT
```

Only the assigned worker publishes its delivery. The requestor reviews changed
coverage contracts. Cases copy exact AC conditions; declared inputs include
implementation, tools, configuration, dependencies and datasets. Evidence can be
reused while those inputs, hashes and contracts remain unchanged. Missing or stale
evidence cannot become an automatic pass.

Workflow prepares integration before final acceptance. The original requestor
independently checks the proposed solution and every exit condition against the
current snapshot:

```sh
agentlink work review-template PROJECT --output review.yaml
agentlink work accept PROJECT --review review.yaml --evidence acceptance.md --detail 'Independent outcome findings'
# Or: agentlink work reject PROJECT --review review.yaml --detail 'Failed outcome findings and bounded correction'
```

Delivery is not acceptance. Human holds remain independent. Integration rechecks
accepted candidate and target commits under repository locks and records each
product separately; it does not push or reset unrelated changes. Worker retirement
requires exact idle-child verification; cleanup preserves dirty or unmerged work.
The postmortem precedes resource removal. The factual retrospective follows verified
integration and cleanup; PM submits it with `agentlink work retrospective PROJECT
--file review.yaml`, and the original requestor supplies the concluding document.
Closed records and evidence remain browsable.

Read the [complete worker and manager command guide](skills/agenlink-manager/references/worker-cli.md)
for peer requests, execution tracks, token reviews, work budgets, gate
corrections, owner actions, supervision and closeout.

## Registry and web console

The registry serves the original record browser: search, root/register navigation,
schema descriptions, linked records and documents, project status and workflow
actions, coverage readiness and retrospective pages. Native project data lives in
`registry/DevProjects/metadata/{intakes,projects,closed-projects,retrospectives}`.
The installation’s `registry/DevProjects/schema/*.schema.yaml` files define these records;
no renamed project model or positional AC conversion is required.

Generic registry tooling reads the same original YAML tree: exact lookup, all-word
search, schema-defined null/TODO drafts, YAML field edits, local schema/reference
checks, schema lint and generated-field ownership. Public records have dotted
identity keys and retain their declared fields without a wrapper.
See [registry operations](skills/agenlink-operate/references/registry.md).

The web console is a trusted loopback owner interface. Same-origin checks and
session tokens protect writes; named holds and proposal decisions retain independent
requestor acceptance. It is not multi-user authentication.

## Operating constraints

One temporary worker executes one AC at a time. Progress checkpoints are due every
three minutes; experiment budgets independently range from one to four minutes.
Token-review guidance must provide bounded actions within the current constraints.
Default per-AC usage is 0.6M observed uncached input plus output tokens, with
nonblocking course correction at 0.4M. Explicit budget extensions preserve cumulative
spend. Unknown or partial observations remain identified as such.

Reviews, compaction, dependency waits, named owner holds and worker execution tracks
remain distinct. Automation retries and escalates unanswered handoffs according to
actual recipient activity. Sending a message is not verified recovery. Native turn
review packets include visible calls, outputs and messages; hidden reasoning is
excluded. Private transcripts stay outside committed registry records.

## Storage and verification

`config.json` configures the workspace. `agents.json` is the sole agent roster. Public registry
records are original YAML objects discovered directly under `registry/`. Project and intake
commands, workflow execution and UI all read these same YAML objects. There is no
JSON project model or status-copy bridge.
Native agent registrations and aliases are `agents.json` and `aliases.json`; original
message objects live in `mail/NAME/{new,read,sent}`. Original project YAML records are
stored separately under `registry/DevProjects/metadata/`; their keys and short IDs
remain stable through archive. `registry/DevProjects/retrospectives/` contains factual
snapshots and reports. `projects/` holds workflow state, locks and worker runtime
state; `agents/` holds role directories, and `runtime/` holds installation configuration and service logs. Machine configuration and private sessions remain outside the package.

Use explicit workspace commands and preserve append-only status/events. Locks and
exact process identities protect concurrent operations. This is a trusted local
installation, not a network-filesystem database.

`npm run check` and `npm run build` perform static validation. Native provider and
full project execution require an explicitly authorized workspace. Compilation alone
does not establish end-to-end functional parity or operational readiness.

## License

Copyright 2026 Alexm. Licensed under the [Apache License, Version 2.0](LICENSE).
See [NOTICE](NOTICE) for attribution. Third-party dependencies retain their own
licenses.

## Runtime and installation boundary

Agentlink is a versioned base runtime. Deploy its packaged release unchanged; do not patch installed JavaScript. Installations contain data, configuration, identities, native sessions, service settings and hooks. The package includes the canonical project, intake and retrospective schemas and their shared record-key definition. `agentlink init --home PATH` installs missing schemas into the workspace registry tree; existing schemas and records remain authoritative and are never overwritten. Rerun init to repair an installation missing these files. Never reconstruct schemas from runtime code. `serve --workflow --headless` runs the standard controller without a separate UI. `registry-publication.json` configures publication into an existing Registry page. Build generic fixes in this repository and replace the complete pinned release.
