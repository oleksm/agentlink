import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { atomic, locked } from "./records.js";
import type { RecordData as Row } from "./common.js";
export const PREFIXES: Record<string, string> = {
  intake: "I",
  project: "P",
  retrospective: "R",
};
export const label = (rec: Row) =>
  [rec.identity.id, rec.identity.name].filter(Boolean).join(" ");
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".yaml")
        ? [join(dir, e.name)]
        : [],
  );
}
export function assign(rec: Row, root: string): void {
  const identity = rec.identity,
    key = identity.key,
    prefix = PREFIXES[key.split(".")[0]];
  if (!prefix) return;
  const directory = join(root, "registry/DevProjects/.ids");
  locked(join(directory, "lock"), () => {
    const path = join(directory, "reservations.json"),
      ids: Record<string, string> = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : {};
    for (const source of sources(join(root, "registry/DevProjects/metadata"))) {
      const item = parse(readFileSync(source, "utf8"))?.identity ?? {};
      if (item.id && PREFIXES[item.key?.split(".")[0]]) {
        if (ids[item.key] && ids[item.key] !== item.id)
          throw Error("Short ID changed for " + item.key);
        ids[item.key] = item.id;
      }
    }
    let given = identity.id === "TODO" ? undefined : identity.id;
    if (key in ids) {
      if (given && given !== ids[key])
        throw Error("Short ID changed for " + key);
      given = ids[key];
    }
    if (given) {
      if (!new RegExp("^" + prefix + "(?:0[1-9]|[1-9][0-9]+)$").test(given))
        throw Error("Invalid short ID: " + given);
      if (Object.entries(ids).some(([k, v]) => k !== key && v === given))
        throw Error("Duplicate short ID: " + given);
    } else
      given =
        prefix +
        String(
          Math.max(
            0,
            ...Object.values(ids)
              .filter((v) => v.startsWith(prefix))
              .map((v) => Number(v.slice(1))),
          ) + 1,
        ).padStart(2, "0");
    ids[key] = given;
    atomic(
      path,
      JSON.stringify(Object.fromEntries(Object.entries(ids).sort()), null, 2) +
        "\n",
    );
    identity.id = given;
  });
}
export function errors(records: Row[]): Array<[string, string]> {
  const seen: Row = {},
    result: Array<[string, string]> = [];
  for (const rec of records) {
    const identity = rec.identity ?? {},
      key = identity.key ?? "",
      prefix = PREFIXES[key.split(".")[0]];
    if (!prefix) continue;
    const value = identity.id ?? "";
    if (!new RegExp("^" + prefix + "(?:0[1-9]|[1-9][0-9]+)$").test(value))
      result.push([key, "identity.id: missing or invalid short ID"]);
    else if (value in seen && seen[value] !== key)
      result.push([key, "identity.id: duplicate " + value]);
    seen[value] = key;
  }
  return result;
}
