import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { assign } from "./project_ids.js";
import { Records, folders, locked } from "./records.js";
import type { RecordData } from "./common.js";
const policies = fileURLToPath(
  new URL("../../skills/agenlink-manager/references/", import.meta.url),
);
/** Copy source bytes only when the destination is absent; preserve installation customizations. */
export function provisionNativeWorkspace(home: string): string[] {
  const installed: string[] = [];
  const copyMissing = (source: string, target: string) => {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      installed.push(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  };
  mkdirSync(join(home, "registry"), { recursive: true });
  for (const name of ["workflow-policy.json"])
    copyMissing(join(policies, name), join(home, name));
  return installed;
}
function nativeSchema(kind: string, home: string): RecordData {
  if (!Object.hasOwn(folders, kind))
    throw Error("no schema says x-kind " + kind);
  return parse(
    readFileSync(
      join(home, "registry/DevProjects/schema", kind + ".schema.yaml"),
      "utf8",
    ),
  );
}
function draftPath(kind: string, slug: string, home: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(slug) || slug === ".." || slug === ".")
    throw Error("Invalid registry slug: " + slug);
  return new Records(home).path(kind + "." + slug);
}
/** Source new semantics: required top-level values are null, required identity values TODO. */
export function nativeDraft(
  kind: string,
  slug: string,
  home: string,
): RecordData {
  draftPath(kind, slug, home);
  const schema = nativeSchema(kind, home),
    name = slug.replaceAll("-", " "),
    record: RecordData = {
      identity: {
        key: kind + "." + slug,
        name: name.slice(0, 1).toUpperCase() + name.slice(1).toLowerCase(),
      },
    };
  for (const key of schema.required ?? [])
    if (key !== "identity") record[key] = null;
  for (const key of schema.properties?.identity?.required ?? [])
    if (!Object.hasOwn(record.identity, key)) record.identity[key] = "TODO";
  assign(record, home);
  return record;
}
/** Explicit draft write only; incomplete drafts are deliberately not schema-validated or enabled. */
export function writeDraft(
  kind: string,
  slug: string,
  home: string,
): { path: string; record: RecordData } {
  const path = draftPath(kind, slug, home);
  return locked(join(home, "registry", ".native-draft"), () => {
    if (existsSync(path))
      throw Error(relative(resolve(home), path) + " exists");
    provisionNativeWorkspace(home);
    const record = nativeDraft(kind, slug, home),
      schema = join(home, "registry/DevProjects/schema", kind + ".schema.yaml"),
      rel = relative(dirname(path), schema).split(sep).join("/");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      "# yaml-language-server: $schema=" +
        rel +
        "\n" +
        stringify(record, { lineWidth: 200 }),
      { flag: "wx", mode: 0o600 },
    );
    return { path, record };
  });
}
