import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { acquireDirectoryLock } from "../locks.js";
import { validateStandardRecord } from "../registry/project-schemas.js";
import type { RecordData } from "./common.js";

export const NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const folders: Record<string, string> = {
  project: "projects",
  intake: "intakes",
  retrospective: "retrospectives",
};
export function atomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function locked<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireDirectoryLock(path + ".d");
  try {
    return action();
  } finally {
    release();
  }
}
export function read_record(path: string): RecordData {
  const value = parse(readFileSync(path, "utf8"), { maxAliasCount: 10000 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected a registry object: " + path);
  return value;
}
export function validate_record(record: RecordData, home: string) {
  const kind = String(record.identity?.key || "").split(".")[0]!;
  if (!folders[kind])
    throw Error("Expected an intake, project or retrospective identity");
  const errors = validateStandardRecord(kind, record, home);
  if (errors.length) throw Error(errors.join("; "));
  return record;
}
/** Read original YAML without coercion; validate at write/import and explicit check boundaries. */
export class Records {
  readonly metadata: string;
  constructor(readonly home: string) {
    this.metadata = join(home, "registry/DevProjects/metadata");
  }
  path(key: string) {
    const dot = key.indexOf("."),
      kind = key.slice(0, dot),
      slug = key.slice(dot + 1);
    if (!folders[kind] || !/^[a-z0-9][a-z0-9.-]*$/.test(slug))
      throw Error("Invalid registry key: " + key);
    const active = join(this.metadata, folders[kind]!, slug + ".yaml");
    if (kind !== "project") return active;
    const archived = join(this.metadata, "closed-projects", slug + ".yaml");
    if (existsSync(active) && existsSync(archived))
      throw Error("Duplicate active/closed project: " + slug);
    return existsSync(archived) ? archived : active;
  }
  read(key: string) {
    return read_record(this.path(key));
  }
  list(kind?: string) {
    const rows: RecordData[] = [];
    for (const folder of [...Object.values(folders), "closed-projects"]) {
      const dir = join(this.metadata, folder);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .sort()) {
        const value = read_record(join(dir, file));
        if (
          typeof value.identity?.key === "string" &&
          (!kind || value.identity.key.startsWith(kind + "."))
        )
          rows.push(value);
      }
    }
    return rows;
  }
  save(record: RecordData) {
    validate_record(record, this.home);
    const path = this.path(record.identity.key),
      kind = record.identity.key.split(".")[0];
    atomic(
      path,
      "# yaml-language-server: $schema=" +
        relative(
          dirname(path),
          join(this.home, "registry/DevProjects/schema", kind + ".schema.yaml"),
        ) +
        "\n" +
        stringify(record, { version: "1.1", lineWidth: 140 }),
    );
    return record;
  }
  update<T>(key: string, action: (record: RecordData) => T) {
    return locked(
      join(this.home, "projects", key.replace(/^[^.]+\./, ""), "workers.lock"),
      () => {
        const record = this.read(key),
          result = action(record);
        this.save(record);
        return result;
      },
    );
  }
  import(record: RecordData) {
    validate_record(record, this.home);
    return locked(join(this.home, "registry", ".native-import"), () => {
      const path = this.path(record.identity.key);
      if (existsSync(path)) {
        const old = this.read(record.identity.key);
        if (JSON.stringify(old) !== JSON.stringify(record))
          throw Error(
            "Record already exists with different content: " +
              record.identity.key,
          );
        return old;
      }
      return this.save(record);
    });
  }
}
