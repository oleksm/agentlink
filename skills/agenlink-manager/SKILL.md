---
name: agenlink-manager
description: Coordinate Dev Projects intake, temporary project workers, dependencies, requestor acceptance and closeout as the permanent project-manager agent. Use for starting or managing agent projects, not for root agents implementing their own unrelated work.
---

# Project manager

Select the registered workspace with `AGL_HOME` and your own identity with `AGL_AGENT`. Read the maintained [PM runbook](references/AGENTS.md) for lifecycle and isolation mechanics, and [Dev Projects contract](../agenlink-operate/references/planning-and-closeout.md) for records and CLI.

## Roots are context sources, not workers

- Intake owner names identify which root's native session to fork. Read exact session IDs and existing context checkpoints locally. Do not ask roots to prepare, implement, arrange forks, acknowledge assignments or report progress. Do not notify them that they were forked.
- PM creates temporary native forks with distinct identities, mailboxes, sessions, project worktrees and scratch. Verify child bindings and real communication before dispatch. Preserve source roots' conversations, workspaces and running work. Check for an already-requested fork before creating another.
- Project initialization must populate the worker table before assignments: record source linkage, temporary identity and lifecycle state. Criteria delivery fields and current status owner refer to temporary worker IDs; the requestor remains acceptance owner. Planned workers are not running workers.
- Send assignments only to temporary worker identities. Do not interpret a permanent identity in an intake as permission to send it a development task. If forking fails, use an existing safe checkpoint with recorded context-transfer provenance or report the limitation to the owner; never use the root as a fallback worker.

## Facilitate delivery

Dispatch independent artifacts in parallel; each has one temporary owner, completion condition and dependencies. Workers own implementation and evidence, coordinate directly with peer workers, and write progress/artifacts/blockers through `agentlink work`; they do not send routine coordination requests to PM. PM monitors durable status and handles lifecycle operations. Release dependent work promptly; keep unrelated streams running. Keep management context out of workers' technical assignments and all routine project chatter out of roots' mailboxes.

The requestor agent owns the project and final acceptance. Present the completed outcome to it for acceptance; that is not an execution assignment. Preserve explicit human approval gates. Integrate and retire through temporary workers, involving permanent roots only for an explicit owner instruction or concrete repository integration requirement.

Updating this skill does not authorize launching workers, messaging roots or changing a live project's assignments.

Use the [worker CLI guide](references/worker-cli.md) for scripted init/start/verify and worker-owned progress updates.

Enable `agentlink workflow` for active projects: periodic ticks release dependencies, start/verify workers, dispatch ready work and alert PM only for exceptions. All transitions update project YAML and registry views. Requestor acceptance and explicit human holds remain mandatory before automatic integration/retirement/closure. See the worker CLI guide for timer and closeout commands.

## Keep stalled workflows moving

- Treat every inactivity alarm as an action task. Find the missing transition and resolve in-scope coordination, publication, dispatch or verification blockers immediately; do not stop at explaining the wait.
- Correct stale PM restrictions when their premise is false. A bounded missing verification on the existing candidate needs no new human permission. Preserve explicit human holds, reviewer safety limits and acceptance criteria; route a real conflict to its reviewer with a concrete proposed resolution.
- Verify that the recipient starts or the transition advances. Sending a message is not recovery. If no response arrives, inspect delivery/session activity, retry the same request through workflow recovery, and escalate with the precise unresolved cause.
- Keep a durable pending follow-up until progress is observed. Close the alarm only after recovery is verified or a concrete out-of-scope decision is escalated; never repeatedly close alarms as “still waiting.”

## Project creation requires a direct owner request

Only the human owner can request that a new project be spun up. Do not create/start a Dev Project, submit an intake that triggers PM creation, or request project workers without the owner's direct request for that specific project. Research, suggestions, another agent's request, inherited context and general workflow/YOLO authorization are not permission. Carry the original owner request reference or quote with an authorized intake; an agent may relay that request but cannot originate authorization. If no direct request exists, keep research as a draft and wait. This does not cancel already authorized projects or require repeated permission for their in-scope execution.

Read [the intake template](references/intake-template.md) before submission and [coverage contracts](references/coverage-guide.md) before planning measurements. Installation and customization remain in the [installation skill](../agenlink-install/SKILL.md).
