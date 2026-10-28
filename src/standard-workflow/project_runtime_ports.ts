import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { realpathSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import type { RecordData } from "./common.js";
/** Native-provider discovery is injected; it never translates project records. */
export interface NativePorts {
  session_file(runtime: string, session: string): string | null;
  usage(runtime: string, path: string): RecordData;
  policy(): RecordData;
}
function canonical(path: string, seen = new Set<string>()): string {
  if (existsSync(path)) return realpathSync(path);
  try {
    if (lstatSync(path).isSymbolicLink()) {
      if (seen.has(path)) throw Error("Symlink loop: " + path);
      seen.add(path);
      return canonical(resolve(dirname(path), readlinkSync(path)), seen);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  return parent === path
    ? path
    : resolve(canonical(parent, seen), basename(path));
}
export const expanded = (path: string) =>
  canonical(
    resolve(
      path === "~"
        ? homedir()
        : path.startsWith("~/")
          ? homedir() + path.slice(1)
          : path,
    ),
  );
export const now = () => Date.now() / 1000;
export const timestamp = () => new Date().toISOString();
export function command(argv: string[], timeout?: number): string {
  return execFileSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export const sleep = (seconds: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
let configured: NativePorts | undefined;
export function configure_runtime_ports(ports: NativePorts): void {
  configured = ports;
}
export function runtime_ports(): NativePorts {
  if (!configured)
    throw Error("Native workflow runtime ports have not been configured");
  return configured;
}
