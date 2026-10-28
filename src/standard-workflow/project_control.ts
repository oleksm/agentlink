import {reason as configuredBudget,turn} from './project_budgets.js';
import { state, type RecordData } from "./common.js";
import { limit } from "./project_token_budget.js";
import { held_disposition } from "./project_failure_routing.js";
import { assess } from "./project_coverage.js";
export function control(rec: RecordData, c: RecordData,home?:string): string {
  const held = held_disposition(rec, c.id);
  if (held) return "Requestor hold: " + held;
  const review = c.token_review || {};
  if (["hold", "pause requested", "reviewing"].includes(review.state))
    return "Review " + review.state + ": " + (review.guidance || "");
  const configured=configuredBudget(rec,c);if(configured)return configured;
  if(home){const current=turn(rec,c,home);if(current&&current.remaining<=0)return 'Turn time budget reached; checkpoint and finish this turn';}
  const u = c.token_usage || {};
  if (
    Math.max(0, (u.input || 0) - (u.cached_input || 0)) + (u.output || 0) >=
    limit(c,rec)
  )
    return "Token limit reached; wrap-up only, no experimental recovery";
  return "";
}
export function decision_wait(
  rec: RecordData,
  steps: RecordData,
): RecordData[] {
  const decisions = (rec.decisions || []).filter(
    (d: RecordData) => d.status === "open" && d.owner === "owner",
  );
  if (!decisions.length) return [];
  const verification = verification_gaps(rec),
    unfinished = Object.fromEntries(
      (rec.acceptance_criteria || [])
        .filter(
          (c: RecordData) =>
            state(rec, c.id) !== "completed" || c.id in verification,
        )
        .map((c: RecordData) => [c.id, c]),
    );
  if (!Object.keys(unfinished).length) return [];
  const blocked = new Set(
    Object.entries(unfinished)
      .filter(([, c]) => control(rec, c as RecordData))
      .map(([cid]) => cid),
  );
  if (!blocked.size) return [];
  const by_step = Object.fromEntries(
    rec.acceptance_criteria.map((c: RecordData) => [c.step, c.id]),
  );
  while (true) {
    const added = Object.entries(unfinished)
      .filter(([, c]: [string, any]) =>
        (steps[c.step]?.depends_on || []).some((dep: string) =>
          blocked.has(by_step[dep]),
        ),
      )
      .map(([cid]) => cid);
    if (added.every((cid) => blocked.has(cid))) break;
    added.forEach((cid) => blocked.add(cid));
  }
  return Object.keys(unfinished).every((cid) => blocked.has(cid))
    ? decisions
    : [];
}
export function verification_gaps(rec: RecordData): RecordData {
  const rows = rec.coverage?.length ? assess(rec) : [],
    plans = Object.fromEntries(
      (rec.coverage || []).map((r: RecordData) => [r.id, r]),
    ),
    gaps: RecordData = {};
  for (const row of rows) {
    const cid = plans[row.id].criterion;
    if (state(rec, cid) === "completed" && row.status !== "evidence ready") {
      const label = row.failed?.length
        ? "failed checks"
        : row.invalid?.length
          ? "stale evidence"
          : "missing verification";
      (gaps[cid] ??= []).push(row.id + ": " + label);
    }
  }
  return gaps;
}
