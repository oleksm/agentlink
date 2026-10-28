import { lstatSync, statSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { RecordData } from "./common.js";
import { expanded } from "./project_runtime_ports.js";
function match(value: string, pattern: string): boolean {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      let end = i + 1;
      if (pattern[end] === "!") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end === pattern.length) out += "\\[";
      else {
        let stuff = pattern.slice(i + 1, end).replaceAll("\\", "\\\\");
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        out += "[" + stuff + "]";
        i = end;
      }
    } else out += c.replace(/[\\^$+?.()|{}]/g, "\\$&");
  }
  return new RegExp(out + "$", "s").test(value);
}
export function extend(
  rec: RecordData,
  caller: string,
  cid: string,
  paths: string[],
): string[] {
  const c = rec.acceptance_criteria.find((x: RecordData) => x.id === cid);
  if (c?.worker !== caller)
    throw Error("only the assigned worker may extend its paths");
  const worker = rec.workers.find((w: RecordData) => w.id === caller),
    product = rec.products.find((p: RecordData) => p.id === worker.product);
  if (
    rec.workers.some(
      (w: RecordData) =>
        w.id !== caller &&
        w.product === worker.product &&
        w.status !== "retired",
    )
  )
    throw Error(
      "shared product: PM must check ownership and record an explicit handoff",
    );
  const own = rec.ownership.find(
      (o: RecordData) => o.source_agent === worker.source.identity,
    ),
    root = realpathSync(product.worktree),
    validated: string[] = [];
  for (const value of paths) {
    const parts = value.split("/").filter((p) => p && p !== ".");
    if (
      value.startsWith("/") ||
      parts.includes("..") ||
      !parts.length ||
      parts.some((p) => p.startsWith(".")) ||
      /[*?\[\]]/.test(value)
    )
      throw Error("ownership requires exact relative product file paths");
    const path = resolve(root, value),
      target = expanded(path),
      rel = relative(root, target);
    let symlink = false;
    try {
      symlink = lstatSync(path).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      rel === ".." ||
      rel.startsWith("../") ||
      isAbsolute(rel) ||
      symlink ||
      (existsSync(path) &&
        (lstatSync(path).isSymbolicLink() || statSync(path).isDirectory()))
    )
      throw Error("path escapes product or is not a file");
    for (const other of rec.ownership) {
      if (other === own) continue;
      if (
        (other.owned_paths || []).some(
          (pattern: string) =>
            match(value, pattern) ||
            value.startsWith(pattern.replace(/\/+$/, "") + "/"),
        )
      )
        throw Error("path already assigned; explicit handoff required");
    }
    validated.push(value);
  }
  const added = [...new Set(validated)].filter(
    (value) => !own.owned_paths.includes(value),
  );
  own.owned_paths.push(...added);
  return added;
}
