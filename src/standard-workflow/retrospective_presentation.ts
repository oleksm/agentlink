import { status_badge } from "./presentation.js";
import type { RecordData as Row } from "./common.js";
const esc = (v: any) =>
  String(v).replace(
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
export function ac_table(record: Row): string {
  const route = "x:projects:" + record.project.split(".").slice(1).join(".");
  const rows = record.stats.per_ac.map((item: Row) => {
    const cid = item.criterion,
      tokens = item.uncached_tokens,
      seconds = item.time_seconds;
    return (
      '<tr><td><a data-k="' +
      esc(route) +
      '" data-anchor="ac-' +
      esc(cid) +
      '" href="#' +
      esc(route) +
      '">' +
      esc(cid) +
      "</a></td><td>" +
      status_badge(item.status ?? "unknown") +
      "</td><td>" +
      (seconds == null ? "unknown" : (seconds / 60).toFixed(1)) +
      "</td><td>" +
      (tokens == null ? "unknown" : (tokens / 1000000).toFixed(1) + "M") +
      "</td>" +
      ["status_changes", "workflow_actions", "blockers"]
        .map((k) => "<td>" + esc(item[k] ?? "unknown") + "</td>")
        .join("") +
      "<td>" +
      (item.limitations?.length
        ? "<ul>" +
          item.limitations.map((x: any) => "<li>" + esc(x) + "</li>").join("") +
          "</ul>"
        : "") +
      "</td></tr>"
    );
  });
  return (
    "<table><thead><tr><th>ID</th><th>Status</th><th>Time (min)</th><th>Tokens</th><th>Status Changes</th><th>Workflow Actions</th><th>Blockers</th><th>Limitations</th></tr></thead><tbody>" +
    rows.join("") +
    "</tbody></table>"
  );
}
export function render(
  record: Row,
  references: Record<string, string> = {},
): string {
  const text = (x: any) => references[String(x)] ?? esc(x),
    bullets = (values: any[]) =>
      values?.length
        ? "<ul>" +
          values.map((x) => "<li>" + text(x) + "</li>").join("") +
          "</ul>"
        : "<p>Pending review</p>",
    summary = record.summary ?? {};
  let result =
    "<h1>" +
    esc([record.identity.id, record.identity.name].filter(Boolean).join(" ")) +
    "</h1>";
  result +=
    "<p>Project Status " +
    status_badge(record.project_status) +
    "</p><p>Retrospective " +
    status_badge(record.state === "complete" ? "completed" : record.state) +
    "</p>";
  result +=
    "<h2>Project Goal</h2><p>" +
    esc(record.project_goal ?? "Pending goal copy") +
    "</p><h2>Summary</h2><h3>Went Well</h3>" +
    bullets(summary.went_well ?? []) +
    "<h3>Did Not Work</h3>";
  result += summary.did_not_work?.length
    ? "<ul>" +
      summary.did_not_work
        .map(
          (x: Row) =>
            "<li><strong>What:</strong> " +
            esc(x.what) +
            "<br><strong>Why:</strong> " +
            esc(x.why) +
            "</li>",
        )
        .join("") +
      "</ul>"
    : "<p>Pending review</p>";
  result +=
    "<h3>Proposed Project Corrections</h3>" +
    bullets(summary.proposed_project_corrections ?? []) +
    "<h2>Workflow</h2>" +
    ac_table(record);
  for (const step of record.step_reviews ?? []) {
    const cid = step.criterion,
      route = "x:projects:" + record.project.split(".").slice(1).join(".");
    result +=
      '<section><h3><a data-k="' +
      esc(route) +
      '" data-anchor="ac-' +
      esc(cid) +
      '" href="#' +
      esc(route) +
      '">' +
      esc(cid) +
      "</a></h3><p><strong>Intended result:</strong> " +
      esc(step.intended) +
      "</p><p><strong>Actual outcome:</strong> " +
      esc(step.outcome) +
      "</p><h4>Went Well</h4>" +
      bullets([step.worked]) +
      "<h4>Did Not Work</h4><ul><li><strong>What:</strong> " +
      esc(step.problems) +
      "<br><strong>Why:</strong> " +
      esc(step.why ?? "Pending causal review") +
      "</li></ul><h4>Proposed Project Corrections</h4>" +
      bullets([step.correction]) +
      "<h4>Evidence</h4>" +
      bullets(step.evidence) +
      "</section>";
  }
  if (!record.step_reviews?.length)
    result += "<p>Step analysis pending PM review.</p>";
  const conclusion = record.owner_conclusion ?? {};
  result +=
    "<h2>Conclusion</h2>" +
    (conclusion.document ? bullets([conclusion.document]) : "<p>Pending</p>") +
    "<details><summary>Metrics and source records</summary><table>" +
    Object.entries(record.stats ?? {})
      .filter(([k]) => k !== "per_ac")
      .map(
        ([k, v]) =>
          "<tr><th>" +
          esc(k.replaceAll("_", " ")) +
          "</th><td>" +
          esc(v) +
          "</td></tr>",
      )
      .join("") +
    "</table>" +
    bullets(
      ["facts", "report"].filter((k) => record[k]).map((k) => record[k]),
    ) +
    "</details>";
  return result;
}
