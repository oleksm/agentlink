---
name: agenlink-install
description: Initialize a workspace and install the bundled skills for the original agentmsg and YAML workflow commands.
---

# Install Agenlink

Build the package with `npm install` and `npm run build`. Use `agentlink init
--home PATH` for workspace configuration and missing canonical schemas. The package
provides project, intake, retrospective, root and common schemas. Rerunning init
repairs missing files without overwriting existing schemas. Never invent schemas
from code. Use `agentlink
skills install --dest DIRECTORY` to install the role and operation guides.

Register `registry` and `project-manager` using the original `agentlink msg
register` interface. Preserve an existing `agents.json`, `aliases.json`, native
sessions, permissions, mail and project YAML. Select the workspace explicitly
with `--home` or `AGL_HOME`, and your identity with `--as` or `AGL_AGENT`.

Use the original `msg launch`, `msg bind`, `msg up` and `msg probe` commands.
Start the service with `agentlink serve --workflow --home PATH`, or use
`service render` to generate a systemd unit. A running terminal or successful
build does not establish actual messaging, worker progress or acceptance.

Use the installed operation and manager guides for project workflow commands.
