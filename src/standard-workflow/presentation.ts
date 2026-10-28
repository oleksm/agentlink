import { assess } from "./project_coverage.js";
/** Direct presentation port. Standard records and field names remain unchanged. */
type Row = Record<string, any>;
export type CoverageAssessment = Array<Row>;
const esc = (v: unknown): string =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[c]!,
  );
const minimum = (values: string[]) =>
  values.length ? [...values].sort()[0]! : null;
export function status_history(rec: Row): Row[] {
  const status = rec.status ?? [];
  if (Array.isArray(status)) return status;
  if (status && typeof status === "object") {
    const owner =
      (rec.acceptance_criteria ?? []).find(
        (c: Row) => c.id === status.criterion,
      )?.acceptance_owner ??
      rec.identity?.manager ??
      "";
    return [{ ...status, owner: status.owner ?? owner }];
  }
  return [];
}
export function short_reason(detail: string): string {
  const text =
    detail
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .split(/(?<=[.!?])\s+/, 1)[0] ?? "";
  if (text.length <= 120) return text;
  const prefix = text.slice(0, 117),
    last = prefix.lastIndexOf(" ");
  return (last < 0 ? prefix : prefix.slice(0, last)) + "…";
}
export function archived_record_keys(records: Row[]): Set<string> {
  const byKey = new Map(records.map((r) => [r.identity.key, r]));
  const projects = [...byKey.entries()]
    .filter(([key]) => key.startsWith("project."))
    .map(([, r]) => r);
  const archived = new Set<string>();
  for (const r of projects) {
    const latest = status_history(r)[0] ?? {},
      retro = byKey.get(r.retrospective) ?? {};
    if (
      (r.file ?? "").includes("/closed-projects/") ||
      (latest.workflow_step === "retrospective" &&
        latest.status === "completed" &&
        r.cleanup?.status === "complete" &&
        retro.state === "complete")
    )
      archived.add(r.identity.key);
  }
  const activeIntakes = new Set(
    projects.filter((r) => !archived.has(r.identity.key)).map((r) => r.intake),
  );
  for (const r of projects)
    if (archived.has(r.identity.key)) {
      if (!activeIntakes.has(r.intake) && byKey.has(r.intake))
        archived.add(r.intake);
      if (byKey.has(r.retrospective)) archived.add(r.retrospective);
    }
  for (const [key, r] of byKey)
    if (key.startsWith("retrospective.") && archived.has(r.project))
      archived.add(key);
  return archived;
}
export function archive_registers(data: Row): void {
  const kinds = ["intakes", "retrospectives", "projects"];
  const registers = data.registers
    .filter((r: Row) => r.root === "DevProjects" && kinds.includes(r.kind))
    .sort((a: Row, b: Row) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  for (const register of registers) {
    const previous =
      data.registers.find((r: Row) => r.kind === "archived-" + register.kind) ??
      {};
    register.records = [
      ...new Map(
        [...(previous.records ?? []), ...register.records].map((r: Row) => [
          r.identity.key,
          r,
        ]),
      ).values(),
    ];
  }
  const archived = archived_record_keys(
    registers.flatMap((r: Row) => r.records),
  );
  data.registers = data.registers.filter(
    (r: Row) => r.kind !== "closed-projects" && !r.archive,
  );
  const titles: Row = {
    intakes: "Intake",
    retrospectives: "Retrospective",
    projects: "Projects",
  };
  for (const register of registers) {
    const rows = register.records;
    register.records = rows.filter((r: Row) => !archived.has(r.identity.key));
    data.registers.push({
      ...register,
      kind: "archived-" + register.kind,
      record_kind: register.kind,
      title: titles[register.kind],
      archive: true,
      records: rows.filter((r: Row) => archived.has(r.identity.key)),
    });
  }
}
export function status_summary(rec: Row, observations: Row = {}): Row[] {
  const history = status_history(rec),
    workflow: Row[] = rec.workflow ?? [],
    current = history[0] ?? {};
  const positions = new Map(workflow.map((step, i) => [step.id, i])),
    position = positions.get(current.workflow_step) ?? -1;
  const groups: Record<string, Row[]> = Object.fromEntries(
    workflow.map((step) => [step.id, []]),
  );
  for (const criterion of rec.acceptance_criteria ?? []) {
    const cid = criterion.id,
      rows = history.filter((row) => row.criterion === cid),
      events = (rec.events ?? []).filter(
        (e: Row) => e.criterion === cid && e.status,
      ),
      latest = events.at(-1) ?? rows[0] ?? {};
    if (criterion.requestor_review) continue;
    const result = criterion.result ?? "pending";
    let state =
      result === "pass"
        ? "completed"
        : result === "fail"
          ? "blocked"
          : (latest.status ?? "not started");
    if (state === "completed" && result !== "pass") state = "acceptance";
    const acceptance =
      result === "pass"
        ? "accepted"
        : state === "completed"
          ? "acceptance pending"
          : "";
    (groups.active ??= []).push({
      id: cid,
      name: observations.labels?.[cid] ?? criterion.step ?? cid,
      status: state,
      acceptance,
      token_usage: criterion.token_usage ?? null,
      token_total: observations.criteria?.[cid] ?? null,
      health: criterion.health ?? {},
      owner:
        criterion.worker ||
        latest.actor ||
        latest.owner ||
        criterion.acceptance_owner ||
        "",
    });
  }
  const workflowRollup = (states: string[]) =>
    states.every((x) => x === "completed")
      ? "completed"
      : states.every((x) => ["acceptance", "completed"].includes(x))
        ? "acceptance"
        : states.some((x) => x !== "not started")
          ? "in progress"
          : "not started";
  const rollup = (states: string[]) =>
    states.includes("blocked") ? "blocked" : workflowRollup(states);
  function stateSince(ids: Set<string>, expected: string, parent = false) {
    let timeline: Array<[string, string, string]> = history
      .toReversed()
      .filter((row) => ids.has(row.criterion))
      .map((row) => [row.timestamp, row.criterion, row.status]);
    const known = new Set(timeline.map((row) => row[1]));
    timeline.push(
      ...(rec.events ?? [])
        .filter((e: Row) => ids.has(e.criterion) && !known.has(e.criterion))
        .map(
          (e: Row) =>
            [
              e.at,
              e.criterion,
              e.status === "completed" && (e.actor ?? "").startsWith("worker-")
                ? "acceptance"
                : e.status,
            ] as [string, string, string],
        ),
    );
    timeline = timeline
      .filter((row) => row[0] && row[2])
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
    const states: Record<string, string> = Object.fromEntries(
      [...ids].map((id) => [id, "not started"]),
    );
    let previous = "not started",
      since: string | null = null;
    for (const [at, cid, status] of timeline) {
      states[cid] = status;
      const state = (parent ? workflowRollup : rollup)(Object.values(states));
      if (state !== previous) {
        since = at;
        previous = state;
      }
    }
    return previous === expected ? since : null;
  }
  return workflow.map((step, index) => {
    const sid = step.id,
      criteria = groups[sid] ?? [],
      latest = history.find((row) => row.workflow_step === sid);
    let state =
      sid === current.workflow_step
        ? (current.status ?? "not started")
        : latest && ["bypassed", "fail"].includes(latest.status)
          ? latest.status
          : sid !== "cancelled" && index < position
            ? "completed"
            : (latest?.status ?? "not started");
    let parentStatus: Row | undefined;
    if (criteria.length) {
      state = workflowRollup(criteria.map((c) => c.status));
      parentStatus = history.find(
        (row) => row.workflow_step === sid && !row.criterion,
      );
      if (parentStatus?.status === "blocked") state = "blocked";
    }
    if (
      sid === "active" &&
      state === "completed" &&
      (rec.acceptance_criteria ?? []).some((c: Row) => c.result !== "pass")
    )
      state = "in progress";
    if (sid === "merging" && rec.products?.length) {
      const merges = rec.products.map((p: Row) => p.merge.status);
      if (merges.every((v: string) => v === "not-required")) state = "bypassed";
      else if (
        merges.every((v: string) => ["merged", "not-required"].includes(v))
      )
        state = "completed";
      else if (state === "completed") state = "blocked";
    }
    let timestamp: string | null = null;
    if (criteria.length) {
      timestamp = stateSince(new Set(criteria.map((c) => c.id)), state, true);
      if (parentStatus && parentStatus.status === state)
        timestamp = parentStatus.timestamp ?? null;
      for (const c of criteria)
        c.timestamp = stateSince(new Set([c.id]), c.status);
    } else {
      for (const row of history.filter((row) => row.workflow_step === sid)) {
        if (row.status !== state) break;
        if (row.timestamp) timestamp = row.timestamp;
      }
      if (!timestamp && state === "completed")
        timestamp = minimum(
          history
            .filter(
              (row) =>
                row.timestamp &&
                row.workflow_step !== "cancelled" &&
                (positions.get(row.workflow_step) ?? -1) > index,
            )
            .map((row) => row.timestamp),
        );
    }
    if (sid === "validating" && state === "not started") {
      const reports = (rec.coverage ?? []).flatMap(
        (row: Row) => row.reports ?? [],
      );
      if (reports.length) {
        state = "in progress";
        timestamp = minimum(reports.map((r: Row) => r.at));
      }
    }
    return { id: sid, status: state, timestamp, criteria };
  });
}
export function status_badge(status: string): string {
  const classes: Row = {
    "in progress": "in-progress",
    completed: "completed",
    blocked: "blocked",
    acceptance: "acceptance",
    "not started": "not-started",
    fail: "blocked",
    bypassed: "not-started",
    deferred: "not-started",
  };
  return `<span class="status-badge ${classes[status] ?? "not-started"}">${esc(status)}</span>`;
}
export function owner_label(owner: string, observations: Row = {}): string {
  return `<span title="${esc(owner)}">${esc(observations.owners?.[owner] ?? owner)}</span>`;
}
export function tokens_html(criteria: Row[]): string {
  const totals = criteria
      .filter((c) => c.token_total != null)
      .map((c) => c.token_total as number),
    fmt = (v: number) => v.toLocaleString("en-US");
  if (totals.length) {
    const sum = totals.reduce((a, b) => a + b, 0);
    return `<span title="Recorded token spend: ${fmt(sum)}; input/output split unavailable">${(sum / 1000000).toFixed(1)}M</span>`;
  }
  const known = criteria.filter((c) => c.token_usage).map((c) => c.token_usage);
  if (!known.length) return "";
  const outputs = known.reduce((n, u) => n + u.output, 0),
    cached = known.reduce((n, u) => n + u.cached_input, 0),
    inputs = Math.max(0, known.reduce((n, u) => n + u.input, 0) - cached);
  let title = `Uncached input: ${fmt(inputs)}; output: ${fmt(outputs)}. Cached input excluded: ${fmt(cached)}. Observed since ${minimum(known.map((u) => u.since))}.`;
  if (known.length !== criteria.length || known.some((u) => u.partial))
    title += " Partial: earlier or unattributed usage is excluded.";
  return `<span title="${esc(title)}">${((inputs + outputs) / 1000000).toFixed(1)}M</span>`;
}
export function health_html(health: Row): string {
  if (!health || !Object.keys(health).length) return "";
  const colors: Row = {
    working: "in-progress",
    "working on fix": "in-progress",
    waiting: "not-started",
    stalled: "blocked",
    unresponsive: "blocked",
    completed: "completed",
  };
  return `<span class="status-badge ${colors[health.state] ?? "not-started"}" title="${esc(health.reason ?? "")}">${esc(health.state ?? "")}</span>`;
}
export function time_html(
  value: unknown,
  elapsed = false,
  mode?: string,
): string {
  return value
    ? `<time datetime="${esc(value)}" data-project-time="${mode ?? (elapsed ? "elapsed" : "local")}"></time>`
    : "";
}
export function validation_work_rows(
  rec: Row,
  assessment: CoverageAssessment = assess(rec),
): Row[] {
  if (!rec.coverage?.length) return [];
  const assessed = new Map(assessment.map((row) => [row.id, row])),
    owners = new Map<string, Row[]>();
  for (const row of rec.coverage) {
    if (!owners.has(row.owner)) owners.set(row.owner, []);
    owners.get(row.owner)!.push(row);
  }
  const result: Row[] = [];
  for (const [owner, rows] of owners) {
    const gaps = rows
        .filter((row) => assessed.get(row.id)?.status !== "evidence ready")
        .map((row) => row.id),
      reports = rows.flatMap((row) => row.reports ?? []),
      latest =
        [...reports].sort((a, b) => String(a.at).localeCompare(b.at)).at(-1) ??
        {};
    const state = !gaps.length
      ? "completed"
      : latest.result === "fail"
        ? "blocked"
        : reports.length
          ? "in progress"
          : "not started";
    let detail = !gaps.length
      ? "Evidence ready for independent review. "
      : "Outstanding outcomes: " + gaps.join(", ") + ". ";
    if (Object.keys(latest).length)
      detail += "Latest report: " + short_reason(latest.finding);
    const last = (rec.events ?? [])
      .filter((e: Row) => e.actor === owner)
      .at(-1);
    if (last && last.kind !== "verification")
      detail += " Last worker action: " + short_reason(last.detail ?? "");
    const ids = new Set(rows.map((row) => row.criterion)),
      criteria = (rec.acceptance_criteria ?? []).filter((c: Row) =>
        ids.has(c.id),
      ),
      health =
        criteria
          .map((c: Row) => c.health ?? {})
          .sort((a: Row, b: Row) =>
            String(a.observed_at ?? "").localeCompare(b.observed_at ?? ""),
          )
          .at(-1) ?? {};
    const seen = new Map<string, string>();
    let previous = "not started",
      since: string | null = null;
    const timeline = rows
      .flatMap((row) =>
        (row.reports ?? []).map((report: Row) => ({
          at: report.at,
          row,
          report,
        })),
      )
      .sort((a, b) => String(a.at).localeCompare(b.at));
    for (const { at, row, report } of timeline) {
      for (const c of report.scope.cases)
        seen.set(JSON.stringify([row.id, c]), report.result);
      const ready = rows.every((outcome) =>
          outcome.required_scope.cases.every(
            (c: string) => seen.get(JSON.stringify([outcome.id, c])) === "pass",
          ),
        ),
        observed = ready
          ? "completed"
          : report.result === "fail"
            ? "blocked"
            : "in progress";
      if (observed !== previous) {
        since = at;
        previous = observed;
      }
    }
    if (previous !== state) since = null;
    result.push({
      name: "Validation preparation",
      status: state,
      health,
      owner,
      timestamp: since,
      usage:
        '<span title="Associated AC totals, including implementation; validation-only usage is not separately attributed">' +
        tokens_html(criteria) +
        "</span>",
      detail,
    });
  }
  const root = rec.identity.submitted_by,
    reviewIds = new Set(
      (rec.acceptance_criteria ?? [])
        .filter((c: Row) => c.requestor_review)
        .map((c: Row) => c.id),
    );
  const dispatched = (rec.events ?? []).filter(
      (e: Row) =>
        e.actor === "project-manager" &&
        (e.detail ?? "").startsWith("To " + root + ":") &&
        /Independent final outcome validation|independently validate the complete outcome/.test(
          e.detail,
        ),
    ),
    reviews = (rec.events ?? []).filter(
      (e: Row) => e.actor === root && reviewIds.has(e.criterion) && e.status,
    ),
    last = reviews.at(-1) ?? dispatched.at(-1) ?? {},
    state = last.status ?? (dispatched.length ? "in progress" : "not started"),
    missing = [...assessed.values()]
      .filter((row) => row.status !== "evidence ready")
      .map((row) => row.id);
  const detail = Object.keys(last).length
    ? short_reason(last.detail ?? "")
    : missing.length
      ? "Waiting for coverage: " + missing.join(", ")
      : "Evidence ready; waiting for final-review dispatch and any remaining gates.";
  let since = last.at ?? null;
  for (const e of [...reviews].reverse()) {
    if (e.status !== state) break;
    since = e.at ?? null;
  }
  if (
    state === "in progress" &&
    dispatched.length &&
    reviews.every((e: Row) => e.status === state)
  )
    since = dispatched[0].at;
  let health = {
    state: state === "completed" ? "completed" : "waiting",
    reason: detail,
  };
  if (dispatched.length && state === "in progress")
    health = {
      state: "review requested",
      reason: "Root review dispatched; live activity is not observed here",
    };
  result.push({
    name: "Independent outcome validation",
    status: state,
    health,
    owner: root,
    timestamp: since,
    usage: "",
    detail,
  });
  return result;
}
export function validation_work_html(
  rec: Row,
  rows?: Row[],
  assessment: CoverageAssessment = assess(rec),
): string {
  rows ??= validation_work_rows(rec, assessment);
  if (!rows.length) return "";
  return (
    "<table><thead><tr><th>Work</th><th>Status</th><th>Health</th><th>Owner</th><th>Status changed</th><th>Tokens spent</th><th>Details</th></tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr><td>" +
          esc(row.name) +
          "</td><td>" +
          status_badge(row.status) +
          "</td><td>" +
          health_html(row.health) +
          "</td><td>" +
          esc(row.owner) +
          "</td><td>" +
          time_html(row.timestamp, true) +
          "</td><td>" +
          row.usage +
          "</td><td>" +
          esc(row.detail) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
export function stage_tokens_html(
  rec: Row,
  sid: string,
  observations: Row = {},
): string {
  if (sid in (observations.stages ?? {}))
    return tokens_html([{ token_total: observations.stages[sid] }]);
  const step = (rec.workflow ?? []).find((s: Row) => s.id === sid) ?? {};
  return step.token_usage
    ? tokens_html([step])
    : '<span title="No attributable usage recorded for this stage">Not measured</span>';
}
export function workflow_graph_html(
  rec: Row,
  validationRows?: Row[],
  observations: Row = {},
  assessment: CoverageAssessment = assess(rec),
): string {
  const steps = status_summary(rec, observations);
  let result =
    '<section class="project-workflow"><h2>Workflow</h2><div class="workflow-track" role="group" aria-label="Project workflow">';
  for (const [index, step] of steps
    .filter((s) => s.id !== "cancelled")
    .entries()) {
    if (index)
      result += '<span class="workflow-arrow" aria-label="then">→</span>';
    result += `<div class="workflow-node"><strong>${esc(step.id === "closing" ? "ramp down" : step.id)}</strong>${status_badge(step.status)}`;
    if (step.id in (observations.stages ?? {}))
      result += stage_tokens_html(rec, step.id, observations);
    if (step.id === "validating") {
      const rows = validationRows ?? validation_work_rows(rec, assessment);
      result +=
        '<div class="workflow-criteria">' +
        rows
          .map(
            (row) =>
              '<div class="workflow-criterion"><span>' +
              esc(row.name) +
              '</span><span class="workflow-owner">' +
              esc(row.owner) +
              "</span>" +
              status_badge(row.status) +
              "</div>",
          )
          .join("") +
        "</div>";
    }
    if (step.criteria.length)
      result +=
        '<div class="workflow-criteria">' +
        step.criteria
          .map(
            (c: Row) =>
              `<div class="workflow-criterion"><span>${esc(c.id)} · ${esc(c.name)}</span><span class="workflow-owner">${owner_label(c.owner, observations)}</span><span class="workflow-state" style="display:flex;gap:6px;align-items:center">${status_badge(c.status)}${health_html(c.health)}</span>${tokens_html([c])}</div>`,
          )
          .join("") +
        "</div>";
    result += "</div>";
  }
  result += "</div>";
  for (const step of steps)
    if (step.id === "cancelled")
      result += `<div class="workflow-alternate">Alternate exit: <strong>cancelled</strong> ${status_badge(step.status)}</div>`;
  return result + "</section>";
}
export function status_summary_html(
  rec: Row,
  observations: Row = {},
  assessment: CoverageAssessment = assess(rec),
): string {
  const validationRows = validation_work_rows(rec, assessment);
  let result =
    workflow_graph_html(rec, validationRows, observations, assessment) +
    "<h2>Status</h2><table><thead><tr><th>Workflow</th><th>Status</th><th>Status changed</th><th>Tokens spent</th><th>Details</th></tr></thead><tbody>";
  for (const step of status_summary(rec, observations)) {
    let breakdown = "";
    if (step.id === "validating")
      breakdown = validation_work_html(rec, validationRows);
    if (step.id === "merging") {
      breakdown =
        "<table><tr><th>Product</th><th>Integration</th><th>Details</th></tr>";
      for (const product of rec.products ?? []) {
        const merge = product.merge,
          label = merge.status === "not-required" ? "bypassed" : merge.status,
          detail =
            merge.status === "merged"
              ? (merge.merge_commit ?? "")
              : (merge.reason ?? "");
        breakdown +=
          "<tr><td>" +
          esc(product.id) +
          "</td><td>" +
          status_badge(label) +
          "</td><td>" +
          esc(detail) +
          "</td></tr>";
      }
      breakdown += "</table>";
    }
    if (step.criteria.length) {
      breakdown =
        "<table><thead><tr><th>AC</th><th>Status</th><th>Health</th><th>Owner</th><th>Status changed</th><th>Tokens spent</th></tr></thead><tbody>";
      for (const c of step.criteria) {
        const label = c.id + (c.name !== c.id ? " · " + c.name : "");
        breakdown += `<tr><td>${esc(label)}</td><td>${status_badge(c.status)}</td><td>${health_html(c.health)}</td><td>${owner_label(c.owner, observations)}</td><td>${time_html(c.timestamp, true)}</td><td>${tokens_html([c])}</td></tr>`;
      }
      breakdown += "</tbody></table>";
    }
    result += `<tr><td>${esc(step.id === "closing" ? "ramp down" : step.id)}</td><td>${status_badge(step.status)}</td><td>${time_html(step.timestamp, true)}</td><td>${stage_tokens_html(rec, step.id, observations)}</td><td>${breakdown}</td></tr>`;
  }
  result += "</tbody></table>";
  if (rec.unattributed_token_usage)
    result +=
      "<p>Observed usage across stage/status boundaries (unattributed): " +
      tokens_html([{ token_usage: rec.unattributed_token_usage }]) +
      "</p>";
  return result;
}
export function blockers_newest(rows: Row[]): Row[] {
  const stamp = (r: Row) => {
    const n = Date.parse(String(r.at ?? ""));
    return Number.isFinite(n) ? n : -Infinity;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => stamp(b.r) - stamp(a.r) || b.i - a.i)
    .map((x) => x.r);
}
export function workflow_actions(rec: Row): Row[] {
  const events: Row[] = rec.events ?? [],
    echoes = new Set(
      events
        .filter((e) => e.actor !== "project-manager")
        .map((e) => String(e.criterion ?? "") + ": " + (e.detail ?? "")),
    );
  return blockers_newest(
    events.filter(
      (e) =>
        !(
          e.actor === "project-manager" &&
          e.kind === "decision" &&
          echoes.has(e.detail)
        ),
    ),
  );
}
export function workflow_actions_html(
  rec: Row,
  render: (v: any) => string,
): string {
  let result =
    '<section data-owner-actions data-project="' +
    esc(rec.identity.key.split(".").slice(1).join(".")) +
    '"></section><h2>Workflow Actions</h2><table><thead><tr><th>Time</th><th>AC</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>';
  for (const row of workflow_actions(rec))
    result +=
      "<tr>" +
      [
        time_html(row.at, true),
        render(row.criterion ?? ""),
        render(row.actor ?? ""),
        render(row.kind ?? ""),
        '<details class="workflow-action"><summary><span class="workflow-action-text">' +
          render(row.detail ?? "") +
          '</span><span class="workflow-action-toggle"></span></summary></details>',
      ]
        .map((cell) => "<td>" + cell + "</td>")
        .join("") +
      "</tr>";
  return result + "</tbody></table>";
}
export function coverage_html(rec: Row, render: (v: any) => string): string {
  const observed = new Map(assess(rec).map((r) => [r.id, r]));
  let out =
    "<p>Evidence readiness; final acceptance remains independent.</p><table><tr><th>Outcome</th><th>Owner</th><th>Required scope</th><th>Readiness</th><th>Missing</th><th>Evidence</th></tr>";
  for (const row of rec.coverage ?? []) {
    const state = observed.get(row.id)!;
    out +=
      "<tr>" +
      [
        row.statement,
        row.owner,
        row.required_scope,
        state.status,
        state.missing,
        state.evidence,
      ]
        .map((x) => "<td>" + render(x) + "</td>")
        .join("") +
      "</tr>";
  }
  return out + "</table>";
}
