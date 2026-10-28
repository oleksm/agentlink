import {configured} from './project_budgets.js';
import type { RecordData } from "./common.js";
export const WARNING = 400_000,
  LIMIT = 600_000;
export const limit = (criterion: RecordData,rec:RecordData={}): number =>
  criterion.token_budget_limit ?? configured(rec,"token_budget_per_ac",LIMIT);
export const warning=(rec:RecordData={})=>configured(rec,"token_warning_per_ac",WARNING);
export const stage = (threshold: number, ceiling = LIMIT, warningAt = WARNING): string =>
  threshold >= ceiling ? "wrap-up" : threshold >= warningAt ? "warning" : "";
export function next_threshold(
  spent: number,
  review: RecordData,
  interval: number,
  ceiling = LIMIT,
  warningAt = WARNING,
): number {
  let due = review.next_at ?? interval;
  const previous = review.threshold ?? 0;
  if (review.state === "advising") {
    if (spent >= ceiling) return ceiling;
    if (previous < warningAt && warningAt <= spent) return warningAt;
    return ceiling;
  }
  for (const boundary of [warningAt, ceiling])
    if (previous < boundary) due = Math.min(due, boundary);
  if (spent >= ceiling && previous < ceiling) return ceiling;
  return due;
}
export function instruction(threshold: number, ceiling = LIMIT, warningAt = WARNING): string {
  if (stage(threshold, ceiling, warningAt) === "wrap-up")
    return `TOKEN LIMIT: ${ceiling / 1e6}M uncached tokens per AC reached. Project outcome is at risk. Request wrap-up now: salvage useful artifacts, record unmet criteria and stop implementation. Resume only for bounded verification/publication of existing work; otherwise hold. No new experiments or budget reset. Changed goals still require a recorded scope decision. `;
  if (stage(threshold, ceiling, warningAt) === "warning")
    return `TOKEN WARNING: ${warningAt / 1e6}M of the ${ceiling / 1e6}M per-AC budget reached. Correct course now: reduce remaining work, retain useful results and specify a finish condition before the limit. `;
  return "";
}
export function template(review: RecordData, warningAt=WARNING, ceiling=review.limit??LIMIT): RecordData {
  if (!stage(review.threshold, ceiling, warningAt)) return {};
  return {
    token_budget: {
      stage: stage(review.threshold, ceiling, warningAt),
      finish_plan: "",
      unmet_criteria: "",
      work_kind:
        review.threshold >= ceiling
          ? "wrap-up"
          : "course-correction",
    },
  };
}
export function errors(review: RecordData, report: RecordData, warningAt=WARNING, ceiling=review.limit??LIMIT): string[] {
  const expected = stage(review.threshold, ceiling, warningAt);
  if (!expected) return [];
  const value = report.token_budget;
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !==
      ["stage", "finish_plan", "unmet_criteria", "work_kind"].sort().join()
  )
    return [
      "token_budget: regenerate review template; budget warning/wrap-up response required",
    ];
  const problems = [];
  if (value.stage !== expected)
    problems.push("token_budget: stale budget stage");
  if (
    ["finish_plan", "unmet_criteria"].some(
      (k) => typeof value[k] !== "string" || !value[k].trim(),
    )
  )
    problems.push(
      "token_budget: name finish plan and unmet criteria (or explicitly none)",
    );
  const kind = expected === "wrap-up" ? "wrap-up" : "course-correction";
  if (value.work_kind !== kind)
    problems.push("token_budget: required work_kind is " + kind);
  return problems;
}
