import { acquireDirectoryLock } from "./locks.js";
import { spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, atomicJson, workspacePath } from "./store.js";
const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
export function serviceStatus(store: Store): {
  running: boolean;
  pid?: number;
  url?: string;
} {
  try {
    const record = JSON.parse(
      readFileSync(join(store.home, "runtime/service.json"), "utf8"),
    ) as { pid: number; start: string; url: string };
    const args = readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split(
      "\0",
    );
    const start = readFileSync(`/proc/${record.pid}/stat`, "utf8")
      .split(") ")
      .slice(1)
      .join(") ")
      .split(" ")[19];
    const homeIndex = args.indexOf("--home");
    const env = Object.fromEntries(
      readFileSync(`/proc/${record.pid}/environ`, "utf8")
        .split("\0")
        .filter(Boolean)
        .map((s) => {
          const n = s.indexOf("=");
          return [s.slice(0, n), s.slice(n + 1)];
        }),
    );
    const selectedHome =
      homeIndex >= 0
        ? args[homeIndex + 1]
        : (args.find((a) => a.startsWith("--home="))?.slice(7) ??
          env.AGL_HOME);
    return {
      running:
        start === record.start &&
        args.includes(cli) &&
        workspacePath(selectedHome) === store.home &&
        args.includes("serve"),
      pid: record.pid,
      url: record.url,
    };
  } catch {
    return { running: false };
  }
}
export async function startService(store: Store) {
  mkdirSync(join(store.home, "runtime"), { recursive: true });
  const release = acquireDirectoryLock(
    join(store.home, "runtime/service-start.lock"),
  );
  try {
    return await startServiceLocked(store);
  } finally {
    release();
  }
}
async function startServiceLocked(store: Store) {
  if (serviceStatus(store).running) return serviceStatus(store);
  mkdirSync(join(store.home, "runtime"), { recursive: true });
  const fd = openSync(join(store.home, "runtime/service.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [cli, "serve", "--workflow", "--home", store.home],
    { detached: true, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  child.unref();
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let url = `http://127.0.0.1:${store.config().port}`;
  if (!child.pid) throw Error("Service did not start");
  let start: string | undefined;
  for (let i = 0; i < 50; i++) {
    if (exited) throw Error("Service exited; inspect runtime/service.log");
    try {
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8")
        .split(") ")
        .slice(1)
        .join(") ")
        .split(" ");
      start = stat[19];
      try {
        const registered = JSON.parse(
          readFileSync(join(store.home, "runtime/service.json"), "utf8"),
        );
        if (registered.pid === child.pid) url = registered.url;
      } catch {
        /* CLI may not have registered its bound port yet. */
      }
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const health = (await response.json()) as { pid?: number };
      if (response.ok && health.pid === child.pid) {
        atomicJson(join(store.home, "runtime/service.json"), {
          pid: child.pid,
          start,
          url,
        });
        return serviceStatus(store);
      }
    } catch {
      /* Wait for this process's server, never accept another workspace. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (existsSync(`/proc/${child.pid}`)) child.kill("SIGTERM");
  throw Error("Service did not become healthy; inspect runtime/service.log");
}
export function stopService(store: Store) {
  const status = serviceStatus(store);
  if (status.running && status.pid) process.kill(status.pid, "SIGTERM");
  return { stopped: status.running };
}

export function registerService(store: Store, port: number): void {
  const start = readFileSync(`/proc/${process.pid}/stat`, "utf8")
    .split(") ")
    .slice(1)
    .join(") ")
    .split(" ")[19];
  atomicJson(join(store.home, "runtime/service.json"), {
    pid: process.pid,
    start,
    url: `http://127.0.0.1:${port}`,
  });
}
