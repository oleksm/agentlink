import { mkdirSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Records } from "./records.js";
import type { RecordData as Row } from "./common.js";
import { status_history } from "./presentation.js";
import { validate_plan } from "./project_coverage.js";
import { validate_record as validate_requests } from "./project_requests.js";
export { status_history, short_reason } from "./presentation.js";
export function update_status(rec: Row, changes: Row): boolean {
  const allowed = ["workflow_step", "status", "criterion", "owner", "reason"];
  if (
    !changes ||
    Array.isArray(changes) ||
    typeof changes !== "object" ||
    !Object.keys(changes).length ||
    Object.keys(changes).some((k) => !allowed.includes(k))
  )
    throw Error(
      "status updates accept workflow_step, status, criterion, owner and reason only",
    );
  if (typeof changes.reason !== "string" || !changes.reason.trim())
    throw Error(
      "every status row requires an explicit nonblank reason; include reason in the status object",
    );
  const history = status_history(rec),
    current = history[0] || {},
    updated: Row = {
      ...Object.fromEntries(
        Object.entries(current).filter(([k]) => k !== "timestamp"),
      ),
      ...changes,
    };
  if (
    Object.keys(updated).length !== allowed.length ||
    allowed.some((k) => !(k in updated))
  )
    throw Error(
      "initial status needs workflow_step, status, criterion, owner and reason",
    );
  if (!rec.workflow.some((s: Row) => s.id === updated.workflow_step))
    throw Error("unknown workflow step");
  if (
    ![
      "blocked",
      "not started",
      "in progress",
      "acceptance",
      "completed",
      "bypassed",
      "fail",
      "pending",
    ].includes(updated.status)
  )
    throw Error("unknown work status");
  if (
    updated.criterion &&
    !(rec.acceptance_criteria || []).some(
      (c: Row) => c.id === updated.criterion,
    )
  )
    throw Error("unknown acceptance criterion");
  if (typeof updated.owner !== "string" || !updated.owner.trim())
    throw Error("status owner is required");
  const previous = history.find((r: Row) => r.criterion === updated.criterion);
  if (
    previous &&
    ["workflow_step", "status", "criterion", "owner"].every(
      (k) => updated[k] === previous[k],
    )
  )
    return false;
  updated.timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  rec.status = [updated, ...history];
  return true;
}
const nonempty = (v: any) =>
  v != null &&
  (Array.isArray(v) || typeof v === "string"
    ? v.length > 0
    : typeof v === "object"
      ? Object.keys(v).length > 0
      : Boolean(v));
/** Cross-record-field rules; structural schema validation precedes this function. */
export function check_record(rec: Row): string[] {
  const errors: string[] = [];
  if (rec.identity?.key?.startsWith("retrospective.")) {
    if (!["pending", "completed", "fail"].includes(rec.project_status))
      errors.push("retrospective requires project_status");
    if (rec.state === "complete") {
      if (!nonempty(rec.findings) || !rec.reviewed_at)
        errors.push("complete retrospective requires findings and reviewed_at");
      if (!["completed", "fail"].includes(rec.project_status))
        errors.push(
          "complete retrospective requires an assessed project_status",
        );
    }
    return errors;
  }
  if (!rec.identity?.key?.startsWith("project.")) return [];
  if (!["pending", "completed", "fail"].includes(rec.project_status))
    errors.push("project requires explicit project_status");
  if (
    rec.project_status === "completed" &&
    (rec.products || []).some(
      (p: Row) => !["merged", "not-required"].includes(p.merge?.status),
    )
  )
    errors.push(
      "completed project outcome requires all required integrations recorded",
    );
  for (const c of rec.acceptance_criteria || []) {
    const budget = c.experiment_budget_minutes ?? 3;
    if (!Number.isInteger(budget) || budget < 1 || budget > 4)
      errors.push(c.id + ": experiment budget must be 1..4 minutes");
  }
  for (const row of status_history(rec))
    if (typeof row.reason !== "string" || !row.reason.trim())
      errors.push("status: every row requires a nonblank reason");
  if (nonempty(rec.coverage))
    try {
      validate_plan(rec, rec.coverage);
    } catch (e) {
      errors.push((e as Error).message);
    }
  try {
    validate_requests(rec);
  } catch (e) {
    errors.push("peer coordination: " + (e as Error).message);
  }
  const current = status_history(rec)[0]!,
    step = current.workflow_step,
    prepared = [
      "ready",
      "active",
      "validating",
      "merging",
      "closing",
      "closed",
      "retrospective",
    ].includes(step);
  if (prepared) {
    for (const field of ["goal", "logic", "logistics", "ownership", "products"])
      if (!nonempty(rec[field]))
        errors.push(field + ": required for a prepared project");
    if (!("workers" in rec))
      errors.push("workers: required for a prepared project (empty if none)");
  }
  const criteria: Row[] = rec.acceptance_criteria || [];
  if (prepared)
    for (const c of criteria)
      if (
        !nonempty(c.logic_refs) ||
        c.logic_refs.some(
          (r: string) => !["proposed_solution", "exit_criteria"].includes(r),
        )
      )
        errors.push(
          c.id +
            ": logic_refs must identify the research statements for artifact review",
        );
  if (prepared && !criteria.length)
    errors.push("acceptance_criteria: required for a prepared project");
  if (prepared && !nonempty(rec.logic?.exit_criteria))
    errors.push("logic.exit_criteria: required for a prepared project");
  rec = {
    goal: "",
    logic: {},
    logistics: { owner_holds: [] },
    ownership: [],
    products: [],
    workers: [],
    ...rec,
  };
  const groups: Record<string, Row[]> = Object.fromEntries(
    ["products", "workers", "evidence", "decisions", "blockers", "events"].map(
      (k) => [k, rec[k]],
    ),
  );
  groups.workflow = rec.workflow;
  groups.acceptance_criteria = criteria;
  groups.resources = rec.cleanup.resources;
  const ids: Record<string, Set<any>> = {};
  for (const [name, rows] of Object.entries(groups)) {
    ids[name] = new Set(rows.map((r) => r.id));
    if (ids[name]!.size !== rows.length) errors.push(name + ": duplicate ids");
  }
  const reference = (value: any, group: string, where: string) => {
    if (!ids[group]!.has(value))
      errors.push(`${where}: unknown ${group} id ${value}`);
  };
  function walk(value: any, where = "") {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${where}[${i}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const at = where ? `${where}.${key}` : key;
      if (
        ["evidence", "research_evidence"].includes(key) &&
        Array.isArray(child) &&
        child.every((v) => typeof v === "string")
      )
        child.forEach((v) => reference(v, "evidence", at));
      else if (key === "workflow_step") reference(child, "workflow", at);
      else if (["product", "worker", "criterion"].includes(key)) {
        if (key === "criterion" && child === "") continue;
        reference(
          child,
          (
            {
              product: "products",
              worker: "workers",
              criterion: "acceptance_criteria",
            } as Row
          )[key],
          at,
        );
      } else if (key === "owned_resources")
        for (const v of child as any[]) reference(v, "resources", at);
      walk(child, at);
    }
  }
  walk(rec);
  for (const c of criteria) {
    if (
      c.result === "deferred" &&
      !rec.decisions.some(
        (d: Row) =>
          d.status === "decided" &&
          d.owner === "owner" &&
          d.id.startsWith("owner-scope-"),
      )
    )
      errors.push("deferred criteria require an explicit owner scope decision");
    if (
      c.result !== "pending" &&
      (!nonempty(c.actual_result) || !nonempty(c.evidence))
    )
      errors.push(
        `criterion ${c.id}: a result needs actual_result and evidence`,
      );
  }
  for (const w of rec.workers) {
    const t = w.track || {};
    for (const cid of [t.active, t.resume, ...(t.suspended || [])])
      if (cid && !ids.acceptance_criteria!.has(cid))
        errors.push("worker track references unknown criterion " + cid);
    if ((t.suspended || []).includes(t.active))
      errors.push("worker track cannot be both active and suspended");
  }
  const forkIds = new Set(),
    forkSessions = new Set(),
    permanent = new Set([
      ...rec.ownership.map((o: Row) => o.source_agent),
      rec.identity.manager,
      ...rec.workers.map((w: Row) => w.source.identity),
    ]),
    session = (s: Row) => JSON.stringify([s.runtime, s.session]),
    sourceSessions = new Set(rec.workers.map((w: Row) => session(w.source)));
  for (const w of rec.workers) {
    if (
      !["planned", "starting"].includes(w.status) &&
      ["fork", "resume_command", "context_method", "runtime_manifest"].some(
        (k) => !nonempty(w[k]),
      )
    )
      errors.push(
        `worker ${w.id}: needs actual fork session, resume command, context method and runtime manifest`,
      );
    if (w.fork?.session === w.source.session && w.fork)
      errors.push(`worker ${w.id}: fork cannot reuse the source session`);
    if (w.fork) {
      const f = w.fork,
        s = session(f);
      if (permanent.has(f.identity) || forkIds.has(f.identity))
        errors.push(
          `worker ${w.id}: fork identity must be distinct from permanent roles and other workers`,
        );
      if (sourceSessions.has(s))
        errors.push(`worker ${w.id}: fork session belongs to a source agent`);
      if (forkSessions.has(s))
        errors.push(
          `worker ${w.id}: fork session is already used by another worker`,
        );
      forkIds.add(f.identity);
      forkSessions.add(s);
    }
  }
  for (const o of rec.ownership)
    if ("share" in o && !o.share_source)
      errors.push("ownership.share: needs the supplied share's source");
  for (const b of rec.logistics.budgets || [])
    if (b.unit === "currency" && !b.currency)
      errors.push("logistics.budgets: currency budget needs currency code");
  for (const d of rec.decisions)
    if (
      d.status === "decided" &&
      (!nonempty(d.outcome) || !nonempty(d.evidence))
    )
      errors.push(`decision ${d.id}: needs outcome and evidence`);
  for (const b of rec.blockers)
    if (
      b.status === "resolved" &&
      (!nonempty(b.resolution) || !nonempty(b.evidence))
    )
      errors.push(`blocker ${b.id}: needs resolution and evidence`);
  if (
    current.status === "blocked" &&
    !rec.blockers.some((b: Row) => b.status === "open")
  )
    errors.push("blocked project needs an open blocker");
  if (prepared)
    for (const p of rec.products)
      for (const field of [
        "base_commit",
        "project_branch",
        "worktree",
        "lock_path",
      ])
        if (!p[field])
          errors.push(`product ${p.id}: ${field} required for ${step}`);
  for (const p of rec.products) {
    const m = p.merge,
      pub = p.publication || {};
    if (
      pub.status === "published" &&
      ["remote", "commit", "evidence"].some((k) => !nonempty(pub[k]))
    )
      errors.push(
        `product ${p.id}: published needs remote, commit and evidence`,
      );
    if (["held", "not-required"].includes(pub.status) && !pub.reason)
      errors.push(`product ${p.id}: publication status needs a reason`);
    if (
      m.status === "merged" &&
      ["candidate_commit", "merge_commit", "at", "evidence"].some(
        (k) => !nonempty(m[k]),
      )
    )
      errors.push(
        `product ${p.id}: merged requires candidate, merge commit, time and evidence`,
      );
    if (m.status === "not-required" && !m.reason)
      errors.push(`product ${p.id}: not-required merge needs a reason`);
  }
  if (
    (rec.logistics.prohibited_actions || []).includes("merge") &&
    rec.products.some(
      (p: Row) =>
        !["not-required", "pending", "blocked"].includes(p.merge.status),
    )
  )
    errors.push(
      "owner prohibition forbids merging; acceptance cannot release it",
    );
  if (["merging", "closing", "closed", "retrospective"].includes(step)) {
    if (criteria.some((c) => !["pass", "deferred"].includes(c.result)))
      errors.push("integration: every criterion must pass");
    if (
      rec.blockers.some((b: Row) => b.status === "open") ||
      nonempty(rec.logistics.owner_holds)
    )
      errors.push("integration: open blockers or owner holds remain");
    const evidence = new Set(criteria.flatMap((c) => c.evidence));
    for (const p of rec.products) {
      const candidate = p.merge.candidate_commit;
      if (
        !candidate ||
        !rec.evidence.some(
          (e: Row) =>
            evidence.has(e.id) && e.product === p.id && e.commit === candidate,
        )
      )
        errors.push(
          `integration: product ${p.id} needs exit-criterion evidence at its candidate commit`,
        );
    }
  }
  if (
    ["closing", "closed", "retrospective"].includes(step) &&
    rec.products.some(
      (p: Row) => !["merged", "not-required"].includes(p.merge.status),
    )
  )
    errors.push(`${step}: some products remain unmerged`);
  for (const r of rec.cleanup.resources)
    if (r.status === "removed") {
      if (!r.project_owned)
        errors.push(`resource ${r.id}: cannot remove a permanent resource`);
      if (!nonempty(r.evidence) || !rec.postmortem)
        errors.push(
          `resource ${r.id}: removal needs evidence and prior postmortem`,
        );
    }
  if (
    rec.cleanup.status === "complete" &&
    (!nonempty(rec.cleanup.evidence) ||
      rec.cleanup.resources.some((r: Row) =>
        ["pending", "blocked"].includes(r.status),
      ))
  )
    errors.push("cleanup: complete needs evidence and no pending resources");
  if (rec.cleanup.status === "not-required" && !rec.cleanup.reason)
    errors.push("cleanup: not-required needs a reason");
  if (
    rec.cleanup.status === "not-required" &&
    rec.cleanup.resources.some((r: Row) =>
      ["pending", "blocked"].includes(r.status),
    )
  )
    errors.push(
      "cleanup: not-required cannot leave pending or blocked resources",
    );
  if (["closed", "retrospective"].includes(step)) {
    if (
      !rec.postmortem ||
      !["complete", "not-required"].includes(rec.cleanup.status)
    )
      errors.push("closed: postmortem and completed cleanup required");
    if (rec.workers.some((w: Row) => w.status !== "retired"))
      errors.push("closed: temporary workers must be retired");
  }
  if (
    step === "retrospective" &&
    current.status === "completed" &&
    !rec.retrospective
  )
    errors.push(
      "retrospective: reviewed summary and intake/prevalidation findings required",
    );
  return errors;
}
export {
  workflow_actions,
  workflow_actions_html,
  blockers_newest,
  coverage_html,
} from "./presentation.js";

export function project_path(root: string, slug: string): string {
  return new Records(root).path("project." + slug);
}
export function archive_completed(root: string, rec: Row): string | null {
  const state = status_history(rec)[0]!;
  if (state.workflow_step !== "retrospective" || state.status !== "completed")
    return null;
  if (rec.cleanup?.status !== "complete")
    throw Error("Archive requires completed cleanup");
  const errors = check_record(rec);
  if (errors.length) throw Error(errors.join("; "));
  const retrospective = parse(
    readFileSync(new Records(root).path(rec.retrospective), "utf8"),
  );
  if (retrospective.state !== "complete")
    throw Error("Archive requires reviewed retrospective");
  if (
    retrospective.owner_conclusion &&
    retrospective.owner_conclusion.state !== "completed"
  )
    throw Error("Archive requires owner conclusion");
  const slug = rec.identity.key.split(".").slice(1).join("."),
    source = project_path(root, slug),
    folder = join(root, "registry/DevProjects/metadata/closed-projects"),
    target = join(folder, slug + ".yaml");
  mkdirSync(folder, { recursive: true });
  if (source !== target) renameSync(source, target);
  return target;
}
