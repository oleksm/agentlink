import type { RecordData } from "./common.js";
import { state } from "./common.js";
import { process as inspect_process } from "./project_health.js";
export { state };
export function worker(rec: RecordData, name: string): RecordData {
  const found = rec.workers.find((w: RecordData) => w.id === name);
  if (!found) throw Error("Unknown worker: " + name);
  return found;
}
export function track(rec: RecordData, name: string): RecordData {
  return (worker(rec, name).track ??= {
    active: "",
    suspended: [],
    resume: "",
  });
}
export function review_reservation(rec: RecordData, name: string): string {
  return (
    rec.acceptance_criteria.find(
      (c: RecordData) =>
        c.worker === name &&
        ["pause requested", "reviewing"].includes(c.token_review?.state),
    )?.id || ""
  );
}
export function acquire(
  rec: RecordData,
  name: string,
  cid: string,
  publication = false,
): void {
  if (
    !publication &&
    ["requested", "ready", "compacting"].includes(
      worker(rec, name).context_maintenance?.state,
    )
  )
    throw Error("worker held for native context compaction");
  const c = rec.acceptance_criteria.find((x: RecordData) => x.id === cid);
  if (["pause requested", "reviewing", "hold"].includes(c?.token_review?.state))
    throw Error("AC paused for root token review");
  const reserved = review_reservation(rec, name);
  if (reserved && reserved !== cid)
    throw Error("review reservation belongs to " + reserved);
  const t = track(rec, name);
  if (t.active && t.active !== cid)
    throw Error(
      name +
        " is assigned to " +
        t.active +
        "; safely pause that AC before starting " +
        cid,
    );
  if (t.resume && t.resume !== cid)
    throw Error("resume priority belongs to " + t.resume);
  t.active = cid;
  t.suspended = t.suspended.filter((x: string) => x !== cid);
  if (t.resume === cid) t.resume = "";
  if (c?.worker === name) (c.execution ??= {}).paused = false;
}
export function available(rec: RecordData, name: string, cid: string): boolean {
  if (
    ["requested", "ready", "compacting"].includes(
      worker(rec, name).context_maintenance?.state,
    )
  )
    return false;
  const c = rec.acceptance_criteria.find((x: RecordData) => x.id === cid);
  if (["pause requested", "reviewing", "hold"].includes(c?.token_review?.state))
    return false;
  const reserved = review_reservation(rec, name);
  if (reserved && reserved !== cid) return false;
  const t = track(rec, name);
  return ["", cid].includes(t.active) && ["", cid].includes(t.resume);
}
export function release(rec: RecordData, name: string, cid: string): void {
  const t = track(rec, name);
  if (t.active === cid) t.active = "";
}
export function pause(
  rec: RecordData,
  name: string,
  cid: string,
  reason: string,
  waiting_for?: string | null,
): void {
  if (!reason.trim()) throw Error("safe pause needs a checkpoint reason");
  const c = rec.acceptance_criteria.find((x: RecordData) => x.id === cid);
  if (c?.worker !== name)
    throw Error("pause belongs to the assigned temporary worker");
  const t = track(rec, name),
    info = (c.execution ??= {});
  if (!["in progress", "blocked"].includes(state(rec, cid)) && t.active !== cid)
    throw Error("cannot pause work that is not running or reserved");
  const proc = inspect_process(info.job_pid || 0);
  if (proc && proc.start === info.job_start)
    throw Error(
      "registered job still running; reach a safe stop before pausing",
    );
  const switching = !!t.resume && t.resume !== cid,
    other_active = t.active !== "" && t.active !== cid,
    waiting =
      ["pause requested", "reviewing"].includes(c.token_review?.state) ||
      state(rec, cid) === "blocked" ||
      info.waiting_on ||
      waiting_for;
  if (!switching && !other_active && !waiting)
    throw Error(
      "switch only when blocked/waiting, or workflow requests return to a cleared original track",
    );
  if (
    waiting_for &&
    (waiting_for === cid ||
      !rec.acceptance_criteria.some((x: RecordData) => x.id === waiting_for))
  )
    throw Error("waiting-for must name another project AC");
  if (waiting_for) info.waiting_for = waiting_for;
  Object.assign(info, {
    paused: true,
    paused_for_return: switching,
    pause_reason: reason,
    paused_at: new Date().toISOString(),
  });
  if (!t.suspended.includes(cid)) t.suspended.push(cid);
  release(rec, name, cid);
  c.health = {
    state: "paused",
    reason: "Paused safely: " + reason,
    observed_at: info.paused_at,
  };
}
export function request_resume(
  rec: RecordData,
  name: string,
  cid: string,
): void {
  const t = track(rec, name);
  if (!t.suspended.includes(cid))
    throw Error("resume request requires a safely paused AC");
  if (t.resume && t.resume !== cid)
    throw Error("another original track already has resume priority");
  t.resume = cid;
}
export function initialize(rec: RecordData): void {
  for (const w of rec.workers) {
    if ("track" in w) continue;
    const running = rec.acceptance_criteria.filter(
      (c: RecordData) =>
        c.worker === w.id &&
        !c.requestor_review &&
        ["in progress", "blocked"].includes(state(rec, c.id)) &&
        !c.execution?.paused,
    );
    w.track = { active: running[0]?.id || "", suspended: [], resume: "" };
  }
}
export function conflicts(rec: RecordData, name: string): string[] {
  const t = track(rec, name);
  return rec.acceptance_criteria
    .filter(
      (c: RecordData) =>
        c.worker === name &&
        !c.requestor_review &&
        state(rec, c.id) === "in progress" &&
        !c.execution?.paused &&
        c.id !== t.active,
    )
    .map((c: RecordData) => c.id);
}
export function cleared(
  rec: RecordData,
  c: RecordData,
  steps: RecordData,
  by_step: RecordData,
): boolean {
  const explicit = c.execution?.waiting_for,
    deps = steps[c.step].depends_on;
  return (
    !!explicit &&
    state(rec, explicit) === "completed" &&
    deps.every((d: string) => state(rec, by_step[d].id) === "completed")
  );
}

/** Finished delivery can receive review without reserving a new execution turn. */
export function resume_after_review(rec: RecordData, name: string, cid: string): void {
  if (state(rec, cid) === "completed") return;
  request_resume(rec, name, cid);
}
