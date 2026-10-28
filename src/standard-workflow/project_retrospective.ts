import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import {
  join,
  dirname,
  basename,
  extname,
  resolve,
  isAbsolute,
  relative,
} from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { status_history, update_status, workflow_actions } from "./projects.js";
import { sha256, epoch, type RecordData as Row } from "./common.js";
import { runtime_ports } from "./project_runtime_ports.js";
import { assign } from "./project_ids.js";
import { Records } from "./records.js";
import { validateStandardPart } from "../registry/project-schemas.js";
export { render, ac_table } from "./retrospective_presentation.js";
export const FIELDS = [
  "summary",
  "decisions_review",
  "what_worked",
  "what_did_not",
];
export const RETROSPECTIVE_GUIDANCE =
  "Focus on the work: intended and actual outcomes, measurements, technical causes, trade-offs and concrete corrections. Do not name the human user, recount approvals or permissions, or frame lessons as personal blame, credit or responsibility. Describe scope changes by what was included or excluded, and delays by the failed workflow transition. Preserve factual results and limitations.";
export const OWNER_CONCLUSION_REQUEST =
  "I want you to study the retro and tell me what would take for project to succeed knowing it now. Share your document. " +
  RETROSPECTIVE_GUIDANCE;
export function check_topic_focus(value: any, key = ""): void {
  if (["evidence", "source", "document", "facts", "report"].includes(key))
    return;
  if (Array.isArray(value)) {
    for (const v of value) check_topic_focus(v, key);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) check_topic_focus(v, k);
  } else if (typeof value === "string") {
    const prose = value.replace(/(?:https?:\/\/|\/home\/|~\/)\S+/g, "");
    if (
      /\b(?:approv(?:al|als|e|ed|ing)|authori[sz](?:ation|ations|ed|ing)|owner(?:'s)?\s+(?:decision|permission|consent))\b/i.test(
        prose,
      )
    )
      throw Error(
        "Retrospective narrative must be topic-focused. " +
          RETROSPECTIVE_GUIDANCE,
      );
  }
}
export function ac_metrics(rec: Row, cutoff?: string): Row[] {
  const limit = cutoff ? epoch(cutoff) : Infinity,
    result: Row[] = [],
    actions = workflow_actions(rec).filter((e) => epoch(e.at) <= limit),
    blockers = (rec.blockers ?? []).filter((b: Row) => epoch(b.at) <= limit);
  const blockerCriterion = (b: Row) =>
    b.criterion ??
    (/^(?:work-|health-)(C[0-9]+)(?:-|$)/.exec(b.id ?? "") ??
      /^(C[0-9]+):/.exec(b.reason ?? ""))?.[1];
  for (const c of rec.acceptance_criteria) {
    const cid = c.id,
      rows = [...status_history(rec)]
        .reverse()
        .filter((x) => x.criterion === cid && epoch(x.timestamp) <= limit),
      events: Row[] = (rec.events ?? []).filter(
        (e: Row) => e.criterion === cid && e.status && epoch(e.at) <= limit,
      ),
      states: string[] = [];
    for (const row of rows)
      if (states.at(-1) !== row.status) states.push(row.status);
    const starts = events
        .filter((e) => ["in progress", "blocked"].includes(e.status))
        .map((e) => epoch(e.at)),
      ends = events
        .filter((e) => e.status === "completed")
        .map((e) => epoch(e.at)),
      status =
        c.result === "deferred"
          ? "deferred"
          : c.result === "pass"
            ? "completed"
            : (states.at(-1) ?? events.at(-1)?.status ?? "not started"),
      end = ends.length
        ? Math.max(...ends)
        : limit !== Infinity
          ? limit
          : Math.max(0, ...events.map((e) => epoch(e.at))),
      seconds = starts.length
        ? Math.round(Math.max(0, end - Math.min(...starts)))
        : null,
      u = c.token_usage,
      tokens = u
        ? Math.max(0, (u.input ?? 0) - (u.cached_input ?? 0)) + (u.output ?? 0)
        : null,
      limitations: string[] = [];
    if (c.result === "deferred")
      limitations.push(
        "Not delivered under the original scope; excluded from the completed outcome.",
      );
    if (!u) limitations.push("Token usage unavailable.");
    else if (u.partial) limitations.push("Token observation is partial.");
    if (seconds === null)
      limitations.push("No recorded start; elapsed time unavailable.");
    const final =
      [...events].reverse().find((e) => e.status === "completed") ?? {};
    for (const sentence of (final.detail ?? "").split(/(?<=[.!?])\s+|\n/))
      if (
        /\b(fail(?:ed|ure|s)?|uncollected|unmeasured|uncommissioned|unresolved|not delivered|not commissioned|not flight.ready|known gap|not.*acceptance)\b/i.test(
          sentence,
        )
      )
        limitations.push(sentence.trim());
    result.push({
      criterion: cid,
      status,
      time_seconds: seconds,
      uncached_tokens: tokens,
      limitations: [...new Set(limitations)],
      status_changes: Math.max(0, states.length - 1),
      workflow_actions: actions.filter((e) => e.criterion === cid).length,
      blockers: new Set(
        blockers
          .filter((b: Row) => blockerCriterion(b) === cid)
          .map((b: Row) => b.id),
      ).size,
      reopens: states
        .slice(0, -1)
        .filter(
          (s, i) =>
            ["completed", "acceptance"].includes(s) &&
            ["in progress", "blocked"].includes(states[i + 1]!),
        ).length,
    });
  }
  return result;
}
export function statistics(rec: Row): Row {
  let tokens = 0,
    turns = 0;
  for (const c of rec.acceptance_criteria) {
    const u = c.token_usage ?? {};
    tokens +=
      Math.max(0, (u.input ?? 0) - (u.cached_input ?? 0)) + (u.output ?? 0);
  }
  for (const w of rec.workers) {
    const fork = w.fork ?? {},
      source = runtime_ports().session_file(fork.runtime, fork.session),
      times = rec.events
        .filter((e: Row) => e.worker === w.id || e.actor === w.id)
        .map((e: Row) => epoch(e.at)),
      start = times.length ? Math.min(...times) : 0;
    if (!source || !start) continue;
    for (const line of readFileSync(source, "utf8").split("\n")) {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (epoch(r.timestamp) < start) continue;
      const content = r.message?.content ?? [],
        toolResult =
          Array.isArray(content) &&
          content.some((b: Row) => b?.type === "tool_result");
      if (
        (fork.runtime === "codex" &&
          r.type === "event_msg" &&
          r.payload?.type === "task_started") ||
        (fork.runtime === "claude" && r.type === "user" && !toolResult)
      )
        turns++;
    }
  }
  const per_ac = ac_metrics(rec),
    times = rec.events.filter((e: Row) => e.at).map((e: Row) => epoch(e.at));
  return {
    uncached_tokens: tokens,
    tokens_m: Math.round(tokens / 1000) / 1000,
    turns,
    review_episodes: rec.events.filter((e: Row) =>
      (e.detail ?? "").includes("safe pause and source-root review required."),
    ).length,
    delivery_seconds: times.length
      ? Math.max(...times) - Math.min(...times)
      : 0,
    task_count: rec.acceptance_criteria.length,
    escalation_count: rec.events.filter((e: Row) =>
      /OWNER DECISION REQUIRED:|unresolved after/.test(e.detail ?? ""),
    ).length,
    decision_count: rec.decisions.length,
    blocker_count: rec.blockers.length,
    reopens: per_ac.reduce((n, r) => n + r.reopens, 0),
    per_ac,
  };
}
const slug = (rec: Row) => rec.identity.key.split(".").slice(1).join(".");
export function record_path(rec: Row, root: string): string {
  return new Records(root).path(rec.retrospective);
}
export function load(rec: Row, root: string): Row {
  return parse(readFileSync(record_path(rec, root), "utf8"));
}
export function write(record: Row, root: string): void {
  if (!record.identity.id) assign(record, root);
  new Records(root).save(record);
}
export function prepare(rec: Row, root: string): Row {
  if (rec.retrospective) return load(rec, root);
  if (status_history(rec)[0]?.workflow_step !== "retrospective")
    throw Error(
      "Retrospective creation requires the retrospective workflow step",
    );
  const folder = join(root, "registry/DevProjects/retrospectives");
  mkdirSync(folder, { recursive: true });
  const snapshot = join(folder, slug(rec) + "-facts.json"),
    data = {
      goal: rec.goal,
      logic: rec.logic,
      decisions: rec.decisions,
      criteria: rec.acceptance_criteria,
      products: rec.products,
      blockers: rec.blockers,
      stats: statistics(rec),
    };
  writeFileSync(snapshot, JSON.stringify(data, null, 2) + "\n");
  const template = join(folder, slug(rec) + "-review.yaml"),
    draft: Row = {
      ...Object.fromEntries(FIELDS.map((k) => [k, ""])),
      improvements: [
        {
          target: "",
          change: "",
          prevalidation: "",
          evidence: "",
          disposition: "planned",
        },
      ],
      project_status: rec.project_status,
      project_summary: {
        went_well: [],
        did_not_work: [],
        proposed_project_corrections: [],
      },
      step_reviews: rec.acceptance_criteria.map((c: Row) => ({
        criterion: c.id,
        intended: c.observable_pass_condition,
        outcome: "",
        worked: "",
        problems: "",
        why: "",
        correction: "",
        evidence: [],
      })),
    };
  writeFileSync(template, stringify(draft));
  const record = {
    identity: {
      key: "retrospective." + slug(rec),
      name: rec.identity.name + " retrospective",
    },
    project: rec.identity.key,
    project_status: rec.project_status,
    state: "pending",
    created_at: new Date().toISOString(),
    facts: snapshot,
    facts_sha256: sha256(readFileSync(snapshot)),
    report: template,
    stats: data.stats,
    project_goal: rec.goal,
    summary: {
      went_well: [],
      did_not_work: [],
      proposed_project_corrections: [],
    },
  };
  rec.retrospective = record.identity.key;
  write(record, root);
  return record;
}
export function submit(
  rec: Row,
  path: string,
  caller: string,
  root: string,
): void {
  if (caller !== "project-manager")
    throw Error("PM owns project retrospective");
  if (status_history(rec)[0]?.workflow_step !== "retrospective")
    throw Error("retrospective follows acceptance, integration and cleanup");
  const review = parse(readFileSync(path, "utf8"));
  check_topic_focus(review);
  const required = [
    ...FIELDS,
    "improvements",
    "project_summary",
    "step_reviews",
    "project_status",
  ];
  if (
    !review ||
    typeof review !== "object" ||
    Array.isArray(review) ||
    Object.keys(review).length !== required.length ||
    required.some((k) => !(k in review))
  )
    throw Error(
      "use retrospective review template, including project_status, project_summary and step_reviews",
    );
  if (!["completed", "fail"].includes(review.project_status))
    throw Error(
      "review project_status must explicitly assess completed or fail from outcome evidence; closure is not delivery",
    );
  if (rec.project_status === "fail" && review.project_status !== "fail")
    throw Error(
      "Retrospective cannot silently replace a recorded failed project outcome",
    );
  const errors = [
    ...validateStandardPart("retrospective", "summary", review.project_summary, root),
    ...validateStandardPart(
      "retrospective",
      "step_reviews",
      review.step_reviews,
      root,
    ),
  ];
  if (errors.length) throw Error(errors.join("; "));
  if (
    ["went_well", "did_not_work", "proposed_project_corrections"].some(
      (k) => !review.project_summary[k].length,
    )
  )
    throw Error("summary needs all three bullet lists");
  const ids = review.step_reviews.map((s: Row) => s.criterion);
  if (
    ids.length !== new Set(ids).size ||
    ids.length !== rec.acceptance_criteria.length ||
    rec.acceptance_criteria.some((c: Row) => !ids.includes(c.id))
  )
    throw Error("review every step, including deferred work");
  if (review.step_reviews.some((s: Row) => !s.why?.trim()))
    throw Error("each step needs why it did not work");
  for (const key of FIELDS)
    if (typeof review[key] !== "string" || !review[key].trim())
      throw Error("retrospective requires " + key);
  if (!Array.isArray(review.improvements) || !review.improvements.length)
    throw Error(
      "record intake/prevalidation improvements or an evidenced no-change finding",
    );
  for (const row of review.improvements) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).length !== 5 ||
      ["target", "change", "prevalidation", "evidence", "disposition"].some(
        (k) => !(k in row),
      )
    )
      throw Error(
        "improvement requires target/change/prevalidation/evidence/disposition",
      );
    if (Object.values(row).some((v) => typeof v !== "string" || !v.trim()))
      throw Error("improvement fields must be concrete nonempty text");
    if (!["planned", "applied", "not-needed"].includes(row.disposition))
      throw Error("improvement disposition: planned/applied/not-needed");
  }
  const retro = load(rec, root),
    facts = retro.facts;
  if (sha256(readFileSync(facts)) !== retro.facts_sha256)
    throw Error("retrospective fact snapshot changed");
  const report = join(
    dirname(facts),
    basename(facts).replace("-facts.json", "-review.yaml"),
  );
  writeFileSync(report, stringify(review));
  rec.project_status = review.project_status;
  Object.assign(retro, {
    project_status: rec.project_status,
    state: "pending",
    report,
    reviewed_at: new Date().toISOString(),
    findings: Object.fromEntries(
      Object.entries(review).filter(
        ([k]) =>
          !["project_status", "project_summary", "step_reviews"].includes(k),
      ),
    ),
    summary: review.project_summary,
    step_reviews: review.step_reviews,
    owner_conclusion: { owner: rec.identity.submitted_by, state: "pending" },
  });
  write(retro, root);
  update_status(rec, {
    workflow_step: "retrospective",
    status: "pending",
    criterion: "",
    owner: caller,
    reason: "PM retrospective written; owner conclusion pending: " + report,
  });
  rec.events.push({
    id: "retrospective-" + randomUUID().replaceAll("-", "").slice(0, 12),
    at: retro.reviewed_at,
    actor: caller,
    kind: "decision",
    detail:
      "PM retrospective written; owner conclusion pending. Intake/prevalidation actions: " +
      report,
    evidence: [],
  });
}
const expanded = (p: string) =>
  p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
export function attach_owner_conclusion(
  rec: Row,
  root: string,
  source: string,
): string {
  const retro = load(rec, root);
  if (!["completed", "fail"].includes(retro.project_status))
    throw Error("assess project_status before completing the retrospective");
  source = resolve(expanded(source));
  if (!statSync(source).isFile() || !statSync(source).size)
    throw Error("Conclusion document must exist and be nonempty");
  if ([".md", ".txt"].includes(extname(source).toLowerCase()))
    check_topic_focus(readFileSync(source, "utf8"));
  const target = join(
    root,
    "registry/DevProjects/retrospectives",
    slug(rec) + "-owner-conclusion" + extname(source),
  );
  if (source !== target) copyFileSync(source, target);
  const at = new Date().toISOString();
  retro.owner_conclusion ??= { owner: rec.identity.submitted_by };
  Object.assign(retro.owner_conclusion, {
    state: "completed",
    document: target,
    source,
    sha256: sha256(readFileSync(target)),
    received_at: at,
  });
  retro.state = "complete";
  write(retro, root);
  update_status(rec, {
    workflow_step: "retrospective",
    status: "completed",
    criterion: "",
    owner: "project-manager",
    reason: "Owner conclusion attached: " + target,
  });
  rec.events.push({
    id: "owner-conclusion-" + randomUUID().replaceAll("-", "").slice(0, 12),
    at,
    actor: "project-manager",
    kind: "decision",
    detail: "Requestor conclusion attached unchanged: " + target,
    evidence: [],
  });
  return target;
}
export function* conclusion_documents(
  message: Row,
  home: string,
  slug: string,
): Generator<string> {
  const see = message.see ?? [],
    candidates = typeof see === "string" ? [see] : [...see];
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  candidates.push(
    ...(message.summary ?? "")
      .matchAll(
        new RegExp(
          "(?:/home/[^\\s`<>]+|~/[^\\s`<>]+|" +
            escaped +
            "/reviews/[^\\s`<>]+)",
          "g",
        ),
      )
      .map((m: RegExpMatchArray) => m[0]),
  );
  for (const candidate of candidates) {
    let document = expanded(candidate.replace(/[.,;]+$/, ""));
    if (!isAbsolute(document)) {
      document = join(home, "projects", document);
      const r = relative(resolve(home, "projects", slug), resolve(document));
      if (r === ".." || r.startsWith("../") || isAbsolute(r)) continue;
    }
    if (
      [".md", ".txt", ".pdf", ".html", ".docx"].includes(
        extname(document).toLowerCase(),
      )
    )
      try {
        if (statSync(document).isFile()) yield document;
      } catch {}
  }
}
