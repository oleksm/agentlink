import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, dirname, relative } from "node:path";
export function helper(argv: string[], allowed: string[][] = []): boolean {
  if (basename(argv[0] || '') === 'codex-code-mode-host') return true;
  return allowed.some(command => JSON.stringify(command) === JSON.stringify(argv));
}
function provider_child(pid: number, row: { ppid: number; argv: string[] }, pane_pid: number, rows: Map<number, { ppid: number; argv: string[] }>, proc: string, runtime?: string): boolean {
    if (runtime !== "codex" || row.ppid !== pane_pid)
        return false;
    const parent = rows.get(pane_pid);
    if (!parent || basename(parent.argv[0] || "") !== "node" ||
        JSON.stringify(parent.argv.slice(2)) !== JSON.stringify(row.argv.slice(1)))
        return false;
    try {
        const wrapper = realpathSync(parent.argv[1] || "");
        if (!wrapper.endsWith("/node_modules/@openai/codex/bin/codex.js"))
            return false;
        const binary = realpathSync(join(proc, String(pid), "exe"));
        const location = relative(dirname(dirname(wrapper)), binary);
        return /^node_modules\/@openai\/codex-linux-(?:x64|arm64)\/vendor\/(?:x86_64|aarch64)-unknown-linux-(?:musl|gnu)\/bin\/codex$/.test(location) &&
            realpathSync(row.argv[0] || "") === binary &&
            realpathSync(join(proc, String(pid), "cwd")) === realpathSync(join(proc, String(pane_pid), "cwd"));
    }
    catch {
        return false;
    }
}
export function remaining_jobs(
  pane_pid: number,
  proc = "/proc",
  runtime?: string,
  helpers: string[][] = [],
): { pid: number; executable: string }[] {
  const rows = new Map<number, { ppid: number; argv: string[] }>();
  for (const name of readdirSync(proc).filter((x) => /^\d+$/.test(x))) {
    try {
      const text = readFileSync(join(proc, name, "stat"), "utf8"),
        fields = text
          .slice(text.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/),
        raw = readFileSync(join(proc, name, "cmdline"))
          .toString("utf8")
          .replace(/\0+$/, "");
      rows.set(Number(name), {
        ppid: Number(fields[1]),
        argv: raw.split("\0"),
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const found = new Set([pane_pid]);
  for (;;) {
    const n = found.size;
    for (const [pid, row] of rows) if (found.has(row.ppid)) found.add(pid);
    if (n === found.size) break;
  }
  return [...found]
    .filter((pid) => pid !== pane_pid && !helper(rows.get(pid)!.argv, helpers) &&
      !provider_child(pid, rows.get(pid)!, pane_pid, rows, proc, runtime))
    .sort((a, b) => a - b)
    .map((pid) => ({ pid, executable: basename(rows.get(pid)!.argv[0]!) }));
}
