import {sample_shared} from './project_shared_usage.js';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RecordData } from "./common.js";
import { runtime_ports, type NativePorts } from "./project_runtime_ports.js";
export function native_usage(
  worker: RecordData,
  ports: NativePorts = runtime_ports(),
): [string, RecordData] | null {
  const fork = worker.fork || {};
  if (!fork.session) return null;
  const path = ports.session_file(fork.runtime, fork.session);
  if (!path) return null;
  const raw = ports.usage(fork.runtime, path).tokens;
  if (!raw || !Object.keys(raw).length) return null;
  const cached = raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? 0;
  let input = raw.input_tokens || 0;
  if (fork.runtime === "claude")
    input += cached + (raw.cache_creation_input_tokens || 0);
  return [
    fork.session,
    { input, output: raw.output_tokens || 0, cached_input: cached },
  ];
}
export function sample(
  rec: RecordData,
  home: string,
  reader: (worker: RecordData) => [string, RecordData] | null = native_usage,
): void {
  const folder = join(
      home,
      "projects",
      rec.identity.key.replace(/^project\./, ""),
    ),
    path = join(folder, "token-usage.json");
  const state: RecordData = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { workers: {}, criteria: {} };
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    stages = (state.stages ??= {}),
    history = rec.status || [],
    current = Array.isArray(history) ? history[0] : history,
    stage = current?.workflow_step ?? null,
    boundary = current?.timestamp ?? null;
  const criteria: RecordData = Object.fromEntries(
    (rec.acceptance_criteria || []).map((c: RecordData) => [c.id, c]),
  );
  for (const worker of rec.workers || []) {
    const wid = worker.id,
      events = (rec.events || []).filter(
        (e: RecordData) => e.actor === wid && criteria[e.criterion] && e.status,
      ),
      latest = events.at(-1) || {};
    let active = ["in progress", "blocked"].includes(latest.status)
      ? latest.criterion
      : null;
    if ("track" in worker) active = worker.track.active || null;
    let reading;
    try {
      reading = reader(worker);
    } catch {
      reading = null;
    }
    if (!reading) {
      delete state.workers[wid];
      continue;
    }
    const [session, counts] = reading,
      before = state.workers[wid];
    if (
      before &&
      before.session === session &&
      Object.keys(counts).every((k) => counts[k] >= before.counts[k])
    ) {
      const sid =
        before.stage === stage && before.boundary === boundary
          ? stage
          : "unattributed";
      if (sid) {
        const total = (stages[sid] ??= {
          input: 0,
          output: 0,
          cached_input: 0,
          since: before.at,
          partial: true,
        });
        for (const k of Object.keys(counts))
          total[k] += counts[k] - before.counts[k];
        total.observed_at = now;
      }
      const cid = before.active;
      if (criteria[cid]?.worker === wid) {
        const total = (state.criteria[cid] ??= {
          input: 0,
          output: 0,
          cached_input: 0,
          since: before.at,
          partial: true,
        });
        for (const k of Object.keys(counts))
          total[k] += counts[k] - before.counts[k];
        total.observed_at = now;
      }
    }
    if (active && !state.criteria[active])
      state.criteria[active] = {
        input: 0,
        output: 0,
        cached_input: 0,
        since: now,
        observed_at: now,
        partial: true,
      };
    state.workers[wid] = {
      session,
      counts,
      active,
      at: now,
      stage: stage ?? null,
      boundary: boundary ?? null,
    };
  }
  sample_shared(rec, home, state, now);
  for (const [cid, usage] of Object.entries(state.criteria))
    if (criteria[cid]) criteria[cid].token_usage = { ...(usage as RecordData) };
  for (const step of rec.workflow || [])
    if (stages[step.id]) step.token_usage = { ...stages[step.id] };
  if (stages.unattributed)
    rec.unattributed_token_usage = { ...stages.unattributed };
  mkdirSync(folder, { recursive: true });
  const tmp = path + "." + randomUUID().replaceAll("-", "") + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
export function policy(path: string): RecordData {
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const key of [
    "root_review_uncached_tokens_per_ac",
    "compact_uncached_tokens_per_worker",
    "worker_update_seconds",
    "experiment_budget_seconds",
  ])
    if (!Number.isInteger(data[key]) || data[key] <= 0)
      throw Error("positive token interval required: " + key);
  return data;
}
