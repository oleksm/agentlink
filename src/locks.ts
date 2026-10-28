import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const boot = () =>
  readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
function start(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")
      .slice(1)
      .join(") ")
      .split(" ")[19];
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return undefined;
    throw error;
  }
}
/** Reclaim only a proven stale owner. Unidentified locks remain fail-closed. */
export function acquireDirectoryLock(path: string): () => void {
  const token = randomUUID();
  const take = () => {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        start: start(process.pid),
        boot: boot(),
        token,
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  };
  try {
    take();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let old: { pid: number; start?: string; boot?: string; token?: string };
    try {
      old = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    } catch {
      throw Error(`Lock owner unknown: ${path}; inspect before recovery`);
    }
    if (!Number.isInteger(old.pid) || old.pid <= 0)
      throw Error(`Invalid lock owner: ${path}`);
    if (
      (old.token && !/^[a-f0-9-]+$/.test(old.token)) ||
      (old.boot && !/^[a-f0-9-]+$/.test(old.boot))
    )
      throw Error(`Invalid lock identity: ${path}`);
    const current = start(old.pid);
    const stale =
      (old.boot && old.boot !== boot()) ||
      !current ||
      (old.start && old.start !== current);
    if (!stale) throw Error(`Workspace busy: ${path}; owner ${old.pid}`);
    // Keep the nonempty quarantine as a tombstone. Concurrent reclaimers cannot
    // rename a newly acquired lock over the same stale owner's directory.
    const quarantine =
      path + ".stale-" + (old.token ?? `${old.pid}-${old.boot ?? "unknown"}`);
    if (existsSync(quarantine))
      throw Error(`Lock recovery already in progress: ${path}`);
    renameSync(path, quarantine);
    try {
      take();
    } catch {
      throw Error(`Lock acquired by another reconciler: ${path}`);
    }
  }
  return () => {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (owner.token !== token) throw Error(`Lock ownership changed: ${path}`);
    rmSync(path, { recursive: true, force: true });
  };
}
