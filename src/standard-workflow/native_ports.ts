/** Native provider transcript observations. */
import { jsonlRows } from "../jsonl.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { session_file } from "./project_review_recovery.js";
import { policy as read_policy } from "./project_usage.js";
import type { NativePorts } from "./project_runtime_ports.js";
import type { RecordData } from "./common.js";
export function usage(runtime: string, path: string): RecordData {
  const result: RecordData = {
      source: path || null,
      tokens: null,
      limits: null,
    },
    responses = new Map<any, RecordData>();
  if (path)
    for (const r of jsonlRows(path)) {
      if (runtime === "codex") {
        const p = r.payload || {};
        if (r.type === "event_msg" && p.type === "token_count") {
          const info = p.info || {};
          if (
            info.total_token_usage &&
            Object.keys(info.total_token_usage).length
          )
            result.tokens = info.total_token_usage;
          if (p.rate_limits && Object.keys(p.rate_limits).length) {
            result.limits = p.rate_limits;
            result.limits_observed_at = r.timestamp ?? null;
          }
        }
      } else if (r.type === "assistant") {
        const m = r.message || {},
          key = m.id || r.requestId || r.uuid;
        if (!m.usage || !Object.keys(m.usage).length) continue;
        const response = responses.get(key) || {};
        for (const k of [
          "input_tokens",
          "output_tokens",
          "cache_read_input_tokens",
          "cache_creation_input_tokens",
        ])
          response[k] = Math.max(response[k] || 0, m.usage[k] || 0);
        responses.set(key, response);
      }
    }
  const totals: RecordData = {};
  for (const response of responses.values())
    for (const [k, v] of Object.entries(response))
      totals[k] = (totals[k] || 0) + v;
  if (Object.keys(totals).length) result.tokens = totals;
  return result;
}
export const DEFAULT_POLICY = {
  root_review_uncached_tokens_per_ac: 100000,
  compact_uncached_tokens_per_worker: 100000,
  worker_update_seconds: 180,
  experiment_budget_seconds: 180,
  token_reviewer: "requestor-root",
};
export function make_native_ports(home: string): NativePorts {
  return {
    session_file: (runtime, session) => session_file(runtime, session) || null,
    usage,
    policy: () => {
      const path = join(home, "workflow-policy.json");
      return existsSync(path) ? read_policy(path) : { ...DEFAULT_POLICY };
    },
  };
}
