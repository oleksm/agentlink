import * as configuredBudgets from './project_budgets.js';
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { runtime_ports } from "./project_runtime_ports.js";
import { Workers, atomic, locked } from "./workers.js";
import * as projects from "./projects.js";
import * as review from "./project_review.js";
import * as coverage from "./project_coverage.js";
import * as tracks from "./project_tracks.js";
import * as health from "./project_health.js";
import * as control from "./project_control.js";
import * as dependencies from "./project_dependencies.js";
import * as failure from "./project_failure_routing.js";
import * as waits from "./project_verification_waits.js";
import * as integration from "./project_integration.js";
import * as context from "./project_context.js";
import * as usage from "./project_usage.js";
import * as jobs from "./project_jobs.js";
import * as job_guard from "./project_job_guard.js";
import * as gates from "./project_gates.js";
import * as requests from "./project_requests.js";
import * as handoffs from "./project_handoffs.js";
import * as cadence from "./project_review_cadence.js";
import * as turn_review from "./project_turn_review.js";
import * as compliance from "./project_review_compliance.js";
import * as budget from "./project_token_budget.js";
import * as recovery from "./project_review_recovery.js";
import * as closeout from "./workflow_closeout.js";
import { last_activity } from "./project_inactivity.js";
import { sha256, json_sorted, epoch, type RecordData } from "./common.js";
export const utc = () => new Date().toISOString();
export const read = (path: string, fallback: any): any =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
const guide = (name: string) =>
  fileURLToPath(
    new URL(
      `../../skills/agenlink-manager/references/${name}`,
      import.meta.url,
    ),
  );
const now = () => Date.now() / 1000;
const uuid = () => randomUUID().replaceAll("-", "");
const alive = (home: string, name: string) => {
 const c = read(join(home,"agents.json"),{})[name] || {};
 return spawnSync("tmux", [
    "-L",
    c.tmux_socket || "agent-" + name,
    "has-session",
    "-t",
    c.tmux_terminal || "agent-" + name,
  ]).status === 0;
};
export class Flow {
  manager: Workers;
  root: string;
  home: string;
  path: string;
  state: RecordData;
  stall: number;
  rec: RecordData;
  intake: RecordData;
  steps: RecordData;
  criteria: RecordData;
  by_step: RecordData;
  cycle_members = new Set<string>();
  failed_coverage_reviews = new Set<string>();
  constructor(project: string, stall = 900, root: string, home: string) {
    this.manager = new Workers(project, root, home);
    this.root = root;
    this.home = home;
    this.path = join(this.manager.folder, "workflow.json");
    this.state = read(this.path, { sent: {}, probes: {}, started: {} });
    this.stall = stall;
    this.manager.defer_pages = true;
    this.rec = this.manager.record;
    review.prepare(this.rec);
    tracks.initialize(this.rec);
    this.intake = YAML.parse(
      readFileSync(
        join(
          home,
          "registry/DevProjects/metadata/intakes",
          this.rec.intake.split(".", 2)[1] + ".yaml",
        ),
        "utf8",
      ),
    );
    for (const field of ["engineering_assumptions", "feasibility"])
      if (field in (this.intake.logic || {}))
        this.rec.logic[field] ??= this.intake.logic[field];
    this.steps = Object.fromEntries(
      review.plan(this.rec, this.intake).map((s: RecordData) => [s.id, s]),
    );
    this.criteria = Object.fromEntries(
      review.active_criteria(this.rec).map((c: RecordData) => [c.id, c]),
    );
    this.by_step = Object.fromEntries(
      Object.values(this.criteria).map((c) => [c.step, c]),
    );
    for (const c of Object.values(this.criteria)) {
      c.experiment_budget_minutes ??=
        this.steps[c.step].experiment_budget_minutes ?? 3;
      if (this.steps[c.step].validation_group)
        c.validation_group = this.steps[c.step].validation_group;
    }
  }
  save() {
    this.manager.record = this.rec;
    this.manager.save();
    atomic(this.path, JSON.stringify(this.state, null, 2));
  }
  event(
    detail: string,
    kind = "worker",
    worker?: string,
    criterion?: string,
    evidence: string[] = [],
  ) {
    const e: RecordData = {
      id: "flow-" + uuid().slice(0, 12),
      at: utc(),
      actor: "project-manager",
      kind,
      detail,
      evidence: [...evidence],
    };
    if (worker) e.worker = worker;
    if (criterion) e.criterion = criterion;
    this.rec.events.push(e);
  }
  message(token: string, to: string, summary: string, see?: string): string {
    if (token in this.state.sent) return this.state.sent[token].message;
    const mid = this.manager.mail(
      "send",
      to,
      "task",
      "--ref",
      this.rec.identity.key,
      "--summary",
      summary.slice(0, 400),
      "--see",
      see || this.manager.path,
    );
    this.manager.mail("deliver", to, "--delay", "0");
    this.event(
      "To " + to + ": " + summary + (see ? " Details: " + see : ""),
      "worker",
      this.rec.workers.some((w: RecordData) => w.id === to) ? to : undefined,
    );
    this.state.sent[token] = { message: mid, at: now() };
    atomic(this.path, JSON.stringify(this.state, null, 2));
    return mid;
  }
  proof(description: string, data: unknown): string {
    const path = join(this.manager.folder, "recovery", uuid() + ".json");
    atomic(path, JSON.stringify(data, null, 2));
    const ident = this.evidence("test", description, path);
    this.rec.evidence.at(-1).sha256 = sha256(readFileSync(path));
    return ident;
  }
  evidence(
    kind: string,
    description: string,
    location: string,
    product?: string,
    commit?: string,
  ): string {
    const ident = "flow-evidence-" + uuid().slice(0, 12),
      e: RecordData = {
        id: ident,
        kind,
        location,
        description,
        recorded_by: "project-manager",
        at: utc(),
      };
    if (product) e.product = product;
    if (commit) e.commit = commit;
    this.rec.evidence.push(e);
    return ident;
  }
  status(cid?: string): RecordData {
    return (
      [...this.rec.events]
        .reverse()
        .find((e) => e.criterion === cid && "status" in e) || {
        status: "not started",
      }
    );
  }
  alert(reason: string, criterion?: string) {
    const event = criterion ? this.status(criterion) : {},
      ident = "flow-" + sha256(reason + "|" + (event.id || "")).slice(0, 12);
    let blocker = this.rec.blockers.find((b: RecordData) => b.id === ident);
    if (blocker?.status === "resolved") return;
    const alerts = (this.state.alerts ??= {});
    if (!blocker) {
      let owner = criterion
        ? this.criteria[criterion].worker
        : "project-manager";
      const work = this.rec.blockers.find(
        (b: RecordData) => b.id === "work-" + criterion && b.status === "open",
      );
      if (work) owner = work.owner;
      if (reason.startsWith("Worker runtime:")) owner = "project-manager";
      blocker = {
        id: ident,
        at: utc(),
        reason,
        owner,
        status: "open",
        evidence: [],
      };
      this.rec.blockers.push(blocker);
      alerts[ident] = {
        criterion,
        created: now(),
        event: event.id,
        kind: ["no progress update", "no start acknowledgement"].some((x) =>
          reason.includes(x),
        )
          ? "stale"
          : "issue",
      };
      this.event(reason, "decision", undefined, criterion);
      if (
        ["merging", "closing"].includes(
          projects.status_history(this.rec)[0]!.workflow_step,
        )
      )
        projects.update_status(this.rec, {
          workflow_step: "validating",
          status: "blocked",
          criterion: criterion || "",
          owner: "project-manager",
          reason: projects.short_reason(reason),
        });
      this.save();
    }
    const owner = this.rec.workers.some(
      (w: RecordData) => w.id === blocker.owner,
    )
      ? blocker.owner
      : "project-manager";
    this.message(
      "alert-" + ident,
      owner,
      `${this.rec.identity.key}: ${reason}. Update via work CLI; coordinate with peer workers.`,
    );
  }
  resolve_flow_alerts(cid: string) {
    const event = this.status(cid);
    for (const b of this.rec.blockers) {
      if (
        !(
          b.id.startsWith("flow-") &&
          b.reason.startsWith(cid + ":") &&
          b.status === "open"
        )
      )
        continue;
      const stale = ["no progress update", "no start acknowledgement"].some(
          (x) => b.reason.includes(x),
        ),
        meta = this.state.alerts?.[b.id] || {},
        origin =
          this.rec.events.find((e: RecordData) => e.detail === b.reason) || {},
        created = meta.created || (origin.at ? epoch(origin.at) : now()),
        at = event.at ? epoch(event.at) : 0;
      if (
        stale &&
        at > created &&
        ["in progress", "completed", "blocked"].includes(event.status)
      ) {
        const proof = this.proof(cid + " progress resumed", event);
        Object.assign(b, {
          status: "resolved",
          resolution: cid + " published a newer progress event.",
          evidence: [proof],
        });
      } else if (event.status === "completed" && event.evidence?.length) {
        this.verify_delivery(cid);
        Object.assign(b, {
          status: "resolved",
          resolution: cid + " completion evidence revalidated.",
          evidence: [...event.evidence],
        });
      }
    }
  }
  invalidate_delivery(cid: string, reason: string) {
    const old = this.status(cid),
      rejected = (old.id || "").startsWith("review-rejected-");
    if (old.status !== "completed" && !rejected) return;
    const proof = this.proof(cid + " delivery invalidated", {
        reason,
        previous_completion: old,
        at: utc(),
      }),
      affected = new Set([cid]);
    while (true) {
      const expanded = new Set([
        ...affected,
        ...Object.values(this.criteria)
          .filter((c) =>
            this.steps[c.step].depends_on.some((d: string) =>
              affected.has(this.by_step[d].id),
            ),
          )
          .map((c) => c.id),
      ]);
      if (expanded.size === affected.size) break;
      expanded.forEach((c) => affected.add(c));
    }
    for (const target of affected) {
      const previous = this.status(target);
      if (
        target !== cid &&
        !["in progress", "completed"].includes(previous.status)
      )
        continue;
      const c = this.criteria[target],
        detail =
          target === cid
            ? reason
            : `Dependency ${cid} invalidated; revalidate against its replacement artifacts.`;
      if (!(rejected && target === cid)) c.result = "pending";
      this.rec.events.push({
        id: "recovery-" + uuid().slice(0, 12),
        at: utc(),
        actor: "project-manager",
        kind: "verification",
        worker: c.worker,
        criterion: target,
        status: "blocked",
        detail,
        evidence: [proof],
      });
      projects.update_status(this.rec, {
        workflow_step: "active",
        status: "blocked",
        criterion: target,
        owner: review.execution_owner(this.rec, c),
        reason: projects.short_reason(detail),
      });
      (this.state.recovery ??= {})[target] = { upstream: cid, proof };
      this.alert(target + ": " + detail, target);
    }
  }
  recovery_ready(cid: string) {
    const r = this.state.recovery?.[cid];
    if (!r || r.upstream === cid) return;
    const deps = this.steps[this.criteria[cid].step].depends_on;
    if (deps.every((d: string) => this.verify_delivery(this.by_step[d].id))) {
      if (this.criteria[cid].execution?.paused) {
        tracks.request_resume(this.rec, this.criteria[cid].worker, cid);
        return;
      }
      this.message(
        "recovery-ready-" + r.proof + "-" + cid,
        this.criteria[cid].worker,
        `${cid}: dependencies revalidated. Resume through work update, rerun affected checks, and republish fresh artifact/evidence hashes. Prior acceptance is invalid.`,
      );
    }
  }
  verify_delivery(cid: string): boolean {
    const event = this.status(cid);
    if (event.status !== "completed") return false;
    const ids = event.evidence || [];
    if (!ids.length) throw Error(`${cid}: completed without evidence`);
    if (
      ids.some(
        (id: string) => !this.rec.evidence.some((e: RecordData) => e.id === id),
      )
    )
      throw Error(`${cid}: completion references unknown evidence`);
    for (const e of this.rec.evidence) {
      if (!ids.includes(e.id)) continue;
      if (!existsSync(e.location) || !statSync(e.location).isFile())
        throw Error(`${cid}: evidence missing: ${e.location}`);
      if (e.sha256 !== sha256(readFileSync(e.location)))
        throw Error(`${cid}: evidence changed after completion: ${e.location}`);
    }
    return true;
  }
  probe(worker: RecordData): boolean {
    const ident = worker.id;
    let probe = this.state.probes[ident];
    if (!probe) {
      const config = read(join(this.home, "agents.json"), {}),
        peers = this.rec.workers.filter(
          (w: RecordData) =>
            w.id !== ident &&
            config[w.id]?.session &&
            !["retired", "planned"].includes(w.status),
        );
      const manager = this.rec.identity.manager;
      const peer = peers[0]?.id ||
        (manager !== ident && config[manager]?.session ? manager : undefined);
      if (!peer)
        throw Error(
          `${ident}: no bound project worker or manager available for a real probe`,
        );
      const data = JSON.parse(
        this.manager.mail("probe", ident, peer, "--wait", "0"),
      );
      probe = data.id;
      this.state.probes[ident] = probe;
      atomic(this.path, JSON.stringify(this.state, null, 2));
      this.manager.mail("deliver", ident, "--delay", "0");
      this.manager.mail("deliver", peer, "--delay", "0");
      this.event(
        `Real communication probe ${probe} requested between ${ident} and ${peer}.`,
        "worker",
        ident,
      );
      this.save();
    }
    const record = read(join(this.home, "probes", probe + ".json"), {});
    for (const peer of [record.a, record.b])
      if (peer) this.manager.mail("deliver", peer, "--delay", "0");
    const data = JSON.parse(
      this.manager.mail("probe", "--check", probe, "--wait", "0"),
    );
    if (data.state === "EXPIRED") {
      const retries = (this.state.probe_retries ??= {});
      if ((retries[ident] || 0) >= 2)
        throw Error(
          `${ident}: communication probe expired after two fresh attempts; inspect transport`,
        );
      retries[ident] = (retries[ident] || 0) + 1;
      delete this.state.probes[ident];
      this.event(
        `Expired probe ${probe} replaced for ${ident}; fresh attempt ${retries[ident]}/2.`,
        "worker",
        ident,
      );
      this.save();
      return this.probe(worker);
    }
    if (data.state === "PASS") delete (this.state.probe_retries ??= {})[ident];
    return data.state === "PASS";
  }
  ensure_worker(worker: RecordData): boolean {
    const name = worker.id,
      c = read(join(this.home, "agents.json"), {})[name];
    if (!c)
      throw Error(
        `${name}: worker must be initialized in the table before start`,
      );
    if (!c.session) {
      if (!(name in this.state.started)) {
        this.manager.start(name);
        this.rec = this.manager.record;
        this.state.started[name] = now();
        this.event(
          "Native fork starting; waiting for child binding.",
          "worker",
          name,
        );
        this.save();
      } else if (!alive(this.home, name))
        throw Error(
          "Worker runtime: " +
            name +
            " exited before binding; PM inspection required",
        );
      else if (now() - this.state.started[name] > this.stall)
        throw Error(`${name}: native fork startup has stalled`);
      return false;
    }
    if (!alive(this.home, name))
      throw Error(
        "Worker runtime: " +
          name +
          " terminal absent; supervisor owns recovery",
      );
    this.manager.record = this.rec;
    this.manager.verify(name);
    this.rec = this.manager.record;
    if (!this.probe(worker)) {
      if (now() - (this.state.started[name] ?? now()) > this.stall)
        throw Error(`${name}: worker communication verification stalled`);
      return false;
    }
    if (worker.status === "planned") worker.status = "starting";
    return true;
  }
  dispatch(c: RecordData) {
    if (
      this.cycle_members.has(c.id) ||
      !tracks.available(this.rec, c.worker, c.id) ||
      tracks.conflicts(this.rec, c.worker).length
    )
      return;
    tracks.acquire(this.rec, c.worker, c.id);
    this.save();
    const worker = this.rec.workers.find((w: RecordData) => w.id === c.worker);
    if (!this.ensure_worker(worker)) return;
    const step = this.steps[c.step],
      p = this.manager.product(worker.product),
      assignment = join(
        this.manager.folder,
        "runtime",
        worker.id,
        c.id + "-assignment.md",
      ),
      deps = step.depends_on.map((d: string) => this.by_step[d].id);
    let text = `# ${c.id}: ${step.id}\n\nWorker: ${worker.id}\nWorktree: ${p.worktree}\nBranch: ${p.project_branch}\nGit lock: ${p.lock_path}\n\n${step.deliverable.description}\n\nArtifact: ${step.deliverable.artifact}\n\nCompletion: ${step.completion_condition}\n\nDependency evidence: ${deps.join(", ") || "none"}; read the project record evidence entries. Remap repository paths into your project worktree and mutable generated data into your project-specific scratch/output directory; never overwrite installed data or source workspaces.\n\nUse work update ${this.rec.identity.key} ${c.id} for progress/blockers; work ask for temporary peers. Completion requires --artifact and --evidence. Integration waits for independent acceptance and hold release.\n`;
    text += `\nExperiment budget: ${c.experiment_budget_minutes} minutes per experiment. Use the smallest useful sample. Publish the observed result and next decision through work update. Repeat only with a new reason.\n`;
    text +=
      "\nEngineering assumptions for this step:\n" +
      YAML.stringify(
        (this.rec.logic.engineering_assumptions || []).filter((a: RecordData) =>
          a.applies_to.includes(c.step),
        ),
      );
    const feasibility = this.rec.logic.feasibility || {};
    text +=
      "\nFeasibility bounds and resolution work:\n" +
      YAML.stringify({
        budget_bounds: feasibility.budget_bounds || [],
        assumptions: (feasibility.assumptions || []).filter(
          (a: RecordData) => a.resolution_step === c.step,
        ),
      });
    text +=
      "\nArtifact release contracts:\n" +
      YAML.stringify(step.dependency_artifacts || []);
    if (c.validation_group)
      text +=
        "\nJoint validation group: " +
        c.validation_group +
        ". Publish measurements against the same product candidates as its other members.\n";
    text +=
      "\nCompletion kind: " +
      (step.completion_kind || "delivery") +
      ". Verify this artifact against its own gate; implementation delivery does not wait for installation.\n\nOne AC at a time. Use work pause/resume for track changes; pause fallback work when the original track becomes ready.\n\nProject resource limits and execution constraints:\n" +
      (this.rec.logistics.resources || []).join("\n") +
      "\n\nRun work coverage-status for current outcome gaps.\n\nLogic review required before active exit:\n" +
      c.logic_refs
        .map((ref: string) => ref + ": " + this.rec.logic[ref])
        .join("\n") +
      "\nProvide artifact evidence addressing these statements and the AC condition.\n\nCheckpoint every 3 minutes: result, next action, or named dependency. Register long jobs with --job-pid/--job-log; preserve output at safe pauses.\n\nInspect the actual output. For visual work, open matching candidate/reference views before scaling; publish changed frames with the candidate ID.\n\nVerify baseline and fixture. Check cheaply first; use frames for appearance. Captures must match the completed phase and deterministic fixture.\n";
    text +=
      "\nOutcome coverage plan and evidence reporting: read " +
      guide("coverage-guide.md") +
      ".\nWorker CLI details: " +
      guide("worker-cli.md") +
      ".\n";
    atomic(assignment, text);
    const token = "dispatch-" + c.id;
    if (!(token in this.state.sent)) {
      const mid = this.message(
        token,
        worker.id,
        `START ${c.id} (${c.step}): prerequisites delivered and native worker communication verified. Read scoped assignment, acknowledge via work update in-progress, then implement. Coordinate with peers only; record artifacts/blockers through CLI.`,
        assignment,
      );
      this.event(
        `${c.id} dispatched to ${worker.id}; message ${mid}; acknowledgement pending.`,
        "worker",
        worker.id,
        c.id,
      );
      this.save();
    } else if (now() - this.state.sent[token].at > this.stall)
      this.alert(
        `${c.id}: dispatched but no start acknowledgement within ${Math.floor(this.stall / 60)} minutes`,
        c.id,
      );
  }
  monitor_health(cid: string, allow_recovery = true) {
    const c = this.criteria[cid],
      event = this.status(cid),
      time = now(),
      controller = control.control(this.rec, c,this.home);
    if (controller) {
      c.health = { state: "paused", reason: controller, observed_at: utc() };
      return;
    }
    const hold = failure.held_disposition(this.rec, cid);
    if (hold) {
      c.health = {
        state: "paused",
        reason: "Recorded outcome hold: " + hold,
        observed_at: utc(),
      };
      return;
    }
    const worker = this.rec.workers.find((w: RecordData) => w.id === c.worker),
      waiting = dependencies.waiting(this.rec, c, this.steps);
    if (waiting.length && ["blocked", "not started"].includes(event.status)) {
      c.health = {
        state: "waiting",
        reason: "Waiting for named inputs: " + waiting.join(", "),
        observed_at: utc(),
      };
      return;
    }
    if (waiting.length) allow_recovery = false;
    if (event.status === "completed") {
      const gaps = control.verification_gaps(this.rec)[cid] || [];
      c.health = health.delivered_health(c, event, gaps);
      if (gaps.length) return;
    }
    const observations = (this.state.health_observations ??= {}),
      before = observations[cid] || {};
    let observation: RecordData = {};
    if (["in progress", "blocked"].includes(event.status)) {
      try {
        observation = health.observe(
          worker,
          c.execution || {},
          before,
          this.home,
        );
      } catch {
        observation = { activity: before.activity || 0, alive: false };
      }
    }
    const r = this.state.recovery?.[cid] || {},
      upstream = r.upstream;
    if (
      upstream &&
      upstream !== cid &&
      this.status(upstream).status !== "completed"
    ) {
      observation.dependency = upstream;
      observation.waiting_on = this.criteria[upstream].worker;
    }
    observations[cid] = observation;
    const h =
      event.status === "completed"
        ? health.delivered_health(c, event, [])
        : health.assess(c, event, observation, time, this.stall);
    c.health = h;
    observation.jobs_observed_at = time;
    if (
      allow_recovery &&
      !h.dependency &&
      !["stalled", "unresponsive"].includes(h.state) &&
      !(cid in (this.state.health_recovery || {})) &&
      health.update_budget_due(c, event, time)
    ) {
      const checkpoint = c.execution?.reported_at || event.at || "",
        token =
          "checkpoint-reminder-" + cid + "-" + sha256(checkpoint).slice(0, 12),
        reason = "Checkpoint overdue";
      this.message(
        token,
        worker.id,
        `${cid}: ${reason}. Publish the observed result or running stage via work update; include job PID/log for a long run. Preserve current output. Keep the next experiment within ${c.experiment_budget_minutes ?? 3} min using the smallest useful sample.`,
      );
    }
    if (!allow_recovery) {
      h.reason =
        "Waiting for unfinished upstream delivery; recovery belongs to the upstream owner";
      if (["stalled", "unresponsive"].includes(h.state)) h.state = "waiting";
      return;
    }
    const episodes = (this.state.health_recovery ??= {});
    let episode = episodes[cid];
    const sent = this.state.sent,
      recovery_tokens = Object.keys(sent).filter(
        (token) =>
          token.startsWith("alert-") &&
          this.rec.blockers.some(
            (b: RecordData) =>
              b.id === token.slice(6) &&
              b.status === "open" &&
              b.reason.startsWith(cid + ":"),
          ),
      );
    h.recovery_stage = h.dependency
      ? "Waiting on dependency"
      : recovery_tokens.length
        ? "Worker notified"
        : "";
    h.recovery_at = health.iso(
      recovery_tokens.length
        ? Math.min(...recovery_tokens.map((t) => sent[t].at))
        : 0,
    );
    if (recovery_tokens.some((token) => "escalate-" + token.slice(6) in sent))
      h.recovery_stage = "PM escalation";
    let recovered = event.status === "completed";
    if (recovered) this.verify_delivery(cid);
    const old_blocker = this.rec.blockers.find(
      (b: RecordData) => episode && b.id === episode.blocker,
    );
    if (
      episode &&
      old_blocker &&
      old_blocker.reason.includes("Declared checkpoint is overdue") &&
      event.status === "in progress" &&
      h.state === "working"
    ) {
      const proof = this.proof(cid + " overdue-only recovery corrected", {
        health: h,
        event,
      });
      Object.assign(old_blocker, {
        status: "resolved",
        resolution:
          "Reporting lateness alone is not a work stall; current activity reassessed.",
        evidence: [proof],
      });
      delete episodes[cid];
      episode = undefined;
      this.event(
        cid + ": cancelled reporting-only recovery; work remains active.",
        "decision",
        undefined,
        cid,
        [proof],
      );
    }
    recovered =
      recovered ||
      !!(
        event.status === "in progress" &&
        episode &&
        epoch(c.execution?.recovery_resolved_at) > episode.started
      );
    if (episode && recovered) {
      const blocker = this.rec.blockers.find(
        (b: RecordData) => b.id === episode.blocker,
      );
      if (blocker?.status === "open") {
        const proof = this.proof(cid + " recovery resolved", {
          health: h,
          event,
          execution: c.execution || {},
        });
        Object.assign(blocker, {
          status: "resolved",
          resolution:
            "Worker explicitly reported recovery with progress, or delivered verified evidence.",
          evidence: [proof],
        });
      }
      delete episodes[cid];
      episode = undefined;
      h.recovery_stage = "Recovered";
      h.recovery_at = health.iso(time);
    }
    const trigger =
      ["stalled", "unresponsive"].includes(h.state) ||
      (event.status === "blocked" && !h.dependency);
    if (!episode && (recovered || !trigger)) {
      if (
        ["in progress", "blocked"].includes(event.status) &&
        !h.dependency &&
        !c.execution?.next_checkpoint &&
        !health.update_budget_due(c, event, time)
      )
        this.message(
          "health-checkpoint-" + cid,
          worker.id,
          `${cid}: publish current action, meaningful progress and next checkpoint via work update --action TEXT --progress TEXT --next-checkpoint TEXT --check-in-minutes N. For jobs include --job-pid PID --job-log FILE. No PM reply.`,
        );
      if (h.waiting_on && h.waiting_on !== worker.id)
        this.message(
          "health-wait-" +
            cid +
            "-" +
            h.waiting_on +
            "-" +
            (h.checkpoint_due || ""),
          h.waiting_on,
          `${cid}: ${worker.id} is waiting on you: ${h.action}. Coordinate directly and record progress through work CLI.`,
        );
      return;
    }
    if (!episode) {
      const ident = "health-" + cid + "-" + uuid().slice(0, 8),
        proof = this.proof(cid + " recovery started", h);
      this.rec.blockers.push({
        id: ident,
        at: utc(),
        reason: cid + ": " + h.reason,
        owner: worker.id,
        status: "open",
        evidence: [proof],
      });
      episode = { started: time, blocker: ident };
      episodes[cid] = episode;
    }
    this.recovery_attempt(cid, worker, episode, h, time);
  }
  recovery_attempt(
    cid: string,
    worker: RecordData,
    episode: RecordData,
    h: RecordData,
    time: number,
  ) {
    if (control.control(this.rec, this.criteria[cid],this.home)) return;
    const actions = [
      [
        "Reduce experiment scope",
        "Investigate sample rebuild time. Profile costly stages and cut non-primary factors from the experiment; retain the primary failure and final acceptance criteria.",
      ],
      [
        "Add tracing and debug tools",
        "Add targeted traces/debug tools to expose inconsistencies sooner and speed up experiment variations. Record observed failures and timings.",
      ],
      [
        "Pause and research",
        "Pause implementation. Do a web search using primary sources; identify missing factors, cite sources, and form a revised experiment before resuming.",
      ],
      [
        "Review goal and acceptance gate",
        "Review the overall project goal and research logic holistically. Explain what this gate protects, what it blocks, and whether its metric, method, threshold and coverage reasonably represent acceptance. If misaligned, produce a concrete old/new gate correction with primary evidence, tradeoffs and unchanged intended outcome. Publish the review as a browsable artifact and submit work propose-gate PROJECT AC --proposal FILE using the worker CLI guide. Workflow obtains independent peer review then the temporary requestor decision, records and applies approved correction, and requires fresh validation; never silently waive a gate, fabricate a pass or change the owner goal.",
      ],
    ];
    const steps = actions.length;
    let stage = episode.attempt || 0,
      title: string;
    if (stage && time < (episode.due || 0))
      title = actions[(stage - 1) % steps]![0]!;
    else if (stage < 2 * steps) {
      stage++;
      const action = actions[(stage - 1) % steps]!;
      title = action[0]!;
      const instruction = action[1]!,
        cycle = Math.floor((stage - 1) / steps) + 1,
        token = episode.blocker + "-attempt-" + stage,
        path = join(this.manager.folder, "recovery", token + ".md");
      atomic(
        path,
        `# ${cid}: recovery cycle ${cycle}/2, step ${((stage - 1) % steps) + 1}/${steps}\n\n${instruction}\n\nCoordinate with temporary peers via work ask. Preserve evidence and the intended outcome; document any justified gate correction before applying it. Publish findings and next experiment through work update with --progress, --action, --next-checkpoint and --check-in-minutes 10. Only when the blockage is actually resolved, use in-progress --outcome progress with concrete --progress evidence; routine activity/checkpoints do not reset recovery. Verified completion also ends recovery. After eight unsuccessful ten-minute windows, pause retries for the human owner decision.\n`,
      );
      this.message(
        token,
        worker.id,
        `${cid}: recovery ${cycle}/2, step ${((stage - 1) % steps) + 1}/${steps}: ${title}. Follow attached instructions; report findings via work CLI. Ten-minute window; preserve the goal and record gate corrections explicitly.`,
        path,
      );
      const delivered = this.state.sent[token].at;
      Object.assign(episode, {
        attempt: stage,
        attempt_at: delivered,
        due: delivered + 600,
      });
    } else {
      h.recovery_stage = "Owner decision required after 2 recovery cycles";
      h.recovery_at = health.iso(episode.attempt_at ?? episode.started);
      h.next_checkpoint = "Human owner decision";
      h.checkpoint_due = "";
      this.message(
        episode.blocker + "-pause",
        worker.id,
        `${cid}: two recovery cycles exhausted. Pause further retries, preserve artifacts/jobs safely, publish attempts and findings through work CLI. Await human owner decision; do not weaken criteria.`,
      );
      this.message(
        episode.blocker + "-owner",
        "project-manager",
        `OWNER DECISION REQUIRED: ${this.rec.identity.key} ${cid} remains unresolved after two cycles of scope reduction, tracing/debugging, web research and goal/gate review, ten minutes each. Present recorded attempts and blocker to the owner; no automatic third cycle.`,
      );
      return;
    }
    h.recovery_stage = `Cycle ${Math.floor((stage - 1) / steps) + 1}/2 · Step ${((stage - 1) % steps) + 1}/${steps}: ${title}`;
    h.recovery_at = health.iso(episode.attempt_at);
    h.next_checkpoint = "Recovery findings: " + title;
    h.checkpoint_due = health.iso(episode.due);
  }
  recover_idle_waits() {
    let candidates = Object.values(this.criteria).filter(
      (c) =>
        !c.requestor_review &&
        ["in progress", "blocked"].includes(this.status(c.id).status),
    );
    candidates = candidates.filter(
      (c) =>
        !c.execution?.paused &&
        this.steps[c.step].depends_on.every(
          (d: string) => this.status(this.by_step[d].id).status === "completed",
        ),
    );
    candidates = candidates.filter(
      (c) =>
        !["pause requested", "reviewing", "hold"].includes(
          c.token_review?.state,
        ) &&
        !["requested", "ready", "compacting"].includes(
          this.rec.workers.find((w: RecordData) => w.id === c.worker)
            .context_maintenance?.state,
        ),
    );
    if (
      this.rec.logistics.owner_holds?.length ||
      !candidates.length ||
      candidates.some((c) =>
        ["working", "working on fix"].includes(c.health?.state),
      )
    ) {
      delete this.state.idle_wait;
      return;
    }
    const waiting = candidates.filter(
      (c) =>
        c.health?.state === "waiting" &&
        !["Waiting for peer requests:", "Waiting for named inputs:"].some((s) =>
          (c.health.reason || "").startsWith(s),
        ),
    );
    if (!waiting.length) {
      delete this.state.idle_wait;
      return;
    }
    const signature = waiting
        .map((c) => c.id + ":" + (c.health.waiting_on || ""))
        .sort()
        .join(","),
      idle = (this.state.idle_wait ??= { signature, since: now() });
    if (idle.signature !== signature) {
      this.state.idle_wait = { signature, since: now() };
      return;
    }
    if (now() - idle.since < 60) return;
    for (const c of waiting) {
      const cid = c.id,
        worker = this.rec.workers.find((w: RecordData) => w.id === c.worker),
        h = c.health,
        ident = "idle-" + cid + "-" + Math.floor(idle.since),
        missing =
          c.execution?.next_checkpoint ||
          c.execution?.action ||
          "missing checkpoint",
        peer = h.waiting_on;
      if (
        peer &&
        peer !== worker.id &&
        this.rec.workers.some((w: RecordData) => w.id === peer)
      )
        this.message(
          ident + "-peer",
          peer,
          `${cid}: project has waiting work and no active worker. Requested artifact/checkpoint: ${missing}. Own this dependency explicitly or identify its temporary owner via work ask. Publish current action and a ten-minute checkpoint through CLI; no PM reply.`,
        );
      const episodes = (this.state.health_recovery ??= {});
      let episode = episodes[cid];
      if (!episode) {
        const proof = this.proof(cid + " idle dependency recovery", {
          health: h,
          missing,
          idle_since: idle.since,
        });
        this.rec.blockers.push({
          id: ident,
          at: utc(),
          reason: cid + ": waiting with no active worker; " + missing,
          owner: worker.id,
          status: "open",
          evidence: [proof],
        });
        episode = { started: now(), blocker: ident };
        episodes[cid] = episode;
        this.event(
          cid +
            ": no active worker while dependency is waiting; recovery started for " +
            missing,
          "decision",
          worker.id,
          cid,
          [proof],
        );
      }
      this.recovery_attempt(cid, worker, episode, h, now());
    }
  }
  dispatch_final_review(c: RecordData) {
    if (
      !this.prepare_integration() ||
      coverage.assess(this.rec).some((x) => x.status !== "evidence ready")
    )
      return;
    const requestor = this.rec.identity.submitted_by,
      stamp = review.snapshot(this.rec),
      dossier = join(
        this.manager.folder,
        "reviews",
        "final-" + stamp.slice(0, 16) + ".md",
      );
    if (!existsSync(dossier)) {
      let body = `# Independent outcome validation: ${this.rec.identity.name}\n\nActual requestor: ${requestor}. This is your authorized final validation handoff; implementation remains in isolated project worktrees.\n\nGoal: ${this.rec.goal}\n\nRead current project: ${this.manager.path}\n\n`;
      body +=
        cadence.RESULT_REVIEW +
        "\n\nReview all recorded gate decisions and independent reviews against the original research logic. Reproduce final checks and visual comparisons on the exact candidate. Do not modify permanent/source workspaces. Preserve explicit human visual approval requirements.\n\n";
      body +=
        "\n## Research logic\n" +
        this.rec.logic.proposed_solution +
        "\n\n## Exit criteria\n" +
        this.rec.logic.exit_criteria +
        "\n\n## Delivered artifacts\n" +
        review
          .artifacts(this.rec)
          .map((e: RecordData) => e.location)
          .join("\n");
      body += `\nIndependently validate the complete outcome against your research logic, not the worker delivery checklist. Record your final report through work update ${this.manager.project} ${c.id} completed --artifact FILE --evidence FILE (the ID is only a transport handle). Then use work review-template and work accept/reject with logical outcome findings.\n`;
      atomic(dossier, body);
    }
    const revision = this.rec.events.filter(
      (e: RecordData) => e.criterion === c.id && e.status === "blocked",
    ).length;
    this.message(
      "final-requestor-" + c.id + "-" + revision,
      requestor,
      "Independent final outcome validation is assigned to you as actual requestor root. Review delivered results against your research logic and exit criteria, not the worker delivery steps. Read the handoff and publish through work CLI. Keep explicit human approval requirements; no automatic pass.",
      dossier,
    );
  }
  route_gate_reviews(): boolean {
    const pending = this.rec.decisions.filter(
      (d: RecordData) => d.id.startsWith("gate-") && d.status === "open",
    );
    for (const decision of pending) {
      const proposal = gates.proposal(this.rec, decision),
        peer = gates.peer_review(this.rec, decision),
        target = peer ? review.representative(this.rec) : proposal.peer;
      if (!tracks.available(this.rec, target, proposal.criterion)) continue;
      tracks.acquire(this.rec, target, proposal.criterion);
      const worker = this.rec.workers.find((w: RecordData) => w.id === target);
      if (!this.ensure_worker(worker)) continue;
      const command = peer ? "decide-gate" : "review-gate",
        location = this.rec.evidence.find(
          (e: RecordData) => e.id === decision.evidence[0],
        ).location;
      this.message(
        decision.id + "-" + command,
        target,
        `${proposal.criterion}: review gate correction ${decision.id} against overall goal/logic and recorded evidence. Use work ${command} ${this.manager.project} ${decision.id} --decision approve|reject --evidence FILE --detail FINDING. Temporary requestor owns decision; no root or PM reply.`,
        location,
      );
    }
    return !!pending.length;
  }
  protect_registered_jobs(worker: string): boolean {
    const state = (this.state.protected_jobs ??= {});
    let protected_job = false;
    for (const [cid, c] of Object.entries(this.criteria)) {
      if (c.worker !== worker) continue;
      const observed = job_guard.inspect(c.execution || {}, state[cid] || {});
      if (!observed) {
        delete state[cid];
        continue;
      }
      state[cid] = observed;
      protected_job = true;
      if (observed.stalled)
        this.message(
          "protected-job-stalled-" + cid + "-" + observed.identity,
          "project-manager",
          cid +
            ": registered job has shown no CPU/log progress for 10 awake minutes. Maintenance remains deferred; inspect job/checkpoint before intervention. No automatic stop or restart.",
        );
    }
    return protected_job;
  }
  maintain_context() {
    const interval =
      runtime_ports().policy().compact_uncached_tokens_per_worker;
    for (const w of this.rec.workers) {
      if (
        !w.fork ||
        w.status === "retired" ||
        this.protect_registered_jobs(w.id)
      )
        continue;
      const m = (w.context_maintenance ??= {
          state: "complete",
          baseline: 0,
          boundary: "",
        }),
        spent = context.tokens(this.rec, w.id),
        boundary = context.boundary(this.rec, w.id);
      if (
        m.state === "complete" &&
        (spent - (m.baseline || 0) >= interval ||
          boundary !== (m.boundary || ""))
      ) {
        Object.assign(m, {
          state: "requested",
          requested_at: now(),
          reason:
            boundary !== (m.boundary || "")
              ? "Task boundary"
              : `${interval / 1000000}M uncached tokens`,
        });
        this.event(
          w.id + ": context checkpoint required: " + m.reason,
          "worker",
          w.id,
        );
        this.save();
      }
      if (!context.PENDING.includes(m.state)) continue;
      if (
        Object.values(this.criteria).some(
          (c) =>
            c.worker === w.id &&
            ["pause requested", "reviewing"].includes(c.token_review?.state),
        )
      )
        continue;
      const token = "context-" + w.id + "-" + m.requested_at;
      if (m.state === "requested") {
        const checkpoint = context.review_checkpoint(
          this.rec,
          w,
          this.manager.folder,
        );
        if (checkpoint) {
          Object.assign(m, {
            state: "ready",
            checkpoint: String(checkpoint),
            ready_at: now(),
          });
          this.event(
            "Reused safe review checkpoint for context maintenance; no second checkpoint request.",
            "worker",
            w.id,
          );
          this.save();
          continue;
        }
        this.message(
          token,
          w.id,
          `Context checkpoint: ${m.reason}. Save goal, current AC, artifacts/evidence, blockers, next action and root guidance in a file. Run work compact-ready ${this.manager.project} --checkpoint FILE, then end turn. Workflow compacts this same session; do not start another task.`,
        );
      } else if (m.state === "ready") {
        try {
          if (context.launch(w, this.home)) {
            Object.assign(m, { state: "compacting", sent_at: now() });
            this.event("Native /compact requested for " + w.id, "worker", w.id);
            this.save();
          }
        } catch (error) {
          this.message(
            token + "-error",
            "project-manager",
            "Compaction could not start for " +
              w.id +
              ": " +
              (error as Error).message,
          );
        }
      } else if (m.state === "compacting") {
        try {
          const [, path] = context.native(w, this.home);
          if (context.compacted(path, m.sent_at)) {
            Object.assign(m, {
              state: "complete",
              completed_at: now(),
              baseline: spent,
              boundary,
            });
            this.event(
              "Native compaction verified for " +
                w.id +
                "; checkpoint " +
                m.checkpoint,
              "worker",
              w.id,
            );
            this.save();
            this.message(
              token + "-complete",
              w.id,
              "Same-session compaction verified. Read checkpoint " +
                m.checkpoint +
                " and latest project/root guidance. Resume only your reserved AC; if none, wait for workflow assignment.",
            );
          }
        } catch (error) {
          this.message(
            token + "-error",
            "project-manager",
            "Compaction verification failed for " +
              w.id +
              ": " +
              (error as Error).message,
          );
        }
      }
      const notified = this.state.sent[token]?.at ?? now(),
        started =
          m.state === "compacting"
            ? (m.sent_at ?? notified)
            : m.state === "ready"
              ? (m.ready_at ?? notified)
              : notified;
      if (context.PENDING.includes(m.state) && now() - started > 600)
        this.message(
          token + "-timeout",
          "project-manager",
          "Context maintenance stalled for " +
            w.id +
            " in " +
            m.state +
            ". Work remains held; inspect runtime/checkpoint.",
        );
    }
  }
  peer_requests() {
    for (const req of this.rec.peer_requests || []) {
      if (req.state === "verified" && !requests.verified(this.rec, req)) {
        Object.assign(req, {
          state: "rejected",
          detail:
            "Verified artifact changed or disappeared; fresh delivery and review required",
          revision: req.revision + 1,
          updated_at: utc(),
        });
        this.event(
          req.id + ": artifact invalidated",
          "worker",
          undefined,
          req.criterion,
        );
      }
      if (req.state === "verified" && req.purpose === "verification")
        this.message(
          "verification-ready-" + req.id + "-" + req.revision,
          req.requester,
          `${req.criterion}: verification input ${req.required_artifact} is delivered and evidence-verified. Run the pending coverage checks within the AC budget and publish reports when your track is available. Keep implementation delivery intact; existing review/compaction holds still apply.`,
          this.manager.path,
        );
      if (["verified", "cancelled"].includes(req.state)) continue;
      const reviewing = req.state === "delivered",
        target = reviewing ? req.requester : req.owner,
        cid = reviewing ? req.criterion : req.owner_criterion,
        worker = this.rec.workers.find((w: RecordData) => w.id === target),
        track = tracks.track(this.rec, target);
      let available =
        ["", cid].includes(track.active) &&
        !["requested", "ready", "compacting"].includes(
          worker.context_maintenance?.state,
        );
      if (!reviewing)
        available = available && tracks.available(this.rec, target, cid);
      const token = "peer-request-" + req.id + "-" + req.revision;
      if (available) {
        if (!track.active) {
          if (reviewing) {
            track.active = cid;
            track.suspended = track.suspended.filter((x: string) => x !== cid);
            req.review_reserved = true;
          } else {
            tracks.acquire(this.rec, target, cid);
            req.owner_reserved = true;
          }
        }
        this.save();
        if (reviewing)
          this.message(
            token,
            target,
            `${req.id}: peer delivered ${req.required_artifact}. Inspect artifact/evidence in project peer_requests; use work request-review ${this.manager.project} ${req.id} --decision accept|reject --detail FINDING. Artifact review only; implementation holds remain.`,
          );
        else
          this.message(
            token,
            target,
            `${req.id}: ${cid} peer request from ${req.requester}: deliver ${req.required_artifact}. Details in project peer_requests. Use work request-reply ${this.manager.project} ${req.id} --state acknowledged|blocked|delivered --detail TEXT; delivered needs --artifact FILE --evidence FILE.`,
          );
      }
      if (req.state === "blocked")
        this.message(
          token + "-blocked",
          req.requester,
          req.id +
            ": peer reports a blocker: " +
            req.detail +
            ". Resolve via peer request CLI; no routine PM mail.",
        );
      const deadline = reviewing
        ? epoch(req.updated_at) + 600
        : epoch(req.due_at);
      if (now() > deadline) {
        const reminder = token + "-overdue";
        this.message(
          reminder,
          target,
          req.id +
            ": response/checkpoint overdue. Publish the requested artifact/review, or a concrete blocked response through work request-reply/request-review. Do not start a second execution track.",
        );
        const notified = this.state.sent[reminder]?.at ?? now();
        if (now() - notified > 600)
          this.message(
            reminder + "-escalate",
            "project-manager",
            req.id +
              ": unresolved after responsible peer notification; owner " +
              target +
              ". Details in project peer_requests.",
          );
      }
    }
    for (const c of Object.values(this.criteria)) {
      const r = c.token_review || {},
        ids = (this.rec.peer_requests || [])
          .filter(
            (q: RecordData) => q.criterion === c.id && q.state !== "cancelled",
          )
          .map((q: RecordData) => q.id);
      if (r.state === "hold" && ids.length && !r.release_requests)
        this.message(
          "bind-peer-hold-" + c.id + "-" + r.reviewed_at + "-" + ids.join(","),
          r.root,
          `${c.id}: worker registered peer requests ${ids.join(", ")}. If these express your hold, bind release_requests mode any|all through work token-review; otherwise keep hold. No permission inferred from prose.`,
          r.guidance,
        );
    }
    for (const update of this.rec.pending_updates || [])
      if (update.state === "rejected")
        this.message(
          "queued-rejected-" + update.id,
          update.worker,
          update.id +
            ": preserved update could not be applied: " +
            update.detail +
            ". Read pending_updates and publish corrected evidence through work update.",
        );
  }
  resolve_review_hold(c: RecordData): boolean {
    const r = c.token_review,
      cid = c.id;
    let authorized = r.release_after || [];
    const request = r.release_requests;
    if (request) {
      if (!requests.ready(this.rec, request)) return true;
      authorized = request.requests;
    }
    const dependency = c.execution?.waiting_for,
      waiting = authorized.length ? authorized : dependency ? [dependency] : [];
    if (!waiting.length) return false;
    if (!request) {
      if (
        waiting.some((dep: string) => this.status(dep).status !== "completed")
      )
        return true;
      try {
        if (!waiting.every((dep: string) => this.verify_delivery(dep)))
          return true;
      } catch {
        return true;
      }
    }
    if (authorized.length) {
      const prerequisites = this.steps[c.step].depends_on.map(
        (s: string) => this.by_step[s].id,
      );
      try {
        if (
          !request &&
          !prerequisites.every((dep: string) => this.verify_delivery(dep))
        )
          return true;
      } catch {
        return true;
      }
      const track = tracks.track(this.rec, c.worker);
      if (!["", cid].includes(track.resume)) return true;
      const interval =
          runtime_ports().policy().root_review_uncached_tokens_per_ac,
        u = c.token_usage || {},
        spent =
          Math.max(0, (u.input || 0) - (u.cached_input || 0)) + (u.output || 0);
      tracks.request_resume(this.rec, c.worker, cid);
      Object.assign(r, {
        state: "reviewed",
        next_at: (Math.floor(spent / interval) + 1) * interval,
      });
      this.event(
        cid +
          ": root-authorized conditional hold released; verified " +
          authorized.join(", ") +
          ". Guidance: " +
          r.guidance,
        "decision",
        undefined,
        cid,
      );
      this.save();
      return true;
    }
    const token =
      "hold-ready-" +
      cid +
      "-" +
      (r.reviewed_at ?? r.requested_at) +
      "-" +
      (this.status(dependency).id || "");
    this.message(
      token,
      r.root,
      `${cid}: dependency ${dependency} re-completed and evidence verified. Your review hold still blocks the worker. Record resume, or an explicit release_after condition, through work token-review ${this.manager.project} ${cid} --file FILE. Reuse the reviewed packet; no new implementation requested.`,
      r.guidance,
    );
    if (now() - (this.state.sent[token]?.at ?? now()) > 600)
      this.message(
        token + "-escalate",
        "project-manager",
        `${cid}: verified dependency cleared, but root has not released its review hold after notification.`,
      );
    return true;
  }
  token_reviews() {
    usage.sample(this.rec, this.home);
    const interval =
      runtime_ports().policy().root_review_uncached_tokens_per_ac;
    for (const [cid, c] of Object.entries(this.criteria)) {
      if (
        c.requestor_review ||
        c.result === "pass" ||
        failure.held_disposition(this.rec, cid) ||
        (this.protect_registered_jobs(c.worker)&&configuredBudgets.spent(c)<budget.limit(c,this.rec))
      )
        continue;
      const u = c.token_usage || {},
        spent =
          Math.max(0, (u.input || 0) - (u.cached_input || 0)) + (u.output || 0);
      let r = c.token_review || {};
      if (r.state === "reviewed")
        r.next_at = Math.min(
          r.next_at ?? (Math.floor(spent / interval) + 1) * interval,
          (Math.floor(spent / interval) + 1) * interval,
        );
      const due = Math.max(1,budget.next_threshold(spent, r, interval, budget.limit(c,this.rec),budget.warning(this.rec)));
      if (
        spent >= due &&
        !["pause requested", "reviewing", "hold"].includes(r.state) &&
        (r.state !== "advising" || due > (r.threshold || 0))
      ) {
        if (!["in progress", "blocked"].includes(this.status(cid).status))
          continue;
        const worker = this.rec.workers.find(
            (w: RecordData) => w.id === c.worker,
          ),
          sequence = cadence.next_sequence(this.rec, cid, r);
        r = {
          sequence,
          course_correction: sequence % 3 === 0 || due >= budget.warning(this.rec),
          history_since: r.reviewed_at || "",
          prior_guidance: r.guidance || "",
          prior_turn_manifest: r.turn_manifest || "",
          state: spent < budget.limit(c,this.rec) ? "advising" : "pause requested",
          ...(Number.isFinite(budget.limit(c,this.rec))&&budget.limit(c,this.rec)>=600000?{limit:budget.limit(c,this.rec)}:{}),
          threshold: due,
          requested_at: utc(),
          source_root: worker.source.identity,
          root: review.token_reviewer(this.rec, c),
          reviewer_kind: "root",
        };
        c.token_review = r;
        this.event(
          `${cid}: ${(spent / 1000000).toFixed(1)}M uncached tokens; ` +
            (r.state === "advising"
              ? "nonblocking requestor review"
              : "token limit: safe pause and wrap-up review"),
          "worker",
          undefined,
          cid,
        );
        this.save();
      }
      // A pause flag alone does not prove the worker saved a safe checkpoint.
      if (r.state === "reviewing" && this.status(cid).status !== "completed" &&
          !tracks.track(this.rec, c.worker).suspended.includes(cid)) {
        this.message("token-safe-pause-" + cid + "-" + r.threshold, c.worker,
          `${cid}: review awaits your safe checkpoint. Save findings, finish registered jobs, then work pause ${this.manager.project} ${cid} --detail CHECKPOINT. Existing paused display does not replace this checkpoint.`);
      }
      if (r.state === "pause requested") {
        this.message(
          "token-pause-" + cid + "-" + r.threshold,
          c.worker,
          budget.instruction(r.threshold,budget.limit(c,this.rec),budget.warning(this.rec)) +
            `${cid}: token review checkpoint. Stop at a safe checkpoint, save current findings/artifacts, then work pause ${this.manager.project} ${cid} --detail CHECKPOINT. Do not continue until reviewer guidance is recorded.`,
        );
        if (c.execution?.paused && tracks.track(this.rec, c.worker).suspended.includes(cid)) {
          r.state = "reviewing";
          this.save();
        }
      }
      // Issue one stable packet per review; pending ticks only monitor its response.
      if (["reviewing", "advising"].includes(r.state) &&
          !this.state.sent["token-root-turns-v2-" + cid + "-" + r.threshold +
            (r.course_correction ? "-scope" : "") + "-" + r.root]) {
        turn_review.prepare(
          this.rec,
          c,
          join(this.manager.folder, "token-reviews"),
          this.home,
        );
        this.save();
        const course = cadence.required(r),
          packet = join(
            this.manager.folder,
            "token-reviews",
            cid + "-" + r.threshold + "-request.yaml",
          );
        atomic(
          packet,
          YAML.stringify({
            project: this.rec.identity.key,
            criterion: cid,
            threshold: r.threshold,
            goal: this.rec.goal,
            logic: this.rec.logic,
            criterion_record: c,
            products: this.rec.products,
            evidence: this.rec.evidence,
            compliance_requirements: {
              constraints: compliance.policy(this.rec, c),
              rule: "Every proposed action, including final builds, must fit the AC budget. Declare expected_seconds, timeout_seconds and checkpoint/scope-reduction fallback. Conflicting submissions are rejected to you; revise the same review, never release the worker or exempt a build.",
            },
            result_review: cadence.RESULT_REVIEW,
            review_question:
              (r.state === "advising"
                ? "NONBLOCKING: worker continues while you review. Do not request a pause unless evidence requires a hold. "
                : "") +
              budget.instruction(r.threshold,budget.limit(c,this.rec),budget.warning(this.rec)) +
              (course
                ? cadence.QUESTION
                : "Given the actual attempts and failures, what could help this agent achieve its goal sooner? Identify the highest-value change, missing information, simpler experiment, better tooling or dependency help. Do not merely endorse the current course. Read all supplied turns and cite the failed attempts behind your recommendation."),
            turn_history: r.turn_manifest,
            coordination: {
              rule: "Execution and peer review requests go only to the temporary workers listed here via work ask; the reviewer advises and is not an implementation assignee. Resume does not accept the AC or release dependencies/owner holds. State the next bounded checkpoint and where the worker must stop. Use gate_update for an actual evidenced gate correction; prose alone changes no gate. For hold-until-dependency use release_after: [AC_ID]; this authorizes automatic release only after verified delivery. For peer artifacts use release_requests: {mode: any|all, requests: [request-ID]}; only requester-verified responses release it. Prose alone cannot release a hold.",
              workers: Object.fromEntries(
                this.rec.workers.map((w: RecordData) => [
                  w.source.identity,
                  w.id,
                ]),
              ),
              cli: "agenlink",
              template_command: `agenlink work token-review-template ${this.manager.project} ${cid} --output RESPONSE.yaml`,
            },
            response: {
              threshold: r.threshold,
              decision: "hold",
              goal_review: "",
              gate_review: "",
              direction: "",
              failed_turn_review: "",
              reviewed_turns: [],
              turn_manifest_sha256: r.turn_manifest_sha256,
              acceleration_review: "",
              compliance: compliance.template(this.rec, c),
              ...cadence.template(r,budget.warning(this.rec),budget.limit(c,this.rec)),
            },
          }),
        );
        this.message(
          "token-root-turns-v2-" +
            cid +
            "-" +
            r.threshold +
            (r.course_correction ? "-scope" : "") +
            "-" +
            r.root,
          r.root,
          (r.state === "advising"
            ? "NONBLOCKING review: worker continues; return guidance without a pause unless a real hold is necessary. "
            : "") +
            budget.instruction(r.threshold,budget.limit(c,this.rec),budget.warning(this.rec)) +
            (course
              ? `${cid}: review #${r.sequence}. Immediate course correction: reduce task/project scope to finish; salvage completed artifacts. Supply scope_correction with dropped work and a finish condition. Read failed turns; submit via work token-review. Changed original goal requires a recorded scope decision. See packet.`
              : `${cid}: independent token review for ${c.worker}. Read supplied native turns, including failed attempts. What could help this agent achieve its goal sooner? Give concrete acceleration guidance grounded in that history. Submit response via work token-review ${this.manager.project} ${cid} --file FILE. Use the packet role map for temporary peer requests. Resume is not acceptance; preserve dependencies and owner holds.`),
          packet,
        );
      }
      let scope_pending = false;
      if (r.state === "hold")
        for (const decision of this.rec.decisions) {
          if (
            decision.status === "open" &&
            decision.id.startsWith("scope-") &&
            (decision.outcome || "").includes(r.guidance || "NO-GUIDANCE")
          ) {
            scope_pending = true;
            this.message(
              "scope-decision-" + decision.id,
              "project-manager",
              `${cid}: third-review course correction proposes reduced project scope. Present ${decision.id} and salvaged artifacts to the owner. Original goal unchanged; worker held.`,
              r.guidance,
            );
          }
        }
      if (scope_pending) continue;
      if (r.state === "hold" && this.resolve_review_hold(c)) continue;
      if (r.state === "reviewing") {
        recovery.recover(this, c);
        continue;
      }
      if (["pause requested", "reviewing", "hold"].includes(r.state)) {
        const sent =
            this.state.sent[
              "token-root-turns-v2-" +
                cid +
                "-" +
                r.threshold +
                (r.course_correction ? "-scope" : "") +
                "-" +
                r.root
            ]?.at,
          started =
            ["reviewing", "hold"].includes(r.state) && sent
              ? sent
              : epoch(r.requested_at);
        if (now() - started > 600) {
          const detail =
            r.state === "hold"
              ? `${cid}: reviewer explicitly directed a hold. Guidance is already recorded at ${r.guidance || ""}. Check external release conditions; do not restart recovery or request the same review again.`
              : `${cid}: token checkpoint still waiting for safe pause or root guidance. Review state: ${r.state}. Worker remains held.`;
          this.message(
            "token-escalate-" + cid + "-" + r.threshold,
            "project-manager",
            detail,
          );
        }
      }
    }
  }
  coordinate_tracks() {
    const reserved = new Set<string>();
    for (const d of this.rec.decisions || []) {
      if (!(d.id.startsWith("gate-") && d.status === "open")) continue;
      const proposal = gates.proposal(this.rec, d),
        target = gates.peer_review(this.rec, d)
          ? review.representative(this.rec)
          : proposal.peer;
      reserved.add(JSON.stringify([target, proposal.criterion]));
    }
    for (const w of this.rec.workers) {
      const name = w.id,
        t = tracks.track(this.rec, name);
      for (const cid of new Set<string>(
        [t.active, t.resume, ...t.suspended].filter(Boolean),
      )) {
        if (this.status(cid).status !== "completed") continue;
        if (t.active === cid && reserved.has(JSON.stringify([name, cid])))
          continue;
        const info = this.criteria[cid].execution || {},
          job = health.process(info.job_pid || 0);
        if (job && job.start === info.job_start) continue;
        if (!this.verify_delivery(cid)) continue;
        if (t.active === cid) t.active = "";
        if (t.resume === cid) t.resume = "";
        t.suspended = t.suspended.filter((x: string) => x !== cid);
        this.event(
          "Released completed " +
            cid +
            " worker reservation; delivery evidence verified.",
          "worker",
          name,
          cid,
        );
      }
      const conflicts = tracks.conflicts(this.rec, name);
      if (conflicts.length) {
        this.message(
          "track-conflict-" + name + "-" + t.active + "-" + conflicts.join(","),
          name,
          "One AC at a time: keep " +
            t.active +
            " as the original track. Reach a safe checkpoint on " +
            conflicts.join(", ") +
            " and acknowledge each via work pause PROJECT AC --detail TEXT. Stop their jobs before pausing. Do not work both tracks. If original is blocked/waiting, pause it explicitly before switching.",
        );
        continue;
      }
      if (!t.resume) {
        const ready: string[] = [];
        for (const cid of t.suspended) {
          const c = this.criteria[cid];
          if (
            !tracks.available(this.rec, name, cid) &&
            ["pause requested", "reviewing", "hold"].includes(
              c.token_review?.state,
            )
          )
            continue;
          if (!tracks.cleared(this.rec, c, this.steps, this.by_step)) continue;
          const deps = new Set<string>([
            ...this.steps[c.step].depends_on.map(
              (d: string) => this.by_step[d].id,
            ),
            c.execution.waiting_for,
          ]);
          try {
            if ([...deps].every((dep) => this.verify_delivery(dep)))
              ready.push(cid);
          } catch {}
        }
        if (!t.active)
          ready.push(
            ...t.suspended.filter(
              (cid: string) =>
                this.criteria[cid].execution?.paused_for_return &&
                !ready.includes(cid),
            ),
          );
        if (ready.length) t.resume = ready[0];
      }
      const target = t.resume;
      if (
        !target ||
        ["requested", "ready", "compacting"].includes(
          w.context_maintenance?.state,
        ) ||
        ["pause requested", "reviewing", "hold"].includes(
          this.criteria[target].token_review?.state,
        )
      )
        continue;
      if (t.active && t.active !== target) {
        const current = t.active,
          at = this.criteria[target].execution?.paused_at || "";
        this.message(
          "track-return-" + name + "-" + target + "-" + at,
          name,
          `${target} is ready to resume. Pause ${current} at a safe checkpoint first: work pause ${this.manager.project} ${current} --detail TEXT. Stop its jobs and save evidence. Workflow waits for that pause acknowledgment before releasing ${target}; do not run both.`,
        );
      } else if (!t.active) {
        tracks.acquire(this.rec, name, target);
        this.event(
          "Worker " +
            name +
            " reserved for resumed " +
            target +
            " after safe pause acknowledgment.",
          "worker",
          name,
          target,
        );
        const stamp = this.criteria[target].execution?.paused_at || "";
        this.message(
          "track-resume-" + name + "-" + target + "-" + stamp,
          name,
          `Resume ${target}; read root guidance ${this.criteria[target].token_review?.guidance || "if present"}; other track has paused safely. Use work update with truthful status: remain blocked if intake prerequisites are unfinished. Execute only the bounded root-authorized response. One AC at a time; preserve checkpoints and evidence.`,
        );
      }
    }
  }
  monitor_contention() {
    const groups: RecordData = {},
      time = now();
    for (const slug of read(
      join(this.home, "projects/workflow-enabled.json"),
      [],
    )) {
      const path = join(
        this.home,
        "registry/DevProjects/metadata/projects",
        slug + ".yaml",
      );
      if (!existsSync(path)) continue;
      const rec =
          slug === this.manager.project
            ? this.rec
            : YAML.parse(readFileSync(path, "utf8")),
        state =
          slug === this.manager.project
            ? this.state
            : read(join(this.home, "projects", slug, "workflow.json"), {});
      for (const c of rec.acceptance_criteria || []) {
        const obs = state.health_observations?.[c.id] || {},
          found = (obs.discovered_jobs || []).filter(
            (j: RecordData) => time - (j.observed_at || 0) < 120,
          );
        if (found.length) {
          const group = (groups[c.worker] ??= { project: slug, jobs: [] });
          group.jobs.push(...found);
        }
      }
    }
    const conflicts = jobs.contention(groups),
      active = new Set(),
      episodes = (this.state.cpu_contention ??= {});
    for (const conflict of conflicts) {
      if (!conflict.projects.includes(this.manager.project)) continue;
      const token = sha256(json_sorted(conflict)).slice(0, 16);
      active.add(token);
      const episode = (episodes[token] ??= {
        since: time,
        id: uuid().slice(0, 10),
      });
      conflict.workers.forEach((name: string, i: number) => {
        if (conflict.projects[i] === this.manager.project)
          this.message(
            "cpu-contention-" + episode.id,
            name,
            "Observed CPU contention: your advancing job overlaps another project on CPUs " +
              conflict.cpus.join(",") +
              ". Check elapsed versus CPU time; within your declared budget use a non-overlapping allocation or report the constraint via CLI. Preserve caps and root processes. Publish chosen affinity and measured timing.",
          );
      });
      if (
        time - episode.since >= 600 &&
        this.manager.project === [...conflict.projects].sort()[0]
      )
        this.alert(
          "Cross-project CPU overlap persists for ten minutes on " +
            JSON.stringify(conflict.cpus) +
            "; PM resource allocation needed for " +
            conflict.workers.join(", "),
        );
    }
    for (const token of Object.keys(episodes))
      if (!active.has(token)) {
        this.event(
          "CPU contention observation cleared; allocation or job activity changed.",
          "verification",
        );
        delete episodes[token];
      }
  }
  supervise_workers() {
    const config = read(join(this.home, "agents.json"), {}),
      attempts = (this.state.runtime_recovery ??= {});
    for (const worker of this.rec.workers) {
      const name = worker.id;
      if (["planned", "retired", "complete"].includes(worker.status)) continue;
      if (alive(this.home, name)) {
        for (const blocker of this.rec.blockers)
          if (
            blocker.status === "open" &&
            blocker.reason.startsWith("Worker runtime: " + name)
          ) {
            const evidence = this.proof(name + " managed terminal restored", {
              session: config[name]?.session,
              observed_at: utc(),
            });
            Object.assign(blocker, {
              status: "resolved",
              resolution:
                "Managed worker terminal is present again; execution/communication checks remain separate.",
              evidence: [evidence],
            });
          }
        continue;
      }
      const c = config[name] || {},
        reason = "Worker runtime: " + name;
      if (!c.session) {
        this.alert(
          reason +
            " exited before binding; inspect launch manifest. No automatic refork.",
        );
        continue;
      }
      const previous = attempts[name] || {};
      if (previous.session === c.session && now() - (previous.at || 0) < 600) {
        this.alert(
          reason +
            " disappeared again within ten minutes of recovery; PM intervention required.",
        );
        continue;
      }
      attempts[name] = { session: c.session, at: now() };
      atomic(this.path, JSON.stringify(this.state, null, 2));
      try {
        this.manager.record = this.rec;
        this.manager.resume_missing(name);
        this.rec = this.manager.record;
        this.event(
          "Worker runtime: " +
            name +
            " resumed its existing child in a persistent scope; awaiting verification.",
          "worker",
          name,
        );
      } catch (error) {
        this.alert(
          reason + " cannot safely resume: " + (error as Error).message,
        );
      }
    }
    this.save();
  }
  route_coverage(): boolean {
    let outstanding = new Set<string>();
    const rows = coverage.assess(this.rec),
      coverage_guide = guide("coverage-guide.md");
    if (!this.rec.coverage?.length) {
      const target = this.rec.identity.submitted_by;
      this.message(
        "coverage-plan-v2",
        target,
        "Review the coverage contract: cases copy their AC pass condition, methods add no requirements, inputs include consumed implementation/tools/dependencies/data. Map measurement ownership to temporary workers. Submit work coverage-plan PROJECT --file YAML. Lifecycle directions are not acceptance measurements.",
        coverage_guide,
      );
      outstanding.add("coverage-plan");
      handoffs.follow_up(
        this,
        "coverage-plan",
        target,
        "coverage-plan-v2",
        coverage_guide,
        "Publish the missing plan via work coverage-plan. Final review cannot start until the plan and reports exist.",
      );
      handoffs.resolve_except(this, outstanding);
      return false;
    }
    const owners: RecordData = {},
      missing_owners = new Set(
        rows
          .filter(
            (row) =>
              row.status !== "evidence ready" &&
              this.status(
                this.rec.coverage.find((x: RecordData) => x.id === row.id)
                  .criterion,
              ).status === "completed",
          )
          .map((row) => row.owner),
      );
    for (const [key, item] of Object.entries(
      this.state.coverage_handoffs || {},
    ) as [string, RecordData][])
      if (key !== "coverage-plan" && missing_owners.has(item.owner))
        outstanding.add(key);
    for (const row of rows) {
      const planned = this.rec.coverage.find(
          (x: RecordData) => x.id === row.id,
        ),
        criterion = this.criteria[planned.criterion];
      if (
        this.failed_coverage_reviews.has(criterion.id) ||
        this.status(criterion.id).status !== "completed" ||
        !this.verify_delivery(criterion.id)
      )
        continue;
      const deps = this.steps[criterion.step].depends_on;
      if (
        deps.some(
          (d: string) => this.status(this.by_step[d].id).status !== "completed",
        )
      )
        continue;
      if (
        row.status !== "evidence ready" &&
        tracks.available(this.rec, row.owner, planned.criterion)
      ) {
        if (this.status(planned.criterion).status !== "completed")
          tracks.acquire(this.rec, row.owner, planned.criterion);
        (owners[row.owner] ??= []).push(row);
      }
    }
    for (const [owner, gaps] of Object.entries(owners)) {
      const worker = this.rec.workers.find((w: RecordData) => w.id === owner);
      if (!this.ensure_worker(worker)) continue;
      const details: string[] = [],
        revision: any[] = [];
      for (const row of gaps) {
        const planned = this.rec.coverage.find(
          (x: RecordData) => x.id === row.id,
        );
        details.push(
          "# " +
            row.id +
            "\n" +
            planned.statement +
            "\nMeasurement: " +
            planned.measurement +
            "\nRequired scope: " +
            JSON.stringify(planned.required_scope) +
            "\nMissing: " +
            row.missing.join(", "),
        );
        revision.push([row.id, row.missing, (planned.reports || []).length]);
      }
      const detail = join(this.manager.folder, "coverage", owner + ".md");
      atomic(
        detail,
        details.join("\n\n") +
          "\n\nPublish via work coverage-report " +
          this.manager.project +
          " --file REPORT.yaml. Reuse existing reproducible evidence where it covers the case; do not rerun blindly. Evidence-ready is not root acceptance. Coordinate with peers and keep normal progress checkpoints.\nGuide: " +
          coverage_guide,
      );
      const stamp = sha256(json_sorted(revision)).slice(0, 12),
        handoff = "coverage-" + owner + "-" + stamp;
      this.message(
        handoff,
        owner,
        "Outcome coverage: " +
          gaps.map((r: RecordData) => r.id).join(", ") +
          ". Read the measurement tasks. Reuse valid evidence; fill uncovered cases and publish via coverage-report. Preserve original logic. Coordinate with peers; routine reports through CLI.",
        detail,
      );
      outstanding = new Set(
        [...outstanding].filter(
          (key) => this.state.coverage_handoffs?.[key]?.owner !== owner,
        ),
      );
      outstanding.add(handoff);
      handoffs.follow_up(
        this,
        handoff,
        owner,
        handoff,
        detail,
        "Publish the missing reports via work coverage-report: " +
          gaps.map((r: RecordData) => r.id).join(", ") +
          ".",
      );
    }
    handoffs.resolve_except(this, outstanding);
    return rows.every((x) => x.status === "evidence ready");
  }
  monitor_project_inactivity() {
    const history = projects.status_history(this.rec),
      current = history[0] || {},
      phase = current.workflow_step;
    if (
      ["closed", "cancelled"].includes(phase) ||
      (phase === "retrospective" && current.status === "completed")
    )
      return;
    const decisions = control.decision_wait(this.rec, this.steps);
    if (decisions.length) {
      const signature = sha256(
          json_sorted(
            decisions.map((d) => [d.id, d.question ?? null, d.outcome ?? null]),
          ),
        ).slice(0, 16),
        previous = this.state.decision_wait || {},
        waiting = {
          signature,
          decisions: decisions.map((d) => d.id),
          first_seen:
            previous.signature === signature
              ? previous.first_seen || utc()
              : utc(),
          last_checked: utc(),
          state: "waiting",
        };
      this.state.decision_wait = waiting;
      atomic(
        join(this.manager.folder, "decision-wait.json"),
        JSON.stringify(waiting, null, 2),
      );
      this.message(
        "decision-wait-" + signature,
        "project-manager",
        "Decision required: " +
          waiting.decisions.join(", ") +
          ". All unfinished work is held or dependent. This persistent action replaces repeated inactivity investigations; resume on a recorded decision, preserve holds.",
        this.manager.path,
      );
      atomic(this.path, JSON.stringify(this.state, null, 2));
      return;
    }
    if (this.state.decision_wait?.state === "waiting") {
      this.state.decision_wait.state = "released";
      atomic(
        join(this.manager.folder, "decision-wait.json"),
        JSON.stringify(this.state.decision_wait, null, 2),
      );
      delete this.state.inactivity_clock;
    }
    const prefix = "PROJECT INACTIVITY ALARM:",
      time = now(),
      last =
        last_activity(this.rec) || (this.state.inactivity_started ??= time),
      mono = Number(process.hrtime.bigint()) / 1e9,
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      clock = this.state.inactivity_clock || {};
    const reset =
      !Object.keys(clock).length ||
      clock.boot !== boot ||
      mono < (clock.mono ?? mono) ||
      Math.abs(time - (clock.wall ?? time) - (mono - (clock.mono ?? mono))) > 5;
    const elapsed =
        reset || last !== clock.activity
          ? 0
          : clock.elapsed + Math.max(0, mono - clock.mono),
      generation =
        reset || last !== clock.activity
          ? String(process.hrtime.bigint())
          : clock.generation;
    this.state.inactivity_clock = {
      boot,
      wall: time,
      mono,
      activity: last,
      elapsed,
      generation,
      signal_version: 2,
    };
    atomic(this.path, JSON.stringify(this.state, null, 2));
    if (elapsed < 600) return;
    for (const c of Object.values(this.criteria)) recovery.recover(this, c);
    this.message(
      `project-inactivity-${generation}-${Math.floor(elapsed / 600)}`,
      "project-manager",
      `${prefix} ${this.rec.identity.key}: inactive ${Math.floor(elapsed / 60)} awake min. Workflow: ${phase}. CRITICAL CALL TO ACTION: decide now, resolve the exception and resume authorized workflow. Do not merely report the wait. Verify progress. Preserve explicit holds; escalate the exact decision if blocked. Record action and follow up until resolved.`,
    );
    this.save();
  }
  route_owner_actions() {
    const pending = (this.state.owner_action_followups ??= {}),
      phase = projects.status_history(this.rec)[0]!.workflow_step;
    for (const action of [...this.rec.events]) {
      if (!action.id.startsWith("owner-ui-")) continue;
      const proof = this.rec.evidence.find((e: RecordData) =>
        (action.evidence || []).includes(e.id),
      );
      if (!proof) continue;
      const record = read(proof.location, {});
      if (!Object.keys(record).length) continue;
      const hold_approved =
          record.choice === "approve" && record.action?.kind === "hold",
        target = hold_approved
          ? this.rec.identity.submitted_by
          : "project-manager",
        token = "owner-action-" + action.id,
        entry = (pending[action.id] ??= { target, state: "pending" });
      if (entry.state === "responded") continue;
      const responded = this.rec.events.some(
        (e: RecordData) =>
          e.actor === target &&
          (e.at || "") > action.at &&
          !(e.id || "").startsWith("owner-ui-") &&
          ["decision", "merge", "cleanup", "review", "verification"].includes(
            e.kind,
          ) &&
          (target !== "project-manager" ||
            ["merge", "cleanup"].includes(e.kind) ||
            (e.detail || "").includes(action.id) ||
            (e.detail || "").includes(record.action?.id || "NO-ACTION")) &&
          !(e.detail || "").startsWith("To "),
      );
      if (
        responded ||
        ["closing", "closed", "retrospective", "cancelled"].includes(phase)
      ) {
        Object.assign(entry, { state: "responded", responded_at: utc() });
        continue;
      }
      const instruction = hold_approved
        ? "Owner released the named hold. Recheck current review/candidate validity and finish acceptance via CLI; no automatic pass. "
        : "Apply this recorded owner decision/direction to the project; preserve independent acceptance and unrelated holds. ";
      this.message(token, target, instruction + action.detail, proof.location);
      const mono = Number(process.hrtime.bigint()) / 1e9,
        previous = entry.monotonic_at ?? mono;
      if (mono >= previous)
        entry.awake_elapsed = (entry.awake_elapsed || 0) + mono - previous;
      entry.monotonic_at = mono;
      const elapsed = entry.awake_elapsed || 0;
      if (elapsed >= 180)
        this.message(
          token + "-reminder",
          target,
          "Approval follow-up: no recorded disposition yet. " +
            instruction +
            "Record the action or remaining blocker, referencing " +
            action.id +
            ".",
          proof.location,
        );
      if (elapsed >= 600)
        this.message(
          token + "-escalation",
          "project-manager",
          "Approval has no recorded disposition after 10 minutes: " +
            action.id +
            "; responsible agent " +
            target +
            ". Resolve the stalled transition; do not ask the owner to approve again.",
          proof.location,
        );
      if (!hold_approved || this.rec.logistics.owner_holds.length) continue;
      for (const w of this.rec.workers) {
        if (
          w.status === "retired" ||
          ["requested", "ready", "compacting"].includes(
            w.context_maintenance?.state,
          )
        )
          continue;
        const track = tracks.track(this.rec, w.id),
          choices = Object.values(this.criteria).filter(
            (c) =>
              c.worker === w.id &&
              !c.requestor_review &&
              this.status(c.id).status === "blocked" &&
              !["pause requested", "reviewing", "hold"].includes(
                c.token_review?.state,
              ),
          );
        for (const c of choices) {
          if (
            !["", c.id].includes(track.active) ||
            !["", c.id].includes(track.resume)
          )
            continue;
          const deps = this.steps[c.step].depends_on.map(
            (d: string) => this.by_step[d].id,
          );
          try {
            if (!deps.every((d: string) => this.verify_delivery(d))) continue;
          } catch {
            continue;
          }
          this.message(
            token + "-worker-" + w.id,
            w.id,
            "Owner approval recorded. Reassess " +
              c.id +
              " against the exact record. Resume via work resume/update only if its blocker is cleared; preserve other holds and one AC per worker. Otherwise publish the remaining blocker. No automatic acceptance or new scope.",
            proof.location,
          );
          break;
        }
      }
    }
  }
  tick() {
    this.route_owner_actions();
    this.monitor_project_inactivity();
    const phase = projects.status_history(this.rec)[0]!.workflow_step;
    if (phase === "retrospective") {
      this.retrospective();
      return;
    }
    if (["closed", "cancelled"].includes(phase)) return;
    if (phase === "closing") {
      if (
        this.rec.decisions.some(
          (d: RecordData) => d.id === "requestor-salvage-closeout",
        )
      )
        this.verify_salvage_closeout();
      else review.require_accepted(this.rec);
      this.ramp_down();
      return;
    }
    const groups = dependencies.cycles(this.rec, this.steps);
    this.cycle_members = new Set(groups.flat());
    for (const group of groups) {
      const reason =
        "Dependency/hold cycle: " +
        group.join(", ") +
        ". Correct artifact release conditions; diagnostic work must not require its own result.";
      this.alert(reason, group[0]);
      const signature = group.join("-"),
        since = ((this.state.dependency_cycle_seen ??= {})[signature] ??=
          now());
      if (now() - since > 600)
        this.message(
          "dependency-cycle-escalate-" + signature,
          "project-manager",
          reason +
            " Still unresolved after worker notification; review release conditions. No experimental recovery or gate waiver applied.",
        );
    }
    usage.sample(this.rec,this.home);
    for(const [cid,c] of Object.entries(this.criteria)){
      if(this.status(cid).status==='completed'||failure.held_disposition(this.rec,cid)||['hold','pause requested','reviewing'].includes(c.token_review?.state))continue;
      const turn=configuredBudgets.turn(this.rec,c,this.home),reason=configuredBudgets.reason(this.rec,c)||(turn&&turn.remaining<=0?'Turn time budget reached; save a checkpoint and finish this turn':'');
      if(reason){this.message('configured-budget-'+cid+'-'+JSON.stringify(this.rec.configuration||{})+(reason.startsWith('Turn')?'-'+turn!.start:''),c.worker,`${cid}: ${reason}. Stop implementation at a safe checkpoint; preserve reports and publish current findings. No automatic retry or budget reset.`);c.health={state:c.execution?.paused?'paused':'waiting',reason,observed_at:utc()};}
    }
    this.supervise_workers();
    this.peer_requests();
    waits.inspect(this);
    this.failed_coverage_reviews = failure.route(this);
    this.token_reviews();
    this.maintain_context();
    this.coordinate_tracks();
    const delivery_ready = Object.values(this.criteria)
      .filter((c) => !c.requestor_review)
      .every((c) => this.status(c.id).status === "completed");
    if (delivery_ready) this.prepare_integration();
    const coverage_ready = this.route_coverage(),
      gate_pending = this.route_gate_reviews();
    if (Object.values(this.criteria).every((c) => c.result === "pass")) {
      if (gate_pending) {
        this.save();
        return;
      }
      try {
        review.require_accepted(this.rec);
      } catch {
        let ready = true;
        for (const cid of Object.keys(this.criteria)) {
          try {
            if (!this.verify_delivery(cid)) ready = false;
          } catch (error) {
            this.invalidate_delivery(cid, (error as Error).message);
            ready = false;
          }
        }
        if (coverage_ready && ready) this.request_logic_review();
        this.save();
        return;
      }
      this.closeout();
      return;
    }
    let completed: string[] = [];
    for (const [cid, c] of Object.entries(this.criteria)) {
      if (this.cycle_members.has(cid)) continue;
      const event = this.status(cid),
        status = event.status;
      if (this.failed_coverage_reviews.has(cid)) {
        c.health = {
          state: "waiting",
          reason: "Failed outcome evidence awaits requestor disposition",
          observed_at: utc(),
        };
        continue;
      }
      try {
        const owner = this.rec.workers.find(
            (w: RecordData) => w.id === c.worker,
          ),
          controller = control.control(this.rec, c,this.home);
        if (controller && status !== "completed") {
          c.health = {
            state: "paused",
            reason: controller,
            observed_at: utc(),
          };
          continue;
        }
        const hold_health = health.delivery_wait(c, []);
        if (hold_health) {
          c.health = hold_health;
          continue;
        }
        if (
          ["pause requested", "reviewing", "hold"].includes(
            c.token_review?.state,
          )
        ) {
          c.health = {
            state: c.execution?.paused ? "paused" : "waiting",
            reason:
              c.token_review.state === "hold"
                ? "Explicit root hold: " + (c.token_review.guidance || "")
                : "Token checkpoint: " + c.token_review.state,
            observed_at: utc(),
          };
          continue;
        }
        if (
          !c.requestor_review &&
          status !== "completed" &&
          ["requested", "ready", "compacting"].includes(
            owner.context_maintenance?.state,
          )
        ) {
          const pending = this.steps[c.step].depends_on.filter(
            (d: string) =>
              this.status(this.by_step[d].id).status !== "completed",
          );
          c.health = health.delivery_wait(c, pending, true);
          continue;
        }
        if (c.execution?.paused) {
          c.health = {
            state: "paused",
            reason:
              "Paused; worker reserved for " +
              tracks.track(this.rec, c.worker).active,
            observed_at: utc(),
          };
          continue;
        }
        if (c.requestor_review) {
          if (status === "completed") {
            this.verify_delivery(cid);
            completed.push(cid);
            this.resolve_flow_alerts(cid);
          } else if (
            coverage_ready &&
            !gate_pending &&
            this.steps[c.step].depends_on.every((d: string) =>
              this.verify_delivery(this.by_step[d].id),
            )
          )
            this.dispatch_final_review(c);
          continue;
        }
        const pending = this.steps[c.step].depends_on.filter(
          (d: string) => this.status(this.by_step[d].id).status !== "completed",
        );
        if (pending.length && ["blocked", "not started"].includes(status)) {
          this.monitor_health(cid, false);
          continue;
        }
        this.monitor_health(cid);
        if (status === "completed") {
          this.verify_delivery(cid);
          completed.push(cid);
          this.resolve_flow_alerts(cid);
          continue;
        }
        // Startup reports do not establish readiness or acknowledgement of an assignment.
        if (
          ["blocked", "in progress"].includes(status) &&
          !("dispatch-" + cid in this.state.sent) &&
          !(event.id || "").startsWith("review-rejected-")
        ) {
          if (this.steps[c.step].depends_on.every((d: string) =>
            this.verify_delivery(this.by_step[d].id),
          )) this.dispatch(c);
          continue;
        }
        if (status === "blocked") {
          if ((event.id || "").startsWith("review-rejected-")) {
            this.invalidate_delivery(cid, event.detail);
            continue;
          }
          this.resolve_flow_alerts(cid);
          this.recovery_ready(cid);
          if (
            !this.state.recovery?.[cid] &&
            this.steps[c.step].depends_on.length
          )
            this.message(
              "blocked-inputs-ready-" + cid + "-" + (event.id || ""),
              c.worker,
              `${cid}: upstream delivery artifacts are now available. Reassess your blocker against current evidence and resume through work update when ready; report any remaining own-work failure explicitly.`,
            );
          if (event.actor !== c.worker)
            this.alert(`${cid}: ${event.detail || "blocked"}`, cid);
          continue;
        }
        if (status === "in progress") {
          const worker = this.rec.workers.find(
            (w: RecordData) => w.id === c.worker,
          );
          if (!this.ensure_worker(worker)) continue;
          worker.status = "active";
          this.resolve_flow_alerts(cid);
          continue;
        }
        if (
          this.steps[c.step].depends_on.every((d: string) =>
            this.verify_delivery(this.by_step[d].id),
          )
        )
          this.dispatch(c);
      } catch (error) {
        if (status === "completed")
          this.invalidate_delivery(cid, (error as Error).message);
        else this.alert((error as Error).message, cid);
      }
    }
    this.monitor_contention();
    this.recover_idle_waits();
    completed = completed.filter(
      (cid) => this.status(cid).status === "completed",
    );
    if (
      completed.length === Object.keys(this.criteria).length &&
      !gate_pending &&
      coverage_ready
    )
      this.request_logic_review();
    this.save();
  }
  prepare_integration(): boolean {
    for (const blocker of this.rec.blockers) {
      if (
        blocker.status !== "open" ||
        blocker.owner !== "project-manager" ||
        !blocker.id.startsWith("flow-")
      )
        continue;
      const product = this.rec.products.find(
        (p: RecordData) =>
          blocker.reason ===
          p.id +
            ": integration reconciliation conflicts; resolve on the project branch",
      );
      if (product) {
        let resolved = false;
        try {
          resolved = this.manager.integration_lock(product, () =>
            integration.reconciled(product),
          );
        } catch {}
        if (resolved) {
          const proof = this.proof(
            "Integration conflict resolved on clean project branch",
            {
              product: product.id,
              candidate: integration.git(product.worktree, "rev-parse", "HEAD"),
            },
          );
          Object.assign(blocker, {
            status: "resolved",
            resolution:
              "Current target is an ancestor of the clean project candidate.",
            evidence: [proof],
          });
          this.event(
            "Verified integration conflict resolved: " + product.id,
            "decision",
            undefined,
            undefined,
            [proof],
          );
        }
      }
    }
    if (
      this.rec.logistics.owner_holds?.length ||
      this.rec.blockers.some(
        (b: RecordData) => b.status === "open" && !review.closeout_alert(b),
      )
    )
      return false;
    if (
      (this.rec.logistics.prohibited_actions || []).includes("merge") &&
      this.rec.products.some(
        (p: RecordData) => p.merge.status !== "not-required",
      )
    )
      return false;
    const pins: RecordData[] = [];
    try {
      for (const p of this.rec.products) {
        if (p.merge.status === "not-required") continue;
        this.manager.integration_lock(p, () =>
          pins.push(integration.prepare_product(p)),
        );
      }
    } catch (error) {
      this.alert((error as Error).message);
      return false;
    }
    if (
      json_sorted(pins) !== json_sorted(this.rec.integration_preflight || [])
    ) {
      this.rec.integration_preflight = pins;
      this.event(
        "Prepared integration candidate against current targets; retain only checks with unchanged consumed inputs.",
        "decision",
      );
      this.save();
    }
    return true;
  }
  request_logic_review() {
    if (
      !this.prepare_integration() ||
      coverage.assess(this.rec).some((x) => x.status !== "evidence ready")
    )
      return;
    for (const cid of Object.keys(this.criteria))
      if (this.status(cid).status === "completed")
        this.resolve_flow_alerts(cid);
    const requestor = this.rec.identity.submitted_by,
      report = review.template(this.rec),
      file = join(
        this.manager.folder,
        "reviews",
        "logic-" + report.snapshot.slice(0, 16) + ".yaml",
      );
    if (!existsSync(file)) atomic(file, YAML.stringify(report));
    this.message(
      "logic-review-" + report.snapshot,
      requestor,
      `${this.rec.identity.key}: independently validate the complete outcome against your own research logic and exit criteria. Do not recheck the delivery-step checklist. Record logical findings and evidence; accept using work accept --review FILE --evidence APPROVAL --detail TEXT. Active cannot exit before review passes.`,
      file,
    );
    projects.update_status(this.rec, {
      workflow_step: "validating",
      status: "in progress",
      criterion: "",
      owner: requestor,
      reason: "Independent outcome review: " + file,
    });
  }
  verify_salvage_closeout() {
    return closeout.verify_salvage_closeout(this);
  }
  reconcile_integration_alerts() {
    return closeout.reconcile_integration_alerts(this);
  }
  closeout() {
    return closeout.closeout(this);
  }
  ramp_down() {
    return closeout.ramp_down(this);
  }
  retrospective() {
    return closeout.retrospective(this);
  }
}

export function enable(home: string, project: string): void {
  configure(home, project, true);
}
export function disable(home: string, project: string): void {
  configure(home, project, false);
}
function configure(home: string, project: string, enabled: boolean): void {
  if (!/^[a-z][a-z0-9-]*$/.test(project))
    throw Error("valid project slug required");
  locked(join(home, "projects/workflow-config.lock"), () => {
    const path = join(home, "projects/workflow-enabled.json"),
      names = new Set<string>(read(path, []));
    if (enabled) names.add(project);
    else names.delete(project);
    atomic(path, JSON.stringify([...names].sort()));
  });
}
export async function tick_projects(
  root: string,
  home: string,
  options: { project?: string; all?: boolean; stall_minutes?: number } = {},
  render?: () => void | Promise<void>,
): Promise<string[]> {
  const names: string[] = options.all
      ? read(join(home, "projects/workflow-enabled.json"), [])
      : [options.project!],
    errors: string[] = [];
  for (const name of names) {
    if (!name) throw Error("project or --all required");
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw Error("valid project slug required");
    locked(join(home, "projects", name, "workers.lock"), () => {
      let flow: Flow | undefined;
      try {
        flow = new Flow(name, (options.stall_minutes ?? 15) * 60, root, home);
        flow.tick();
      } catch (error) {
        errors.push(name + ": " + (error as Error).message);
        if (flow) {
          try {
            new Flow(
              name,
              (options.stall_minutes ?? 15) * 60,
              root,
              home,
            ).alert((error as Error).message);
          } catch (alert_error) {
            errors.push(
              name +
                ": could not record workflow failure: " +
                (alert_error as Error).message,
            );
          }
        }
      }
    });
    const { replay_queued } = await import("./project_work.js");
    await replay_queued(root, name, home);
  }
  if (render) await render();
  return errors;
}
