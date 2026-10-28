import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { sha256, json_sorted, type RecordData } from "./common.js";
export const contract = (row: RecordData): string =>
  sha256(
    json_sorted(
      Object.fromEntries(Object.entries(row).filter(([k]) => k !== "reports")),
    ),
  );
export function validate(rec: RecordData, row: RecordData): void {
  const declarations = row.inputs || [];
  if (!declarations.length)
    throw Error("declare consumed product paths, tools and external datasets");
  const products = new Set(rec.products.map((p: RecordData) => p.id)),
    seen = new Set(),
    covered = new Set();
  for (const item of declarations) {
    const product = item.product,
      path = item.path || "",
      key = JSON.stringify([product ?? null, path]);
    if (!path || seen.has(key))
      throw Error("input paths must be nonblank and distinct");
    seen.add(key);
    if (product) {
      if (
        !products.has(product) ||
        posix.isAbsolute(path) ||
        path.split("/").includes("..")
      )
        throw Error(
          "product input must be a repository-relative file or directory",
        );
      covered.add(product);
    } else if (!isAbsolute(path))
      throw Error("external input needs an absolute file path");
  }
  if ((row.required_scope.products || []).some((p: string) => !covered.has(p)))
    throw Error("declare consumed inputs for every required product");
}
export function fingerprint(
  rec: RecordData,
  declarations: RecordData[],
): RecordData[] {
  const products = Object.fromEntries(
    rec.products.map((p: RecordData) => [p.id, p]),
  );
  return declarations.map((item) => {
    const path = item.path,
      product = item.product;
    let hash: string;
    if (product) {
      const repo = products[product].worktree,
        git = (...args: string[]) =>
          execFileSync("git", ["-C", repo, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
      if (git("status", "--porcelain", "--untracked-files=all", "--", path))
        throw Error("consumed input is dirty: " + path);
      if (
        git("ls-tree", "-r", "HEAD", "--", path)
          .split("\n")
          .some(
            (line) => line.startsWith("120000 ") || line.startsWith("160000 "),
          )
      )
        throw Error("declare symlink/submodule contents separately: " + path);
      hash = git(
        "rev-parse",
        path === "." ? "HEAD^{tree}" : "HEAD:" + path,
      ).trim();
    } else {
      if (!statSync(path).isFile())
        throw Error("external input missing: " + path);
      hash = sha256(readFileSync(path));
    }
    return { ...item, hash };
  });
}
export function current(
  rec: RecordData,
  row: RecordData,
  report: RecordData,
): boolean {
  try {
    return (
      report.contract_hash === contract(row) &&
      json_sorted(report.inputs) === json_sorted(fingerprint(rec, row.inputs))
    );
  } catch {
    return false;
  }
}
