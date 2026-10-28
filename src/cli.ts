#!/usr/bin/env node
import { nativeCli } from './standard-workflow/cli.js';
import { parseArgs } from "node:util";
import { Store, initialize, workspacePath } from "./store.js";
import { runRegistryCommand } from "./registry-cli.js";
import {
  startService,
  stopService,
  serviceStatus,
  registerService,
} from "./daemon.js";
import { serve } from "./server.js";
import { installSkills, writeService } from "./install.js";

const help = `agentlink — local agent coordination

Use --home PATH or AGL_HOME for the workspace.
Use --as NAME or AGL_AGENT for your registered identity.

  init [--name NAME] [--port NUMBER]
  serve [--port NUMBER] [--workflow] [--headless]      Serve the registry UI and native workflows
  skills install --dest DIRECTORY
  msg send TO KIND --summary TEXT [--ref REF] [--reply-to ID]
  msg inbox [--peek] | msg open
  msg bind AGENT --runtime codex|claude [--session UUID]
  msg launch AGENT | msg up | msg term AGENT
  msg probe AGENT PEER | msg probe-send ID | msg probe-ack ID MESSAGE
  msg spool AGENT | msg handoff-ready PATH | msg handoff-cancel AGENT
  msg switch AGENT --to codex|claude | msg storage [--json]
  registry list|show|find|new|set|check|refs|view
  registry put --file FILE
  registry schema-list|schema-show|schema-lint|own

  project submit --file draft.yaml [--check]
  project create --file project.yaml     Record an authorized project
  project import --file record.yaml      Preserve an existing standard record
  project list | project show ID | project check [ID]
  workers workspace PROJECT PRODUCT
  workers init PROJECT SOURCE --product PRODUCT [--name WORKER]
  workers start|verify|resume PROJECT WORKER
  workers bind PROJECT WORKER [--session UUID]
  workers status PROJECT
  workflow enable|disable PROJECT
  workflow tick PROJECT | workflow tick --all
  work show PROJECT
  work update PROJECT AC in-progress|blocked|completed --detail TEXT
  work ask PROJECT PEER --summary TEXT
  work review-template PROJECT --output FILE
  work accept PROJECT --review FILE --evidence FILE --detail TEXT
  work reject PROJECT --review FILE --detail TEXT
  work coverage-plan|coverage-report PROJECT --file FILE
  work coverage-status PROJECT
  work pause|resume PROJECT AC --detail TEXT
  work token-review-template PROJECT AC --output FILE
  work token-review PROJECT AC --file FILE
  work retrospective PROJECT --file FILE

Project/intake/retrospective records use the installation’s canonical YAML schemas unchanged.
Additional worker commands are documented in the manager worker CLI guide.
`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const globals: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    for (const name of ["home", "as"])
      if (token === `--${name}` || token.startsWith(`--${name}=`)) {
        const value =
          token === `--${name}` ? args[i + 1] : token.slice(name.length + 3);
        if (!value) throw Error(`--${name} needs a value`);
        globals[name] = value;
        args.splice(i, token === `--${name}` ? 2 : 1);
        i--;
        break;
      }
  }
  if (args.includes("--help")) {
    console.log(help);
    return;
  }
  const routedStore = new Store(globals.home);
  const native = await nativeCli(routedStore, args, globals.as ?? process.env.AGL_AGENT);
  if (native.handled) {
    if (native.output !== undefined) { if(native.output)process.stdout.write(native.output+'\n');process.exitCode=native.exitCode??0; }
    else console.log(JSON.stringify(native.value ?? {ok:true}, null, 2));
    if (native.value && typeof native.value === 'object' && 'valid' in native.value && native.value.valid === false) process.exitCode = 1;
    return;
  }
  if (args[0] === 'registry') {
    const value=runRegistryCommand(routedStore,args.slice(1),globals.as ?? process.env.AGL_AGENT);
    console.log(JSON.stringify(value ?? { ok: true }, null, 2));
    if (
      args[0] === "registry" &&
      value &&
      typeof value === "object" &&
      "valid" in value &&
      value.valid === false
    )
      process.exitCode = 1;
    return;
  }
  const { values: v, positionals: p } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      as: { type: "string" },
      file: { type: "string" },
      name: { type: "string" },
      port: { type: "string" },
      summary: { type: "string" },
      see: { type: "string", multiple: true },
      ref: { type: "string" },
      "reply-to": { type: "string" },
      peek: { type: "boolean" },
      revision: { type: "string" },
      check: { type: "boolean" },
      workflow: { type: "boolean" },
      headless: { type: "boolean" },
      help: { type: "boolean" },
      "implementation-failure": { type: "boolean" },
      detail: { type: "string" },
      snapshot: { type: "string" },
      decision: { type: "string" },
      failed: { type: "string" },
      session: { type: "string" },
      status: { type: "string" },
      candidate: { type: "string" },
      dest: { type: "string" },
      runtime: { type: "string" },
      launch: { type: "boolean" },
      timeout: { type: "string" },
    },
  });
  if (v.help || !p.length) {
    console.log(help);
    return;
  }
  const required = (value: string | undefined, label: string): string => {
    if (!value) throw new Error(`Required: ${label}`);
    return value;
  };
  const out = (value: unknown) =>
    console.log(JSON.stringify(value ?? { ok: true }, null, 2));
  const store = routedStore,
    [command, action] = p;
  if (command === "init") {
    const initialized = initialize(workspacePath(globals.home), {
      ...(v.name ? { name: v.name } : {}),
      ...(v.port ? { port: Number(v.port) } : {}),
    });
    out({ home: initialized.home, config: initialized.config() });
    return;
  }
  if (command === "skills" && action === "install") {
    out(installSkills(required(v.dest, "--dest DIRECTORY")));
    return;
  }
  if (command === "service" && action === "start") {
    out(await startService(store));
    return;
  }
  if (command === "service" && action === "stop") {
    out(stopService(store));
    return;
  }
  if (command === "service" && action === "status") {
    out(serviceStatus(store));
    return;
  }
  if (command === "service" && action === "render") {
    store.config();
    out(writeService(store, required(v.file, "--file PATH")));
    return;
  }
  if (command === "serve") {
    const port = v.port === undefined ? undefined : Number(v.port);
    if (
      port !== undefined &&
      (!Number.isInteger(port) || port < 0 || port > 65535)
    )
      throw new Error("Port must be between 0 and 65535");
    const server = await serve(store, { port, workflow: v.workflow, headless: v.headless });
    const address = server.address();
    if (typeof address === "object" && address)
      registerService(store, address.port);
    out({
      url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : ""}`,
      workflow: !!v.workflow,
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => server.close());
    return;
  }
  throw new Error("Unknown command; run agenlink --help");
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
