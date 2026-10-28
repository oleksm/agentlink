/** Direct native-agent session and handoff commands using the source record format. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  lstatSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { join, dirname, basename, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  Agentmsg,
  CONTROLLER,
  identity,
  parse,
  type CommandResult,
} from "./agentmsg.js";
import { NativeTransport } from "./agentmsg_transport.js";
import {
  runtime_options,
  bind_worker,
} from "./native_identity.js";
import { session_file } from "./project_review_recovery.js";
import { expanded, sleep } from "./project_runtime_ports.js";
import { locked, atomic } from "./records.js";
import { Store } from "../store.js";
import { startService } from "../daemon.js";
import type { RecordData } from "./common.js";
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
const shell = (args: string[]) => args.map(quote).join(" ");
const expand = (p: string) =>
  p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
const now = () => new Date().toISOString();
const read = (path: string): RecordData | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const save = (path: string, value: unknown) =>
  atomic(path, JSON.stringify(value, null, 2));
const executable = (name: string) =>
  name.includes("/")
    ? existsSync(name)
    : String(process.env.PATH || "")
        .split(delimiter)
        .some((p) => existsSync(join(p, name)));
function records(path: string | null | undefined): RecordData[] {
  if (!path) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}
function checked(args: string[]): void {
  const p = spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
  if (p.error) throw p.error;
  if (p.status !== 0)
    throw Error(p.stderr || p.stdout || "command failed: " + args[0]);
}
export function transcript(
  source: string | null | undefined,
  runtime: string | null,
  dest: string,
): number {
  let count = 0;
  const output: string[] = [];
  for (const r of records(source)) {
    let role: any = null,
      content: any = null;
    if (runtime === "claude" && ["user", "assistant"].includes(r.type)) {
      const m = r.message || {};
      role = m.role ?? r.type;
      content = m.content;
    } else if (runtime === "codex" && r.type === "response_item") {
      const p = r.payload || {};
      if (p.type === "message") {
        role = p.role;
        content = p.content;
      } else if (
        [
          "function_call",
          "function_call_output",
          "custom_tool_call",
          "custom_tool_call_output",
        ].includes(p.type)
      ) {
        role = "tool-record";
        content = p;
      }
    } else if (runtime === "codex" && r.type === "compacted") {
      role = "compaction";
      content = r.payload;
    }
    if (content == null) continue;
    if (Array.isArray(content))
      content = content.filter(
        (b) =>
          !b ||
          typeof b !== "object" ||
          !["thinking", "redacted_thinking"].includes(b.type),
      );
    output.push(
      JSON.stringify({ role, content, timestamp: r.timestamp ?? null }),
    );
    count++;
  }
  writeFileSync(dest, output.length ? output.join("\n") + "\n" : "");
  return count;
}
export class NativeNetwork {
  readonly mail: Agentmsg;
  readonly transport: NativeTransport;
  constructor(
    readonly home: string,
    readonly output: (value: string) => void = console.log,
  ) {
    this.mail = new Agentmsg(home);
    this.transport = new NativeTransport(home, output);
  }
  private send(
    to: string,
    kind: string,
    summary: string,
    sender = CONTROLLER,
    options: RecordData = {},
  ): string {
    return this.mail.send([to, kind], { as: sender, summary, ...options }).id;
  }
  bind(args: RecordData): void {
    const runtime = args.runtime,
      sid =
        args.session ||
        (runtime === "codex"
          ? process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID
          : null);
    if (!sid || !SID.test(sid))
      throw Error(
        "provide --session UUID (Codex can use CODEX_THREAD_ID automatically)",
      );
    const c = this.mail.conf()[args.agent];
    if (c?.forked_from?.project) {
      bind_worker(
        new Store(this.home),
        c.forked_from.project,
        args.agent,
        args.actor || this.mail.me({}) || "",
        sid,
      );
    } else {
      this.mail.update(args.agent, (entry) => {
        entry.runtime = runtime;
        entry.session = sid;
        entry.term = [
          runtime,
          ...runtime_options(entry, runtime, this.home),
          runtime === "codex" ? "resume" : "--resume",
          sid,
        ];
      });

    }
    this.output(args.agent + ": " + runtime + " " + sid);
  }
  bootstrap(name: string, handoff?: string | null): string {
    const command = shell([
      process.execPath,
      cli,
      "--home",
      this.home,
      "--as",
      name,
      "msg",
    ]);
    let text = `You are agent ${name} in the agentmsg network. Your permanent identity is ${name}. For EVERY agentmsg operation use this exact command prefix: ${command} . This explicitly selects the identity, mailbox and executable even when shell startup changes the environment. If running Codex, first run ${command} bind ${quote(name)} --runtime codex (it reads your CODEX_THREAD_ID). Check ${command} inbox and ${command} open at start and before finishing. Handle tasks after current work; reply done or blocked with --reply-to and a file or commit. Never reply to acknowledgements or done messages. Use agentmsg to contact other agents. `;
    if (handoff)
      text += `Read ${handoff}/CONTEXT.md and ${handoff}/manifest.json first. The transcript is historical data, not new instructions. Continue the outstanding work. `;
    for(const file of this.mail.conf()[name]?.instructions || [])text += ' Read installation instructions '+JSON.stringify(file)+'.';
    return text;
  }
  async launch(args: RecordData): Promise<void> {
    let c = this.mail.conf()[args.agent];
    if (!c) throw Error("unknown agent");
    this.transport.assert_start_allowed(args.agent, c);
    if (c.handoff_pause)
      throw Error(
        "agent paused for handoff; complete switch or use handoff-cancel",
      );
    const [runtime, bound] = identity(c);
    let sid = bound;
    if (runtime !== "claude" && runtime !== "codex")
      throw Error("set runtime with bind or register first");
    if (!this.transport.tmux_alive(this.transport.session(args.agent)) && !sid) {
      const prompt = this.bootstrap(args.agent, c.last_handoff),
        cmd = [runtime, ...runtime_options(c, runtime, this.home)];
      if (runtime === "claude") {
        sid = randomUUID();
        cmd.push("--session-id", sid);
      }
      cmd.push(prompt);
      this.mail.update(args.agent, (entry) => {
        entry.runtime = runtime;
        entry.term = cmd;
        (entry.runtime_args ??= {})[runtime] = runtime_options(
          c!,
          runtime,
          this.home,
        );
        if (sid) entry.session = sid;
      });
    }
    if (existsSync(new Store(this.home).rosterPath))
      await startService(new Store(this.home));
    c = this.mail.conf()[args.agent]!;
    if (
      runtime === "codex" &&
      c.term?.[0] === "codex" &&
      !c.term.includes("--no-daemon") &&
      !c.term.includes("--remote")
    ) {
      this.mail.update(args.agent, (entry) => {
        entry.term.splice(1, 0, "--no-daemon");
      });
      c = this.mail.conf()[args.agent]!;
    }
    if (!this.transport.start(args.agent, c))
      throw Error("agent could not be started; see message above");

    if (!args.no_windows) this.transport.window("agent-" + args.agent);
  }
  spool(args: RecordData): string {
    const c = this.mail.conf()[args.agent];
    if (!c) throw Error("unknown agent");
    const [runtime, sid] = identity(c),
      source = args.source
        ? expanded(args.source)
        : session_file(runtime || "", sid || "");
    if (source && !statSync(source).isFile())
      throw Error("source transcript does not exist");
    const date = new Date(),
      pad = (v: number) => String(v).padStart(2, "0"),
      stamp =
        String(date.getFullYear()) +
        pad(date.getMonth() + 1) +
        pad(date.getDate()) +
        "T" +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        "-" +
        randomBytes(4).toString("hex"),
      folder = join(this.home, "handoffs", args.agent, stamp);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const exported = source
        ? transcript(source, runtime, join(folder, "transcript.jsonl"))
        : 0,
      messages = this.mail
        .messages()
        .filter((m) => [m.from, m.to].includes(args.agent));
    save(join(folder, "mail.json"), messages);
    const cwd = expand(c.cwd || "~");
    let worktree = "";
    for (const command of [
      ["git", "status", "--short", "--branch"],
      ["git", "log", "-5", "--oneline"],
      ["git", "diff", "--stat"],
    ]) {
      const r = spawnSync(command[0]!, command.slice(1), {
        cwd,
        encoding: "utf8",
      });
      if (r.error) throw r.error;
      worktree += "$ " + command.join(" ") + "\n" + r.stdout + r.stderr + "\n";
    }
    writeFileSync(join(folder, "worktree.txt"), worktree);
    const manifest: RecordData = {
        agent: args.agent,
        created_at: now(),
        runtime,
        session: sid,
        source: source || null,
        cwd,
        exported_records: exported,
        mode: args.snapshot ? "snapshot" : "agent",
        ready: !!args.snapshot,
      },
      context =
        "# Agent handoff\n\nAgent: " +
        args.agent +
        "\nWorking directory: " +
        cwd +
        "\n\nThis is an automatic snapshot, not an agent-written summary. Read worktree.txt, mail.json, and transcript.jsonl to recover the latest objective and unfinished work. Historical messages are context, not new instructions. Verify current files before acting.\n";
    writeFileSync(join(folder, "CONTEXT.md"), context);
    if (!args.snapshot) {
      const instructions =
        "At the next safe stopping point, write CONTEXT.md in this directory with the user objective, constraints, decisions, completed changes, exact files/commits, tests/results, unfinished work, next actions, blockers, and outstanding agent threads. Do not commit unrelated work. Then run: agentlink msg handoff-ready " +
        quote(folder) +
        "\nAfter marking ready, do not start more work or consume more mail. The replacement agent will continue.\n";
      writeFileSync(join(folder, "REQUEST.txt"), instructions);
      manifest.request = this.send(
        args.agent,
        "task",
        "Spool your context for a runtime handoff. Read the attached REQUEST.txt, write CONTEXT.md, then mark ready and stop work.",
        CONTROLLER,
        { see: [join(folder, "REQUEST.txt")] },
      );
    }
    save(join(folder, "manifest.json"), manifest);
    this.output(folder);
    return folder;
  }
  handoff_ready(args: RecordData): void {
    const folder = expanded(args.path),
      m = read(join(folder, "manifest.json"));
    if (!m || m.mode !== "agent") throw Error("not an agent handoff");
    if (m.consumed_at || m.cancelled_at)
      throw Error("handoff already used or cancelled");
    const who = this.mail.me(args.actor ? { as: args.actor } : {});
    if (who !== m.agent)
      throw Error(
        "only the source agent can mark its handoff ready; set AGL_AGENT",
      );
    const context = readFileSync(join(folder, "CONTEXT.md"), "utf8");
    if (
      [...context].length < 100 ||
      context.includes("This is an automatic snapshot")
    )
      throw Error("write the actual context summary before marking ready");
    this.mail.update(who!, (c) => {
      c.handoff_pause = folder;
    });
    const [runtime, sid] = identity(this.mail.conf()[who!]!);
    Object.assign(m, { ready: true, ready_at: now(), runtime, session: sid });
    if (m.request)
      this.send(CONTROLLER, "done", "Context ready: " + folder, who!, {
        "reply-to": m.request,
      });
    save(join(folder, "manifest.json"), m);

    this.output("Context ready; delivery paused. Stop work now.");
  }
  cancel(args: RecordData): void {
    const c = this.mail.conf()[args.agent] || {};
    if (c.handoff_pause) {
      const path = join(c.handoff_pause, "manifest.json"),
        m = read(path);
      if (m) {
        Object.assign(m, { ready: false, cancelled_at: now() });
        save(path, m);
      }
    }
    this.mail.update(args.agent, (entry) => {
      delete entry.handoff_pause;
    });

    this.output("Delivery resumed. Existing handoff files retained.");
  }
  switch(args: RecordData): number {
    return locked(
      join(this.home, "run", "switch-" + args.agent + ".lock"),
      () => {
        let c = this.mail.conf()[args.agent];
        if (!c) throw Error("unknown agent");
        this.transport.assert_start_allowed(args.agent, c);
        const folder = args.handoff
            ? expanded(args.handoff)
            : this.spool({
                agent: args.agent,
                source: null,
                snapshot: args.snapshot,
              }),
          deadline = performance.now() / 1000 + Number(args.wait ?? 180);
        let m: RecordData;
        for (;;) {
          const read_manifest = read(join(folder, "manifest.json"));
          if (!read_manifest || read_manifest.agent !== args.agent)
            throw Error("handoff belongs to a different agent or is missing");
          m = read_manifest;
          if (m.cancelled_at)
            throw Error("handoff cancelled; spool fresh context");
          if (m.consumed_at)
            throw Error(
              "handoff already used; spool current context for the next switch",
            );
          if (m.ready) break;
          if (performance.now() / 1000 >= deadline) {
            this.output("Waiting for source context. Continue with:");
            this.output(
              "agentlink msg switch " +
                args.agent +
                " --to " +
                args.to +
                " --handoff " +
                quote(folder),
            );
            return 1;
          }
          sleep(1);
        }
        c = this.mail.conf()[args.agent]!;
        if (m.mode === "agent" && c.handoff_pause !== folder)
          throw Error("source has not paused for this handoff");
        const [current_runtime, current_sid] = identity(c);
        if (
          m.runtime !== current_runtime ||
          (m.session && m.session !== current_sid)
        )
          throw Error(
            "source session changed since this handoff; spool fresh context",
          );
        if (!executable(args.to))
          throw Error(args.to + " executable not found");
        const sess = "agent-" + args.agent,
          alive = this.transport.tmux_alive(sess);
        if (m.mode === "snapshot" && alive)
          throw Error(
            "snapshot ready; exit the source agent before switching with --handoff (no agent confirmed a safe stopping point)",
          );
        const [runtime, sid] = identity(c);
        if (!alive && sid) {
          const p = spawnSync("pgrep", ["-f", "(claude|codex).*" + sid], {
            encoding: "utf8",
          });
          if (p.stdout?.trim())
            throw Error(
              "source conversation is open outside agentmsg; exit it and retry with --handoff",
            );
        }
        const backup = join(this.home, "switches", basename(folder) + ".json"),
          event: RecordData = {
            agent: args.agent,
            at: now(),
            from: runtime,
            to: args.to,
            handoff: folder,
            previous_config: structuredClone(c),
            state: "prepared",
          };
        save(backup, event);
        const prompt = this.bootstrap(args.agent, folder),
          profiles = { ...(c.runtime_args || {}) },
          old_command: string[] = c.term || [];
        if (runtime && old_command[0] === runtime && !(runtime in profiles)) {
          let boundary = old_command.findIndex((token) =>
            ["resume", "--resume", "--session-id"].includes(token),
          );
          if (boundary < 0) boundary = old_command.length;
          if (boundary < old_command.length)
            profiles[runtime] = old_command.slice(1, boundary);
        }
        const command = [
            args.to,
            ...runtime_options(
              { ...c, runtime_args: profiles },
              args.to,
              this.home,
            ),
          ],
          new_sid = args.to === "claude" ? randomUUID() : null;
        if (new_sid) command.push("--session-id", new_sid);
        command.push(prompt);
        if (alive && args.no_start)
          checked([...this.transport.tx(sess), "kill-session", "-t", sess]);
        if (!args.no_start) this.transport.mark_starting(args.agent);
        this.mail.update(args.agent, (entry) => {
          Object.assign(entry, {
            runtime: args.to,
            term: command,
            last_handoff: folder,
            runtime_args: profiles,
          });
          delete entry.session;
          delete entry.wake;
          delete entry.handoff_pause;
          if (new_sid) entry.session = new_sid;
        });
        const handoffs = join(this.home, "handoffs", args.agent);
        for (const entry of existsSync(handoffs)
          ? readdirSync(handoffs, { withFileTypes: true })
          : []) {
          if (!entry.isDirectory()) continue;
          const path = join(handoffs, entry.name, "manifest.json"),
            other = read(path);
          if (
            dirname(path) === folder ||
            !other ||
            other.consumed_at ||
            other.cancelled_at
          )
            continue;
          Object.assign(other, {
            ready: false,
            cancelled_at: now(),
            superseded_by: folder,
          });
          save(path, other);
          if (other.request) {
            const queued = this.mail
              .unread(args.agent)
              .filter(([, message]) => message.id === other.request);
            this.mail.claim(args.agent, queued);
            this.send(
              CONTROLLER,
              "blocked",
              "This orchestration handoff was superseded by the completed runtime switch.",
              args.agent,
              { "reply-to": other.request },
            );
          }
        }
        m.consumed_at = now();
        save(join(folder, "manifest.json"), m);
        event.state = "configured";
        save(backup, event);
        if (!args.no_start) {
          if (alive)
            checked([
              ...this.transport.tx(sess),
              "respawn-pane",
              "-k",
              "-t",
              sess,
              "-c",
              expand(c.cwd || "~"),
              "-e",
              "AGL_AGENT=" + args.agent,
              "-e",
              "AGL_HOME=" + this.home,
              ...this.transport.storage_env(
                args.agent,
                this.mail.conf()[args.agent]!,
              ),
              ...command,
            ]);
          if (!this.transport.start(args.agent, this.mail.conf()[args.agent]!))
            throw Error("switch configured but launch failed; use msg launch");
          if (!args.no_windows && !this.transport.watched(sess))
            this.transport.window(sess);
          event.state = "started";
          save(backup, event);
        }

        this.output(
          args.agent +
            ": " +
            runtime +
            " -> " +
            args.to +
            "; context " +
            folder +
            "; mailbox preserved",
        );
        return 0;
      },
    );
  }
  storage(json = false): RecordData[] {
    const rows: RecordData[] = [];
    for (const [name, c] of Object.entries(this.mail.conf())) {
      const scratch = resolve(
          expand(c.scratch_dir || join(this.home, "scratch", name)),
        ),
        base = resolve(expand(c.storage_dir || scratch));
      let total = 0,
        files = 0,
        latest = 0;
      const seen = new Set<string>();
      const walk = (dir: string) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path);
            continue;
          }
          try {
            if (
              entry.isSymbolicLink() &&
              existsSync(path) &&
              statSync(path).isDirectory()
            )
              continue;
            const st = lstatSync(path),
              key = st.dev + ":" + st.ino;
            if (seen.has(key)) continue;
            seen.add(key);
            total += st.blocks * 512;
            files++;
            latest = Math.max(latest, st.mtimeMs / 1000);
          } catch {}
        }
      };
      if (existsSync(base)) walk(base);
      const pids = new Set<number>();
      for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
        let refs: string[];
        try {
          refs = [
            join("/proc", pid, "cwd"),
            join("/proc", pid, "exe"),
            ...readdirSync(join("/proc", pid, "fd")).map((fd) =>
              join("/proc", pid, "fd", fd),
            ),
          ];
        } catch {
          continue;
        }
        for (const ref of refs)
          try {
            const target = readlinkSync(ref);
            if (target === base || target.startsWith(base + "/"))
              pids.add(Number(pid));
          } catch {}
      }
      rows.push({
        agent: name,
        path: base,
        scratch_dir: scratch,
        allocated_bytes: total,
        files,
        last_modified: latest || null,
        open_pids: [...pids].sort((a, b) => a - b),
      });
    }
    if (json) this.output(JSON.stringify(rows, null, 2));
    else {
      for (const row of rows)
        this.output(
          String(row.agent).padEnd(12) +
            " " +
            (row.allocated_bytes / 1024 ** 3).toFixed(2).padStart(7) +
            " GiB  open PIDs: [" +
            row.open_pids.join(", ") +
            "]  " +
            row.path,
        );
      this.output(
        "Read-only. No open references does not prove files are disposable. Only accessible /proc entries are inspected; unmanaged /tmp paths are not included.",
      );
    }
    return rows;
  }
}
export async function network_cli(
  home: string,
  args: string[],
  actor?: string,
): Promise<CommandResult | undefined> {
  const [command, ...rest] = args;
  if (
    ![
      "bind",
      "launch",
      "spool",
      "handoff-ready",
      "handoff-cancel",
      "switch",
      "storage",
    ].includes(command || "")
  )
    return;
  const lines: string[] = [],
    network = new NativeNetwork(home, (text) => lines.push(text)),
    [pos, opt] = parse(rest),
    a: RecordData = {
      ...Object.fromEntries(
        Object.entries(opt).map(([k, v]) => [k.replaceAll("-", "_"), v]),
      ),
      actor: opt.as || actor,
    };
  if (command === "handoff-ready") {
    if (!pos[0]) throw Error("handoff-ready PATH");
    a.path = pos[0];
  } else if (command !== "storage") {
    if (!pos[0]) throw Error(command + " AGENT");
    a.agent = network.mail.canonical(pos[0]!);
  }
  if (["bind", "switch"].includes(command!)) {
    const provider = command === "bind" ? a.runtime : a.to;
    if (!["claude", "codex"].includes(provider))
      throw Error(
        command === "bind"
          ? "--runtime claude|codex required"
          : "--to claude|codex required",
      );
  }
  let exitCode = 0;
  switch (command) {
    case "bind":
      network.bind(a);
      break;
    case "launch":
      await network.launch(a);
      break;
    case "spool":
      network.spool(a);
      break;
    case "handoff-ready":
      network.handoff_ready(a);
      break;
    case "handoff-cancel":
      network.cancel(a);
      break;
    case "switch":
      if (a.wait != null && !Number.isFinite(Number(a.wait)))
        throw Error("--wait requires a number");
      exitCode = network.switch(a);
      break;
    case "storage":
      network.storage(!!a.json);
      break;
  }
  return { output: lines.join("\n"), exitCode };
}
