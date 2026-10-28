import { bundledSkills } from "./roles.js";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";

export function installSkills(destination: string | string[]): string[] {
  const targets = [
    ...new Set(
      (Array.isArray(destination) ? destination : [destination]).map((path) =>
        resolve(path),
      ),
    ),
  ];
  const installed: string[] = [];
  const missing: { source: string; target: string; directory: boolean }[] = [];
  const inspect = (source: string, path: string): void => {
    const directory = lstatSync(source).isDirectory();
    let current;
    try {
      current = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      current &&
      (current.isSymbolicLink() ||
        current.isDirectory() !== directory ||
        (!directory && !readFileSync(path).equals(readFileSync(source))))
    ) {
      throw new Error(
        `Existing skill differs; preserve it in a backup before upgrading this bundle, or choose another client destination: ${path}`,
      );
    }
    if (!current) missing.push({ source, target: path, directory });
    if (directory)
      for (const name of readdirSync(source))
        inspect(join(source, name), join(path, name));
  };
  // Check every destination and complete bundle before copying anything. A matching SKILL.md
  // alone does not prove that installed references are current or complete.
  for (const target of targets)
    for (const name of bundledSkills) {
      const source = fileURLToPath(
          new URL(`../skills/${name}`, import.meta.url),
        ),
        path = join(target, name);
      inspect(source, path);
      installed.push(path);
    }
  for (const item of missing) {
    if (item.directory) mkdirSync(item.target, { recursive: true });
    else cpSync(item.source, item.target, { errorOnExist: true, force: false });
  }
  return installed;
}
const quote = (value: string): string =>
  '"' +
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$") +
  '"';
export function serviceTemplate(store: Store): string {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  for (const value of [process.execPath, cli, store.home])
    if (/[\r\n\0]/.test(value)) throw new Error("Invalid service path");
  return `[Unit]\nDescription=Agent registry and workflow\n\n[Service]\nType=simple\nKillMode=process\nExecStart=${quote(process.execPath)} ${quote(cli)} serve --workflow${store.config().headless ? " --headless" : ""} --home ${quote(store.home)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
export function writeService(store: Store, path: string): string {
  const content = serviceTemplate(store);
  if (existsSync(path) && readFileSync(path, "utf8") !== content)
    throw new Error("Service file exists with different content");
  writeFileSync(path, content, { mode: 0o600 });
  return resolve(path);
}
