import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { RecordData } from "./common.js";
import { process as inspect_process } from "./project_health.js";
export function inspect(
  execution: RecordData,
  previous: RecordData,
  now = performance.now() / 1000,
): RecordData | null {
  const proc = inspect_process(execution.job_pid || 0);
  if (!proc || proc.start !== execution.job_start) return null;
  let log: [number, number] | null = null;
  try {
    if (execution.job_log) {
      const s = statSync(execution.job_log, { bigint: true });
      log = [Number(s.size), Number(s.mtimeNs)];
    }
  } catch {}
  const identity = (proc.pid || execution.job_pid) + ":" + proc.start,
    fresh =
      previous.identity !== identity || now < (previous.observed_at ?? now),
    advancing =
      fresh ||
      proc.cpu > (previous.cpu ?? proc.cpu) ||
      JSON.stringify(log) !== JSON.stringify(previous.log ?? null),
    progress_at = advancing ? now : (previous.progress_at ?? now);
  return {
    identity,
    cpu: proc.cpu,
    log,
    observed_at: now,
    progress_at,
    stalled: now - progress_at >= 600,
  };
}
