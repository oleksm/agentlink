/** Direct worker command port: delivery is never acceptance. */
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, basename, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { type RecordData, sha256, json_sorted } from "./common.js";
import { Records, locked, atomic } from "./records.js";
import * as projects from "./projects.js";
import * as review from "./project_review.js";
import * as health from "./project_health.js";
import * as coverage from "./project_coverage.js";
import * as tracks from "./project_tracks.js";
import * as dependencies from "./project_dependencies.js";
import * as requests from "./project_requests.js";
import * as cadence from "./project_review_cadence.js";
import * as compliance from "./project_review_compliance.js";
import * as token_budget from "./project_token_budget.js";
import * as usage from "./project_usage.js";
import * as ownership from "./project_ownership.js";
import * as evidence_store from "./project_evidence_store.js";
import * as verification_waits from "./project_verification_waits.js";
import * as gates from "./project_gates.js";
import * as turn_review from "./project_turn_review.js";
import * as retrospective from "./project_retrospective.js";
import { expanded, command, runtime_ports } from "./project_runtime_ports.js";
export interface WorkPorts {
  home: string;
  caller(): string;
  send(
    caller: string,
    peer: string,
    summary: string,
    key: string,
    see: string[],
  ): string;
  request_pages(root: string): void;
  refresh_pages(root: string): void;
  archive_completed(root: string, rec: RecordData): void;
  output(value: string): void;
}
let configured: WorkPorts | undefined;
export function configure_work_ports(ports: WorkPorts): void {
  configured = ports;
}
function ports(): WorkPorts {
  if (!configured) throw Error("Worker command ports have not been configured");
  return configured;
}
const uid = () => randomUUID().replaceAll("-", "").slice(0, 12),
  now = () => new Date().toISOString(),
  load = (path: string): RecordData =>
    parse(readFileSync(expanded(path), "utf8"));
const object = (x: any): x is RecordData =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const inside = (path: string, root: string) => {
  const r = relative(root, path);
  return r !== ".." && !r.startsWith("../") && !isAbsolute(r);
};
export async function execute(
  a: RecordData,
  root: string,
  queued_id?: string,
  refresh = true,
): Promise<any> {
  const result = _execute(a, root, queued_id, false);
  if (
    refresh &&
    ![
      "show",
      "requests",
      "token-review-template",
      "review-template",
      "coverage-status",
      "ask",
    ].includes(a.command)
  )
    ports().request_pages(root);
  return result;
}
export function _execute(
  a: RecordData,
  root: string,
  queued_id?: string,
  refresh = true,
): any {
  const p = ports(),
    home = p.home,
    key = a.project.startsWith("project.") ? a.project : "project." + a.project,
    slug = key.replace(/^project\./, "");
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw Error("invalid project ID");
  const records = new Records(home),
    path = records.path(key),
    folder = join(home, "projects", slug);
  return locked(join(folder, "workers.lock"), () => {
    const rec = records.read(key);
    review.prepare(rec);
    let caller = p.caller();
    tracks.initialize(rec);
    const workers: RecordData = Object.fromEntries(
        rec.workers.map((w: RecordData) => [w.id, w]),
      ),
      criteria: RecordData = Object.fromEntries(
        review.active_criteria(rec).map((c) => [c.id, c]),
      ),
      intake = records.read(rec.intake),
      steps: RecordData = Object.fromEntries(
        review.plan(rec, intake).map((s: RecordData) => [s.id, s]),
      ),
      prior_cycles = new Set(dependencies.cycles(rec, steps).map(json_sorted));
    const check_dependency_changes = () => {
      const changed = dependencies
        .cycles(rec, steps)
        .filter((c) => !prior_cycles.has(json_sorted(c)));
      if (changed.length)
        throw Error(
          "dependency/hold cycle: " +
            json_sorted(changed.sort()) +
            "; supply an independent artifact or correct the release condition",
        );
    };
    const save_action = () => {
      check_dependency_changes();
      const errors = projects.check_record(rec);
      if (errors.length) throw Error(errors.join("; "));
      records.save(rec);
      if (refresh) p.refresh_pages(root);
    };
    const print = (value: any) =>
        p.output(
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
        ),
      state = (cid: string) => tracks.state(rec, cid);
    const send = (peer: string, summary: string, see: string[] = []) => {
      if (!workers[peer] || peer === caller)
        throw Error("recipient must be another temporary project worker");
      if (summary.length > 400) throw Error("summary exceeds 400 characters");
      return p.send(caller, peer, summary, key, see);
    };
    if (a.command === "ownership") {
      const added = ownership.extend(rec, caller, a.criterion, a.path);
      if (!a.detail.trim()) throw Error("ownership extension needs a reason");
      if (added.length) {
        rec.events.push({
          id: "ownership-" + uid(),
          at: now(),
          actor: caller,
          kind: "decision",
          criterion: a.criterion,
          detail:
            "Automatic same-product ownership extension: " +
            added.join(", ") +
            ". " +
            a.detail,
          evidence: [],
        });
        save_action();
        const assignment = join(
          folder,
          "runtime",
          caller,
          a.criterion + "-assignment.md",
        );
        if (existsSync(assignment))
          appendFileSync(
            assignment,
            "\nAdditional owned paths: " +
              added.join(", ") +
              ". Existing locks, checks and holds remain.\n",
          );
      }
      print(
        "Owned paths recorded: " + (added.length ? added : a.path).join(", "),
      );
      return;
    }
    if (a.command === "retrospective") {
      retrospective.submit(rec, a.file, caller, root);
      save_action();
      p.archive_completed(root, rec);
      print(
        "PM retrospective recorded; awaiting owner conclusion; pages rebuilt",
      );
      return;
    }
    let queued: RecordData | undefined;
    if (queued_id) {
      queued = (rec.pending_updates || []).find(
        (q: RecordData) => q.id === queued_id,
      );
      if (!queued) throw Error("Unknown queued update");
      if (queued.state !== "queued") return;
      caller = queued.worker;
      if (
        ["requested", "ready", "compacting"].includes(
          workers[caller].context_maintenance?.state,
        )
      )
        return;
      if (!tracks.available(rec, caller, queued.criterion)) return;
      try {
        requests.validate_queued(rec, queued);
      } catch (e) {
        Object.assign(queued, {
          state: "rejected",
          detail: (e as Error).message,
        });
        requests.event(
          rec,
          "project-manager",
          queued_id + ": cannot apply saved update: " + (e as Error).message,
          queued.criterion,
        );
        save_action();
        return;
      }
    }
    if (a.command === "requests") {
      print(rec.peer_requests || []);
      return;
    }
    if (["request", "request-reply", "request-review"].includes(a.command)) {
      const result = requests.apply(rec, a, caller);
      save_action();
      print(result);
      return;
    }
    if (a.command === "token-review-template") {
      const r = criteria[a.criterion].token_review || {};
      if (!Object.keys(r).length)
        throw Error("no token review requested for this AC");
      const output = expanded(a.output);
      writeFileSync(
        output,
        stringify({
          threshold: r.threshold,
          decision: "hold",
          goal_review: "",
          gate_review: "",
          direction: "",
          failed_turn_review: "",
          reviewed_turns: [],
          turn_manifest_sha256: r.turn_manifest_sha256 || "",
          acceleration_review: "",
          compliance: compliance.template(rec, criteria[a.criterion]),
          ...cadence.template(r,token_budget.warning(rec),token_budget.limit(criteria[a.criterion],rec)),
        }),
      );
      print(
        "Review template: " +
          output +
          "; resume means permission to continue, not acceptance.",
      );
      return;
    }
    if (a.command === "compact-ready") {
      if (!workers[caller])
        throw Error(
          "only the assigned worker can acknowledge context checkpoint",
        );
      const maintenance = workers[caller].context_maintenance || {};
      if (maintenance.state !== "requested")
        throw Error("no pending compaction request");
      const checkpoint = expanded(a.checkpoint);
      if (
        !statSync(checkpoint).isFile() ||
        !readFileSync(checkpoint, "utf8").trim()
      )
        throw Error("nonempty checkpoint file required");
      for (const c of Object.values(criteria) as RecordData[]) {
        if (c.worker !== caller) continue;
        const info = c.execution || {},
          proc = health.process(info.job_pid || 0);
        if (proc && proc.start === info.job_start)
          throw Error("stop registered jobs before compaction acknowledgment");
      }
      Object.assign(maintenance, {
        state: "ready",
        checkpoint,
        ready_at: Date.now() / 1000,
      });
      rec.events.push({
        id: "context-" + uid(),
        at: now(),
        actor: caller,
        kind: "worker",
        worker: caller,
        detail: "Context checkpoint ready: " + checkpoint,
        evidence: [],
      });
      save_action();
      print(
        "Checkpoint recorded. End your turn now; workflow compacts this same session and wakes you afterward.",
      );
      return;
    }
    if (a.command === "token-review") {
      token_review(
        rec,
        a,
        caller,
        criteria,
        state,
        folder,
        save_action,
        root,
        p,
      );
      return;
    }
    if (["pause", "resume"].includes(a.command)) {
      if (!a.detail.trim())
        throw Error("track switching requires a checkpoint reason");
      if (!workers[caller])
        throw Error("track switching requires the temporary worker");
      if (a.command === "pause") {
        const by_step: RecordData = Object.fromEntries(
            Object.values(criteria).map((c: any) => [c.step, c]),
          ),
          pending = steps[criteria[a.criterion].step].depends_on
            .filter((d: string) => state(by_step[d].id) !== "completed")
            .map((d: string) => by_step[d].id);
        tracks.pause(
          rec,
          caller,
          a.criterion,
          a.detail,
          a.waiting_for || pending[0] || null,
        );
      } else tracks.request_resume(rec, caller, a.criterion);
      rec.events.push({
        id: "track-" + uid(),
        at: now(),
        actor: caller,
        kind: "worker",
        worker: caller,
        criterion: a.criterion,
        detail: a.command + ": " + a.detail,
        evidence: [],
      });
      save_action();
      print(
        a.command === "pause"
          ? "Safe pause recorded"
          : "Resume queued; workflow waits for the other track to pause",
      );
      return;
    }
    if (a.command.startsWith("coverage-")) {
      if (a.command === "coverage-status") {
        print(coverage.assess(rec));
        return;
      }
      if (
        ["merging", "closing", "closed", "retrospective", "cancelled"].includes(
          projects.status_history(rec)[0]!.workflow_step,
        )
      )
        throw Error("coverage changes require an executing project");
      const data = load(a.file);
      let proof: string[] = [],
        detail: string;
      if (a.command === "coverage-plan") {
        coverage.set_plan(rec, data as RecordData[], caller);
        detail =
          "Outcome coverage plan updated; original exit criteria preserved";
      } else {
        const outcome = (rec.coverage || []).find(
          (x: RecordData) => x.id === data.outcome,
        );
        tracks.acquire(rec, caller, outcome.criterion);
        proof = coverage.publish(rec, data, caller);
        const relevant = new Set(
          rec.coverage
            .filter((x: RecordData) => x.criterion === outcome.criterion)
            .map((x: RecordData) => x.id),
        );
        if (
          state(outcome.criterion) === "completed" &&
          coverage
            .assess(rec)
            .filter((x) => relevant.has(x.id))
            .every((x) => x.status === "evidence ready")
        )
          tracks.release(rec, caller, outcome.criterion);
        detail = "Outcome " + data.outcome + ": " + data.finding;
      }
      rec.events.push({
        id: "coverage-" + uid(),
        at: now(),
        actor: caller,
        kind: "verification",
        detail,
        evidence: proof,
      });
      save_action();
      print(coverage.assess(rec));
      return;
    }
    if (["propose-gate", "review-gate", "decide-gate"].includes(a.command)) {
      if (
        ["merging", "closing", "closed", "retrospective", "cancelled"].includes(
          projects.status_history(rec)[0]!.workflow_step,
        )
      )
        throw Error(
          "gate correction requires an executing project, before integration",
        );
      const cid =
          a.command === "propose-gate"
            ? a.criterion
            : gates.proposal(
                rec,
                rec.decisions.find((d: RecordData) => d.id === a.gate),
              ).criterion,
        reserved = tracks.track(rec, caller).active === cid,
        finishing_peer =
          ["review-gate", "decide-gate"].includes(a.command) &&
          criteria[cid].worker !== caller;
      if (!(reserved && finishing_peer)) tracks.acquire(rec, caller, cid);
      const result = gates.apply(
        rec,
        a,
        caller,
        join(folder, "gate-reviews"),
        root,
      );
      if (a.command !== "propose-gate" && criteria[cid].worker !== caller)
        tracks.release(rec, caller, cid);
      save_action();
      print(result);
      return;
    }
    if (a.command === "review-template") {
      const output = expanded(a.output);
      mkdirSync(dirname(output), { recursive: true });
      if (existsSync(output))
        throw Error("output exists; choose a new review file");
      writeFileSync(output, stringify(review.template(rec)));
      print(output);
      return;
    }
    if (a.command === "show") {
      print({
        project: key,
        requestor: rec.identity.submitted_by,
        representative: review.representative(rec),
        work: Object.values(criteria).map((c: any) => ({
          criterion: c.id,
          step: c.step ?? null,
          worker: c.worker ?? null,
          status: state(c.id),
          acceptance: c.result,
        })),
        blockers: rec.blockers.filter((b: RecordData) => b.status === "open"),
      });
      return;
    }
    if (a.command === "reject") {
      reject(rec, a, caller, criteria, key, save_action, print);
      return;
    }
    if (a.command === "accept") {
      accept(rec, a, caller, criteria, state, save_action, print);
      return;
    }
    const root_review =
      a.command === "update" &&
      criteria[a.criterion]?.requestor_review &&
      caller === rec.identity.submitted_by;
    if (!workers[caller] && !root_review)
      throw Error(
        "execution requires its temporary worker; only explicit final validation belongs to the requestor root",
      );
    if (a.command === "retire-ready") {
      if (
        Object.values(criteria).some((c: any) => c.result !== "pass") ||
        rec.products.some(
          (product: RecordData) =>
            !["merged", "not-required"].includes(product.merge.status),
        )
      )
        throw Error("retirement requires acceptance and integrations");
      const worker = workers[caller],
        config = JSON.parse(readFileSync(join(home, "agents.json"), "utf8"))[
          caller
        ];
      if (config.session !== worker.fork?.session)
        throw Error("native child binding mismatch");
      const manifest = worker.runtime_manifest,
        m = JSON.parse(readFileSync(manifest, "utf8")),
        pid = command([
          "tmux",
          "-L",
          "agent-" + caller,
          "display-message",
          "-p",
          "-t",
          "agent-" + caller,
          "#{pane_pid}",
        ]).trim(),
        started = command(["ps", "-p", pid, "-o", "lstart="]).trim();
      Object.assign(m, {
        retire_ready: true,
        retire_session: config.session,
        retire_at: Date.now() / 1000,
        pane_pid: pid,
        pane_start: started,
        retire_detail: a.detail,
      });
      atomic(manifest, JSON.stringify(m, null, 2));
      rec.events.push({
        id: "retire-ready-" + uid(),
        at: now(),
        actor: caller,
        kind: "cleanup",
        worker: caller,
        detail:
          "Worker attests safe idle state, no remaining jobs: " + a.detail,
        evidence: [],
      });
      records.save(rec);
      if (refresh) p.refresh_pages(root);
      print(
        "Retirement readiness recorded. Remain idle; runner will stop only this verified child.",
      );
      return;
    }
    if (a.command === "ask") {
      print(send(a.peer, a.summary, a.see || []));
      return;
    }
    if (a.reason != null && (!a.reason.trim() || a.reason.length > 120))
      throw Error("--reason must be nonblank and at most 120 characters");
    const c = criteria[a.criterion];
    if (review.execution_owner(rec, c) !== caller)
      throw Error("criterion belongs to another owner");
    const status = a.status.replace("-", " ");
    if (status === "blocked" && !a.implementation_failure) {
      const waits = verification_waits.pending(rec, c.id);
      if (waits.length && !verification_waits.delivery_error(rec, c))
        throw Error(
          "Downstream verification wait is already tracked: keep delivered implementation available; publish coverage when the peer artifact arrives. For a genuine implementation failure, use --implementation-failure with concrete evidence/detail.",
        );
    }
    if (
      status === "in progress" &&
      !root_review &&
      !queued_id &&
      ["requested", "ready", "compacting"].includes(
        workers[caller].context_maintenance?.state,
      )
    ) {
      const id = requests.queue_update(rec, a, caller);
      save_action();
      print(
        id +
          ": update preserved; workflow applies after compaction and revalidates evidence/gates",
      );
      return;
    }
    if (!root_review && ["in progress", "completed"].includes(status))
      tracks.acquire(rec, caller, c.id, status === "completed");
    const by_step: RecordData = Object.fromEntries(
      Object.values(criteria)
        .filter((x: any) => x.step)
        .map((x: any) => [x.step, x]),
    );
    if (!steps[c.step]) throw Error("criterion needs an intake step mapping");
    c.experiment_budget_minutes ??=
      steps[c.step].experiment_budget_minutes ?? 3;
    if (steps[c.step].validation_group)
      c.validation_group = steps[c.step].validation_group;
    if (["in progress", "completed"].includes(status)) {
      const pending = steps[c.step].depends_on.filter(
        (dep: string) =>
          !by_step[dep] || state(by_step[dep].id) !== "completed",
      );
      if (pending.length)
        throw Error("unfinished dependencies: " + pending.join(", "));
    }
    if (
      status === "blocked" &&
      !workers[a.blocked_by] &&
      !(root_review && a.blocked_by === caller)
    )
      throw Error(
        "--blocked-by must identify the responsible temporary worker (use yourself for an external constraint)",
      );
    if (status === "completed" && (!a.artifact?.length || !a.evidence?.length))
      throw Error("completed requires --artifact and --evidence paths");
    const attachments: string[] = [];
    for (const [kind, filenames] of [
      ["review", a.artifact || []],
      ["test", a.evidence || []],
    ] as [string, string[]][])
      for (const filename of filenames) {
        let file = expanded(filename);
        if (!statSync(file).isFile())
          throw Error("file does not exist: " + file);
        let digest = sha256(readFileSync(file));
        const source_file = file;
        if (kind === "test" || inside(file, join(folder, "runtime")))
          [file, digest] = evidence_store.snapshot(
            file,
            evidence_store.folder(rec, home),
          );
        const id = "worker-evidence-" + uid();
        rec.evidence.push({
          id,
          kind,
          location: file,
          description:
            a.detail +
            (file !== source_file
              ? " Published snapshot of " + source_file
              : ""),
          recorded_by: caller,
          sha256: digest,
        });
        attachments.push(id);
      }
    health.checkpoint(c, a, status, workers);
    if (root_review) delete c.health;
    const blocker_id = "work-" + c.id;
    for (const b of rec.blockers) {
      if (b.id !== blocker_id || b.status !== "open") continue;
      if (!attachments.length) {
        const proof_path = join(
          folder,
          "recovery",
          "progress-" + randomUUID().replaceAll("-", "") + ".json",
        );
        mkdirSync(dirname(proof_path), { recursive: true });
        writeFileSync(
          proof_path,
          JSON.stringify({
            criterion: c.id,
            actor: caller,
            status,
            detail: a.detail,
            at: now(),
          }),
        );
        const proof_id = "progress-proof-" + uid();
        rec.evidence.push({
          id: proof_id,
          kind: "test",
          location: proof_path,
          description: "Worker progress resolves prior blocker",
          recorded_by: caller,
          sha256: sha256(readFileSync(proof_path)),
        });
        attachments.push(proof_id);
      }
      Object.assign(b, {
        status: "resolved",
        resolution: a.detail,
        evidence: attachments,
      });
    }
    if (status === "blocked") {
      rec.blockers = rec.blockers.filter(
        (b: RecordData) => b.id !== blocker_id,
      );
      rec.blockers.push({
        id: blocker_id,
        at: now(),
        reason: a.detail,
        owner: a.blocked_by,
        status: "open",
        evidence: attachments,
      });
    }
    if (c.result === "fail") c.result = "pending";
    const checkpoint_detail = [
      ["action", "Action"],
      ["progress", "Progress"],
      ["next_checkpoint", "Next checkpoint"],
      ["waiting_on", "Waiting on"],
      ["job_log", "Job log"],
    ]
      .filter(([field]) => a[field!])
      .map(([field, label]) => label + ": " + a[field!])
      .join("\n");
    rec.events.push({
      id: "progress-" + uid(),
      at: now(),
      actor: caller,
      kind: "worker",
      worker: c.worker,
      criterion: c.id,
      status,
      detail: a.detail + (checkpoint_detail ? "\n" + checkpoint_detail : ""),
      evidence: attachments,
    });
    if (status === "completed" && !root_review) {
      tracks.release(rec, caller, c.id);
      const maintenance = (workers[caller].context_maintenance ??= {
        state: "complete",
        baseline: 0,
        boundary: "",
      });
      if (queued_id && maintenance.state === "complete")
        maintenance.boundary = rec.events.at(-1).id;
      else if (maintenance.state === "complete")
        Object.assign(maintenance, {
          state: "requested",
          requested_at: Date.now() / 1000,
          reason: "Task boundary",
        });
    }
    if (queued_id)
      Object.assign(queued!, {
        state: "applied",
        detail:
          "Applied after compaction; evidence and gate snapshot revalidated",
      });
    let reason: string;
    if (status === "completed") {
      const expected = basename(steps[c.step].deliverable.artifact),
        artifact =
          a.artifact.find((name: string) => basename(name) === expected) ||
          a.artifact[0];
      reason = "Delivered " + expanded(artifact);
    } else reason = a.reason || projects.short_reason(a.detail);
    projects.update_status(rec, {
      workflow_step: root_review ? "validating" : "active",
      status: status === "completed" ? "acceptance" : status,
      criterion: c.id,
      owner: caller,
      reason,
    });
    usage.sample(rec, home);
    save_action();
    print(
      c.id +
        ": " +
        status +
        "; page refresh queued; acceptance remains " +
        c.result,
    );
    if (status === "blocked" && a.blocked_by !== caller)
      print(
        "Peer task: " +
          send(
            a.blocked_by,
            (key + " " + c.id + " blocked: " + a.detail).slice(0, 400),
            [path],
          ),
      );
    if (status === "completed")
      for (const target of Object.values(criteria) as RecordData[]) {
        const step = steps[target.step] || {},
          deps = step.depends_on || [];
        if (!deps.includes(c.step) || state(target.id) !== "not started")
          continue;
        if (
          !deps.every(
            (dep: string) =>
              by_step[dep] && state(by_step[dep].id) === "completed",
          ) ||
          target.requestor_review
        )
          continue;
        const peer = target.worker;
        if (!tracks.available(rec, peer, target.id)) continue;
        if (peer === caller) {
          print("Ready: " + target.id + " for you; dependencies complete");
          continue;
        }
        const record = join(folder, "releases", target.id + ".txt");
        if (existsSync(record)) continue;
        const message = send(
          peer,
          key +
            ": dependencies for " +
            target.id +
            " (" +
            target.step +
            ") delivered. Read project evidence via work show. Proceed when your worker session is verified; report progress via CLI.",
          [path],
        );
        mkdirSync(dirname(record), { recursive: true });
        writeFileSync(record, message + "\n");
        print("Ready " + target.id + ": " + message);
      }
    return;
  });
}
function token_review(
  rec: RecordData,
  a: RecordData,
  caller: string,
  criteria: RecordData,
  state: (cid: string) => string,
  folder: string,
  save: () => void,
  root: string,
  p: WorkPorts,
): void {
  const c = criteria[a.criterion],
    r = c.token_review || {};
  if (
    caller !== rec.identity.submitted_by ||
    caller !== r.root ||
    !["reviewing", "advising", "hold"].includes(r.state)
  )
    throw Error(
      "only the permanent project requestor can review an acknowledged token pause",
    );
  const advisory = r.state === "advising",
    report = load(a.file);
  if (!object(report))
    throw Error(
      "token review must be a YAML object; use work token-review-template",
    );
  const allowed = new Set([
      "threshold",
      "decision",
      "goal_review",
      "gate_review",
      "direction",
      "gate_update",
      "failed_turn_review",
      "reviewed_turns",
      "turn_manifest_sha256",
      "acceleration_review",
      "release_after",
      "release_requests",
      "scope_correction",
      "compliance",
      "token_budget",
    ]),
    unknown = Object.keys(report)
      .filter((k) => !allowed.has(k))
      .sort();
  if (unknown.length)
    throw Error(
      "unknown review fields: " +
        unknown.join(", ") +
        "; submit the response, not the request packet",
    );
  if (report.threshold !== r.threshold)
    throw Error("stale token-review threshold");
  for (const field of ["goal_review", "gate_review", "direction"])
    if (typeof report[field] !== "string" || !report[field].trim())
      throw Error("review needs " + field);
  if (!["resume", "hold"].includes(report.decision))
    throw Error("decision must be resume or hold");
  const conflicts = [
    ...compliance.errors(rec, c, report),
    ...token_budget.errors(r, report,token_budget.warning(rec),token_budget.limit(c,rec)),
  ];
  if (conflicts.length) {
    const digest = sha256(stringify(report, { sortMapEntries: true })).slice(
        0,
        16,
      ),
      id = "review-compliance-" + c.id + "-" + r.threshold + "-" + digest,
      record = join(folder, "token-reviews", id + ".yaml");
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, stringify({ report, errors: conflicts }));
    if (!rec.events.some((e: RecordData) => e.id === id)) {
      rec.events.push({
        id,
        at: now(),
        actor: caller,
        kind: "decision",
        criterion: c.id,
        detail:
          "Review rejected for compliance; reviewer must revise same threshold. " +
          conflicts.join("; ") +
          " Record: " +
          record,
        evidence: [],
      });
      save();
      p.request_pages(root);
    }
    throw Error(
      "REVIEW REJECTED; worker remains held. " +
        conflicts.join("; ") +
        ". Revise recommendation and resubmit this review; no new review cycle. Generate current fields with work token-review-template " +
        rec.identity.key.replace(/^project\./, "") +
        " " +
        c.id +
        " --output FILE",
    );
  }
  cadence.validate(r, report);
  turn_review.validate(r, report);
  if (
    typeof report.acceleration_review !== "string" ||
    !report.acceleration_review.trim()
  )
    throw Error(
      "acceleration_review: what could help this agent achieve its goal sooner, based on its attempts?",
    );
  if (report.release_requests != null) {
    if (report.decision !== "hold" || report.release_after?.length)
      throw Error(
        "release_requests requires hold and cannot combine with release_after",
      );
    requests.condition(rec, report.release_requests);
    const selected = (rec.peer_requests || []).filter((q: RecordData) =>
      report.release_requests.requests.includes(q.id),
    );
    if (
      selected.some(
        (q: RecordData) => q.criterion !== c.id || q.requester !== c.worker,
      )
    )
      throw Error("release requests must belong to this AC and its worker");
    r.release_requests = report.release_requests;
  } else delete r.release_requests;
  if (report.release_after != null) {
    const after = report.release_after;
    if (
      report.decision !== "hold" ||
      !Array.isArray(after) ||
      !after.length ||
      after.some(
        (cid) => typeof cid !== "string" || !criteria[cid] || cid === c.id,
      ) ||
      new Set(after).size !== after.length
    )
      throw Error(
        "release_after requires decision hold and unique other project AC IDs",
      );
    r.release_after = after;
  } else delete r.release_after;
  const correction = report.gate_update;
  if (correction && Object.keys(correction).length) {
    if (correction.goal_preserved !== true)
      throw Error(
        "gate correction must preserve owner goal and original exit logic",
      );
    for (const field of [
      "condition",
      "verification_method",
      "rationale",
      "coverage_impact",
    ])
      if (typeof correction[field] !== "string" || !correction[field].trim())
        throw Error("gate_update requires " + field);
    report.gate_evidence = gates.attachments(correction.evidence || []);
    report.previous_gate = {
      condition: c.observable_pass_condition,
      verification_method: c.verification_method,
    };
    c.observable_pass_condition = correction.condition;
    c.verification_method = correction.verification_method;
    const intake = new Records(p.home).read(rec.intake),
      affected = new Set([c.step]);
    for (;;) {
      const count = affected.size;
      for (const step of review.plan(rec, intake))
        if (step.depends_on.some((d: string) => affected.has(d)))
          affected.add(step.id);
      if (affected.size === count) break;
    }
    for (const item of Object.values(criteria) as RecordData[]) {
      if (!affected.has(item.step)) continue;
      item.result = "pending";
      delete item.actual_result;
      if (["completed", "in progress", "blocked"].includes(state(item.id)))
        rec.events.push({
          id: "token-gate-" + uid(),
          at: now(),
          actor: caller,
          kind: "decision",
          criterion: item.id,
          worker: item.worker,
          status: "blocked",
          detail:
            "Root token review corrected gate; revalidate affected artifacts",
          evidence: [],
        });
    }
  }
  const destination = join(
    folder,
    "token-reviews",
    a.criterion + "-" + r.threshold + "-" + uid().slice(0, 8) + ".yaml",
  );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, stringify(report));
  const at = now();
  Object.assign(r, {
    state: report.decision === "resume" ? "reviewed" : "hold",
    reviewed_at: at,
    guidance: destination,
  });
  if (report.decision === "resume") {
    const u = c.token_usage || {},
      spent =
        Math.max(0, (u.input || 0) - (u.cached_input || 0)) + (u.output || 0),
      interval = runtime_ports().policy().root_review_uncached_tokens_per_ac;
    r.next_at = (Math.floor(spent / interval) + 1) * interval;
    const t = tracks.track(rec, c.worker);
    if (!["", c.id].includes(t.resume) && state(t.resume) === "not started")
      t.resume = "";
    if (!advisory && ["", c.id].includes(t.resume))
      tracks.resume_after_review(rec, c.worker, c.id);
  }
  if (report.scope_correction?.changes_project_goal)
    rec.decisions.push({
      id: "scope-" + uid(),
      question:
        "Reduce project scope to salvage completed work: " +
        report.scope_correction.reduced_project,
      status: "open",
      owner: rec.identity.owner || "owner",
      outcome: "Proposed only; original goal unchanged. Review: " + destination,
      evidence: [],
    });
  rec.events.push({
    id: "token-review-" + uid(),
    at,
    actor: caller,
    kind: "decision",
    criterion: c.id,
    detail: "Root token review " + report.decision + ": " + destination,
    evidence: [],
  });
  save();
  p.output(
    "Root guidance recorded: " +
      destination +
      "; decision=" +
      report.decision +
      ". This is not acceptance. Worker resumes only after workflow holds clear.",
  );
}
function reject(
  rec: RecordData,
  a: RecordData,
  caller: string,
  criteria: RecordData,
  key: string,
  save: () => void,
  print: (v: any) => void,
): void {
  if (caller !== rec.identity.submitted_by)
    throw Error("only the requestor can reject a logic review");
  const path = expanded(a.review),
    report = load(path);
  if (
    !object(report) ||
    report.project !== key ||
    report.reviewer !== caller ||
    report.snapshot !== review.snapshot(rec)
  )
    throw Error(
      "review must identify this requestor, project and current candidate snapshot",
    );
  const checks = review.validate_findings(rec, report, caller),
    failed = checks.filter((x: RecordData) => x.result === "fail");
  if (!failed.length)
    throw Error("provide at least one failed logical outcome finding");
  const routes = coverage.rejection_routes(rec, failed),
    corrections = report.corrections || {};
  for (const cid of Object.keys(routes)) {
    const correction = object(corrections) ? corrections[cid] : null;
    if (
      !object(correction) ||
      !["resume", "hold"].includes(correction.decision) ||
      !String(correction.direction || "").trim()
    )
      throw Error(
        "Rejection needs corrections." +
          cid +
          ": decision resume|hold, direction, compliance (use token-review-template compliance fields). Return a bounded correction or concrete hold disposition.",
      );
    const conflicts = compliance.errors(rec, criteria[cid], correction);
    if (conflicts.length)
      throw Error(
        "Correction rejected for " +
          cid +
          ": " +
          conflicts.join("; ") +
          ". Revise recommendation; no gate/status change applied.",
      );
  }
  const proof = "review-rejected-" + uid();
  rec.evidence.push({
    id: proof,
    kind: "review",
    location: path,
    description: a.detail,
    recorded_by: caller,
    sha256: sha256(readFileSync(path)),
  });
  for (const [cid, findings] of Object.entries(routes) as [
    string,
    RecordData[],
  ][]) {
    const c = criteria[cid],
      detail =
        "Outcome review failed: " +
        findings.map((x) => x.finding).join("; ") +
        "; Requestor disposition: " +
        json_sorted(corrections[cid]);
    c.result = "fail";
    c.actual_result = detail;
    c.evidence.push(proof);
    if (corrections[cid].decision === "hold")
      Object.assign((c.execution ??= {}), {
        paused: true,
        pause_reason:
          "Requestor correction hold: " + corrections[cid].direction,
        paused_at: now(),
      });
    else {
      const t = tracks.track(rec, c.worker);
      if (t.suspended.includes(cid) && ["", cid].includes(t.resume))
        tracks.request_resume(rec, c.worker, cid);
    }
    const blocker = "work-" + c.id;
    rec.blockers = rec.blockers.filter((b: RecordData) => b.id !== blocker);
    rec.blockers.push({
      id: blocker,
      at: now(),
      reason: detail,
      owner: review.execution_owner(rec, c),
      status: "open",
      evidence: [proof],
    });
    rec.events.push({
      id: "review-rejected-" + uid(),
      at: now(),
      actor: caller,
      kind: "verification",
      worker: c.worker,
      criterion: c.id,
      status: "blocked",
      detail,
      evidence: [proof],
    });
    projects.update_status(rec, {
      workflow_step: "active",
      status: "blocked",
      criterion: c.id,
      owner: review.execution_owner(rec, c),
      reason: projects.short_reason(detail),
    });
  }
  save();
  print(
    "Review failures recorded; workflow routes findings to temporary workers and requests a new review after replacement delivery.",
  );
}
function accept(
  rec: RecordData,
  a: RecordData,
  caller: string,
  criteria: RecordData,
  state: (cid: string) => string,
  save: () => void,
  print: (v: any) => void,
): void {
  if (caller !== rec.identity.submitted_by)
    throw Error("only the requestor can accept the project");
  if (Object.keys(criteria).some((cid) => state(cid) !== "completed"))
    throw Error("all deliverables must be completed before final acceptance");
  const proof = expanded(a.evidence);
  if (!statSync(proof).isFile())
    throw Error("acceptance evidence file required");
  if (rec.logistics.owner_holds.length && !a.release_holds)
    throw Error(
      "explicit owner holds remain; supply evidence and --release-holds only when approval is actually received",
    );
  if (
    rec.blockers.some(
      (b: RecordData) => b.status === "open" && !review.closeout_alert(b),
    )
  )
    throw Error("open blockers remain");
  const path = expanded(a.review),
    report = load(path),
    reviewed = review.validate(rec, report, caller),
    review_id = "logic-review-" + uid();
  rec.evidence.push({
    id: review_id,
    kind: "review",
    location: path,
    description: report.snapshot,
    recorded_by: caller,
    sha256: sha256(readFileSync(path)),
  });
  let ident = "";
  for (const product of rec.products) {
    const candidate = command([
      "git",
      "-C",
      product.worktree,
      "rev-parse",
      "HEAD",
    ]).trim();
    if (
      command(["git", "-C", product.worktree, "status", "--porcelain"]).trim()
    )
      throw Error("candidate worktree must be clean");
    ident = "acceptance-" + uid();
    rec.evidence.push({
      id: ident,
      kind: "review",
      location: proof,
      description: a.detail,
      recorded_by: caller,
      sha256: sha256(readFileSync(proof)),
      product: product.id,
      commit: candidate,
    });
    product.merge.candidate_commit = candidate;
    for (const criterion of Object.values(criteria) as RecordData[]) {
      criterion.result = "pass";
      criterion.actual_result =
        "Project outcome accepted against research logic: " +
        reviewed.map((x: RecordData) => x.finding).join("; ");
      criterion.evidence.push(ident, review_id);
    }
  }
  if (a.release_holds) {
    rec.events.push({
      id: "holds-released-" + uid(),
      at: now(),
      actor: caller,
      kind: "decision",
      detail:
        "Requestor explicitly records approval of owner holds: " + a.detail,
      evidence: [ident],
    });
    rec.logistics.owner_holds = [];
  }
  projects.update_status(rec, {
    workflow_step: "validating",
    status: "completed",
    criterion: "",
    owner: caller,
    reason: "Accepted: " + proof,
  });
  save();
  print(
    "Requestor acceptance recorded; workflow runner will integrate and close out.",
  );
}
export async function replay_queued(
  root: string,
  slug: string,
  home: string,
): Promise<void> {
  const records = new Records(home),
    key = "project." + slug,
    rec = records.read(key);
  for (const entry of rec.pending_updates || []) {
    if (entry.state !== "queued") continue;
    try {
      await execute(JSON.parse(entry.payload).args, root, entry.id, false);
    } catch (e) {
      locked(join(home, "projects", slug, "workers.lock"), () => {
        const current = records.read(key),
          q = (current.pending_updates || []).find(
            (q: RecordData) => q.id === entry.id,
          );
        if (q.state !== "queued") return;
        Object.assign(q, { state: "rejected", detail: (e as Error).message });
        requests.event(
          current,
          "project-manager",
          q.id +
            ": saved update requires worker correction: " +
            (e as Error).message,
          q.criterion,
        );
        const errors = projects.check_record(current);
        if (errors.length) throw Error(errors.join("; "));
        records.save(current);
      });
    }
  }
}
/** Argument fields mirror argparse's original underscore names. */
export function parse_args(argv: string[]): RecordData {
  const command = argv[0];
  const allowed = new Set([
    "show",
    "update",
    "ask",
    "accept",
    "reject",
    "review-template",
    "retire-ready",
    "propose-gate",
    "review-gate",
    "decide-gate",
    "coverage-plan",
    "coverage-report",
    "coverage-status",
    "pause",
    "resume",
    "token-review",
    "token-review-template",
    "compact-ready",
    "request",
    "request-reply",
    "request-review",
    "retrospective",
    "ownership",
    "requests",
  ]);
  if (!command || !allowed.has(command) || !argv[1])
    throw Error("work requires command and project");
  const a: RecordData = {
      command,
      project: argv[1],
      artifact: [],
      evidence: [],
      see: [],
      path: [],
      due_minutes: 30,
      purpose: "implementation",
    },
    positionals: string[] = [];
  const option_sets: Record<string, string[]> = {
    update: [
      "reason",
      "detail",
      "artifact",
      "evidence",
      "blocked_by",
      "experiment_budget_minutes",
      "implementation_failure",
      "action",
      "progress",
      "next_checkpoint",
      "check_in_minutes",
      "waiting_on",
      "job_pid",
      "job_log",
      "outcome",
    ],
    ask: ["summary", "see"],
    accept: ["review", "evidence", "detail", "release_holds"],
    reject: ["review", "detail"],
    "review-template": ["output"],
    "retire-ready": ["detail"],
    "propose-gate": ["proposal"],
    "review-gate": ["decision", "evidence", "detail"],
    "decide-gate": ["decision", "evidence", "detail"],
    "coverage-plan": ["file"],
    "coverage-report": ["file"],
    pause: ["detail", "waiting_for"],
    resume: ["detail"],
    "token-review": ["file"],
    "token-review-template": ["output"],
    "compact-ready": ["checkpoint"],
    request: ["owner_ac", "artifact", "detail", "due_minutes", "purpose"],
    "request-reply": ["state", "artifact", "evidence", "detail"],
    "request-review": ["decision", "detail"],
    retrospective: ["file"],
    ownership: ["path", "detail"],
  };
  const booleans = new Set(["release_holds", "implementation_failure"]),
    numbers = new Set([
      "experiment_budget_minutes",
      "check_in_minutes",
      "job_pid",
      "due_minutes",
    ]),
    lists = new Set(["artifact", "see", "path"]);
  if (["update", "request-reply"].includes(command)) lists.add("evidence");
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2).replaceAll("-", "_");
    if (!(option_sets[command] || []).includes(name))
      throw Error("unrecognized argument: " + arg);
    if (booleans.has(name)) {
      a[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw Error("missing value for " + arg);
    if (lists.has(name)) a[name].push(value);
    else if (numbers.has(name)) {
      if (!/^-?\d+$/.test(value)) throw Error(arg + " requires an integer");
      a[name] = Number(value);
    } else a[name] = value;
  }
  const fields: Record<string, string[]> = {
    update: ["criterion", "status"],
    ask: ["peer"],
    "propose-gate": ["criterion"],
    "review-gate": ["gate"],
    "decide-gate": ["gate"],
    pause: ["criterion"],
    resume: ["criterion"],
    "token-review": ["criterion"],
    "token-review-template": ["criterion"],
    request: ["criterion", "peer"],
    "request-reply": ["request"],
    "request-review": ["request"],
    ownership: ["criterion"],
  };
  const positional = fields[command] || [];
  if (positionals.length !== positional.length)
    throw Error("work " + command + " requires " + positional.join(" "));
  positional.forEach((f, i) => (a[f] = positionals[i]));
  const required: Record<string, string[]> = {
    update: ["detail"],
    ask: ["summary"],
    accept: ["review", "evidence", "detail"],
    reject: ["review", "detail"],
    "review-template": ["output"],
    "retire-ready": ["detail"],
    "propose-gate": ["proposal"],
    "review-gate": ["decision", "evidence", "detail"],
    "decide-gate": ["decision", "evidence", "detail"],
    "coverage-plan": ["file"],
    "coverage-report": ["file"],
    pause: ["detail"],
    resume: ["detail"],
    "token-review": ["file"],
    "token-review-template": ["output"],
    "compact-ready": ["checkpoint"],
    request: ["owner_ac", "artifact", "detail"],
    "request-reply": ["state", "detail"],
    "request-review": ["decision", "detail"],
    retrospective: ["file"],
    ownership: ["path", "detail"],
  };
  for (const name of required[command] || [])
    if (
      a[name] == null ||
      a[name] === "" ||
      (Array.isArray(a[name]) && !a[name].length)
    )
      throw Error(
        "work " + command + " requires --" + name.replaceAll("_", "-"),
      );
  if (command === "request") a.artifact = a.artifact.at(-1);
  const choices: Record<string, string[]> = {
    outcome: ["progress", "no-progress"],
    purpose: ["implementation", "verification"],
  };
  if (["review-gate", "decide-gate"].includes(command))
    choices.decision = ["approve", "reject"];
  if (command === "request-reply")
    choices.state = ["acknowledged", "blocked", "delivered"];
  if (command === "request-review") choices.decision = ["accept", "reject"];
  for (const [name, values] of Object.entries(choices))
    if (a[name] != null && !values.includes(a[name]))
      throw Error("invalid --" + name.replaceAll("_", "-") + ": " + a[name]);
  if (
    command === "update" &&
    !["not-started", "in-progress", "blocked", "completed"].includes(a.status)
  )
    throw Error("invalid update status");
  if (
    a.experiment_budget_minutes != null &&
    (!Number.isInteger(a.experiment_budget_minutes) ||
      a.experiment_budget_minutes < 1 ||
      a.experiment_budget_minutes > 4)
  )
    throw Error("experiment budget must be 1..4");
  return a;
}
