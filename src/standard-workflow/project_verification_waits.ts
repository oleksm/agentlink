import { readFileSync, statSync } from "node:fs";
import {
  active_criteria,
  delivery,
  sha256,
  type RecordData,
} from "./common.js";
export function delivery_error(
  rec: RecordData,
  criterion: RecordData,
): string | null {
  if (criterion.result === "fail") return "requestor rejected this criterion";
  const event = delivery(rec, criterion.id);
  if (event.status !== "completed")
    return "implementation is not currently delivered; republish valid delivery evidence first";
  const proofs = Object.fromEntries(
      rec.evidence.map((e: RecordData) => [e.id, e]),
    ),
    ids = event.evidence || [];
  if (!ids.length) return "delivery has no evidence";
  for (const eid of ids) {
    const proof = proofs[eid] || {},
      path = proof.location || ".";
    try {
      if (!statSync(path).isFile()) return "delivery evidence missing: " + path;
    } catch {
      return "delivery evidence missing: " + path;
    }
    if (sha256(readFileSync(path)) !== proof.sha256)
      return "delivery evidence changed: " + path;
  }
  return null;
}
export const pending = (rec: RecordData, cid: string): RecordData[] =>
  (rec.peer_requests || []).filter(
    (q: RecordData) =>
      q.criterion === cid &&
      q.purpose === "verification" &&
      !["verified", "cancelled"].includes(q.state),
  );
export function downstream(
  rec: RecordData,
  steps: RecordData,
  producer: string,
  consumer: string,
): boolean {
  const bystep = Object.fromEntries(
      active_criteria(rec).map((c) => [c.step, c.id]),
    ),
    byid = Object.fromEntries(active_criteria(rec).map((c) => [c.id, c]));
  const reaches = (cid: string, seen: Set<string>): boolean => {
    if (cid === consumer) return true;
    if (seen.has(cid)) return false;
    seen.add(cid);
    const c = byid[cid] || {};
    return (steps[c.step]?.depends_on || [])
      .filter((d: string) => d in bystep)
      .some((d: string) => reaches(bystep[d], seen));
  };
  return reaches(producer, new Set());
}
export function inspect(flow: RecordData): void {
  for (const q of flow.rec.peer_requests || []) {
    if (["verified", "cancelled"].includes(q.state)) continue;
    const cid = q.criterion,
      producer = q.owner_criterion;
    if (!downstream(flow.rec, flow.steps, producer, cid)) continue;
    if (q.purpose === "verification") {
      const error = delivery_error(flow.rec, flow.criteria[cid]);
      if (error)
        flow.message(
          "verification-invalid-" + q.id,
          "project-manager",
          `CRITICAL CALL TO ACTION: ${cid} verification waits on ${producer}, but delivery is invalid: ${error}. Resolve the dependency; do not restore delivery or waive acceptance.`,
          flow.manager.path,
        );
      continue;
    }
    flow.message(
      "verification-classify-" + q.id,
      q.requester,
      `${cid} requests an artifact from downstream ${producer}, which depends on ${cid}. If only final verification is waiting, retain valid implementation delivery and repeat work request with --purpose verification. Otherwise report the real implementation cycle. No automatic acceptance or delivery restoration.`,
      flow.manager.path,
    );
  }
}
