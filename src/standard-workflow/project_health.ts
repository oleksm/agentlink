import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { epoch, type RecordData } from "./common.js";
import {
  expanded,
  now as clock,
  runtime_ports,
  type NativePorts,
} from "./project_runtime_ports.js";
import * as jobs from "./project_jobs.js";
export { epoch };
export const iso = (value: number) =>
  value
    ? new Date(value * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00")
    : "";
export function process(pid: number, proc_root = "/proc"): RecordData | null {
  try {
    const text = readFileSync(
        join(proc_root, String(Math.trunc(pid)), "stat"),
        "utf8",
      ),
      fields = text
        .slice(text.lastIndexOf(") ") + 2)
        .trim()
        .split(/\s+/);
    if (fields.length < 20) return null;
    return {
      pid: Math.trunc(pid),
      start: fields[19],
      cpu: Number(fields[11]) + Number(fields[12]),
    };
  } catch {
    return null;
  }
}
export function checkpoint(
  criterion: RecordData,
  args: RecordData,
  status: string,
  workers: RecordData,
  policy: RecordData = runtime_ports().policy(),
): void {
  const now = clock(),
    info = (criterion.execution ??= {});
  if (args.experiment_budget_minutes != null) {
    const n = args.experiment_budget_minutes;
    if (!Number.isInteger(n) || n < 1 || n > 4)
      throw Error("experiment budget must be 1..4 minutes");
    criterion.experiment_budget_minutes = n;
  }
  if (args.action) info.action = args.action;
  if (args.progress && args.progress !== info.progress)
    Object.assign(info, {
      progress: args.progress,
      last_progress: iso(now),
      failed_attempts: 0,
    });
  const next_step = args.next_checkpoint,
    minutes = args.check_in_minutes;
  if (minutes != null && !(minutes >= 1 && minutes <= 120))
    throw Error("--check-in-minutes must be 1..120");
  const budget = policy.worker_update_seconds;
  if (next_step) {
    info.next_checkpoint = next_step;
    info.checkpoint_due = iso(
      now + (minutes ? Math.min(budget, 60 * minutes) : budget),
    );
  } else if (minutes == null && status === "in progress")
    info.checkpoint_due = iso(now + budget);
  else if (minutes != null)
    throw Error("--check-in-minutes requires --next-checkpoint");
  if (args.waiting_on) {
    if (!(args.waiting_on in workers))
      throw Error("--waiting-on must name a temporary project worker");
    info.waiting_on = args.waiting_on;
  } else if (status !== "blocked") delete info.waiting_on;
  if (args.outcome === "no-progress")
    info.failed_attempts = (info.failed_attempts || 0) + 1;
  if (args.outcome === "progress" && !args.progress)
    throw Error("--outcome progress requires --progress");
  if (args.outcome === "progress") info.recovery_resolved_at = iso(now);
  if (args.job_pid) {
    const p = process(args.job_pid);
    if (!p) throw Error("job PID is not running");
    info.job_pid = args.job_pid;
    info.job_start = p.start;
  }
  if (args.job_log) {
    const path = expanded(args.job_log);
    if (!statSync(path).isFile())
      throw Error("--job-log must be an existing file");
    info.job_log = path;
  }
  info.reported_at = iso(now);
  if (status === "completed") {
    clear_completed(info);
    info.progress = args.detail || "Delivered";
    info.last_progress = iso(now);
  }
}
export function observe(
  worker: RecordData,
  execution: RecordData,
  previous: RecordData,
  home: string,
  ports: NativePorts = runtime_ports(),
): RecordData {
  const now = clock(),
    result: RecordData = {
      alive: false,
      activity: 0,
      job_running: false,
      job_advancing: false,
    },
    config =
      JSON.parse(readFileSync(join(home, "agents.json"), "utf8"))[worker.id] ||
      {},
    sid = worker.fork?.session;
  if (!sid || config.session !== sid) return result;
  const run = spawnSync(
    "tmux",
    ["-L", "agent-" + worker.id, "has-session", "-t", "agent-" + worker.id],
    { timeout: 3000 },
  );
  if (run.error) throw run.error;
  result.alive = run.status === 0;
  const path = ports.session_file(worker.fork.runtime, sid);
  if (path) {
    const raw = readFileSync(path);
    for (const line of raw
      .subarray(Math.max(0, raw.length - 1000000))
      .toString("utf8")
      .split("\n")) {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const tool =
        [
          "function_call",
          "function_call_output",
          "custom_tool_call",
          "custom_tool_call_output",
        ].includes(r.payload?.type) ||
        (Array.isArray(r.message?.content) &&
          r.message.content.some(
            (x: RecordData) =>
              x &&
              typeof x === "object" &&
              ["tool_use", "tool_result"].includes(x.type),
          ));
      if (tool) result.activity = Math.max(result.activity, epoch(r.timestamp));
    }
  }
  result.discovered_jobs = jobs.observe(
    worker,
    config,
    previous.discovered_jobs || [],
    undefined,
    now,
  );
  if (result.discovered_jobs.length) {
    result.job_running = true;
    result.job_advancing = result.discovered_jobs.some(
      (p: RecordData) => p.advancing,
    );
  }
  const job = process(execution.job_pid || 0);
  if (job && job.start === execution.job_start) {
    result.job_running = true;
    result.job_cpu = job.cpu;
    if (job.cpu > (previous.job_cpu ?? job.cpu)) result.job_advancing = true;
  }
  if (execution.job_log) {
    try {
      const stat = statSync(execution.job_log);
      result.log_size = stat.size;
      result.log_mtime = stat.mtimeMs / 1000;
      if (
        result.log_mtime >= now - 900 &&
        (stat.size !== previous.log_size ||
          result.log_mtime !== previous.log_mtime)
      )
        result.job_advancing = true;
    } catch {}
  }
  if (result.job_advancing) result.activity = now;
  result.activity = Math.max(result.activity, previous.activity || 0);
  return result;
}
export function assess(
  criterion: RecordData,
  event: RecordData,
  observation: RecordData,
  now: number,
  stall = 900,
): RecordData {
  const info = criterion.execution || {},
    started = epoch(event.at),
    activity = observation.activity || 0,
    worker_report = event.actor == null || event.actor === criterion.worker,
    reported = epoch(info.reported_at) || (worker_report ? started : 0),
    progress = epoch(info.last_progress),
    waiting = observation.waiting_on || info.waiting_on,
    dependency = observation.dependency || "",
    status = event.status || "not started",
    advancing = observation.job_running && observation.job_advancing,
    recent_activity = activity > 0 && now - activity <= stall,
    recent_report = reported > 0 && now - reported <= stall,
    busy = recent_activity || observation.job_running;
  let state: string, reason: string;
  if (status === "completed") {
    state = criterion.result === "pass" ? "completed" : "waiting";
    reason =
      criterion.result === "pass"
        ? "Accepted"
        : "Delivered; awaiting acceptance";
  } else if (status === "not started") {
    state = "waiting";
    reason = "Awaiting dependencies or dispatch";
  } else if ((waiting || dependency) && !busy) {
    state = "waiting";
    reason =
      "Waiting for " +
      (waiting || dependency) +
      "; recovery belongs to the input producer";
  } else if ((info.failed_attempts || 0) >= 3) {
    state = "stalled";
    reason =
      "Three attempts reported without progress; revise approach with a peer";
  } else if (progress && now - progress > 2 * stall && !advancing) {
    state = "stalled";
    reason = "Activity has not produced a new meaningful-progress report";
  } else if (busy && (waiting || dependency)) {
    state = "working";
    reason =
      "Worker active" +
      (observation.job_running ? "; tracked app/job running" : "") +
      "; peer input still pending from " +
      (waiting || dependency);
  } else if (dependency) {
    state = "waiting";
    reason =
      "Waiting for " + dependency + " to be revalidated by " + String(waiting);
  } else if (waiting) {
    state = "waiting";
    reason = "Waiting on " + waiting;
  } else if (observation.job_running) {
    state = "working";
    reason =
      "Tracked app/job running; meaningful progress monitored separately";
  } else if (status === "blocked" && (recent_activity || recent_report)) {
    state = "working on fix";
    reason =
      "Delivery is blocked, but its worker has recent activity; progress is tracked separately";
  } else if (now - Math.max(activity, reported, started) > stall) {
    state = "unresponsive";
    reason =
      "No recent tool activity, advancing job output or progress report observed";
  } else if (status === "blocked") {
    state = "waiting";
    reason = "Awaiting worker checkpoint after the blocker";
  } else if (now - (progress || reported || started) > 2 * stall) {
    state = "stalled";
    reason = "Activity continues without a recent meaningful-progress report";
  } else {
    state = "working";
    reason = "Recent tool activity or worker progress report";
  }
  const discovered = observation.discovered_jobs || [];
  if (discovered.length)
    reason +=
      "; observed jobs: " +
      [...new Set(discovered.map((p: RecordData) => p.name))]
        .sort()
        .join(", ") +
      (discovered.some((p: RecordData) => p.advancing)
        ? " (CPU advancing)"
        : " (progress not yet observed)");
  return {
    state,
    reason,
    observed_at: iso(now),
    last_activity: iso(activity),
    last_progress: iso(progress),
    progress: info.progress || "",
    action: info.action || (event.detail || "").slice(0, 120),
    next_checkpoint: info.next_checkpoint || "",
    checkpoint_due: info.checkpoint_due || "",
    waiting_on: waiting || "",
    dependency,
  };
}
export function update_budget_due(
  criterion: RecordData,
  event: RecordData,
  now: number,
  last_notice = 0,
  policy: RecordData = runtime_ports().policy(),
): boolean {
  const info = criterion.execution || {},
    budget = policy.worker_update_seconds;
  if (!["in progress", "blocked"].includes(event.status) || info.paused)
    return false;
  if (
    ["pause requested", "reviewing", "hold"].includes(
      criterion.token_review?.state,
    )
  )
    return false;
  if (event.status === "blocked" && (info.waiting_on || info.waiting_for))
    return false;
  const reported = epoch(info.reported_at) || epoch(event.at);
  return !!reported && now - reported >= budget && now - last_notice >= budget;
}
export function delivery_wait(
  criterion: RecordData,
  pending: string[],
  maintaining = false,
): RecordData | null {
  if (criterion.token_review?.state === "hold")
    return {
      state: "paused",
      reason: "Scope/review hold: " + (criterion.token_review.guidance || ""),
      observed_at: iso(clock()),
    };
  if (maintaining)
    return {
      state: "waiting",
      reason: pending.length
        ? "Waiting for dependencies: " + pending.join(", ")
        : "Workflow preparing next action",
      observed_at: iso(clock()),
    };
  return null;
}
export function clear_completed(info: RecordData): void {
  for (const key of [
    "action",
    "next_checkpoint",
    "checkpoint_due",
    "waiting_on",
    "waiting_for",
    "job_pid",
    "job_start",
    "job_log",
    "paused_for_return",
    "pause_reason",
    "paused_at",
  ])
    delete info[key];
  info.paused = false;
}
export function delivered_health(
  criterion: RecordData,
  event: RecordData,
  gaps: string[] = [],
): RecordData {
  const info = (criterion.execution ??= {});
  clear_completed(info);
  const summary = event.detail || "Delivered";
  info.progress = summary;
  info.last_progress = event.at ?? info.reported_at ?? "";
  return {
    state: gaps.length || criterion.result !== "pass" ? "waiting" : "completed",
    reason: gaps.length
      ? "Delivered — revalidation needed: " + gaps.join("; ")
      : criterion.result === "pass"
        ? "Accepted"
        : "Delivered; awaiting acceptance",
    observed_at: iso(clock()),
    progress: summary,
    last_progress: info.last_progress,
  };
}
