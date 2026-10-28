import { acquireDirectoryLock } from "./locks.js";
import { provisionNativeWorkspace } from "./standard-workflow/native_workspace.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  configSchema,
  type Config,
} from "./contracts.js";

export const workspacePath = (value?: string): string =>
  resolve(
    value ??
      process.env.AGL_HOME ??
      join(homedir(), ".local/share/agenlink"),
  );
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export class Store {
  readonly home: string;
  constructor(home?: string) {
    this.home = workspacePath(home);
  }
  get rosterPath(): string {
    return join(this.home, "agents.json");
  }
  config(): Config {
    return configSchema.parse(
      JSON.parse(readFileSync(join(this.home, "config.json"), "utf8")),
    );
  }

}
export function initialize(home: string, options: Partial<Config> = {}): Store {
  const store = new Store(home);
  mkdirSync(store.home, { recursive: true, mode: 0o700 });
  const lock = join(store.home, ".write-lock");
  const release = acquireDirectoryLock(lock);
  try {
    const cfgPath = join(store.home, "config.json");
    if (!existsSync(cfgPath))
      atomicJson(
        cfgPath,
        configSchema.parse({
          version: 1,
          name: "Agent workspace",
          port: 8792,
          tickSeconds: 30,
          ...options,
        }),
      );
    else store.config();
    for (const folder of ["registry", "registry/evidence", "runtime"])
      mkdirSync(join(store.home, folder), { recursive: true, mode: 0o700 });
    provisionNativeWorkspace(store.home);
    if (!existsSync(join(store.home, "registry/.git")))
      execFileSync(
        "git",
        ["init", "-b", "main", join(store.home, "registry")],
        { stdio: "pipe" },
      );
    return store;
  } finally {
    release();
  }
}
