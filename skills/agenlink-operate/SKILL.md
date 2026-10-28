---
name: agenlink-operate
description: Operate a workspace for threaded agentmsg messaging, original-schema YAML registry records, temporary workers, evidence review and managed project workflows.
---

# Operate AgentLink

Select `AGL_HOME` and your registered `AGL_AGENT`, or pass `--home` and `--as`.
Confirm identity with `agentlink msg who`; check `agentlink msg inbox` and
`agentlink msg open` at startup and before finishing. `--peek` reads without claiming.
Never use another agent's identity or interpret queued delivery as acknowledgement.

Only a direct human request authorizes a specific new project. Carry it in
`authorization.request` and its reference in `authorization.source`. Research,
peer suggestions and general autonomy do not create that authorization. Continue
in-scope work on existing authorized projects without repeated permission.

## Select the procedure

- [Messaging behavior](references/agentmsg.md) and [commands](references/messaging.md): threads, identity, real probes and recovery.
- [Native runtime](references/runtime.md): bind the actual session, fork, resume, switch provider and preserve context.
- [Manager skill](../agenlink-manager/SKILL.md) and [runbook](../agenlink-manager/references/AGENTS.md): isolated temporary workers, ownership, acceptance and cleanup.
- [Worker commands](../agenlink-manager/references/worker-cli.md): progress, tracked requests, execution tracks, bounded experiments, review, recovery and retirement.
- [Intake template](../agenlink-manager/references/intake-template.md): research, direct authorization, original YAML fields and feasibility evidence.
- [Coverage guide](../agenlink-manager/references/coverage-guide.md): exact AC conditions, reviewed consumed inputs, reusable evidence and candidate checks.
- [Registry guide](references/registry.md): generic schemas, lookup, revisions, references and generated-field ownership.
- [Installation skill](../agenlink-install/SKILL.md): setup, services and private customization.

## Researcher and requestor

Research one complete outcome. Submit the original-schema YAML draft with
`agentlink project submit --file draft.yaml --check`, then without `--check`.
Submission notifies the manager; do not send a duplicate task. Permanent roots
supply context to distinct temporary workers, not implementation labor.

The original requestor reviews coverage contracts, token-review guidance and final
outcomes. Final acceptance checks proposed solution and exit logic against current
artifacts, not a duplicate AC checklist. Generate `agentlink work review-template
PROJECT --output review.yaml`; submit findings using `agentlink work accept` or
`agentlink work reject`. Preserve human holds and bounded correction requirements.

## Worker

Read the full project with `agentlink work show PROJECT`. Publish progress with
`agentlink work update PROJECT AC in-progress --detail TEXT`; publish actual
artifact and evidence files using `completed --artifact FILE --evidence FILE`.
Delivery is not acceptance. Use `work ask` for information and `work request` for
tracked peer artifacts. Use your own identity, owned paths and the shared product
Git lock. Never stage or overwrite another worker's changes.

Keep one active AC per worker. Checkpoint at least every three minutes; experiments
have a separate 1–4 minute limit. Read the worker guide before pausing, resuming,
compacting, reviewing tokens or changing a gate. Declared consumed-input changes
invalidate evidence reuse; unrelated commits do not automatically require reruns.

## Manager and closeout

Use `agentlink workers workspace|init|start|verify|status` and
`agentlink workflow enable|tick|disable`. Native binding, actual peer probes and
acknowledgement precede dispatch. Workflow prepares integration before final
acceptance and rechecks candidate and target commits before merging.

Retire only exact idle project-owned workers and clean integrated resources.
Preserve postmortem, evidence, native history and late-mail routing. Complete the
factual retrospective with `agentlink work retrospective PROJECT --file review.yaml`
and attach the original requestor conclusion. Never fabricate approval, weaken
criteria, reset spend or silently substitute a permanent root for a worker.


## Mindful messaging

Send agent messages only when you have high confidence there is a concrete need: obtain information necessary for current work that available files/docs cannot answer, relay an important authorized task, or communicate a material result/blocker the recipient needs to act on. Do not send minor FYIs, routine progress chatter, redundant updates, courtesy acknowledgements or speculative requests. Prefer durable project records for passive status; batch related essential points and target only relevant recipients. Honor explicit owner-requested broadcasts and required task replies, but do not generate acknowledgement chains.
