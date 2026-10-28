import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { RecordData } from "./common.js";
import { state, epoch } from "./common.js";
import {
  runtime_ports,
  type NativePorts,
  command,
  sleep,
  expanded,
} from "./project_runtime_ports.js";
export const PENDING = ["requested", "ready", "compacting"];
export function tokens(rec: RecordData, wid: string): number {
  return rec.acceptance_criteria
    .filter((c: RecordData) => c.worker === wid)
    .reduce(
      (n: number, c: RecordData) =>
        n +
        Math.max(
          0,
          (c.token_usage?.input || 0) - (c.token_usage?.cached_input || 0),
        ) +
        (c.token_usage?.output || 0),
      0,
    );
}
export function boundary(rec: RecordData, wid: string): string {
  return (
    [...rec.events]
      .reverse()
      .find((e: RecordData) => e.actor === wid && e.status === "completed")
      ?.id || ""
  );
}
export function native(
  worker: RecordData,
  home: string,
  ports: NativePorts = runtime_ports(),
): [RecordData, string] {
  const config =
      JSON.parse(readFileSync(join(home, "agents.json"), "utf8"))[worker.id] ||
      {},
    fork = worker.fork || {};
  if (!fork.session || config.session !== fork.session)
    throw Error("compaction requires exact child session binding");
  const path = ports.session_file(fork.runtime, fork.session);
  if (!path) throw Error("native transcript unavailable");
  return [config, path];
}
export function events(path: string): RecordData[] {
  const raw = readFileSync(path);
  let start = Math.max(0, raw.length - 2000000);
  while (start) {
    const previous = Math.max(0, start - 65536),
      newline = raw.subarray(previous, start).lastIndexOf(10);
    if (newline >= 0) {
      start = previous + newline + 1;
      break;
    }
    start = previous;
  }
  const rows: RecordData[] = [];
  for (const line of raw.subarray(start).toString("utf8").split("\n"))
    try {
      rows.push(JSON.parse(line));
    } catch {}
  return rows;
}
export function compacted(path: string, since: number): boolean {
  return events(path).some(
    (r) =>
      epoch(r.timestamp) >= since &&
      (r.type === "compacted" || r.subtype === "compact_boundary"),
  );
}
export function idle(path: string, runtime: string): boolean {
  const rows = events(path);
  if (runtime === "codex") {
    const turns = rows.filter(
      (r) =>
        r.type === "event_msg" &&
        ["task_started", "task_complete", "turn_aborted"].includes(
          r.payload?.type,
        ),
    );
    return (
      !!turns.length &&
      ["task_complete", "turn_aborted"].includes(turns.at(-1)!.payload.type)
    );
  }
  const turns = rows.filter((r) => ["user", "assistant"].includes(r.type));
  return (
    !!turns.length &&
    turns.at(-1)!.type === "assistant" &&
    turns.at(-1)!.message?.stop_reason === "end_turn"
  );
}
export function launch(
  worker: RecordData,
  home: string,
  ports: NativePorts = runtime_ports(),
): boolean {
  const [config, path] = native(worker, home, ports);
  if (!idle(path, worker.fork.runtime)) return false;
  const session = config.tmux_terminal || "agent-" + worker.id,
    base = ["tmux", "-L", config.tmux_socket || session],
    run = (args: string[]) => command([...base, ...args]);
  let pane = run(["capture-pane", "-p", "-t", session]);
  const prompts = pane
    .split("\n")
    .filter((line) => /^[›❯]/.test(line.trimStart()))
    .map((x) => x.trim());
  if (!prompts.length) return false;
  let prefix = "";
  if (!["›", "❯", "› Ask Codex to do anything"].includes(prompts.at(-1)!)) {
    if (worker.fork.runtime !== "claude") return false;
    const cursor = run([
      "display-message",
      "-p",
      "-t",
      session,
      "#{cursor_x}",
    ]).trim();
    if (cursor !== "2") return false;
    run(["send-keys", "-t", session, "-l", "/"]);
    sleep(0.3);
    pane = run(["capture-pane", "-p", "-t", session]);
    const check = pane
      .split("\n")
      .filter((x) => x.trimStart().startsWith("❯"))
      .map((x) => x.trim());
    if (!check.length || check.at(-1)!.replaceAll("\u00a0", " ") !== "❯ /") {
      run(["send-keys", "-t", session, "BSpace"]);
      return false;
    }
    prefix = "/";
  }
  run(["send-keys", "-t", session, "-l", prefix ? "compact" : "/compact"]);
  sleep(0.5);
  run(["send-keys", "-t", session, "Enter"]);
  return true;
}
export function review_checkpoint(
  rec: RecordData,
  worker: RecordData,
  folder: string,
): string | null {
  const latest = [...(rec.events || [])]
    .reverse()
    .find(
      (e: RecordData) => e.actor === worker.id && e.status && e.criterion,
    )?.criterion;
  for (const c of rec.acceptance_criteria) {
    if (latest && latest !== c.id) continue;
    if (latest && state(rec, c.id) === "completed") continue;
    const review = c.token_review || {},
      execution = c.execution || {};
    if (
      c.worker !== worker.id ||
      !["reviewed", "hold"].includes(review.state) ||
      !execution.paused
    )
      continue;
    const t = worker.track || {};
    if (!["", c.id].includes(t.active)) continue;
    if ((review.reviewed_at || "") < (execution.paused_at || "")) continue;
    for (const value of (execution.pause_reason || "").match(
      /\/[^\s`]+\.md/g,
    ) || []) {
      const path = expanded(value),
        rel = relative(expanded(folder), path);
      if (
        rel === ".." ||
        rel.startsWith("../") ||
        isAbsolute(rel) ||
        !existsSync(path) ||
        !statSync(path).isFile()
      )
        continue;
      const target = join(
        folder,
        "runtime",
        worker.id,
        "review-context-checkpoint.md",
      );
      writeFileSync(
        target,
        readFileSync(path, "utf8") +
          "\n\nCurrent review guidance: " +
          (review.guidance || "") +
          "\nReview decision: " +
          review.state +
          "\nPreserve all project holds.\n",
      );
      return target;
    }
  }
  return null;
}
