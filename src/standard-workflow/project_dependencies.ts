import { active_criteria, delivery, type RecordData } from "./common.js";
export function cycles(rec: RecordData, steps: RecordData): string[][] {
  const criteria = Object.fromEntries(
      active_criteria(rec).map((c) => [c.id, c]),
    ),
    by_step = Object.fromEntries(
      Object.values(criteria).map((c: any) => [c.step, c.id]),
    ),
    graph: Record<string, Set<string>> = {};
  for (const cid of Object.keys(criteria))
    if (delivery(rec, cid).status !== "completed") graph[cid] = new Set();
  const choices: Array<[string, string[]]> = [],
    requests = Object.fromEntries(
      (rec.peer_requests || []).map((q: RecordData) => [q.id, q]),
    );
  for (const cid of Object.keys(graph)) {
    const c = criteria[cid]!,
      step = steps[c.step] || {},
      deps = (step.depends_on || [])
        .filter((d: string) => d in by_step)
        .map((d: string) => by_step[d]);
    if (c.execution?.waiting_for) deps.push(c.execution.waiting_for);
    const review = c.token_review || {};
    if (review.state === "hold") {
      deps.push(...(review.release_after || []));
      const release = review.release_requests || {},
        targets: string[] = [];
      let alternative_available = false;
      for (const ident of release.requests || []) {
        const q = requests[ident] || {},
          target = q.owner_criterion;
        if (
          ["verified", "delivered"].includes(q.state) ||
          criteria[target]?.token_review?.state !== "hold"
        ) {
          alternative_available = true;
          continue;
        }
        if (target in graph) targets.push(target);
      }
      if (release.mode === "all") deps.push(...targets);
      else if (targets.length && !alternative_available)
        choices.push([cid, targets]);
    }
    for (const dep of deps) if (dep in graph) graph[cid]!.add(dep);
  }
  const reaches = (
    start: string,
    target: string,
    seen = new Set<string>(),
  ): boolean => {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    return [...(graph[start] || [])].some((d) => reaches(d, target, seen));
  };
  for (const [cid, targets] of choices)
    if (targets.every((t) => reaches(t, cid)))
      for (const t of targets) graph[cid]!.add(t);
  const found = new Map<string, string[]>();
  const visit = (node: string, path: string[]) => {
    if (path.includes(node)) {
      const cycle = path.slice(path.indexOf(node)).sort();
      found.set(jsonKey(cycle), cycle);
      return;
    }
    for (const dep of graph[node]!) visit(dep, [...path, node]);
  };
  for (const node of Object.keys(graph)) visit(node, []);
  return [...found.values()].sort((a, b) =>
    jsonKey(a).localeCompare(jsonKey(b)),
  );
}
const jsonKey = (a: string[]) => JSON.stringify(a);
export function waiting(
  rec: RecordData,
  c: RecordData,
  steps: RecordData,
): string[] {
  const by_step = Object.fromEntries(
      active_criteria(rec).map((x) => [x.step, x.id]),
    ),
    pending: string[] = [];
  for (const dep of steps[c.step]?.depends_on || []) {
    const cid = by_step[dep];
    if (cid && delivery(rec, cid).status !== "completed") pending.push(cid);
  }
  const cid = c.execution?.waiting_for;
  if (cid && delivery(rec, cid).status !== "completed") pending.push(cid);
  for (const q of rec.peer_requests || [])
    if (q.criterion === c.id && !["verified", "cancelled"].includes(q.state))
      pending.push(q.id);
  return [...new Set(pending)].sort();
}
