import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import YAML from "yaml";
import { sha256, json_sorted, type RecordData } from "./common.js";
import { assess } from "./project_coverage.js";
import { template } from "./project_review.js";
import * as compliance from "./project_review_compliance.js";
import { observe } from "./project_review_recovery.js";
export function held_disposition(rec: RecordData, cid: string): string | null {
  const criterion = rec.acceptance_criteria.find(
    (c: RecordData) => c.id === cid,
  );
  for (const event of [...rec.events].reverse()) {
    if (
      event.criterion !== cid ||
      !(event.id || "").startsWith("review-rejected-")
    )
      continue;
    const proof = rec.evidence.find(
      (e: RecordData) =>
        (event.evidence || []).includes(e.id) && e.kind === "review",
    );
    if (!proof) return null;
    let correction;
    try {
      const raw = readFileSync(proof.location);
      if (proof.sha256 && sha256(raw) !== proof.sha256) return null;
      correction = (YAML.parse(raw.toString()) || {}).corrections?.[cid] || {};
    } catch {
      return null;
    }
    if (correction.decision !== "hold") return null;
    const review = criterion.token_review || {};
    if (
      ["reviewed", "resumed"].includes(review.state) &&
      (review.reviewed_at || "") > (event.at || "")
    )
      return null;
    return proof.location;
  }
  return null;
}
export function route(flow: RecordData): Set<string> {
  const awaiting = new Set<string>();
  for (const [cid, c] of Object.entries(flow.criteria) as [
    string,
    RecordData,
  ][]) {
    if (c.result !== "fail") continue;
    const event = flow.status(cid);
    if (!(event.id || "").startsWith("review-rejected-")) continue;
    const proof = flow.rec.evidence.find(
      (e: RecordData) =>
        (event.evidence || []).includes(e.id) && e.kind === "review",
    );
    if (!proof) continue;
    let recorded;
    try {
      recorded = YAML.parse(readFileSync(proof.location, "utf8"));
    } catch {
      continue;
    }
    if (!(cid in (recorded?.corrections || {}))) continue;
    flow.message(
      "failed-outcome-correction-" + event.id,
      c.worker,
      `${cid}: requestor outcome disposition is recorded. Read the linked review and corrections.${cid}. This replaces earlier publish-and-stop guidance for these findings. Execute only compliant resume actions when your track/dependencies permit; honor hold dispositions. Publish new coverage and delivery; do not wait for human permission for authorized fixes.`,
      proof.location,
    );
  }
  const groups: RecordData = {};
  for (const row of assess(flow.rec)) {
    if (!row.failed?.length) continue;
    const outcome = flow.rec.coverage.find((x: RecordData) => x.id === row.id),
      group = (groups[outcome.criterion] ??= { id: [], failed: [] });
    group.id.push(row.id);
    group.failed.push(...row.failed.map((c: string) => row.id + ":" + c));
  }
  for (const [cid, row] of Object.entries(groups)) {
    row.id = row.id.join(", ");
    const c = flow.criteria[cid];
    if (held_disposition(flow.rec, cid) || c.token_review?.state === "hold")
      continue;
    if (
      c.result === "fail" ||
      !flow.rec.events.some(
        (e: RecordData) => e.criterion === cid && e.status === "completed",
      )
    )
      continue;
    if (!["completed", "blocked"].includes(flow.status(cid).status)) continue;
    const report: RecordData = template(flow.rec);
    report.corrections = {
      [cid]: {
        decision: "resume",
        direction: "",
        compliance: compliance.template(flow.rec, c),
      },
    };
    const signature = sha256(
        json_sorted([row.id, row.failed, report.snapshot]),
      ).slice(0, 16),
      token = "failed-coverage-" + signature,
      folder = join(flow.manager.folder, "reviews");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "failed-coverage-" + signature + ".yaml");
    if (!existsSync(file)) writeFileSync(file, YAML.stringify(report));
    const who = flow.rec.identity.submitted_by;
    flow.message(
      token,
      who,
      `${cid}: delivered work has failed outcome ${row.id}: ${row.failed.join(", ")}. Open actual artifacts vs references. Record disposition via work reject --review FILE --detail TEXT with concrete bounded corrections (AC cap <=240s). Measurement changes need evidenced gate correction; scope changes need explicit decision. Do not wait for human permission for in-scope fixes.`,
      file,
    );
    awaiting.add(cid);
    const sent = flow.state.sent[token],
      now = Date.now() / 1000;
    if (now - sent.at < 600) continue;
    const retry = token + "-retry";
    if (!(retry in flow.state.sent)) {
      const [state, reason] = observe(flow.home, flow.root, who);
      if (state === "idle")
        flow.message(
          retry,
          who,
          `${cid}: failed-outcome disposition still missing. Reuse review ${basename(file)}; record findings and bounded corrections via work reject. No duplicate review cycle.`,
          file,
        );
      else if (state !== "active")
        flow.message(
          token + "-runtime",
          "project-manager",
          `CRITICAL CALL TO ACTION: failed-outcome reviewer ${who} unavailable: ${reason}. Resolve existing review delivery/session.`,
          file,
        );
    }
    const retry_at = flow.state.sent[retry]?.at;
    if (now - sent.at >= 1200 && (!retry_at || now - retry_at >= 600))
      flow.message(
        token + "-escalate",
        "project-manager",
        `CRITICAL CALL TO ACTION: ${cid} failed-outcome disposition still absent. Reviewer ${who}; resolve the handoff and verify correction dispatch.`,
        file,
      );
  }
  return awaiting;
}
