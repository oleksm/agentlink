# Managed project lifecycle

Use the [native procedure](../../agenlink-manager/references/worker-cli.md) and
[manager runbook](../../agenlink-manager/references/AGENTS.md). These operate on
original-schema YAML records under `$AGL_HOME/registry/DevProjects/metadata/`.

Select `AGL_HOME` and your own `AGL_AGENT`. Commands are `agentlink project`,
`agentlink workers`, `agentlink workflow` and `agentlink work`; use their installed
help and the linked guide for exact arguments. Direct owner authorization,
independent requestor acceptance, declared-input evidence hashes and append-only
status/events remain mandatory.

Worker readiness requires a real bidirectional messaging probe. Prefer another
bound project worker; a single-worker project uses its bound project manager.
Both agents must send and acknowledge the probe before implementation starts.
