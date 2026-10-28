import { acquireDirectoryLock } from "../locks.js";
/** Original file-mail transport: claim only once, restore after failed injection. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
  openSync,
  closeSync,
  watch,
} from "node:fs";
import { join, dirname, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync as nativeSpawnSync, spawn } from "node:child_process";
const spawnSync: typeof nativeSpawnSync = ((command: string,args: string[],options: any={})=>nativeSpawnSync(command,args,{timeout:5000,...options})) as typeof nativeSpawnSync;
import { randomBytes } from "node:crypto";
import { Agentmsg, line, wakes } from "./agentmsg.js";
import { sleep } from "./project_runtime_ports.js";
import type { RecordData } from "./common.js";
import { Records } from "./records.js";
type Mail = ReturnType<Agentmsg["unread"]>;
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const expand = (value: string) =>
  value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? homedir() + value.slice(1)
      : value;
const executable = (name: string) =>
  name.includes("/")
    ? existsSync(name)
    : String(process.env.PATH || "")
        .split(delimiter)
        .some((dir) => existsSync(join(dir, name)));
const checked = (argv: string[]) => {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw Error(r.stderr || r.stdout || "command failed: " + argv[0]);
  return r.stdout;
};
export class NativeTransport {
  readonly mail: Agentmsg;
  readonly run: string;
  readonly log: string;
  constructor(
    readonly home: string,
    readonly output: (text: string) => void = console.log,
  ) {
    this.mail = new Agentmsg(home);
    this.run = join(home, "run");
    this.log = join(home, "log");
  }
  assert_start_allowed(name: string, c: RecordData): void {
    const project = c.forked_from?.project;
    if (!project) return;
    const rec = new Records(this.home).read("project." + project);
    const worker = (rec.workers || []).find((w: RecordData) => w.id === name);
    if (!worker || worker.status === "retired")
      throw Error(name + ": project worker is missing or retired");
    if (worker.source?.identity !== c.forked_from.agent)
      throw Error(name + ": project worker source does not match registration");
    const current = Array.isArray(rec.status) ? rec.status[0] : rec.status;
    if (["closed", "cancelled"].includes(current?.workflow_step))
      throw Error(name + ": project is closed or cancelled");
    if (!worker.runtime_manifest || !existsSync(worker.runtime_manifest))
      throw Error(name + ": project worker runtime manifest is missing");
    const manifest = JSON.parse(readFileSync(worker.runtime_manifest, "utf8"));
    if (manifest.retire_ready)
      throw Error(
        name + ": retirement already requested; preserve stop intent",
      );
  }
  session(name: string): string { return this.mail.conf()[name]?.tmux_terminal || "agent-" + name; }
  tx(sess: string): string[] {
    const socket =
      (this.mail.conf()[sess.replace(/^agent-/, "")] || Object.values(this.mail.conf()).find(c => c.tmux_terminal === sess))?.tmux_socket || sess;
    for (const sock of [["-L", socket], []])
      if (
        spawnSync("tmux", [...sock, "has-session", "-t", sess], {
          stdio: "pipe",
        }).status === 0
      )
        return ["tmux", ...sock];
    return ["tmux", "-L", socket];
  }
  tmux_alive(sess: string): boolean {
    return (
      executable("tmux") &&
      spawnSync(
        "tmux",
        [...this.tx(sess).slice(1), "has-session", "-t", sess],
        { stdio: "pipe" },
      ).status === 0
    );
  }
  unsent(sess: string, mark: string): boolean {
    const tx = this.tx(sess),
      pane =
        spawnSync(tx[0]!, [...tx.slice(1), "capture-pane", "-p", "-t", sess], {
          encoding: "utf8",
        }).stdout || "",
      prompts = pane.split("\n").filter((s) => /^[›❯]/.test(s.trimStart()));
    return (
      !!prompts.length &&
      (prompts.at(-1)!.includes(mark) ||
        prompts.at(-1)!.includes("[Pasted text"))
    );
  }
  inject(name: string, sess: string, got: Mail): boolean {
    const text = this.mail.wake_prompt(name, got, true).split("\n").join(" | "),
      run = (args: string[]) => {
        const tx = this.tx(sess);
        return spawnSync(tx[0]!, [...tx.slice(1), ...args], { stdio: "pipe" });
      };
    if ((this.mail.conf()[name]?.term || []).join(" ").includes("claude"))
      run(["send-keys", "-t", sess, "-l", text]);
    else {
      const buf = "agentmsg-" + name;
      run(["set-buffer", "-b", buf, text]);
      run(["paste-buffer", "-p", "-d", "-b", buf, "-t", sess]);
    }
    for (let i = 0; i < 3; i++) {
      sleep(0.8);
      run(["send-keys", "-t", sess, "Enter"]);
      sleep(0.7);
      if (!this.unsent(sess, text.slice(0, 24))) return true;
    }
    this.output(
      new Date().toTimeString().slice(0, 8) +
        " " +
        name +
        ": the mail is still in its input box after three Enters",
    );
    return false;
  }
  running(name: string): boolean {
    try {
      const text = readFileSync(join(this.run, name + ".pid"), "utf8").trim();
      if (!/^\d+$/.test(text)) return false;
      const pid = Number(text);
      process.kill(pid, 0);
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      return !stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z");
    } catch {
      return false;
    }
  }
  starting(name: string): boolean {
    try {
      return (
        Date.now() / 1000 -
          statSync(join(this.run, name + ".starting")).mtimeMs / 1000 <
        12
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }
  mark_starting(name: string): void {
    mkdirSync(this.run, { recursive: true });
    writeFileSync(
      join(this.run, name + ".starting"),
      String(Date.now() / 1000),
    );
  }
  storage_env(name: string, c: RecordData): string[] {
    const path = resolve(
      expand(c.scratch_dir || join(this.home, "scratch", name)),
    );
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return ["-e", "TMPDIR=" + path, "-e", "CLAUDE_CODE_TMPDIR=" + path];
  }
  start(name: string, c: RecordData): boolean {
    this.assert_start_allowed(name, c);
    const sess = this.session(name);
    if (this.tmux_alive(sess)) return true;
    const cmd: string[] = c.term || [];
    if (!cmd.length) return false;
    const sid = cmd
      .join(" ")
      .match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      )?.[0];
    if (sid) {
      const other = (
        spawnSync("pgrep", ["-f", "(claude|codex).*" + sid], {
          encoding: "utf8",
        }).stdout || ""
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (other.length) {
        this.output(
          name +
            ": its conversation is open elsewhere (pid " +
            other.join(", ") +
            "): close it there, then run this again",
        );
        return false;
      }
    }
    const env = [
        "-e",
        "AGL_AGENT=" + name,
        "-e",
        "AGL_HOME=" + this.home,
        "-e",
        "PATH=" +
          dirname(cli) +
          delimiter +
          join(homedir(), "bin") +
          delimiter +
          (process.env.PATH || ""),
        ...this.storage_env(name, c),
      ],
      own = executable("systemd-run")
        ? [
            "systemd-run",
            "--user",
            "--scope",
            "--quiet",
            "--unit=" + sess + "-" + randomBytes(3).toString("hex"),
          ]
        : [];
    this.mark_starting(name);
    checked([
      ...own,
      ...this.tx(sess),
      "new-session",
      "-d",
      "-s",
      sess,
      "-c",
      expand(c.cwd || "~"),
      ...env,
      ...cmd,
    ]);
    this.output(
      "started " +
        name +
        " in tmux session " +
        sess +
        " (" +
        cmd.join(" ") +
        ")",
    );
    if (this.mail.unread(name).length) {
      const child = spawn(
        process.execPath,
        [cli, "--home", this.home, "msg", "deliver", name],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    }
    return true;
  }
  watched(sess: string): boolean {
    const tx = this.tx(sess);
    return !!(
      spawnSync(tx[0]!, [...tx.slice(1), "list-clients", "-t", sess], {
        encoding: "utf8",
      }).stdout || ""
    ).trim();
  }
  window(sess: string): void {
    const term =
      process.env.TERMINAL ||
      ["alacritty", "kitty", "foot", "gnome-terminal", "xterm"].find(
        executable,
      );
    if (!term)
      throw Error(
        "no terminal found: attach with " +
          this.tx(sess).join(" ") +
          " attach -t " +
          sess,
      );
    const env = { ...process.env };
    delete env.TMUX;
    const child = spawn(term, ["-e", ...this.tx(sess), "attach", "-t", sess], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    this.output(
      "opened a " +
        term +
        " window on " +
        sess +
        "; detach with Ctrl-b d, the agent keeps running",
    );
  }
  term(pos: string[], opt: RecordData = {}, rest?: string[]): void {
    if (!pos.length) throw Error("term <agent> [--here] [-- CMD ...]");
    const name = this.mail.canonical(pos[0]!),
      c = this.mail.conf()[name];
    if (!c)
      throw Error("no agent " + name + " in " + join(this.home, "agents.json"));
    this.assert_start_allowed(name, c);
    if (rest?.length) {
      c.term = rest;
      this.mail.update(name, (entry) => {
        entry.term = rest;
      });
    }
    const sess = this.session(name);
    if (!c.term?.length && !this.tmux_alive(sess))
      throw Error(
        "how is " +
          name +
          " started? give it once: msg term " +
          name +
          " -- codex (or -- claude)",
      );
    if (!this.start(name, c)) throw Error("agent terminal could not start");
    if (opt.here && process.env.TMUX) {
      const tx = this.tx(sess);
      spawnSync(tx[0]!, [...tx.slice(1), "switch-client", "-t", sess], {
        stdio: "inherit",
      });
    } else if (!opt.here || !process.stdout.isTTY) this.window(sess);
    else {
      const tx = this.tx(sess);
      spawnSync(tx[0]!, [...tx.slice(1), "attach", "-t", sess], {
        stdio: "inherit",
      });
    }
  }
  up(pos: string[] = [], opt: RecordData = {}): void {
    pos = pos.map((name) => this.mail.canonical(name));
    for (const [name, c] of Object.entries(this.mail.conf())) {
      if (pos.length && !pos.includes(name)) continue;
      try {
        this.assert_start_allowed(name, c);
      } catch (error) {
        this.output((error as Error).message);
        continue;
      }
      if (!c.term?.length) {
        this.output(
          name + ": no start command (msg term " + name + " -- <command> once)",
        );
        continue;
      }
      if (
        this.start(name, c) &&
        !opt["no-windows"] &&
        !opt.no_windows &&
        !this.watched(this.session(name))
      ) {
        this.window(this.session(name));
        sleep(0.5);
      }
    }
  }
  deliver(name: string, delay = 12): void {
    name = this.mail.canonical(name);
    const sess = this.session(name);
    sleep(delay);
    let got = this.mail.unread(name);
    if (
      got.length &&
      wakes(got) &&
      this.tmux_alive(sess) &&
      !this.mail.conf()[name]?.handoff_pause
    ) {
      got = this.mail.claim(name, got);
      if (got.length && !this.inject(name, sess, got))
        this.mail.restore(name, got);
    }
  }
  hook_claude(
    data: RecordData = {},
    opt: RecordData = {},
  ): RecordData | undefined {
    const sid = data.session_id,
      config = this.mail.conf(),
      owner = Object.entries(config).find(
        ([, c]) => sid && c.session === sid,
      )?.[0];
    let name =
      opt.as || process.env.AGL_AGENT || owner || this.mail.me(opt, data.cwd);
    if (name) name = this.mail.canonical(name);
    if (
      !name ||
      (!owner &&
        sid &&
        config[name]?.session != null &&
        config[name]?.session !== sid) ||
      config[name]?.handoff_pause
    )
      return;
    let got = this.mail.unread(name);
    if (!got.length || !wakes(got)) return;
    got = this.mail.claim(name, got);
    if (got.length)
      return { decision: "block", reason: this.mail.wake_prompt(name, got) };
    return;
  }
  private notify(title: string, text: string): void {
    if (executable("notify-send"))
      spawnSync("notify-send", [title, text], { stdio: "ignore" });
  }
  /** One source watcher sweep. The daemon schedules the returned quiet interval. */
  tick(settle = Number(process.env.AGL_SETTLE || 20)): number {
    mkdirSync(this.log, { recursive: true });
    mkdirSync(this.run, { recursive: true });
    const agents = this.mail.conf(),
      mail = join(this.home, "mail"),
      names = [
        ...new Set(
          [
            ...Object.keys(agents),
            ...(existsSync(mail) ? readdirSync(mail) : []),
          ].map((n) => this.mail.canonical(n)),
        ),
      ].sort();
    let soonest = 60;
    for (const name of names) {
      if (
        name === "_agentmsg" ||
        agents[name]?.handoff_pause ||
        this.starting(name)
      )
        continue;
      let got = this.mail.unread(name);
      if (!got.length || !wakes(got)) continue;
      const quiet =
        Date.now() / 1000 -
        Math.max(...got.map(([file]) => statSync(file).mtimeMs / 1000));
      if (quiet < settle) {
        soonest = Math.min(soonest, settle - quiet + 0.5);
        continue;
      }
      const c = agents[name] || {};
      try {
        this.assert_start_allowed(name, c);
      } catch (error) {
        this.output((error as Error).message);
        continue;
      }
      if (this.tmux_alive(this.session(name))) {
        got = this.mail.claim(name, got);
        if (!got.length) continue;
        if (!this.inject(name, this.session(name), got)) {
          this.mail.restore(name, got);
          continue;
        }
        this.notify(
          "Mail for " + name + " (typed into its terminal)",
          line(got.at(-1)![1]).slice(0, 200),
        );
        this.output(
          new Date().toTimeString().slice(0, 8) +
            " typed " +
            got.length +
            " message(s) into agent-" +
            name,
        );
      } else if (c.wake?.length && !this.running(name)) {
        got = this.mail.claim(name, got);
        if (!got.length) continue;
        const prompt = this.mail.wake_prompt(name, got),
          cmd = c.wake.map((a: string) =>
            a.replaceAll("{prompt}", prompt).replaceAll("{name}", name),
          ),
          log = openSync(join(this.log, name + ".log"), "a");
        writeFileSync(
          log,
          "\n=== " +
            new Date().toISOString() +
            " wake " +
            name +
            ": " +
            got.length +
            " message(s)\n",
        );
        const child = spawn(cmd[0], cmd.slice(1), {
          cwd: expand(c.cwd || "~"),
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            AGL_AGENT: name,
            AGL_HOME: this.home,
            PATH:
              dirname(cli) +
              delimiter +
              join(homedir(), "bin") +
              delimiter +
              (process.env.PATH || ""),
          },
        });
        child.on("error", (e) =>
          this.output("wake " + name + ": " + e.message),
        );
        child.unref();
        closeSync(log);
        if (child.pid)
          writeFileSync(join(this.run, name + ".pid"), String(child.pid));
        this.output(
          new Date().toTimeString().slice(0, 8) +
            " woke " +
            name +
            " (pid " +
            child.pid +
            ") for " +
            got.length +
            " message(s)",
        );
      } else if (!c.wake?.length) {
        const key = join(this.run, name + ".notified"),
          newest = got.at(-1)![1].id;
        if (!existsSync(key) || readFileSync(key, "utf8") !== newest) {
          this.notify("Mail for " + name, line(got.at(-1)![1]).slice(0, 200));
          writeFileSync(key, newest);
          this.output(
            new Date().toTimeString().slice(0, 8) +
              " " +
              name +
              ": " +
              got.length +
              " unread (notified)",
          );
        }
      }
    }
    mkdirSync(mail, { recursive: true });
    return soonest;
  }
  async serve(signal?: AbortSignal): Promise<void> {
    mkdirSync(this.run, { recursive: true });
    const release = acquireDirectoryLock(join(this.run, "mail-watcher.lock"));
    let released = false;
    try {
      const module = fileURLToPath(import.meta.url),
        born = statSync(module).mtimeMs;
      this.output("agentmsg serve: watching " + join(this.home, "mail"));
      while (!signal?.aborted) {
        if (statSync(module).mtimeMs !== born) {
          this.output("agentmsg changed: restarting serve");
          if (!process.execve)
            throw Error(
              "Process replacement unavailable; restart the mail watcher",
            );
          release();
          released = true;
          process.execve(
            process.execPath,
            [process.execPath, cli, "--home", this.home, "msg", "serve"],
            process.env,
          );
        }
        const seconds = this.tick();
        await new Promise<void>((resolve) => {
          const watcher = watch(
              join(this.home, "mail"),
              { recursive: true },
              () => finish(),
            ),
            timer = setTimeout(finish, seconds * 1000);
          function finish() {
            clearTimeout(timer);
            watcher.close();
            signal?.removeEventListener("abort", finish);
            resolve();
          }
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
    } finally {
      if (!released) release();
    }
  }
}
