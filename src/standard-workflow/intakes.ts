/** Validate researched intake records and submit them without changing their schema. */
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";
import { validateStandardRecord } from "../registry/project-schemas.js";
import { type RecordData, json_sorted, sha256 } from "./common.js";
import { Records, locked } from "./records.js";
import * as ids from "./project_ids.js";
export interface IntakePorts {
  home: string;
  caller(): string;
  send(
    sender: string,
    key: string,
    destination: string,
    summary: string,
  ): string;
  refresh_pages(root: string): void;
  output(value: string): void;
}
let configured: IntakePorts | undefined;
export function configure_intake_ports(ports: IntakePorts): void {
  configured = ports;
}
function ports(): IntakePorts {
  if (!configured) throw Error("Intake ports have not been configured");
  return configured;
}
const object = (v: any): v is RecordData =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const truth = (v: any) =>
  object(v) ? Object.keys(v).length > 0 : Array.isArray(v) ? v.length > 0 : !!v;
function* walk(value: any, path = ""): Generator<[string, string]> {
  if (object(value))
    for (const [k, v] of Object.entries(value))
      yield* walk(v, path ? path + "." + k : k);
  else if (Array.isArray(value))
    for (const [i, v] of value.entries()) yield* walk(v, path + "[" + i + "]");
  else if (typeof value === "string") yield [path, value];
}
export function submission_errors(
  root: string,
  record: RecordData,
  require_contract = true,
): string[] {
  const rec = structuredClone(record);
  if (object(rec)) (rec.identity ??= {}).id ??= "I01";
  const errors = validateStandardRecord("intake", rec, root);
  if (errors.length) return errors;
  const required = [
      "goal",
      "logic.problem",
      "logic.proposed_solution",
      "logic.research_evidence",
      "logic.exit_criteria",
      "logistics.approach",
      "logistics.dependencies",
      "logistics.resources",
      "logistics.constraints",
      "logistics.risks",
      "affected_areas",
      "out_of_scope",
      "open_questions",
    ],
    empty_allowed = new Set([
      "logistics.dependencies",
      "logistics.constraints",
      "logistics.risks",
      "out_of_scope",
      "open_questions",
    ]);
  for (const field of required) {
    let value: any = rec;
    for (const part of field.split("."))
      value = object(value) ? value[part] : null;
    if (value == null || (!truth(value) && !empty_allowed.has(field)))
      errors.push(
        field +
          ": required for submission (use [] for an explicitly empty optional list)",
      );
  }
  if (rec.open_questions?.length)
    errors.push(
      "open_questions: resolve research and scope questions before submitting",
    );
  if (rec.review?.decision === "rejected")
    errors.push("review: rejected intake cannot be submitted");
  if (!Number.isFinite(Date.parse(rec.submitted_at)))
    errors.push("submitted_at: invalid UTC date/time");
  if (!/^intake\.[a-z0-9][a-z0-9-]*$/.test(rec.identity.key))
    errors.push("identity.key: expected intake.<slug>");
  for (const [path, value] of walk(rec)) {
    if (
      !value.trim() ||
      ["todo", "tbd", "unknown"].includes(value.trim().toLowerCase())
    )
      errors.push(path + ": replace placeholder with researched information");
    if (
      [
        "goal",
        "logic.proposed_solution",
        "logic.exit_criteria",
        "logistics.approach",
      ].some((prefix) => path.startsWith(prefix)) &&
      /\bphase\s*(?:\d+|[ivx]+|one|two|three)\b|\bphased\b/i.test(value)
    )
      errors.push(
        path + ": phased delivery is not allowed; submit one complete outcome",
      );
  }
  const steps: RecordData[] = rec.logistics?.approach || [],
    step_ids = steps.filter(object).map((step) => step.id);
  if (step_ids.length !== new Set(step_ids).size)
    errors.push("logistics.approach: step IDs must be unique");
  const graph: Record<string, string[]> = {},
    vague =
      /^(?:agree(?:ment)?|coordinate|discuss|align|sync|meet|collaborate|decide|work on)\b/i;
  for (const [i, step] of steps.entries()) {
    const at = "logistics.approach[" + i + "]";
    if (!object(step)) {
      errors.push(
        at +
          ": use a structured step with id, one owner, deliverable artifact, completion_condition and depends_on",
      );
      continue;
    }
    if (
      step.owner.includes("-and-") ||
      ["team", "everyone", "all"].includes(step.owner)
    )
      errors.push(at + ".owner: name one accountable agent, not a group");
    if (
      !/^(?:[^\s]+\/)*[^\s/]+\.[A-Za-z][A-Za-z0-9_-]*$/.test(
        step.deliverable.artifact,
      )
    )
      errors.push(
        at + ".deliverable.artifact: name a concrete file path or registry key",
      );
    for (const [field, value] of [
      ["deliverable.description", step.deliverable.description],
      ["completion_condition", step.completion_condition],
    ])
      if (vague.test(value.trim()))
        errors.push(
          at +
            "." +
            field +
            ": coordination is not a deliverable; state the artifact or observable completion check",
        );
    if (
      !/\b(pass(?:es|ed)?|validat(?:e|es|ed|ion)|verif(?:y|ies|ied)|contain(?:s)?|include(?:s)?|match(?:es)?|render(?:s)?|load(?:s)?|measur(?:e|es|ed)|exit(?:s)?|return(?:s)?|exist(?:s)?|accept(?:s|ed)?|zero|no|all)\b|[<>=]/i.test(
        step.completion_condition,
      )
    )
      errors.push(
        at +
          ".completion_condition: state an observable result (for example sample passes validation)",
      );
    graph[step.id] = step.depends_on;
    for (const dep of step.depends_on)
      if (!step_ids.includes(dep) || dep === step.id)
        errors.push(at + ".depends_on: unknown or self dependency " + dep);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const cyclic = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    const found = (graph[node] || [])
      .filter((dep) => dep in graph)
      .some(cyclic);
    visiting.delete(node);
    visited.add(node);
    return found;
  };
  if (Object.keys(graph).some(cyclic))
    errors.push("logistics.approach.depends_on: dependency cycle");
  for (const [i, area] of (rec.affected_areas || []).entries())
    for (const field of ["repository", "components"])
      if (!truth(area[field]))
        errors.push("affected_areas[" + i + "]." + field + ": required");
  if (!require_contract) return errors;
  const personal =
      /\b(?:I|me|my|mine|myself|we|us|our|ours|ourselves|you|your|yours|yourself|owner)\b/i,
    prose_fields = new Set([
      "goal",
      "problem",
      "proposed_solution",
      "exit_criteria",
      "description",
      "completion_condition",
      "lesson",
      "application",
      "statement",
      "success_condition",
      "constraints",
      "risks",
      "out_of_scope",
      "resources",
    ]);
  for (const [path, value] of walk(rec)) {
    const leaf = path
      .split(".")
      .at(-1)!
      .replace(/\[\d+\]/g, "");
    if (!prose_fields.has(leaf) || path.startsWith("authorization.")) continue;
    const prose = value.replace(/https?:\/\/\S+|(?:\/|~\/)\S+/g, ""),
      match = prose.match(personal);
    if (match)
      errors.push(
        path +
          ": personal narration ('" +
          match[0] +
          "'); describe the system and result directly. Put the original request in authorization.request.",
      );
  }
  const logic = rec.logic || {};
  for (const field of [
    "engineering_assumptions",
    "feasibility",
  ])
    if (!truth(logic[field]))
      errors.push("logic." + field + ": required for new submissions");
  const retros: RecordData = {},
    directory = join(root, "registry/DevProjects/metadata/retrospectives");
  if (existsSync(directory))
    for (const filename of readdirSync(directory).filter((f) =>
      f.endsWith(".yaml"),
    )) {
      const r = parse(readFileSync(join(directory, filename), "utf8")) || {};
      retros[r.identity?.key] = r;
    }
  if(Object.values(retros).some((r:RecordData)=>r.state==="complete")&&!truth(logic.retrospective_review))errors.push("logic.retrospective_review: review existing completed retrospectives before submission");
  for (const review of logic.retrospective_review || []) {
    const r = retros[review.retrospective];
    if (!r || r.state !== "complete")
      errors.push(
        "retrospective_review: reference a completed retrospective: " +
          review.retrospective,
      );
    if (
      ["reviewed", "understood", "read", "no change", "none"].includes(
        review.application.trim().toLowerCase(),
      )
    )
      errors.push(
        "retrospective_review.application: state how the lesson shapes scope or delivery, not an acknowledgement",
      );
  }
  for (const [i, step] of steps.entries()) {
    if (!object(step)) continue;
    for (const field of [
      "experiment_budget_minutes",
      "completion_kind",
      "dependency_artifacts",
    ])
      if (!(field in step))
        errors.push(
          "logistics.approach[" +
            i +
            "]." +
            field +
            ": required; experiment budget must be 1..4 minutes",
        );
    const links = step.dependency_artifacts || [];
    if (
      json_sorted(links.map((x: RecordData) => x.step).sort()) !==
      json_sorted([...step.depends_on].sort())
    )
      errors.push(
        step.id +
          ": provide exactly one artifact release contract per dependency",
      );
    const byid: RecordData = Object.fromEntries(
      steps.filter(object).map((x) => [x.id, x]),
    );
    for (const link of links) {
      const producer = byid[link.step];
      if (producer && link.artifact !== producer.deliverable.artifact)
        errors.push(
          step.id + ": dependency artifact must match its producer deliverable",
        );
    }
  }
  for (const a of logic.feasibility?.assumptions || []) {
    if (a.state === "supported" && !truth(a.evidence))
      errors.push("feasibility " + a.id + ": supported requires evidence");
    if (a.state === "open" && !step_ids.includes(a.resolution_step))
      errors.push(
        "feasibility " +
          a.id +
          ": open assumption requires a named resolution step",
      );
  }
  for (const a of logic.engineering_assumptions || [])
    if (
      !truth(a.basis) ||
      !truth(a.applies_to) ||
      a.applies_to.some((s: string) => !step_ids.includes(s))
    )
      errors.push(
        "engineering assumption requires evidence basis and valid applies_to steps",
      );
  return errors;
}
export function refresh_submission_pages(
  root: string,
  destination: string,
): void {
  try {
    ports().refresh_pages(root);
  } catch (e) {
    throw Error(
      "Intake saved at " +
        destination +
        "; page rebuild failed. No new notification sent. Retry the same command.\n" +
        (e as Error).message,
    );
  }
}
export function submit(root: string, source: string, check_only = false): void {
  const rec = parse(readFileSync(source, "utf8")),
    automatic_timestamp = object(rec) && !("submitted_at" in rec);
  if (automatic_timestamp)
    rec.submitted_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let historical_retry = false;
  const key = object(rec) ? rec.identity?.key || "" : "";
  if (/^intake\.[a-z0-9][a-z0-9-]*$/.test(key)) {
    const saved = join(
      root,
      "registry/DevProjects/metadata/intakes",
      key.split(".").slice(1).join(".") + ".yaml",
    );
    if (existsSync(saved)) {
      const prior = parse(readFileSync(saved, "utf8"));
      if (automatic_timestamp) rec.submitted_at = prior.submitted_at;
      rec.identity.id ??= prior.identity.id;
      historical_retry = json_sorted(prior) === json_sorted(rec);
    }
  }
  const errors = submission_errors(root, rec, !historical_retry);
  if (errors.length) throw Error(errors.join("\n"));
  if (check_only) {
    ports().output(key + ": submission checks pass; nothing written or sent");
    return;
  }
  const p = ports(),
    sender = p.caller();
  if (sender !== rec.identity.submitted_by)
    throw Error(
      "caller must match identity.submitted_by; run from the submitting agent environment",
    );
  if (
    typeof rec.authorization?.request !== "string" ||
    !rec.authorization.request.trim()
  )
    throw Error(
      "authorization.request must carry the direct owner request for this project",
    );
  const state = join(p.home, "intake-submissions"),
    destination = new Records(root).path(key);
  mkdirSync(state, { recursive: true });
  locked(join(state, "submit.lock"), () => {
    ids.assign(rec, root);
    const record = join(state, key + ".json");
    if (automatic_timestamp && existsSync(destination))
      rec.submitted_at = parse(readFileSync(destination, "utf8")).submitted_at;
    const payload =
        "# yaml-language-server: $schema=../../schema/intake.schema.yaml\n" +
        stringify(rec, { lineWidth: 120 }),
      digest = sha256(payload);
    if (
      existsSync(destination) &&
      json_sorted(parse(readFileSync(destination, "utf8"))) !== json_sorted(rec)
    )
      throw Error(
        destination + ": existing intake differs; it will not be overwritten",
      );
    if (existsSync(record)) {
      const previous = JSON.parse(readFileSync(record, "utf8")),
        same = [digest, ...(existsSync(destination) ? [sha256(readFileSync(destination))] : [])].includes(previous.sha256);
      if (same && existsSync(destination)) {
        refresh_submission_pages(root, destination);
        p.output(key + ": already submitted; notification " + previous.message);
        return;
      }
      throw Error(
        key + ": already submitted with different content; use a new intake ID",
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination))
      writeFileSync(destination, payload, { flag: "wx" });
    refresh_submission_pages(root, destination);
    let message: string;
    try {
      message = p.send(
        sender,
        key,
        destination,
        "CLI-validated intake " +
          key +
          " from " +
          sender +
          ". Create and start project from the saved intake.",
      );
    } catch (e) {
      throw Error(
        "Intake saved at " +
          destination +
          "; notification failed. Retry the same command.\n" +
          (e as Error).message,
      );
    }
    writeFileSync(record, JSON.stringify({ sha256: digest, message }) + "\n");
    p.output(
      "Created " + destination + "\nNotified project-manager: " + message,
    );
  });
}
