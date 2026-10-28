import { execFileSync, spawnSync } from "node:child_process";
import type { RecordData } from "./common.js";
export const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export const ancestor = (repo: string, older: string, newer: string): boolean =>
  spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", older, newer])
    .status === 0;
export function prepare_product(product: RecordData): RecordData {
  const repo = product.worktree,
    target_repo = product.repository;
  if (git(repo, "branch", "--show-current") !== product.project_branch)
    throw Error(product.id + ": candidate worktree is on a different branch");
  if (git(repo, "status", "--porcelain"))
    throw Error(product.id + ": candidate worktree has dirty files");
  if (
    git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir") !==
    git(target_repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
  )
    throw Error("candidate and target must share a Git repository");
  const target = git(target_repo, "rev-parse", product.merge_target),
    before = git(repo, "rev-parse", "HEAD");
  if (!ancestor(repo, target, before) && !ancestor(repo, before, target)) {
    try {
      git(repo, "merge", "--no-edit", target);
    } catch {
      git(repo, "merge", "--abort");
      throw Error(
        product.id +
          ": integration reconciliation conflicts; resolve on the project branch",
      );
    }
  } else if (ancestor(repo, before, target) && before !== target)
    git(repo, "merge", "--ff-only", target);
  return {
    product: product.id,
    candidate: git(repo, "rev-parse", "HEAD"),
    target,
  };
}
export function require_current(rec: RecordData, integrated_ok = false): void {
  const pins = Object.fromEntries(
    (rec.integration_preflight || []).map((p: RecordData) => [p.product, p]),
  );
  for (const product of rec.products) {
    if (product.merge.status === "not-required") continue;
    const pin = pins[product.id];
    if (!pin)
      throw Error("integration candidate must be prepared before final review");
    const target = git(product.repository, "rev-parse", product.merge_target);
    if (integrated_ok && ancestor(product.repository, pin.candidate, target))
      continue;
    if (target !== pin.target)
      throw Error(
        "integration target moved; prepare the new candidate before review",
      );
    if (git(product.worktree, "rev-parse", "HEAD") !== pin.candidate)
      throw Error("integration candidate changed; prepare before review");
    if (git(product.worktree, "status", "--porcelain"))
      throw Error("integration candidate has dirty files");
  }
}
export const reconciled = (product: RecordData): boolean =>
  git(product.worktree, "branch", "--show-current") ===
    product.project_branch &&
  !git(product.worktree, "status", "--porcelain") &&
  ancestor(
    product.worktree,
    git(product.repository, "rev-parse", product.merge_target),
    git(product.worktree, "rev-parse", "HEAD"),
  );
