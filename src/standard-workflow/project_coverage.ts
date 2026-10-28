import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { git } from "./project_integration.js";
import { delivery, representative, sha256, type RecordData } from "./common.js";
import * as inputs from "./project_check_inputs.js";
import * as evidence_store from "./project_evidence_store.js";
export const normalized = (text: any): string =>
  String(text).split(/\s+/u).filter(Boolean).join(" ");
const object = (v: any): boolean =>
  !!v && typeof v === "object" && !Array.isArray(v);
const subset = (a: any[], b: any[]) => a.every((x) => b.includes(x));
export function validate_plan(rec: RecordData, rows: any): void {
  if (!Array.isArray(rows) || !rows.length)
    throw Error("coverage plan needs outcome rows");
  const ids = new Set(),
    criteria = Object.fromEntries(
      rec.acceptance_criteria.map((c: RecordData) => [c.id, c]),
    ),
    text = normalized(rec.logic.exit_criteria),
    covered = new Set<number>();
  for (const row of rows) {
    if (!object(row)) throw Error("coverage row must be an object");
    const ident = row.id || "";
    if (!/^[a-z][a-z0-9-]*$/.test(ident) || ids.has(ident))
      throw Error("outcome IDs must be unique lowercase slugs");
    ids.add(ident);
    const ref = row.logic_ref,
      statement = normalized(row.statement || "");
    if (
      !["proposed_solution", "exit_criteria"].includes(ref) ||
      !statement ||
      !normalized(rec.logic[ref]).includes(statement)
    )
      throw Error(ident + ": statement must quote the original logic verbatim");
    if (ref === "exit_criteria") {
      const start = [...text.slice(0, text.indexOf(statement))].length;
      for (let i = start; i < start + [...statement].length; i++)
        covered.add(i);
    }
    const c = criteria[row.criterion];
    if (!c || row.owner !== c.worker || c.requestor_review)
      throw Error(
        ident +
          ": map measurement responsibility to a temporary delivery worker",
      );
    if (!String(row.measurement || "").trim())
      throw Error(ident + ": measurement required");
    const scope = row.required_scope || {};
    if (!object(scope))
      throw Error(ident + ": required_scope must be an object");
    const products = scope.products || [];
    if (
      !Array.isArray(products) ||
      products.some((p) => !rec.products.some((x: RecordData) => x.id === p))
    )
      throw Error(ident + ": unknown scope product");
    if (!["real", "synthetic", "either"].includes(scope.dataset))
      throw Error(ident + ": specify real/synthetic/either dataset");
    const cases = scope.cases;
    if (
      !Array.isArray(cases) ||
      !cases.length ||
      cases.some((x) => typeof x !== "string" || !x.trim()) ||
      new Set(cases).size !== cases.length
    )
      throw Error(ident + ": required cases must be distinct nonblank strings");
  }
  const missing = [...text]
    .map((ch, i) => (covered.has(i) ? " " : ch))
    .join("");
  if (/[\p{L}\p{N}]/u.test(missing))
    throw Error("unmapped exit criteria: " + missing.trim());
}
export function trace_valid(rec: RecordData, row: RecordData): boolean {
  const c =
      rec.acceptance_criteria.find((c: RecordData) => c.id === row.criterion) ||
      {},
    checks = row.case_checks || [],
    cases = row.required_scope.cases;
  return (
    checks.length === cases.length &&
    new Set(checks.map((x: RecordData) => x.case)).size ===
      new Set(cases).size &&
    checks.every(
      (x: RecordData) =>
        cases.includes(x.case) &&
        normalized(x.condition || "") ===
          normalized(c.observable_pass_condition || "") &&
        String(x.method || "").trim(),
    )
  );
}
export function group_rows(rec: RecordData, row: RecordData): RecordData[] {
  const criteria = Object.fromEntries(
      rec.acceptance_criteria.map((c: RecordData) => [c.id, c]),
    ),
    group = criteria[row.criterion].validation_group,
    rows = (rec.coverage || []).filter(
      (r: RecordData) =>
        group && criteria[r.criterion].validation_group === group,
    );
  return rows.length ? rows : [row];
}
export function set_plan(
  rec: RecordData,
  rows: RecordData[],
  caller: string,
): void {
  if (
    ![
      rec.identity.manager,
      rec.identity.submitted_by,
      representative(rec),
    ].includes(caller)
  )
    throw Error(
      "coverage planning belongs to PM or temporary requestor representative",
    );
  validate_plan(rec, rows);
  const old = Object.fromEntries(
      (rec.coverage || []).map((x: RecordData) => [x.id, x]),
    ),
    fresh = Object.fromEntries(rows.map((x) => [x.id, x]));
  if (!subset(Object.keys(old), Object.keys(fresh)))
    throw Error("cannot remove planned outcomes");
  for (const [ident, row] of Object.entries(fresh) as [string, RecordData][]) {
    const prior = old[ident],
      changed = !prior || inputs.contract(row) !== inputs.contract(prior);
    if (changed) {
      if (caller !== rec.identity.submitted_by)
        throw Error(
          "changed coverage contract requires requestor root review; cases verify existing criteria, never add requirements",
        );
      const c = rec.acceptance_criteria.find(
          (c: RecordData) => c.id === row.criterion,
        ),
        checks = row.case_checks || [];
      if (
        checks.length !== row.required_scope.cases.length ||
        !subset(
          checks.map((x: RecordData) => x.case),
          row.required_scope.cases,
        ) ||
        new Set(checks.map((x: RecordData) => x.case)).size !==
          new Set(row.required_scope.cases).size
      )
        throw Error(
          "trace every coverage case to its criterion with case_checks",
        );
      if (
        checks.some(
          (x: RecordData) =>
            normalized(x.condition || "") !==
              normalized(c.observable_pass_condition) ||
            !String(x.method || "").trim(),
        )
      )
        throw Error(
          "case condition must copy the AC pass condition exactly; method explains how it is checked",
        );
      inputs.validate(rec, row);
    }
    if (prior) {
      for (const field of ["statement", "logic_ref", "criterion", "owner"])
        if (row[field] !== prior[field])
          throw Error(
            "cannot silently change an outcome or its ownership: " + ident,
          );
      const before = prior.required_scope,
        after = row.required_scope;
      if (!subset(before.products || [], after.products || []))
        throw Error("cannot remove required candidate products");
      if (
        (before.dataset !== "either" && before.dataset !== after.dataset) ||
        !subset(before.cases, after.cases)
      )
        throw Error(
          "cannot narrow outcome coverage; preserve gap and seek explicit scope decision",
        );
    }
    row.reports = prior ? prior.reports || [] : [];
  }
  rec.coverage = rows;
}
export function head(rec: RecordData, product: string): string {
  const item = rec.products.find((p: RecordData) => p.id === product);
  if (!item) throw Error("unknown product");
  try {
    return git(item.worktree, "rev-parse", "HEAD");
  } catch {
    throw Error("cannot read candidate for " + product);
  }
}
export function publish(
  rec: RecordData,
  report: RecordData,
  caller: string,
): string[] {
  if (!object(report)) throw Error("measurement report must be an object");
  const row = (rec.coverage || []).find(
    (x: RecordData) => x.id === report.outcome,
  );
  if (!row || row.owner !== caller)
    throw Error(
      "only the mapped temporary owner may publish outcome measurements",
    );
  const scope = report.scope || {};
  if (!object(scope)) throw Error("scope must be an object");
  if (!["real", "synthetic"].includes(scope.dataset))
    throw Error("report actual dataset: real or synthetic");
  const cases = scope.cases;
  if (
    !Array.isArray(cases) ||
    !cases.length ||
    cases.some((x) => typeof x !== "string" || !x.trim())
  )
    throw Error("report measured cases");
  if (!subset(cases, row.required_scope.cases))
    throw Error("unknown measured case; extend plan first");
  const candidates = report.candidates || {},
    worker = rec.workers.find((w: RecordData) => w.id === caller);
  if (!object(candidates) || !(worker.product in candidates))
    throw Error("bind report to candidate commits, including your product");
  const products = group_rows(rec, row).flatMap(
    (r) => r.required_scope.products || [],
  );
  if (!subset(products, Object.keys(candidates)))
    throw Error(
      "report must bind every product candidate in its validation group",
    );
  for (const [product, sha] of Object.entries(candidates))
    if (sha !== head(rec, product))
      throw Error(
        "report must measure the exact current candidate: " + product,
      );
  if (!["pass", "fail"].includes(report.result))
    throw Error("measurement result must be pass or fail");
  if (!String(report.finding || "").trim())
    throw Error("concrete measurement finding required");
  const files = report.evidence;
  if (!Array.isArray(files) || !files.length)
    throw Error("measurement evidence files required");
  let binding: RecordData = {};
  if (row.inputs?.length) {
    if (!trace_valid(rec, row))
      throw Error(
        "coverage trace changed; requestor must review the current criterion mapping",
      );
    inputs.validate(rec, row);
    binding = {
      inputs: inputs.fingerprint(rec, row.inputs),
      contract_hash: inputs.contract(row),
    };
  }
  const attachments: string[] = [];
  for (const name of files) {
    const source_path = resolve(
      name.startsWith("~/") ? homedir() + name.slice(1) : name,
    );
    if (!statSync(source_path).isFile())
      throw Error("missing measurement evidence: " + source_path);
    const [path, digest] = evidence_store.snapshot(
        source_path,
        evidence_store.folder(rec),
      ),
      ident =
        "coverage-evidence-" + randomUUID().replaceAll("-", "").slice(0, 12);
    rec.evidence.push({
      id: ident,
      kind: "test",
      location: path,
      description: report.finding + " Published snapshot of " + source_path,
      recorded_by: caller,
      sha256: digest,
    });
    attachments.push(ident);
  }
  row.reports ??= [];
  row.reports.push({
    ...binding,
    scope: { dataset: scope.dataset, cases: [...scope.cases] },
    candidates: Object.entries(candidates).map(([product, commit]) => ({
      product,
      commit,
    })),
    result: report.result,
    finding: report.finding,
    evidence: attachments,
    at: new Date().toISOString(),
  });
  return attachments;
}
export function assess(rec: RecordData): RecordData[] {
  if (!rec.coverage?.length)
    return [
      {
        id: "coverage-plan",
        owner: "",
        status: "missing plan",
        missing: ["Map each exit criterion to a measurement and scope"],
        evidence: [],
      },
    ];
  const evidence = Object.fromEntries(
      rec.evidence.map((e: RecordData) => [e.id, e]),
    ),
    heads: RecordData = {},
    result: RecordData[] = [];
  for (const row of rec.coverage) {
    const required = row.required_scope,
      measured = new Set<string>(),
      proof: string[] = [],
      invalid: string[] = [],
      failed: string[] = [],
      seen = new Set<string>(),
      members = group_rows(rec, row),
      group_criteria = new Set(members.map((r) => r.criterion));
    const revised =
      (rec.events || [])
        .filter(
          (e: RecordData) =>
            group_criteria.has(e.criterion) &&
            (e.id || "").match(/^(token-gate-|gate-revalidation-)/),
        )
        .map((e: RecordData) => e.at)
        .sort()
        .at(-1) || "";
    for (const report of [...(row.reports || [])].reverse()) {
      if (revised && report.at <= revised) continue;
      if (
        required.dataset !== "either" &&
        report.scope.dataset !== required.dataset
      )
        continue;
      const cases = [...new Set<string>(report.scope.cases)].filter(
        (c) => !seen.has(c),
      );
      if (!cases.length) continue;
      cases.forEach((c) => seen.add(c));
      const products = members.flatMap((m) => m.required_scope.products || []);
      let valid = subset(
        products,
        report.candidates.map((c: RecordData) => c.product),
      );
      if (row.inputs?.length && !trace_valid(rec, row)) valid = false;
      for (const candidate of report.candidates) {
        const product = candidate.product,
          sha = candidate.commit;
        if (!(product in heads)) {
          try {
            heads[product] = head(rec, product);
          } catch {
            heads[product] = null;
          }
        }
        if (
          sha !== heads[product] &&
          (!(row.inputs || []).some((x: RecordData) => x.product === product) ||
            !inputs.current(rec, row, report))
        )
          valid = false;
      }
      if (row.inputs?.length && !inputs.current(rec, row, report))
        valid = false;
      for (const eid of report.evidence) {
        const e = evidence[eid] || {};
        try {
          if (
            !statSync(e.location || ".").isFile() ||
            sha256(readFileSync(e.location)) !== e.sha256
          )
            valid = false;
        } catch {
          valid = false;
        }
      }
      if (valid && report.result === "fail") failed.push(...cases);
      if (valid && report.result === "pass") {
        cases.forEach((c) => measured.add(c));
        proof.push(...report.evidence);
      } else invalid.push(...cases);
    }
    const missing = required.cases
      .filter((c: string) => !measured.has(c))
      .sort();
    result.push({
      id: row.id,
      owner: row.owner,
      statement: row.statement,
      status: missing.length ? "gap" : "evidence ready",
      missing,
      evidence: [...new Set(proof)],
      invalid,
      failed: failed.sort(),
    });
  }
  const byid = Object.fromEntries(result.map((item) => [item.id, item]));
  for (const row of rec.coverage) {
    const gaps = group_rows(rec, row).filter((r) => byid[r.id]!.missing.length);
    if (gaps.length && byid[row.id]!.status === "evidence ready")
      byid[row.id]!.status = "group waiting";
  }
  return result;
}
export function require_ready(rec: RecordData): void {
  const gaps = assess(rec).filter((x) => x.status !== "evidence ready");
  if (gaps.length)
    throw Error(
      "outcome coverage incomplete: " +
        gaps.map((x) => x.id + ": " + x.missing.join(", ")).join("; "),
    );
}
export function rejection_routes(
  rec: RecordData,
  findings: RecordData[],
): RecordData {
  const current = Object.fromEntries(
      rec.acceptance_criteria
        .filter((c: RecordData) => !c.requestor_review)
        .map((c: RecordData) => [
          c.id,
          new Set(delivery(rec, c.id).evidence || []),
        ]),
    ),
    outcomes = Object.fromEntries(
      (rec.coverage || []).map((x: RecordData) => [x.id, x]),
    ),
    routes: RecordData = {};
  for (const finding of findings) {
    if (finding.result !== "fail") continue;
    const targets = new Set<string>();
    for (const ident of finding.outcomes || []) {
      if (!(ident in outcomes)) throw Error("unknown failed outcome: " + ident);
      targets.add(outcomes[ident].criterion);
    }
    const affected = finding.affected_artifacts || [];
    if (
      affected.some(
        (eid: string) =>
          !Object.values(current).some((ids: any) => ids.has(eid)),
      )
    )
      throw Error("affected_artifacts must name current delivery evidence");
    for (const [cid, ids] of Object.entries(current))
      if (affected.some((eid: string) => (ids as Set<string>).has(eid)))
        targets.add(cid);
    if (!targets.size)
      throw Error(
        "failed finding needs outcomes or affected_artifacts; evidence citations alone do not identify faulty work",
      );
    for (const cid of targets) (routes[cid] ??= []).push(finding);
  }
  return routes;
}
