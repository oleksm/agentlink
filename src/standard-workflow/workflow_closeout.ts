import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  cpSync,
  readdirSync,
} from "node:fs";
import {
  join,
  basename,
  relative,
  isAbsolute,
  resolve,
  dirname,
} from "node:path";
import { spawnSync } from "node:child_process";
import { atomic, locked, run } from "./workers.js";
import { sha256, type RecordData } from "./common.js";
import * as projects from "./projects.js";
import * as review from "./project_review.js";
import * as integration from "./project_integration.js";
import * as context from "./project_context.js";
import * as retirement from "./project_retirement.js";
import * as retrospective_record from "./project_retrospective.js";
const utc = () => new Date().toISOString(),
  now = () => Date.now() / 1000;
const read = (path: string, fallback: any) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
const file = (path: string) => existsSync(path) && statSync(path).isFile();
export function verify_salvage_closeout(flow: RecordData) {
  const required = {
      "owner-scope-salvage-closeout": "owner",
      "requestor-salvage-closeout": flow.rec.identity.submitted_by,
    },
    evidence = Object.fromEntries(
      flow.rec.evidence.map((e: RecordData) => [e.id, e]),
    );
  for (const [ident, owner] of Object.entries(required)) {
    const decision = flow.rec.decisions.find((d: RecordData) => d.id === ident);
    if (
      !decision ||
      decision.status !== "decided" ||
      decision.owner !== owner ||
      !decision.evidence?.length
    )
      throw Error("Salvage closeout needs explicit " + owner + " disposition");
    for (const eid of decision.evidence) {
      const proof = evidence[eid];
      if (
        !file(proof.location) ||
        sha256(readFileSync(proof.location)) !== proof.sha256
      )
        throw Error("Salvage disposition evidence changed: " + eid);
    }
  }
  if (flow.rec.project_status !== "fail")
    throw Error("Salvage must preserve the failed original goal");
  if (
    flow.rec.logistics.owner_holds.length ||
    flow.rec.blockers.some((b: RecordData) => b.status === "open")
  )
    throw Error("Salvage closeout still has open holds/blockers");
  if (
    !(flow.rec.logistics.prohibited_actions || []).includes("delete-artifacts")
  )
    throw Error("Salvage must preserve unmerged artifacts");
  for (const p of flow.rec.products) {
    if (p.merge.status !== "merged")
      throw Error("Salvage integration incomplete");
    run([
      "git",
      "-C",
      p.repository,
      "merge-base",
      "--is-ancestor",
      p.merge.candidate_commit,
      p.merge_target,
    ]);
  }
}
export function reconcile_integration_alerts(flow: RecordData) {
  const alerts = flow.rec.blockers.filter(
    (b: RecordData) => b.status === "open" && review.closeout_alert(b),
  );
  if (!alerts.length) return;
  if (flow.rec.logistics.owner_holds.length)
    throw Error("Explicit owner holds still prevent integration");
  const facts: RecordData[] = [];
  for (const p of flow.rec.products) {
    if (p.merge.status === "not-required") continue;
    if ((flow.rec.logistics.prohibited_actions || []).includes("merge"))
      throw Error("Owner prohibits production merge");
    const candidate = p.merge.candidate_commit;
    if (!candidate) throw Error(`${p.id}: accepted candidate commit missing`);
    flow.manager.integration_lock(p, () => {
      const target = integration.git(p.repository, "rev-parse", p.merge_target),
        integrated = integration.ancestor(p.repository, candidate, target);
      if (existsSync(p.worktree)) {
        if (integration.git(p.worktree, "rev-parse", "HEAD") !== candidate)
          throw Error(`${p.id}: branch changed after acceptance`);
        if (integration.git(p.worktree, "status", "--porcelain"))
          throw Error(`${p.id}: candidate worktree has dirty files`);
      } else if (!integrated)
        throw Error(`${p.id}: candidate worktree missing`);
      if (!integrated) {
        if (
          integration.git(p.repository, "branch", "--show-current") !==
          p.merge_target
        )
          throw Error(`${p.id}: target worktree is on a different branch`);
        if (integration.git(p.repository, "status", "--porcelain"))
          throw Error(`${p.id}: integration target has unrelated dirty files`);
        if (!integration.ancestor(p.repository, target, candidate))
          throw Error(
            `${p.id}: Not possible to fast-forward; reconcile current main on the project branch`,
          );
      }
      facts.push({
        product: p.id,
        candidate,
        target,
        already_integrated: integrated,
      });
    });
  }
  const proof = flow.proof(
    "Integration retry preflight verified current Git conditions",
    { products: facts, resolved_alerts: alerts.map((b: RecordData) => b.id) },
  );
  for (const b of alerts)
    Object.assign(b, {
      status: "resolved",
      resolution:
        "Current integration preflight passed; earlier failure conditions are resolved.",
      evidence: [proof],
    });
  flow.event(
    "Resolved obsolete integration alerts after current candidate/target preflight.",
    "decision",
    undefined,
    undefined,
    [proof],
  );
  flow.save();
}
export function closeout(flow: RecordData) {
  review.require_accepted(flow.rec);
  if (
    flow.rec.logistics.owner_holds.length ||
    flow.rec.blockers.some(
      (b: RecordData) => b.status === "open" && !review.closeout_alert(b),
    )
  ) {
    flow.alert(
      "Acceptance recorded, but explicit holds or open blockers still prevent closeout.",
    );
    return;
  }
  for (const cid of Object.keys(flow.criteria)) flow.verify_delivery(cid);
  flow.reconcile_integration_alerts();
  const required = flow.rec.products.filter(
    (p: RecordData) => p.merge.status !== "not-required",
  );
  projects.update_status(flow.rec, {
    workflow_step: "merging",
    status: required.length ? "in progress" : "bypassed",
    criterion: "",
    owner: "project-manager",
    reason: required.length
      ? "Accepted; integrating required commits"
      : "Integration not required; preserving unmerged artifacts",
  });
  for (const p of flow.rec.products) {
    if (p.merge.status === "not-required") continue;
    if ((flow.rec.logistics.prohibited_actions || []).includes("merge"))
      throw Error(
        "Owner prohibits production merge; acceptance does not release this restriction",
      );
    const candidate = p.merge.candidate_commit;
    if (!candidate) throw Error(`${p.id}: accepted candidate commit missing`);
    flow.manager.integration_lock(p, () => {
      integration.require_current(flow.rec, true);
      const current = existsSync(p.worktree)
        ? integration.git(p.worktree, "rev-parse", "HEAD")
        : candidate;
      if (current !== candidate)
        throw Error(`${p.id}: branch changed after acceptance`);
      let target = integration.git(p.repository, "rev-parse", p.merge_target);
      const integrated = integration.ancestor(p.repository, candidate, target);
      if (!integrated) {
        if (
          integration.git(p.repository, "branch", "--show-current") !==
          p.merge_target
        )
          throw Error(`${p.id}: target worktree is on a different branch`);
        if (integration.git(p.repository, "status", "--porcelain"))
          throw Error(`${p.id}: integration target has unrelated dirty files`);
        integration.git(p.repository, "merge", "--ff-only", candidate);
        target = integration.git(p.repository, "rev-parse", "HEAD");
      }
      if (p.merge.status !== "merged") {
        const proof = flow.evidence(
          "merge",
          "Accepted candidate is reachable from target branch.",
          `git:${p.repository}@${target}`,
          p.id,
          candidate,
        );
        Object.assign(p.merge, {
          status: "merged",
          merge_commit: target,
          at: utc(),
          evidence: [proof],
        });
        flow.event(
          `${p.id} integrated at ${target}.`,
          "merge",
          undefined,
          undefined,
          [proof],
        );
        flow.save();
      }
    });
  }
  for (const b of flow.rec.blockers)
    if (b.status === "open" && review.closeout_alert(b))
      Object.assign(b, {
        status: "resolved",
        resolution: "Integration completed on retry.",
        evidence: [],
      });
  if (required.length)
    projects.update_status(flow.rec, {
      workflow_step: "merging",
      status: "completed",
      criterion: "",
      owner: "project-manager",
      reason:
        "Required product integrations evidenced; any excluded products remain unmerged",
    });
  flow.ramp_down();
}
export function ramp_down(flow: RecordData) {
  const archive = join(
    flow.home,
    "registry/DevProjects/postmortems",
    flow.manager.project,
    "artifacts",
  );
  for (const evidence of flow.rec.evidence) {
    const path = evidence.location;
    if (
      file(path) &&
      flow.rec.products.some((p: RecordData) => {
        const rel = relative(resolve(p.worktree), resolve(path));
        return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
      })
    ) {
      mkdirSync(archive, { recursive: true });
      const target = join(archive, evidence.id + "-" + basename(path));
      cpSync(path, target, { preserveTimestamps: true });
      evidence.location = target;
    }
  }
  flow.save();
  if (!flow.rec.postmortem) {
    const report = join(
      flow.home,
      "registry/DevProjects/postmortems",
      flow.manager.project + ".md",
    );
    let text =
      "# " +
      flow.rec.identity.name +
      "\n\nOutcome: " +
      flow.rec.goal +
      "\n\nRequestor acceptance and exact candidate evidence are recorded in the project.\n\n";
    text += Object.values(flow.criteria)
      .map(
        (c: any) =>
          `- ${c.id}: ${c.result}; evidence ${(c.evidence || []).join(", ")}`,
      )
      .join("\n");
    text +=
      "\n\nIntegration:\n" +
      flow.rec.products
        .map(
          (p: RecordData) =>
            `- ${p.id}: ${p.merge.merge_commit || p.merge.reason || p.merge.status}`,
        )
        .join("\n");
    text +=
      "\n\nRecorded issues and resolutions:\n" +
      flow.rec.blockers
        .map((b: RecordData) => `- ${b.reason}: ${b.resolution || b.status}`)
        .join("\n");
    text +=
      "\n\nTimeline:\n" +
      flow.rec.events
        .map((e: RecordData) => `- ${e.at}: ${e.detail}`)
        .join("\n");
    atomic(report, text + "\n");
    const proof = flow.evidence(
      "review",
      "Postmortem records criteria, integration, timeline and limitations before retirement.",
      report,
    );
    flow.rec.postmortem = {
      outcome:
        "Requestor accepted the recorded outcome; product integration results are listed individually.",
      lessons: [
        "See recorded timeline and blocker resolutions; no unrecorded outcomes inferred.",
      ],
      follow_up: [],
      evidence: [proof],
    };
    flow.save();
  }
  projects.update_status(flow.rec, {
    workflow_step: "closing",
    status: "in progress",
    criterion: "",
    owner: "project-manager",
    reason:
      "Retiring workers and archiving evidence; integration follows each product record",
  });
  flow.save();
  const config = read(join(flow.home, "agents.json"), {});
  for (const w of flow.rec.workers) {
    if (w.status === "retired") continue;
    if (w.id === w.source.identity || !w.id.startsWith("worker-"))
      throw Error("refusing to retire a permanent identity");
    const manifest = read(w.runtime_manifest, {}),
      c = config[w.id];
    if (!c)
      throw Error(`${w.id}: registration missing before verified retirement`);
    if (c.forked_from?.project !== flow.manager.project)
      throw Error("refusing registration not owned by this project");
    if (!manifest.retire_ready) {
      flow.message(
        "retire-" + w.id,
        w.id,
        `${flow.rec.identity.key}: accepted for closeout; see individual product integration records. Stop at a safe point, preserve evidence outside removable worktrees, stop project jobs and report clean/idle state using work retire-ready ${flow.manager.project}. Do not delete files or contact roots.`,
      );
      if (now() - flow.state.sent["retire-" + w.id].at > flow.stall)
        throw Error(`${w.id}: retirement acknowledgement stalled`);
      return;
    }
    if (c.session !== manifest.retire_session)
      throw Error("retirement session changed");
    if (now() - manifest.retire_at < 10) return;
    const socket = "agent-" + w.id,
      observed = spawnSync(
        "tmux",
        ["-L", socket, "display-message", "-p", "-t", socket, "#{pane_pid}"],
        { encoding: "utf8" },
      );
    if (observed.status === 0) {
      const pid = observed.stdout.trim();
      if (
        pid !== String(manifest.pane_pid) ||
        run(["ps", "-p", pid, "-o", "lstart="]) !== manifest.pane_start
      )
        throw Error(`${w.id}: process identity changed`);
      const [, transcript] = context.native(w, flow.home);
      if (!context.idle(transcript, w.fork.runtime)) return;
      const remaining = retirement.remaining_jobs(Number(pid), "/proc", w.fork.runtime, read(join(flow.home, "runtime-helper-commands.json"), []));
      if (remaining.length)
        throw Error(
          `${w.id}: actual child jobs remain at retirement: ${JSON.stringify(remaining)}`,
        );
      run(["tmux", "-L", socket, "kill-session", "-t", socket]);
    }
    locked(join(flow.home, "run/config.lock"), () => {
      const latest = read(join(flow.home, "agents.json"), {}),
        entry = latest[w.id];
      if (!entry || entry.session !== manifest.retire_session)
        throw Error("registration changed during cleanup");
      atomic(
        join(dirname(w.runtime_manifest), "retired-registration.json"),
        JSON.stringify(entry, null, 2),
      );
      const aliases = read(join(flow.home, "aliases.json"), {});
      aliases[w.id] = "project-manager";
      atomic(join(flow.home, "aliases.json"), JSON.stringify(aliases, null, 2));
      delete latest[w.id];
      atomic(join(flow.home, "agents.json"), JSON.stringify(latest, null, 2));
    });
    w.status = "retired";
    const proof = flow.evidence(
      "cleanup",
      "Verified child identity retired; registration/mail references archived, late messages route to PM.",
      w.runtime_manifest,
    );
    for (const resource of flow.rec.cleanup.resources)
      if (resource.id === w.id)
        Object.assign(resource, { status: "removed", evidence: [proof] });
    flow.rec.cleanup.evidence.push(proof);
    flow.save();
  }
  for (const p of flow.rec.products) {
    if (
      p.merge.status === "not-required" ||
      (flow.rec.logistics.prohibited_actions || []).includes("delete-artifacts")
    ) {
      const proof = flow.evidence(
        "cleanup",
        "Retain candidate branch/worktree and artifacts under recorded preservation policy; product merge records state what was integrated.",
        p.worktree,
      );
      for (const resource of flow.rec.cleanup.resources)
        if (p.owned_resources.includes(resource.id))
          Object.assign(resource, { status: "retained", evidence: [proof] });
      flow.rec.cleanup.evidence.push(proof);
      flow.save();
      continue;
    }
    flow.manager.integration_lock(p, () => {
      if (
        !p.project_branch.startsWith("project/") ||
        resolve(p.worktree) === resolve(p.repository)
      )
        throw Error("refusing permanent branch/worktree cleanup");
      if (
        !p.owned_resources.every((rid: string) =>
          flow.rec.cleanup.resources.some(
            (r: RecordData) => r.id === rid && r.project_owned,
          ),
        )
      )
        throw Error("cleanup resources not project-owned");
      if (existsSync(p.worktree)) {
        if (integration.git(p.worktree, "status", "--porcelain"))
          throw Error(`${p.id}: dirty/untracked work prevents cleanup`);
        const head = integration.git(p.worktree, "rev-parse", "HEAD");
        run([
          "git",
          "-C",
          p.repository,
          "merge-base",
          "--is-ancestor",
          head,
          p.merge_target,
        ]);
        run(["git", "-C", p.repository, "worktree", "remove", p.worktree]);
      }
      if (
        spawnSync("git", [
          "-C",
          p.repository,
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/" + p.project_branch,
        ]).status === 0
      )
        run(["git", "-C", p.repository, "branch", "-d", p.project_branch]);
      const proof = flow.evidence(
        "cleanup",
        "Clean integrated project worktree and branch removed; lock/runtime evidence retained.",
        p.repository,
      );
      for (const resource of flow.rec.cleanup.resources)
        if (p.owned_resources.includes(resource.id))
          Object.assign(resource, {
            status: resource.kind === "lock" ? "retained" : "removed",
            evidence: [proof],
          });
      flow.rec.cleanup.evidence.push(proof);
      flow.save();
    });
  }
  for (const resource of flow.rec.cleanup.resources.filter((r: RecordData) =>
    ["pending", "blocked"].includes(r.status),
  )) {
    if (
      (flow.rec.logistics.prohibited_actions || []).includes(
        "delete-artifacts",
      ) &&
      resource.kind === "file" &&
      existsSync(resource.location)
    ) {
      const proof = flow.evidence(
        "cleanup",
        "Owner prohibits deletion: staging/evidence remains retained at its recorded path.",
        resource.location,
      );
      Object.assign(resource, { status: "retained", evidence: [proof] });
      flow.rec.cleanup.evidence.push(proof);
    } else
      throw Error(
        "cleanup resource needs explicit disposition: " + resource.id,
      );
  }
  flow.rec.cleanup.status = "complete";
  if (!flow.rec.workflow.some((s: RecordData) => s.id === "retrospective"))
    flow.rec.workflow.splice(-1, 0, {
      id: "retrospective",
      description:
        "Review outcome, decisions, tokens/turns, lessons and intake/prevalidation improvements.",
    });
  projects.update_status(flow.rec, {
    workflow_step: "retrospective",
    status: "pending",
    criterion: "",
    owner: "project-manager",
    reason: "Accepted, integrated and cleaned up; retrospective review due",
  });
  flow.event(
    "Acceptance, integration and retirement verified; entering retrospective.",
    "cleanup",
    undefined,
    undefined,
    flow.rec.cleanup.evidence,
  );
  flow.save();
  flow.retrospective();
}
export function retrospective(flow: RecordData) {
  const record = retrospective_record.prepare(flow.rec, flow.home);
  flow.save();
  if (record.state === "complete") {
    projects.archive_completed(flow.home, flow.rec);
    return;
  }
  if (record.findings && Object.keys(record.findings).length) {
    const conclusion = (record.owner_conclusion ??= {
      owner: flow.rec.identity.submitted_by,
      state: "pending",
    });
    if (!conclusion.request) {
      const mid = flow.message(
        "owner-conclusion",
        conclusion.owner,
        retrospective_record.OWNER_CONCLUSION_REQUEST,
        retrospective_record.record_path(flow.rec, flow.home),
      );
      Object.assign(conclusion, {
        state: "requested",
        request: mid,
        requested_at: utc(),
      });
      retrospective_record.write(record, flow.home);
      flow.save();
    }
    const mailbox = join(flow.home, "mail/project-manager");
    for (const folder of ["read", "new"]) {
      const dir = join(mailbox, folder);
      for (const name of existsSync(dir)
        ? readdirSync(dir)
            .filter((n) => n.endsWith(".json"))
            .sort()
            .reverse()
        : []) {
        const message = read(join(dir, name), {});
        if (
          message.from !== conclusion.owner ||
          message.reply_to !== conclusion.request ||
          message.kind !== "done"
        )
          continue;
        for (const document of retrospective_record.conclusion_documents(
          message,
          flow.home,
          flow.manager.project,
        )) {
          retrospective_record.attach_owner_conclusion(
            flow.rec,
            flow.home,
            document,
          );
          flow.save();
          projects.archive_completed(flow.home, flow.rec);
          return;
        }
      }
    }
    return;
  }
  flow.message(
    "retrospective-review",
    "project-manager",
    "Retrospective ready. Write topic-focused per-step outcomes, causes and corrections; no human names, approval/permission narrative or personal blame. Submit via work retrospective " +
      flow.manager.project +
      " --file FILE. Read retrospective guidance in worker CLI.",
    record.report,
  );
  flow.save();
}
