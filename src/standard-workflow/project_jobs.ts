import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { command, now as clock } from "./project_runtime_ports.js";
import type { RecordData } from "./common.js";
const RUNTIMES = new Set([
  "claude",
  "codex",
  "node",
  "bash",
  "sh",
  "zsh",
  "tmux",
  "MainThread",
]);
export function processes(proc_root = "/proc"): RecordData[] {
  const rows: RecordData[] = [];
  for (const name of readdirSync(proc_root).filter((x) => /^\d+$/.test(x))) {
    try {
      const text = readFileSync(join(proc_root, name, "stat"), "utf8"),
        end = text.lastIndexOf(") "),
        fields = text
          .slice(end + 2)
          .trim()
          .split(/\s+/);
      if (fields.length < 20) continue;
      rows.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        start: fields[19],
        cpu: Number(fields[11]) + Number(fields[12]),
        name: text.slice(text.indexOf("(") + 1, end),
      });
    } catch {}
  }
  return rows;
}
export function descendants(rows: RecordData[], pid: number): Set<number> {
  const found = new Set([pid]);
  for (;;) {
    const n = found.size;
    for (const r of rows) if (found.has(r.ppid)) found.add(r.pid);
    if (n === found.size) return found;
  }
}
function affinity(pid: number): number[] {
  const text = readFileSync("/proc/" + pid + "/status", "utf8"),
    line = text.match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1];
  if (line === undefined) throw Error("CPU affinity unavailable");
  return line
    .split(",")
    .flatMap((part) => {
      const [a, b] = part.split("-").map(Number);
      return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
    })
    .sort((a, b) => a - b);
}
export function observe(
  worker: RecordData,
  config: RecordData,
  previous: RecordData[],
  rows?: RecordData[],
  now = clock(),
): RecordData[] {
  const sid = worker.fork?.session;
  if (!sid || config.session !== sid || config.forked_from?.project == null)
    return [];
  let pane: number;
  try {
    pane = Number(
      command(
        [
          "tmux",
          "-L",
          "agent-" + worker.id,
          "display-message",
          "-p",
          "-t",
          "agent-" + worker.id,
          "#{pane_pid}",
        ],
        2000,
      ).trim(),
    );
    if (!Number.isInteger(pane)) return [];
  } catch {
    return [];
  }
  rows ??= processes();
  const table = new Map(rows.map((p) => [p.pid, p]));
  if (!table.has(pane)) return [];
  const prior = new Map(previous.map((p) => [p.pid + ":" + p.start, p])),
    result: RecordData[] = [];
  for (const child of descendants(rows, pane)) {
    if (child === pane) continue;
    const p = table.get(child)!;
    if (
      RUNTIMES.has(p.name) ||
      p.name.startsWith("npm ") ||
      p.name.startsWith("mcp-") ||
      p.name.startsWith("uvx")
    )
      continue;
    let allowed: number[];
    try {
      allowed = affinity(child);
    } catch (e) {
      if (
        ["ENOENT", "EACCES", "EPERM"].includes(
          (e as NodeJS.ErrnoException).code || "",
        )
      )
        continue;
      throw e;
    }
    const before = prior.get(child + ":" + p.start) || {};
    result.push({
      ...p,
      affinity: allowed,
      first_seen: before.first_seen ?? now,
      advancing: Object.keys(before).length > 0 && p.cpu > before.cpu,
      observed_at: now,
    });
  }
  return result;
}
export function contention(
  groups: RecordData,
  cpu_count?: number,
): RecordData[] {
  const limit = Math.max(1, Math.floor((cpu_count || cpus().length || 1) / 2)),
    names = Object.keys(groups).sort(),
    result: RecordData[] = [];
  for (let i = 0; i < names.length; i++)
    for (const right of names.slice(i + 1)) {
      const left = names[i]!,
        a = groups[left],
        b = groups[right];
      if (a.project === b.project) continue;
      const allowed = (g: RecordData) =>
        new Set<number>(
          (g.jobs || [])
            .filter(
              (p: RecordData) =>
                p.advancing &&
                p.affinity.length >= 1 &&
                p.affinity.length <= limit,
            )
            .flatMap((p: RecordData) => p.affinity),
        );
      const ac = allowed(a),
        bc = allowed(b),
        overlap = [...ac].filter((x) => bc.has(x)).sort((x, y) => x - y);
      if (overlap.length)
        result.push({
          workers: [left, right],
          projects: [a.project, b.project],
          cpus: overlap,
        });
    }
  return result;
}
