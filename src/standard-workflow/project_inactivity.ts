import { epoch, json_sorted, type RecordData } from "./common.js";
export function last_activity(rec: RecordData): number {
  let latest = 0;
  const seen = new Set<string>();
  for (const event of [...(rec.events || [])].sort(
    (a, b) => epoch(a.at) - epoch(b.at),
  )) {
    const detail = event.detail || "";
    if (
      event.actor === "project-manager" &&
      (event.kind === "worker" || detail.includes("PROJECT INACTIVITY ALARM:"))
    )
      continue;
    const signature = json_sorted(
      Object.fromEntries(
        [
          "actor",
          "kind",
          "criterion",
          "worker",
          "status",
          "detail",
          "evidence",
        ].map((k) => [k, event[k] ?? null]),
      ),
    );
    if (seen.has(signature)) continue;
    seen.add(signature);
    latest = Math.max(latest, epoch(event.at));
  }
  const states = new Map();
  for (const row of [...(Array.isArray(rec.status) ? rec.status : [])].sort(
    (a, b) => epoch(a.timestamp) - epoch(b.timestamp),
  )) {
    const key = json_sorted([row.workflow_step ?? null, row.criterion ?? ""]),
      state = json_sorted([
        row.status ?? null,
        row.owner ?? null,
        row.reason ?? null,
      ]);
    if (states.get(key) === state) continue;
    states.set(key, state);
    latest = Math.max(latest, epoch(row.timestamp));
  }
  return latest;
}
