import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  statSync,
  utimesSync,
  watch as watchDirectory,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { locked, atomic } from "./records.js";
import type { RecordData as Row } from "./common.js";
export const KINDS = ["task", "ack", "done", "blocked", "note"] as const;
export const MAX_SUMMARY = 400;
export const CONTROLLER = "_agentmsg";
export type MessageKind = (typeof KINDS)[number];
export interface Message {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  summary: string;
  at: string;
  ref?: string;
  reply_to?: string;
  see?: string[];
}
export type Mail = Array<[string, Message]>;
export interface Observations {
  tmux_alive?: (name: string) => boolean;
  running?: (name: string) => boolean;
  usage?: (runtime: string | null, session: string | null) => unknown;
  probe_result?: (probe: Row, messages: Message[]) => Row;
}
export interface CommandResult {
  output: string;
  exitCode: number;
}
const expanded = (p: string) =>
  p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const read = (p: string, fallback: any = {}) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
};
const files = (p: string) =>
  existsSync(p)
    ? readdirSync(p)
        .filter((n) => n.endsWith(".json"))
        .sort()
        .map((n) => join(p, n))
    : [];
const localDate = (d: Date) => {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export function line(m: Message): string {
  return `${m.id} ${m.kind} from ${m.from}${m.ref ? " [" + m.ref + "]" : ""}${m.reply_to ? " re " + m.reply_to : ""}: ${m.summary}${m.see?.length ? " see " + m.see.join(", ") : ""}`;
}
export const owed = (m: Message): boolean =>
  ["task", "blocked", "question"].includes(m.kind);
export const wakes = (got: Mail): boolean =>
  got.some(([, m]) => m.kind !== "ack" && !(m.from === m.to && m.reply_to));
export function parse(argv: string[]): [string[], Row] {
  const pos: string[] = [],
    opt: Row = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const equal = a.indexOf("="),
        k = a.slice(2, equal < 0 ? undefined : equal);
      let v: string | boolean = equal < 0 ? true : a.slice(equal + 1);
      if (
        equal < 0 &&
        i + 1 < argv.length &&
        !argv[i + 1]!.startsWith("--") &&
        !["peek", "quiet", "window"].includes(k)
      )
        v = argv[++i]!;
      if (k === "see") (opt.see ??= []).push(v);
      else opt[k] = v;
    } else pos.push(a);
  }
  return [pos, opt];
}
/** Original agentnet runtime identity lookup, including UUIDs in saved resume commands. */
export function identity(c: Row): [string | null, string | null] {
  const cmd = (c.term ?? []).join(" "),
    runtime =
      c.runtime ||
      (cmd.includes("claude")
        ? "claude"
        : cmd.includes("codex")
          ? "codex"
          : c.session
            ? "claude"
            : null),
    ids =
      cmd.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ) ?? [];
  return [
    runtime,
    ids.at(-1) ?? (runtime !== "codex" || c.runtime ? c.session : null) ?? null,
  ];
}
/** Native file mailbox. Persisted message objects retain their original fields. */
export class Agentmsg {
  readonly HOME: string;
  readonly MAIL: string;
  readonly LOG: string;
  readonly RUN: string;
  readonly CONF: string;
  constructor(
    home =       process.env.AGL_HOME ??
      join(homedir(), ".agents"),
  ) {
    this.HOME = resolve(expanded(home));
    this.MAIL = join(this.HOME, "mail");
    this.LOG = join(this.HOME, "log");
    this.RUN = join(this.HOME, "run");
    this.CONF = join(this.HOME, "agents.json");
  }
  conf(): Record<string, Row> {
    return read(this.CONF, {});
  }
  aliases(): Record<string, string> {
    return read(join(this.HOME, "aliases.json"), {});
  }
  canonical(name: string): string {
    if (!name) return name;
    const aliases = this.aliases(),
      seen = new Set<string>();
    while (Object.hasOwn(aliases, name)) {
      if (seen.has(name)) throw Error("cycle in agent aliases");
      seen.add(name);
      name = aliases[name]!;
    }
    return name;
  }
  me(opt: Row = {}, cwd?: string): string | null {
    if (opt.as) return this.canonical(opt.as);
    const env = process.env.AGL_AGENT;
    if (env) return this.canonical(env);
    void cwd;
    return null;
  }
  box(name: string, part = "new"): string {
    const path = join(this.MAIL, this.canonical(name), part);
    mkdirSync(path, { recursive: true });
    return path;
  }
  write_atomic(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  }
  unread(name: string): Mail {
    const out: Mail = [];
    for (const path of files(this.box(name)))
      try {
        out.push([path, JSON.parse(readFileSync(path, "utf8"))]);
      } catch {}
    return out;
  }
  mark_read(name: string, paths: string[]): string[] {
    const claimed: string[] = [];
    for (const path of paths)
      try {
        renameSync(path, join(this.box(name, "read"), basename(path)));
        claimed.push(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    return claimed;
  }
  claim(name: string, got: Mail): Mail {
    const claimed = new Set(
      this.mark_read(
        name,
        got.map(([f]) => f),
      ),
    );
    return got.filter(([f]) => claimed.has(f));
  }
  restore(name: string, got: Mail): void {
    for (const [path] of got)
      try {
        renameSync(join(this.box(name, "read"), basename(path)), path);
        const now = new Date();
        utimesSync(path, now, now);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
  }
  send(pos: string[], opt: Row): Message {
    if (pos.length < 2) throw Error("send <to> <kind> --summary '...'");
    const to = this.canonical(pos[0]!),
      kind = pos[1]!;
    if (!(KINDS as readonly string[]).includes(kind))
      throw Error("kind is one of " + KINDS.join(", "));
    const from = this.me(opt);
    if (!from)
      throw Error(
        "who are you? --as NAME, $AGL_AGENT, or a cwd in agents.json",
      );
    const summary = opt.summary;
    if (typeof summary !== "string")
      throw Error("--summary '...' (at most 400 characters)");
    const length = [...summary].length;
    if (length > MAX_SUMMARY)
      throw Error(
        `the summary is ${length} characters; at most ${MAX_SUMMARY}: put the rest in a file and --see it`,
      );
    const at = localDate(new Date()),
      id =
        at.replaceAll("-", "").replaceAll(":", "") +
        "-" +
        from +
        "-" +
        randomBytes(2).toString("hex"),
      m: Message = { id, from, to, kind: kind as MessageKind, summary, at };
    for (const k of ["ref", "reply_to"] as const) {
      const v = opt[k.replace("_", "-")];
      if (typeof v === "string") m[k] = v;
    }
    if (opt.see) m.see = opt.see;
    // Self-addressed replies are thread bookkeeping, not new work for the sender.
    const target = join(this.box(to, from === to && m.reply_to ? "read" : "new"), id + ".json");
    this.write_atomic(target, m);
    copyFileSync(target, join(this.box(from, "sent"), id + ".json"));
    return m;
  }
  inbox(opt: Row = {}): Mail {
    const name = this.me(opt);
    if (!name) throw Error("who are you? --as NAME");
    const got = this.unread(name);
    return opt.peek ? got : this.claim(name, got);
  }
  show(id: string): Message {
    if (!id) throw Error("show <id>");
    for (const path of this.message_paths())
      if (basename(path) === id + ".json")
        return JSON.parse(readFileSync(path, "utf8"));
    throw Error("no message " + id);
  }
  message_paths(): string[] {
    if (!existsSync(this.MAIL)) return [];
    return readdirSync(this.MAIL, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        const dir = join(this.MAIL, d.name);
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .flatMap((e) => files(join(dir, e.name)));
      });
  }
  messages(): Message[] {
    const found = new Map<string, Message>();
    for (const path of this.message_paths())
      try {
        const m: Message = JSON.parse(readFileSync(path, "utf8"));
        if (m?.id) {
          m.from = this.canonical(m.from);
          m.to = this.canonical(m.to);
          found.set(m.id, m);
        }
      } catch (e) {
        if ((e as Error).message === "cycle in agent aliases") throw e;
      }
    return [...found.values()];
  }
  open(opt: Row = {}): { owe: Message[]; waiting: Message[] } {
    const name = this.me(opt);
    if (!name) throw Error("who are you? --as NAME");
    const load = (paths: string[]) =>
        paths.flatMap((path) => {
          try {
            return [JSON.parse(readFileSync(path, "utf8")) as Message];
          } catch {
            return [];
          }
        }),
      mine = load(files(join(this.MAIL, name, "sent"))),
      received = load([
        ...files(join(this.MAIL, name, "new")),
        ...files(join(this.MAIL, name, "read")),
      ]),
      closedByMe = new Set(
        mine
          .filter((m) => ["done", "blocked"].includes(m.kind))
          .map((m) => m.reply_to),
      ),
      closedToMe = new Set(
        received
          .filter((m) => ["done", "blocked"].includes(m.kind))
          .map((m) => m.reply_to),
      );
    return {
      owe: received
        .filter(
          (m) => ["task", "blocked"].includes(m.kind) && !closedByMe.has(m.id),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      waiting: mine
        .filter((m) => m.kind === "task" && !closedToMe.has(m.id))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  update(name: string, fn: (record: Row) => void): void {
    locked(join(this.RUN, "config.lock"), () => {
      const config = this.conf();
      if (!Object.hasOwn(config, name)) throw Error("unknown agent: " + name);
      fn(config[name]!);
      atomic(this.CONF, JSON.stringify(config, null, 2));
    });
  }
  register(name: string, cwd: string, runtime: string): Row {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
      throw Error(
        "agent name must contain letters, digits, underscores or hyphens",
      );
    if (!["codex", "claude"].includes(runtime))
      throw Error("runtime must be claude or codex");
    cwd = real(expanded(cwd));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      throw Error("working directory does not exist");
    return locked(join(this.RUN, "config.lock"), () => {
      const config = this.conf();
      if (Object.hasOwn(config, name))
        throw Error("agent already exists; use bind to change its session");
      const row = { cwd, runtime, term: [runtime] };
      config[name] = row;
      atomic(this.CONF, JSON.stringify(config, null, 2));
      return row;
    });
  }
  /** Alias chains are configuration, not an automatic rename/move command. */
  alias(name: string): string {
    return this.canonical(name);
  }
  default_wake_prompt(name: string, got: Mail, term = false): string {
    const lines = got.map(([, m]) => line(m)).join("\n"),
      ask = got.map(([, m]) => m).filter(owed),
      as =
        term || (process.env.AGL_AGENT) === name
          ? ""
          : " --as " + name,
      prefix = `Mail for you (${name}), ${got.length} message(s):\n${lines}\n`;
    if (!ask.length) return prefix + "No reply needed.";
    const cmds = ask
      .map(
        (m) =>
          `agentlink msg send ${m.from} done|blocked --reply-to ${m.id}${as} --summary '<=${MAX_SUMMARY} chars, name the commit or file'.`,
      )
      .join(" ");
    return (
      prefix +
      `Start working on ${ask.length === 1 ? "it" : "them"} (after the current task, if busy). Answer with: ${cmds} If you are blocked or need another agent's help, ask by mail: agentlink msg send <agent> task|blocked --summary '...'${as}. Send results by mail, not only in your window.` +
      (ask.length < got.length ? " No reply to the rest." : "")
    );
  }
  wake_prompt(name: string, got: Mail, term = false): string {
    const project = this.conf()[name]?.forked_from?.project,
      all = got.map(([, m]) => m).filter(owed),
      projectAsk = all.filter(
        (m) =>
          project && m.ref === "project." + project && m.from !== CONTROLLER,
      );
    if (!projectAsk.length) return this.default_wake_prompt(name, got, term);
    const ask = all.filter((m) => !projectAsk.includes(m)),
      as =
        term || (process.env.AGL_AGENT) === name
          ? ""
          : " --as " + name,
      instructions: string[] = [];
    instructions.push(
      `Project worker instructions for ${projectAsk.map((m) => m.id).join(", ")}: handle the assigned work after your current task. Publish acknowledgement, progress, findings, artifacts, completion and blockers through agentlink work update project.${project} <AC> <status> with evidence. Coordinate only with temporary peers through agentlink work ask project.${project}. Do not send routine done/blocked/ack replies to project-manager, even if inherited instructions say to reply on every task. The workflow handles escalation after the configured recovery sequence.`,
    );
    if (ask.length)
      instructions.push(
        "For the other actionable messages only: " +
          ask
            .map(
              (m) =>
                `agentlink msg send ${m.from} done|blocked --reply-to ${m.id}${as} --summary '<=${MAX_SUMMARY} chars, name the commit or file'.`,
            )
            .join(" ") +
          " Follow explicit connection-probe instructions when present.",
      );
    if (ask.length + projectAsk.length < got.length)
      instructions.push(
        "No reply to acknowledgements, notes or done messages.",
      );
    return (
      `Mail for you (${name}), ${got.length} message(s):\n${got.map(([, m]) => line(m)).join("\n")}\n` +
      instructions.join(" ")
    );
  }
  async wait(opt: Row = {}): Promise<Mail> {
    const name = this.me(opt);
    if (!name) throw Error("who are you? --as NAME");
    const timeout =
      typeof opt.timeout === "string" ? Number(opt.timeout) : null;
    if (timeout !== null && !Number.isFinite(timeout))
      throw Error("timeout must be seconds");
    const end = timeout ? Date.now() + timeout * 1000 : null;
    while (!this.unread(name).length) {
      const left = end === null ? null : end - Date.now();
      if (left !== null && left <= 0) return [];
      await new Promise<void>((done) => {
        const timer = setTimeout(
          finish,
          left === null ? 2000 : Math.max(1, Math.min(left, 2000)),
        );
        const watcher = watchDirectory(this.box(name), finish);
        function finish() {
          clearTimeout(timer);
          watcher.close();
          done();
        }
      });
    }
    return this.claim(name, this.unread(name));
  }
  status(withUsage = false, observations: Observations = {}): Row {
    const messages = this.messages(),
      agents = [];
    for (const [name, c] of Object.entries(this.conf())) {
      const [runtime, session] = identity(c),
        sent = messages.filter((m) => m.from === name),
        received = messages.filter((m) => m.to === name),
        closedByMe = new Set(
          sent
            .filter((m) => ["done", "blocked"].includes(m.kind))
            .map((m) => m.reply_to),
        ),
        closedToMe = new Set(
          received
            .filter((m) => ["done", "blocked"].includes(m.kind))
            .map((m) => m.reply_to),
        ),
        terminal = observations.tmux_alive?.("agent-" + name) ?? false,
        peers: Row = {};
      for (const m of sent)
        if (m.to !== CONTROLLER) peers[m.to] = (peers[m.to] ?? 0) + 1;
      const row: Row = {
        agent: name,
        runtime,
        session,
        cwd: c.cwd,
        delivery: terminal ? "terminal" : c.wake ? "wake" : "notification",
        process: terminal
          ? "managed-terminal"
          : observations.running?.(name)
            ? "wake-running"
            : "unverified",
        unread: files(join(this.MAIL, name, "new")).length,
        owe: received.filter(
          (m) => ["task", "blocked"].includes(m.kind) && !closedByMe.has(m.id),
        ).length,
        waiting: sent.filter((m) => m.kind === "task" && !closedToMe.has(m.id))
          .length,
        sent: sent.length,
        received: received.length,
        peers,
        last_sent: sent.length
          ? sent
              .map((m) => m.at ?? "")
              .sort()
              .at(-1)
          : null,
        paused_for_handoff: Boolean(c.handoff_pause),
      };
      if (withUsage)
        row.usage = observations.usage?.(runtime, session) ?? {
          source: null,
          tokens: null,
          limits: null,
        };
      agents.push(row);
    }
    const load = (dir: string) =>
      files(join(this.HOME, dir)).flatMap((p) => {
        try {
          return [JSON.parse(readFileSync(p, "utf8"))];
        } catch {
          return [];
        }
      });
    return {
      observed_at: new Date().toISOString(),
      unique_messages: messages.length,
      agents,
      probes: load("probes").map((p) =>
        observations.probe_result
          ? observations.probe_result(p, messages)
          : probe_result(p, messages),
      ),
      switches: load("switches"),
    };
  }
  who(observations: Observations = {}): string {
    const config = this.conf(),
      names = [
        ...new Set(
          [
            ...(existsSync(this.MAIL) ? readdirSync(this.MAIL) : []),
            ...Object.keys(config),
          ].map((n) => this.canonical(n)),
        ),
      ].sort();
    return (
      "agent".padEnd(14) +
      " " +
      "unread".padStart(6) +
      "  " +
      "wake".padEnd(6) +
      " cwd\n" +
      names
        .map((n) => {
          const c = config[n] ?? {},
            how = observations.tmux_alive?.("agent-" + n)
              ? "term"
              : c.wake
                ? "auto"
                : "notify";
          return (
            n.padEnd(14) +
            " " +
            String(this.unread(n).length).padStart(6) +
            "  " +
            how.padEnd(6) +
            " " +
            (c.cwd ?? "")
          );
        })
        .join("\n")
    );
  }
}
export function probe_result(p: Row, messages: Message[]): Row {
  const steps = [
    [p.a, p.b],
    [p.b, p.a],
  ].map(([from, to]) => {
    const pings = messages.filter(
        (m) =>
          m.from === from && m.to === to && m.ref === p.id && m.kind === "task",
      ),
      ack = messages.find(
        (m) =>
          m.from === to &&
          m.to === from &&
          m.kind === "ack" &&
          m.ref === p.id &&
          pings.some((ping) => m.reply_to === ping.id),
      );
    return {
      from,
      to,
      ping: pings.length > 0,
      ack: Boolean(ack),
      ack_at: ack?.at ?? null,
    };
  });
  return {
    id: p.id,
    a: p.a,
    b: p.b,
    created_at: p.created_at,
    state: steps.every((s) => s.ack)
      ? "PASS"
      : Date.now() / 1000 > p.expires
        ? "EXPIRED"
        : "PENDING",
    steps,
  };
}
export async function agentmsg_cli(
  home: string,
  args: string[],
  actor?: string,
  observations: Observations = {},
): Promise<CommandResult> {
  const api = new Agentmsg(home),
    [command, ...rest] = args,
    [pos, opt] = parse(rest);
  if (actor && !opt.as) opt.as = actor;
  const result = (output: string, exitCode = 0) => ({ output, exitCode });
  switch (command) {
    case "send":
      return result(api.send(pos, opt).id);
    case "inbox": {
      const got = api.inbox(opt);
      return result(
        got.length
          ? got.map(([, m]) => line(m)).join("\n")
          : opt.quiet
            ? ""
            : "no mail",
        !got.length && opt.quiet ? 1 : 0,
      );
    }
    case "show":
      return result(JSON.stringify(api.show(pos[0]!), null, 1));
    case "wait": {
      const got = await api.wait(opt);
      return result(
        got.length ? got.map(([, m]) => line(m)).join("\n") : "no mail",
        got.length ? 0 : 1,
      );
    }
    case "open": {
      const threads = api.open(opt),
        lines: string[] = [];
      for (const k of ["owe", "waiting"] as const) {
        lines.push(k + ": " + threads[k].length);
        for (const m of threads[k])
          lines.push("  " + [...line(m)].slice(0, 240).join(""));
      }
      return result(lines.join("\n"));
    }
    case "who":
      return result(api.who(observations));
    case "register": {
      const name = pos[0];
      if (
        !name ||
        typeof opt.cwd !== "string" ||
        typeof opt.runtime !== "string"
      )
        throw Error("register NAME --cwd PATH --runtime codex|claude");
      api.register(name, opt.cwd, opt.runtime);
      return result(
        `Registered ${name}. Start with: agentlink msg launch ${name}`,
      );
    }
    case "status": {
      const s = api.status(Boolean(opt.usage), observations);
      if (opt.json) return result(JSON.stringify(s, null, 2));
      const lines = [
        "AGENT          RUNTIME DELIVERY      UNREAD OWE WAIT SENT RECV",
      ];
      for (const r of s.agents) {
        lines.push(
          String(r.agent).padEnd(14) +
            " " +
            String(r.runtime ?? "?").padEnd(7) +
            " " +
            r.delivery.padEnd(13) +
            " " +
            String(r.unread).padStart(6) +
            " " +
            String(r.owe).padStart(3) +
            " " +
            String(r.waiting).padStart(4) +
            " " +
            String(r.sent).padStart(4) +
            " " +
            String(r.received).padStart(4),
        );
        lines.push(
          "  peers sent: " +
            Object.entries(r.peers)
              .map(([k, v]) => `${k}=${v}`)
              .join(", "),
        );
        if (r.paused_for_handoff) lines.push("  delivery paused for handoff");
        if (opt.usage)
          lines.push("  recorded session usage: " + JSON.stringify(r.usage));
      }
      lines.push(
        `${s.unique_messages} unique messages. Terminal/wake availability is not proof of responsiveness.`,
      );
      for (const p of s.probes.slice(-10))
        lines.push(`probe ${p.id}: ${p.state} (${p.a} <-> ${p.b})`);
      return result(lines.join("\n"));
    }
    case "alias":
      if (pos.length !== 1)
        throw Error(
          "alias NAME resolves existing aliases; edit alias configuration explicitly for renames",
        );
      return result(api.alias(pos[0]!));
    default:
      throw Error("no command " + command);
  }
}
