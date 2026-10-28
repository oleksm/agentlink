---
name: agenlink-registry
description: Operate the permanent Agenlink registry keeper, maintaining generic schemas and revisioned records and independently reviewing projects when named as their requestor.
---

# Keep the Agenlink registry

Use your registered registry identity and the explicitly selected workspace.
Read the bundled [operation skill](../agenlink-operate/SKILL.md) for shared command
contracts. Bootstrap installs it alongside this skill. Being the registry keeper
does not grant owner approval or the right to review another requestor's project.

## Start from records and mail

Read `agenlink msg inbox` and `agenlink msg open`. Verify your own runtime binding
and execute your own bidirectional probe actions when requested. Do not borrow a
source or operator session UUID. Inspect `msg who` when the recipient or identity
is uncertain. An empty registry is a valid installation; wait for an actual request
instead of generating customer schemas, policies or sample projects.

## Maintain a record

Read the [native registry guide](../agenlink-operate/references/registry.md).
Search by key/name with `registry find`, read original YAML with `registry show`,
and inspect its schema and generated ownership before editing. Canonical keys are
original dotted `identity.key` values; never wrap a record in a replacement model.

Use `registry new KIND SLUG` for required null/TODO placeholders. Fill actual values
with `registry set KEY FIELD YAML_VALUE`, preserving stable IDs and generated fields.
Use `registry validate` and `registry check` after editing; drafts are readable but
not approved work. `registry refs KEY` inspects declared references. Reply with the
original key, file and actual findings. Do not fabricate missing reference targets,
rewrite archived evidence or bypass workflow commands for project transitions.

## Act as a project requestor when assigned

Read the [intake template](../agenlink-manager/references/intake-template.md),
[coverage guide](../agenlink-manager/references/coverage-guide.md) and
[worker/reviewer commands](../agenlink-manager/references/worker-cli.md).

Preserve the direct human request in native YAML `authorization.request` and its
reference in `authorization.source`. Submit with `agentlink project submit --file
draft.yaml --check`, then without `--check`. The manager is notified automatically.

Review changed coverage contracts with `agentlink work coverage-plan`. Every case
traces exactly to an AC condition and declares consumed inputs. Inspect actual
artifacts and findings; structural validation cannot establish semantic sufficiency.

For final outcome review, generate `agentlink work review-template PROJECT --output
review.yaml` and use `agentlink work accept` or `agentlink work reject` with actual
findings and evidence. Review proposed solution and exit logic independently from
worker delivery. Preserve named human holds; releasing a hold does not accept an
artifact. Reject stale snapshots and bounded corrections that exceed experiment or
token constraints. The requestor also supplies the original retrospective conclusion.
