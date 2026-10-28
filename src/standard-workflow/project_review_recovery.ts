import { readFileSync, statSync, globSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { idle } from "./project_context.js";
import type { RecordData } from "./common.js";
export function session_file(runtime: string, sid: string): string | undefined {
  if (!sid || !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(sid)) return;
  let paths: string[] = [];
  if (runtime === "codex") {
    const base = process.env.CODEX_HOME || join(homedir(), ".codex");
    paths = [
      ...globSync(join(base, "sessions", `**/*${sid}.jsonl`)),
      ...globSync(join(base, "archived_sessions", `*${sid}.jsonl`)),
    ];
  } else if (runtime === "claude") {
    const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    paths = globSync(join(base, "projects", "*", `${sid}.jsonl`));
  }
  return paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
export function observe(
  home: string,
  _root: string,
  name: string,
): [string, string] {
  const config =
      JSON.parse(readFileSync(join(home, "agents.json"), "utf8"))[name] || {},
    runtime = config.runtime,
    session = config.session;
  if (
    config.handoff_pause ||
    !session ||
    !["claude", "codex"].includes(runtime)
  )
    return ["unknown", "Missing binding or explicit handoff pause"];
  const path = session_file(runtime, session);
  if (!path) return ["unknown", "Native session transcript unavailable"];
  if (!idle(path, runtime)) {
    if (Date.now() / 1000 - statSync(path).mtimeMs / 1000 < 180)
      return [
        "active",
        "Recent native activity; review may be running or queued",
      ];
    return [
      "unknown",
      "No completed native turn and no recent activity; inspect before resuming",
    ];
  }
  const socket = config.tmux_socket || "agent-" + name,
    alive =
      spawnSync("tmux", ["-L", socket, "has-session", "-t", config.tmux_terminal || "agent-" + name])
        .status === 0;
  return [alive ? "idle" : "absent", "Exact bound session is idle"];
}
export function recover(
  flow: RecordData,
  c: RecordData,
  now = Date.now() / 1000,
  observation?: [string, string],
): boolean {
  const review = c.token_review || {};
  if (review.state !== "reviewing") return false;
  const cid = c.id,
    key =
      "token-root-turns-v2-" +
      cid +
      "-" +
      review.threshold +
      (review.course_correction ? "-scope" : "") +
      "-" +
      review.root,
    sent = flow.state.sent[key];
  if (!sent || now - sent.at < 600) return false;
  const state = ((flow.state.review_recovery ??= {})[key] ??= {});
  if ((state.checked_at || 0) + 60 > now) return true;
  state.checked_at = now;
  const [kind, reason] =
    observation || observe(flow.home, flow.root, review.root);
  if (state.observation !== kind) {
    flow.event(
      `${cid}: review recovery: ${review.root}: ${reason}.`,
      "worker",
      undefined,
      cid,
    );
    state.observation = kind;
  }
  if (kind === "active") {
    flow.save();
    return true;
  }
  if (state.retried_at) {
    if (now - state.retried_at >= 600)
      flow.message(
        "review-recovery-escalate-" + key,
        "project-manager",
        `${cid}: review still unanswered ten minutes after retry. Reviewer ${review.root}: ${reason}. Original request ${sent.message}; worker remains held.`,
      );
    flow.save();
    return true;
  }
  if (kind === "unknown") {
    flow.message(
      "review-recovery-inspect-" + key,
      "project-manager",
      `${cid}: cannot safely recover reviewer ${review.root}: ${reason}. Inspect existing session; do not fork or release worker.`,
    );
    flow.save();
    return true;
  }
  try {
    if (kind === "absent")
      flow.manager.mail("launch", review.root, "--no-windows");
    const packet = join(
      flow.manager.folder,
      "token-reviews",
      `${cid}-${review.threshold}-request.yaml`,
    );
    const mid = flow.manager.mail(
      "send",
      review.root,
      "task",
      "--reply-to",
      sent.message,
      "--ref",
      flow.rec.identity.key,
      "--see",
      packet,
      "--summary",
      `Retry existing ${cid} review at ${review.threshold} tokens; no response recorded. Use the same packet and work token-review response. No new review cycle; worker remains paused.`,
    );
    Object.assign(state, { retried_at: now, message: mid, cause: kind });
    flow.save();
    flow.manager.mail("deliver", review.root, "--delay", "0");
    flow.event(
      `${cid}: retried existing review ${sent.message} for ${review.root}; cause: ${kind}. Same packet and threshold; escalation in ten minutes without response.`,
      "worker",
      undefined,
      cid,
    );
  } catch (error) {
    flow.message(
      "review-recovery-error-" + key,
      "project-manager",
      `${cid}: review recovery failed: ${(error as Error).message}. Worker remains held.`,
    );
  }
  flow.save();
  return true;
}
