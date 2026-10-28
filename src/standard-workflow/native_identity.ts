/** Native session binding and exact saved-child restoration. */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, atomicJson } from "../store.js";
import { jsonlRows } from "../jsonl.js";
import { Records, locked } from "./records.js";
import type { RecordData } from "./common.js";
import { session_file } from "./project_review_recovery.js";
import { command } from "./project_runtime_ports.js";
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const read = (path: string, fallback: RecordData = {}): RecordData =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
function process_identity(
  pid: number,
): { start: string; parent: number } | undefined {
  try {
    const text = readFileSync("/proc/" + pid + "/stat", "utf8"),
      fields = text
        .slice(text.lastIndexOf(") ") + 2)
        .trim()
        .split(/\s+/);
    if (fields[0] === "Z" || !fields[19]) return;
    return { start: fields[19], parent: Number(fields[1]) };
  } catch {
    return;
  }
}
function descendant(pid: number, ancestor: number): boolean {
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === ancestor) return true;
    seen.add(pid);
    pid = process_identity(pid)?.parent || 0;
  }
  return false;
}
export function runtime_options(
  c: RecordData,
  runtime: string,
  home: string,
): string[] {
  let options = c.runtime_args?.[runtime];
  const term: string[] = c.term || [];
  if (options == null && term[0] === runtime)
    for (const marker of ["resume", "--resume", "--session-id"])
      if (term.includes(marker)) {
        options = term.slice(1, term.indexOf(marker));
        break;
      }
  if (options == null)
    options = [
      ...(runtime === "codex" ? ["--sandbox", "workspace-write"] : []),
      "--add-dir",
      home,
    ];
  options = [...options];
  if (
    runtime === "codex" &&
    !options.includes("--no-daemon") &&
    !options.includes("--remote")
  )
    options.unshift("--no-daemon");
  return options;
}
function observe_pane(m: RecordData): void {
  const result = spawnSync(
    "tmux",
    ["-L", m.socket, "display-message", "-p", "-t", m.terminal, "#{pane_pid}"],
    { encoding: "utf8", timeout: 2000 },
  );
  if (result.status !== 0) return;
  const pid = Number(result.stdout.trim()),
    proc = process_identity(pid);
  if (!Number.isInteger(pid) || !proc) return;
  if (m.panePid !== pid || m.processStart !== proc.start) {
    m.panePid = pid;
    m.processStart = proc.start;
    const ticks = Number(command(["getconf", "CLK_TCK"]).trim());
    const boot = Number(
      readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1],
    );
    if (!(ticks > 0) || !(boot > 0))
      throw Error("Cannot establish native process start time");
    m.startedAt = new Date(
      (boot + Number(proc.start) / ticks) * 1000,
    ).toISOString();
  }
}
function proves_session(
  path: string,
  runtime: string,
  session: string,
  cwd: string,
): boolean {
  for (const r of jsonlRows(path)) {
    if (runtime === "codex") {
      if (
        r.type === "session_meta" &&
        r.payload?.id === session &&
        typeof r.payload.cwd === "string" &&
        realpathSync(r.payload.cwd) === cwd
      )
        return true;
    } else if (
      r.sessionId === session &&
      typeof r.cwd === "string" &&
      realpathSync(r.cwd) === cwd
    )
      return true;
  }
  return false;
}
function native_call(
  path: string,
  project: string,
  name: string,
  startedAt?: string,
): string | undefined {
  for (const r of jsonlRows(path, true)) {
    if (
      r.type !== "response_item" ||
      !["function_call", "custom_tool_call"].includes(r.payload?.type) ||
      !Number.isFinite(Date.parse(r.timestamp)) ||
      Date.parse(r.timestamp) <
        Math.max(Date.now() - 120000, Date.parse(startedAt || "1970-01-01"))
    )
      continue;
    const text = String(r.payload.input ?? r.payload.arguments ?? "");
    if (
      text.includes("workers bind " + project + " " + name)
    )
      return r.payload.call_id || r.payload.id;
  }
  return;
}
/** Bind the calling child to its existing native session; save only a resume command. */
export function bind_worker(
  store: Store,
  project: string,
  name: string,
  actor: string,
  session?: string,
): RecordData {
  if (actor !== name) throw Error("worker must bind its own identity");
  const records = new Records(store.home),
    key = "project." + project;
  return locked(join(store.home, "projects", project, "workers.lock"), () =>
    locked(join(store.home, "run/config.lock"), () => {
      const rec = records.read(key),
        w = rec.workers.find((x: RecordData) => x.id === name);
      if (!w || w.status === "retired")
        throw Error("unknown or retired project worker");
      const config = read(join(store.home, "agents.json")),
        c = config[name];
      if (
        !c ||
        c.forked_from?.project !== project ||
        c.forked_from?.agent !== w.source.identity
      )
        throw Error("child registration does not match project source");
      const runtime = w.source.runtime;
      if (c.runtime !== runtime) throw Error("native fork runtime mismatch");
      const sid =
        session ||
        (runtime === "codex"
          ? process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID
          : undefined);
      if (!sid || !SID.test(sid))
        throw Error(
          "provide --session UUID (Codex can use CODEX_THREAD_ID automatically)",
        );
      if (
        rec.workers.some((x: RecordData) => x.source.session === sid) ||
        Object.entries(config).some(
          ([id, row]) => id !== name && row.session === sid,
        )
      )
        throw Error("child must have a distinct native session");
      if (c.session && c.session !== sid)
        throw Error(
          "child is already bound; never replace it with another fork",
        );
      const product = rec.products.find((x: RecordData) => x.id === w.product),
        cwd = realpathSync(product.worktree);
      if (realpathSync(c.cwd) !== cwd || realpathSync(process.cwd()) !== cwd)
        throw Error("bind must run from the actual child worktree");
      if (
        command(["git", "-C", cwd, "branch", "--show-current"]).trim() !==
        product.project_branch
      )
        throw Error("workspace branch differs from project record");
      if (!statSync(c.scratch_dir).isDirectory())
        throw Error("worker scratch missing");
      const path = session_file(runtime, sid);
      if (!path || !proves_session(path, runtime, sid, cwd))
        throw Error(
          "native transcript must prove exact child session and worktree",
        );
      const manifest = read(w.runtime_manifest);
      if (
        manifest.expected_child_session &&
        manifest.expected_child_session !== sid
      )
        throw Error("unexpected native child session");
      const m:RecordData = {socket:c.tmux_socket || "agent-"+name,terminal:c.tmux_terminal||"agent-"+name};
      observe_pane(m);
      if (!m.panePid || !m.processStart)
        throw Error(
          "managed child process observation is unavailable; synchronize from host before binding",
        );
      const call =
          runtime === "codex"
            ? native_call(path, project, name, m.startedAt)
            : undefined,
        self = descendant(process.pid, m.panePid),
        native =
          runtime === "codex" &&
          [process.env.CODEX_THREAD_ID, process.env.CODEX_SESSION_ID].includes(
            sid,
          ) &&
          process.env.AGL_AGENT === name &&
          process.env.AGL_HOME === store.home &&
          !!call;
      if (!self && !native)
        throw Error(
          "binding must execute inside its actual native child session",
        );
      const term = [
        runtime,
        ...runtime_options(c, runtime, store.home),
        runtime === "codex" ? "resume" : "--resume",
        sid,
      ];
      Object.assign(c, { runtime, session: sid, term });
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'",
        resume_command = term.map(quote).join(" ");
      Object.assign(manifest, { actual_child_session: sid, resume_command });
      Object.assign(w, {
        fork: {
          identity: name,
          runtime,
          session: sid,
          checkpoint: w.runtime_manifest,
        },
        resume_command,
      });

      atomicJson(join(store.home, "agents.json"), config);
      atomicJson(w.runtime_manifest, manifest);
      records.save(rec);
      return { agent: name, runtime, session: sid, resume_command };
    }),
  );
}
/** Resume a saved child, retaining its exact flags, identity and project holds. */
export function resume_worker(
  store: Store,
  project: string,
  name: string,
  context = "",
): RecordData {
  return locked(join(store.home, "runtime", name + ".native-resume"), () => {
    const records = new Records(store.home),
      rec = records.read("project." + project),
      w = rec.workers.find((x: RecordData) => x.id === name),
      config = read(join(store.home, "agents.json")),
      c = config[name];
    if (
      !w ||
      w.status === "retired" ||
      !c ||
      c.forked_from?.project !== project ||
      c.forked_from.agent !== w.source.identity
    )
      throw Error("recovery requires a registered project child");
    const stage = (Array.isArray(rec.status) ? rec.status[0] : rec.status)
      ?.workflow_step;
    if (["closed", "cancelled"].includes(stage))
      throw Error("project no longer permits worker restoration");
    const saved = read(w.runtime_manifest);
    if (saved.retire_ready)
      throw Error("retirement already requested; preserve stop intent");
    const sid = c.session;
    if (
      !sid ||
      sid !== w.fork?.session ||
      rec.workers.some((x: RecordData) => x.source.session === sid)
    )
      throw Error("recovery requires the exact distinct saved child session");
    if (c.handoff_pause) throw Error("worker paused for handoff");
    const term: string[] = c.term || [];
    if (
      term.includes("fork") ||
      term.includes("--fork-session") ||
      !term.includes(sid) ||
      !term.includes(c.runtime === "codex" ? "resume" : "--resume")
    )
      throw Error("recovery command must resume the saved child");
    const product = rec.products.find((p: RecordData) => p.id === w.product),
      cwd = realpathSync(product.worktree);
    if (
      realpathSync(c.cwd) !== cwd ||
      command(["git", "-C", cwd, "branch", "--show-current"]).trim() !==
        product.project_branch
    )
      throw Error("saved child workspace differs from project record");
    if (!statSync(c.scratch_dir).isDirectory())
      throw Error("worker scratch missing");
    const transcript = session_file(c.runtime, sid);
    if (!transcript || !proves_session(transcript, c.runtime, sid, cwd))
      throw Error(
        "saved native transcript does not prove child session and worktree",
      );
    const socket = c.tmux_socket || "agent-" + name;
    if (
      spawnSync("tmux", ["-L", socket, "has-session", "-t", c.tmux_terminal || "agent-" + name], {
        stdio: "pipe",
        timeout: 2000,
      }).status === 0
    )
      return {agent:name,session:sid};
    if (readdirSync("/proc").filter(p=>/^\d+$/.test(p)).some(p=>{try{return readFileSync(join("/proc",p,"cmdline"),"utf8").split("\0").includes(sid);}catch{return false;}}))
      throw Error(
        "native child still running outside its managed terminal; inspect before recovery",
      );
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'",
      prompt =
        context ||
        `Restoration of existing worker ${name} in project ${project}; no new assignment. Read the current project and your ACs before acting. Preserve owner, requestor, dependency, budget and review holds. Finished delivery is not permission to repeat implementation. Continue only currently authorized work or closeout.`,
      argv = [
        "env",
        "-u",
        "CODEX_THREAD_ID",
        "-u",
        "CODEX_SESSION_ID",
        "-u",
        "CLAUDECODE",
        `AGL_AGENT=${name}`,
        `AGL_HOME=${store.home}`,
        `TMPDIR=${c.scratch_dir}`,
        `CLAUDE_CODE_TMPDIR=${c.scratch_dir}`,
        ...term,
        prompt,
      ];
    command([
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--unit=project-worker-" + name + "-" + randomUUID().slice(0, 8),
      "tmux",
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      c.tmux_terminal || "agent-" + name,
      "-c",
      cwd,
      argv.map(quote).join(" "),
    ]);

    return {agent:name,session:sid};
  });
}

