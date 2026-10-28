import { readFileSync, statSync, realpathSync } from "node:fs";
import {
  resolve as abs,
  dirname,
  basename,
  extname,
  relative,
  isAbsolute,
  join,
} from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { RecordData as Row } from "./common.js";
export const esc = (v: any) =>
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
export const FILE =
  /(?<![\w:/])(?:\/|~\/|(?:[\w.-]+\/)+)[^\s<>"']*?\.[A-Za-z0-9]{1,12}(?=$|[\s),;:#\]`"'}]|\.(?=\s|$))/g;
export const MAX_PREVIEW_BYTES = 8000000,
  MAX_DOCUMENT_BYTES = 256000,
  MAX_EXPANDED_DOCUMENTS = 512;
const TEXT = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".py",
  ".rs",
  ".wgsl",
  ".sh",
  ".csv",
  ".ron",
]);
type Link = (target: string, label: string) => string;
const regexEscape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function inline(text: string, link?: Link): string {
  const anchor: Link =
    link ??
    ((target, label) =>
      /^https?:\/\//.test(target)
        ? `<a href="${esc(target)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
        : esc(label));
  const prose = (value: string) => {
    let result = "",
      start = 0;
    for (const m of value.matchAll(
      new RegExp("https?://[^\\s<>]+|" + FILE.source, "g"),
    )) {
      const target = m[0].replace(/[.,;!?]+$/, "");
      result +=
        esc(value.slice(start, m.index)) +
        anchor(target, /^https?:/.test(target) ? target : basename(target));
      start = m.index + target.length;
    }
    return result + esc(value.slice(start));
  };
  let out = "",
    start = 0;
  for (const m of text.matchAll(
    /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g,
  )) {
    out += prose(text.slice(start, m.index));
    if (m[1] !== undefined) {
      const code = m[1];
      out +=
        "<code>" +
        (new RegExp("^(?:" + FILE.source + ")$").test(code)
          ? anchor(code, basename(code))
          : esc(code)) +
        "</code>";
    } else if (m[2] !== undefined)
      out += "<strong>" + prose(m[2]) + "</strong>";
    else out += anchor(m[4]!.replace(/^<|>$/g, ""), m[3]!);
    start = m.index + m[0].length;
  }
  return out + prose(text.slice(start));
}
export function markdown(text: string, link?: Link): string {
  const render = (s: string) => inline(s, link),
    lines = text.split(/\r\n|\n|\r/),
    out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```"))
        code.push(lines[i++]!);
      out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)/.exec(line);
    if (h) {
      const n = h[1]!.length,
        slug = h[2]!
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_ -]/gu, "")
          .replaceAll(" ", "-");
      out.push(`<h${n} id="${esc(slug)}">${render(h[2]!)}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    const cells = (r: string) =>
      r
        .trim()
        .replace(/^\|+|\|+$/g, "")
        .split("|");
    if (
      i + 1 < lines.length &&
      line.includes("|") &&
      /^[\s|:\-]+$/.test(lines[i + 1]!) &&
      lines[i + 1]!.includes("-")
    ) {
      out.push(
        "<table><thead><tr>" +
          cells(line)
            .map((c) => "<th>" + render(c.trim()) + "</th>")
            .join("") +
          "</tr></thead><tbody>",
      );
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim())
        out.push(
          "<tr>" +
            cells(lines[i++]!)
              .map((c) => "<td>" + render(c.trim()) + "</td>")
              .join("") +
            "</tr>",
        );
      out.push("</tbody></table>");
      continue;
    }
    let item = /^\s*(?:([-*+])|\d+\.)\s+(.*)/.exec(line);
    if (item) {
      const tag = item[1] ? "ul" : "ol";
      out.push("<" + tag + ">");
      while (
        i < lines.length &&
        (item = /^\s*(?:([-*+])|\d+\.)\s+(.*)/.exec(lines[i]!))
      ) {
        out.push("<li>" + render(item[2]!) + "</li>");
        i++;
      }
      out.push("</" + tag + ">");
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(?:#|```|\s*[-*+]\s|\d+\.\s|\|)/.test(lines[i]!)
    )
      paragraph.push(lines[i++]!);
    out.push("<p>" + render(paragraph.join(" ")) + "</p>");
  }
  return out.join("");
}
const mime: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const file = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const canonical = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return abs(p);
  }
};
const within = (p: string, root: string) => {
  const r = relative(root, p);
  return (
    r === "" || (!r.startsWith(".." + "/") && r !== ".." && !isAbsolute(r))
  );
};
function parts(raw: string) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw),
    scheme = match?.[1]?.toLowerCase() ?? "";
  let value = scheme ? raw.slice(match![0].length) : raw,
    netloc = "";
  if (value.startsWith("//")) {
    const m = /^\/\/([^/]*)(.*)$/.exec(value)!;
    netloc = m[1]!;
    value = m[2]!;
  }
  const hash = value.indexOf("#"),
    fragment = hash < 0 ? "" : value.slice(hash + 1);
  if (hash >= 0) value = value.slice(0, hash);
  return { scheme, netloc, path: value.split("?")[0]!, fragment };
}
export function svg_preview(path: string): string {
  let tree;
  try {
    tree = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") throw Error(message);
      },
    }).parseFromString(readFileSync(path, "utf8"), "image/svg+xml");
  } catch {
    return "<p>SVG preview unavailable: invalid XML.</p>";
  }
  const missing: string[] = [];
  const elements = tree.getElementsByTagName("*");
  for (let i = 0; i < elements.length; i++) {
    const el = elements.item(i)!;
    if (el.localName !== "image") continue;
    for (const attribute of ["href", "xlink:href"]) {
      const reference = el.getAttribute(attribute);
      if (!reference || reference.startsWith("data:")) continue;
      const p = parts(reference),
        dependency = canonical(abs(dirname(path), decodeURIComponent(p.path)));
      if (
        p.scheme ||
        p.netloc ||
        !mime[extname(dependency).toLowerCase()] ||
        !file(dependency) ||
        statSync(dependency).size > 10000000
      ) {
        missing.push(reference);
        el.removeAttribute(attribute);
        continue;
      }
      el.setAttribute(
        attribute,
        "data:" +
          mime[extname(dependency).toLowerCase()] +
          ";base64," +
          readFileSync(dependency).toString("base64"),
      );
    }
  }
  const encoded = Buffer.from(
    new XMLSerializer().serializeToString(tree),
  ).toString("base64");
  let body = `<img src="data:image/svg+xml;base64,${encoded}" alt="${esc(basename(path))}" style="max-width:100%;height:auto">`;
  if (missing.length)
    body +=
      "<p>Unavailable SVG image dependencies: " +
      missing.map(esc).join(", ") +
      "</p>";
  return body;
}
export function catalog(
  root: string,
  records: Row[],
  include_paths = false,
  expand_previews = true,
): Row {
  root = abs(root);
  const documents: Record<
      string,
      { name: string; path: string; body: string; parents: Set<string> }
    > = {},
    references: Row = {},
    pending: Array<[string, string]> = [],
    artifact_references: Row = {};
  const productPaths: Array<[string, string]> = records.flatMap((r) =>
    (r.products ?? [])
      .filter((p: Row) => p.repository && p.worktree)
      .map((p: Row) => [canonical(p.repository), canonical(p.worktree)]),
  );
  function resolve(raw: string, base: string) {
    let path = decodeURIComponent(raw);
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (!isAbsolute(path)) {
      const local = join(base, path),
        candidates = [local];
      for (const [repository, worktree] of productPaths)
        if (within(base, repository) || within(base, worktree))
          candidates.push(join(worktree, path), join(repository, path));
      candidates.push(join(root, path));
      path = candidates.find(file) ?? local;
    }
    path = canonical(path);
    for (const [repository, worktree] of productPaths)
      if (within(path, repository)) {
        const candidate = join(worktree, relative(repository, path));
        if (file(candidate)) {
          path = candidate;
          break;
        }
      }
    return path;
  }
  const hash = (s: string) =>
    createHash("sha256").update(s).digest("hex").slice(0, 24);
  function register(path: string, parent: string) {
    const key = "doc:" + hash(path);
    if (!documents[key]) {
      documents[key] = {
        name: basename(path),
        path,
        body: "",
        parents: new Set(),
      };
      pending.push([key, path]);
    }
    documents[key]!.parents.add(parent);
    return key;
  }
  function link(raw: string, label: string, base: string, parent: string) {
    const p = parts(raw);
    if (["http", "https", "mailto"].includes(p.scheme))
      return `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    if (p.scheme && p.scheme !== "file") return esc(label);
    const key = p.path ? register(resolve(p.path, base), parent) : parent,
      fragment = p.fragment
        ? ` data-anchor="${esc(decodeURIComponent(p.fragment))}"`
        : "";
    return `<a data-k="${key}" href="#${key}"${fragment}>${esc(label)}</a>`;
  }
  const patterns = new WeakMap<Row,RegExp>();
  function walk(value: any, parent: string, evidence: Row, scoped: Row) {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, parent, evidence, scoped);
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v, parent, evidence, scoped);
      return;
    }
    if (typeof value !== "string") return;
    let pattern=patterns.get(evidence);
    if(!pattern){
    const ids = Object.keys(evidence)
        .sort((a, b) => b.length - a.length)
        .map(regexEscape)
        .join("|"),
      compiled = new RegExp(
        FILE.source + (ids ? "|(?<![\\w-])(?:" + ids + ")(?![\\w-])" : ""),
        "g",
      );
    patterns.set(evidence,compiled);pattern=compiled;
    }
    const matches = [...value.matchAll(pattern)];
    if (!matches.length) return;
    let rendered = "",
      start = 0,
      used = false;
    for (const m of matches) {
      const raw = m[0];
      let anchor;
      if (evidence[raw]) {
        const item = evidence[raw];
        used = true;
        if (item.page)
          anchor = `<a data-k="${item.page}" href="#${item.page}">${esc(item.label)}</a>`;
        else {
          const target = item.location,
            p = parts(target).path,
            suffix = extname(p).slice(1).toUpperCase();
          let label = basename(p) || raw;
          if (suffix) label += " · " + suffix;
          anchor = link(target, label, root, parent);
        }
      } else anchor = link(raw, basename(raw), root, parent);
      rendered += esc(value.slice(start, m.index)) + anchor;
      start = m.index + raw.length;
    }
    const result = rendered + esc(value.slice(start));
    scoped[value] = result;
    if (!used) references[value] = result;
  }
  for (const rec of records) {
    const key = rec.identity?.key ?? "";
    if (!key.includes(".")) continue;
    const dot = key.indexOf("."),
      kind = key.slice(0, dot),
      slug = key.slice(dot + 1),
      evidence: Row = Object.fromEntries(
        (rec.evidence ?? [])
          .filter((e: Row) => e.location)
          .map((e: Row) => [e.id, e]),
      ),
      fileEvidence = { ...evidence },
      scoped = (artifact_references[key] ??= {}),
      parent = kind === "root" ? "root:DevProjects" : "x:" + kind + "s:" + slug;
    artifact_references[key] = scoped;
    for (const d of rec.decisions ?? []) {
      const page = "doc:" + hash(key + ":decision:" + d.id),
        label = d.question ?? d.id;
      evidence[d.id] = { page, label };
      documents[page] = {
        name: label,
        path: key + " / " + d.id,
        body: "",
        parents: new Set([parent]),
      };
    }
    walk(rec, parent, evidence, scoped);
    for (const d of rec.decisions ?? []) {
      const page = evidence[d.id].page;
      const field = (v: any): string =>
        Array.isArray(v)
          ? "<ul>" +
            v.map((x) => "<li>" + field(x) + "</li>").join("") +
            "</ul>"
          : typeof v === "string"
            ? (scoped[v] ?? esc(v))
            : esc(v);
      const proof =
        "<ul>" +
        (d.evidence ?? [])
          .filter((id: string) => fileEvidence[id])
          .map(
            (id: string) =>
              "<li>" +
              link(
                fileEvidence[id].location,
                basename(fileEvidence[id].location),
                root,
                page,
              ) +
              "</li>",
          )
          .join("") +
        "</ul>";
      documents[page]!.body =
        "<dl>" +
        Object.entries(d)
          .filter(([name]) => name !== "id")
          .map(
            ([name, v]) =>
              "<dt>" +
              esc(
                name
                  .replaceAll("_", " ")
                  .replace(/\b\w/g, (c) => c.toUpperCase()),
              ) +
              "</dt><dd>" +
              (name === "evidence" ? proof : field(v)) +
              "</dd>",
          )
          .join("") +
        "</dl>";
    }
  }
  const omitted =
    "<p>Inline preview omitted to keep the registry responsive. The source file is preserved at the path above.</p>";
  let index = 0,
    previewBytes = 0;
  while (index < pending.length) {
    const [key, path] = pending[index++]!;
    if (!expand_previews) { documents[key]!.body = `<p><a href="/api/files/${key.slice(4)}?download=1">Open source file</a></p>`; continue; }
    if (index > MAX_EXPANDED_DOCUMENTS || previewBytes >= MAX_PREVIEW_BYTES) {
      documents[key]!.body = omitted;
      continue;
    }
    let body;
    try {
      const size = statSync(path).size,
        suffix = extname(path).toLowerCase();
      if (size > Math.min(MAX_DOCUMENT_BYTES, MAX_PREVIEW_BYTES - previewBytes))
        body =
          "<p>This file exceeds the remaining inline preview budget. The source file is preserved at the path above.</p>";
      else if (mime[suffix] && size <= 10000000)
        body = `<img src="data:${mime[suffix]};base64,${readFileSync(path).toString("base64")}" alt="${esc(basename(path))}" style="max-width:100%;height:auto">`;
      else if (suffix === ".svg" && size <= 10000000) body = svg_preview(path);
      else if (!TEXT.has(suffix))
        body = "<p>Preview is not available for this file type.</p>";
      else if (size > 2000000)
        body =
          "<p>This file is too large for the inline preview (2 MB limit).</p>";
      else {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          readFileSync(path),
        );
        if ([".md", ".markdown"].includes(suffix))
          body = markdown(content, (raw, label) =>
            link(raw, label, dirname(path), key),
          );
        else if ([".json", ".yaml", ".yml"].includes(suffix)) {
          let result = "",
            start = 0;
          for (const m of content.matchAll(FILE)) {
            result +=
              esc(content.slice(start, m.index)) +
              link(m[0], basename(m[0]), dirname(path), key);
            start = m.index + m[0].length;
          }
          body = "<pre>" + result + esc(content.slice(start)) + "</pre>";
        } else body = "<pre>" + esc(content) + "</pre>";
      }
    } catch {
      body = "<p>File unavailable when the registry was built.</p>";
    }
    const size = Buffer.byteLength(body);
    if (size > MAX_PREVIEW_BYTES - previewBytes) body = omitted;
    else previewBytes += size;
    documents[key]!.body = body;
  }
  const aliases = new Map<string, Set<string>>();
  for (const rec of records) {
    const scope = artifact_references[rec.identity?.key] ?? {};
    for (const e of [...(rec.evidence ?? []), ...(rec.decisions ?? [])])
      if (e.id in scope) {
        if (!aliases.has(e.id)) aliases.set(e.id, new Set());
        aliases.get(e.id)!.add(scope[e.id]);
      }
  }
  const unique: Row = Object.fromEntries(
      [...aliases]
        .filter(([, links]) => links.size === 1)
        .map(([id, links]) => [id, [...links][0]]),
    ),
    ids = Object.keys(unique).sort((a, b) => b.length - a.length),
    pattern = ids.length
      ? new RegExp(
          "(?<![\\w-])(?:" + ids.map(regexEscape).join("|") + ")(?![\\w-])",
          "g",
        )
      : null,
    pages: Row = {};
  for (const [key, doc] of Object.entries(documents)) {
    let depth = 0;
    doc.body = doc.body
      .split(/(<[^>]*>|&(?:#\w+|\w+);)/g)
      .map((part) => {
        if (part.startsWith("<")) {
          if (/^<a(?:\s|>)/i.test(part) && !part.endsWith("/>")) depth++;
          if (/^<\/a\s*>/i.test(part)) depth = Math.max(0, depth - 1);
          return part;
        }
        return pattern && !depth && !part.startsWith("&")
          ? part.replace(pattern, (m) => unique[m])
          : part;
      })
      .join("");
    const back = [...doc.parents]
      .sort()
      .map(
        (p) =>
          `<a data-k="${esc(p)}" href="#${esc(p)}">${esc(documents[p]?.name ?? p.split(":").at(-1))}</a>`,
      )
      .join(" · ");
    pages[key] =
      `<article class="project-document"><p>Referenced by: ${back}</p><h1>${esc(doc.name)}</h1><p class="meta">${esc(doc.path)}</p>${doc.body}</article>`;
  }
  return {
    ...(include_paths
      ? {
          project_file_paths: Object.fromEntries(
            Object.entries(documents).map(([key, doc]) => [key, doc.path]),
          ),
        }
      : {}),
    project_documents: pages,
    project_file_references: references,
    project_artifact_references: artifact_references,
  };
}
