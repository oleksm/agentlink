import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { relative, join } from "node:path";
import { validateStandardRecord } from "./registry/project-schemas.js";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import type { Store } from "./store.js";
import { NativeRegistry } from "./standard-workflow/native_registry.js";
import { pathToFileURL } from "node:url";
import { catalog } from "./standard-workflow/project_files.js";
import { render as retrospectiveRender } from "./standard-workflow/retrospective_presentation.js";
import {
  archive_registers,
  status_summary_html,
} from "./standard-workflow/presentation.js";
import { assess } from "./standard-workflow/project_coverage.js";
type Row = Record<string, any>;
const asset = (name: string) =>
  readFileSync(new URL("../web/" + name, import.meta.url), "utf8");
const schemaCache = new Map<string,{stamp:string,value:Row}>();
function schemaDocument(url: URL): Row {
 const st=statSync(url),stamp=st.mtimeMs+':'+st.size,key=url.href,old=schemaCache.get(key);
 if(old?.stamp===stamp)return old.value;
 const value=parse(readFileSync(url,'utf8'),{maxAliasCount:10000});schemaCache.set(key,{stamp,value});return value;
}
function resolveShape(ref: string, file: URL): { shape: Row; file: URL } {
  const url = new URL(ref, file),
    pointer = url.hash;
  url.hash = "";
  let shape = schemaDocument(url);
  for (const part of pointer.slice(1).split("/").filter(Boolean))
    shape = shape[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return { shape, file: url };
}
/** Same allOf shape flattening used by the original registry page builder. */
function flattenShape(node: any, file: URL): any {
  if (Array.isArray(node)) return node.map((v) => flattenShape(v, file));
  if (!node || typeof node !== "object") return node;
  const result: Row = Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, flattenShape(v, file)]),
  );
  const shapes = result.allOf;
  delete result.allOf;
  if (shapes && (result.type === "object" || result.properties)) {
    const props = { ...(result.properties ?? {}) },
      required = [...(result.required ?? [])];
    for (let shape of shapes) {
      let shapeFile = file;
      if (shape?.$ref) {
        const resolved = resolveShape(shape.$ref, file);
        shape = resolved.shape;
        shapeFile = resolved.file;
      }
      shape = flattenShape(shape, shapeFile);
      for (const [key, pv] of Object.entries(shape.properties ?? {}) as [
        string,
        any,
      ][])
        if (
          !(key in props) &&
          pv &&
          typeof pv === "object" &&
          ["type", "$ref", "oneOf", "enum", "properties", "const"].some(
            (k) => k in pv,
          )
        )
          props[key] = pv;
      for (const key of shape.required ?? [])
        if (!required.includes(key) && key in props) required.push(key);
    }
    result.properties = props;
    if (required.length) result.required = required;
  } else if (shapes) result.allOf = shapes;
  return result;
}
function groupMetadata(schema: Row, resolve: (ref: string) => Row): Row {
  const groups: Row = {};
  for (const [key, value] of Object.entries(schema.properties ?? {}) as [
    string,
    Row,
  ][]) {
    const shape = value.$ref ? resolve(value.$ref) : value,
      props = shape.properties ?? shape.items?.properties ?? {};
    groups[key] = {
      description: shape.description ?? "",
      props: Object.fromEntries(
        Object.entries(props)
          .filter(([, v]) => v && typeof v === "object")
          .map(([k, v]) => {
            const item = v as Row;
            return [
              k,
              (item.description ?? "") +
                (item["x-unit"] ? ` (${item["x-unit"]})` : ""),
            ];
          }),
      ),
      unit: shape["x-unit"] ?? "",
      units: Object.fromEntries(
        Object.entries(props)
          .filter(([, v]) => v && typeof v === "object" && (v as Row)["x-unit"])
          .map(([k, v]) => [k, (v as Row)["x-unit"]]),
      ),
    };
  }
  return groups;
}
/** Standard objects pass unchanged into the original template, with original navigation metadata. */
export function registryPageStamp(store:Store):string {
 const rows:string[]=[];
 const visit=(p:string)=>{if(!existsSync(p))return;const st=statSync(p);if(st.isDirectory()){for(const n of readdirSync(p).sort())visit(join(p,n));}else if(p.endsWith('.yaml'))rows.push(p+':'+st.mtimeMs+':'+st.size);};
 for(const p of ['DevProjects/metadata','DevProjects/schema','common.schema.yaml','root.schema.yaml'])visit(join(store.home,'registry',p));
 return createHash('sha256').update(rows.join('\n')).digest('hex');
}
const pageCache=new Map<string,{stamp:string,value:any}>();
export function registryPageData(store: Store) {
 const stamp=registryPageStamp(store),cached=pageCache.get(store.home);if(cached?.stamp===stamp)return cached.value;
  const
    template = asset("index.html");
  const data: Row = Object.fromEntries(
    [...template.matchAll(/DATA\.([A-Za-z_]+)/g)].map((m) => [m[1], []]),
  );
  Object.assign(data, {
    roots: { DevProjects: { name: "Dev Projects", note: "" } },
    registers: [],
    key_pages: {},
    register_groups: {},
    project_status_summaries: {},
    project_coverage_status: {},
    project_owner_labels: {},
    
  });
  const names: Record<string, string> = {
      project: "projects",
      intake: "intakes",
      retrospective: "retrospectives",
    },
    titles: Record<string, string> = {
      projects: "Projects",
      intakes: "Intake",
      retrospectives: "Retrospective",
    };
  for (const [native, kind] of Object.entries(names)) {
    const file = pathToFileURL(`${store.home}/registry/DevProjects/schema/${native}.schema.yaml`),
      schema = flattenShape(schemaDocument(file), file);
    data.register_groups[kind] = groupMetadata(schema, (ref) => {
      const r = resolveShape(ref, file);
      return flattenShape(r.shape, r.file);
    });
    data.registers.push({
      kind,
      title: titles[kind],
      root: "DevProjects",
      records: [],
      about: schema.description ?? "",
    });
  }
  const registry = new NativeRegistry(store.home),
    discovered = registry.records();
  const complete = (rec: Row) => {
    const original = { ...rec };
    for (const field of ["slug", "key", "name", "file"]) delete original[field];
    return (
      validateStandardRecord(rec.identity.key.split(".")[0], original, store.home)
        .length === 0
    );
  };
  const entries = discovered.map((r) => ({
    kind: r.kind,
    id: r.key.split(".").slice(1).join("."),
    title: r.name,
    data: { ...r.record, file: relative(registry.tree, r.path) },
    root: r.root,
    schemaPath:
      r.schema ??
      registry
        .schemas()
        .find((s) => (s.schema["x-kind"] ?? []).includes(r.kind))?.path,
  }));
  for (const entry of entries) {
    const r = entry.data as Row;
    if (entry.kind === "root") {
      const root = entry.root || r.identity?.name || entry.id;
      data.roots[root] = {
        name: r.identity?.name ?? entry.title,
        note: r.note ?? "",
      };
      continue;
    }
    const kind = names[entry.kind] || entry.kind,
      root = names[entry.kind] ? "DevProjects" : entry.root || "Registry";
    data.roots[root] ??= { name: root, note: "" };
    let register = data.registers.find((x: Row) => x.kind === kind);
    if (!register) {
      register = {
        kind,
        title: titles[kind] || kind,
        root,
        records: [],
        about: "",
      };
      data.registers.push(register);
      if (entry.schemaPath) {
        const file = pathToFileURL(entry.schemaPath),
          schema = flattenShape(schemaDocument(file), file);
        register.about = schema.description ?? "";
        data.register_groups[kind] = groupMetadata(schema, (ref) => {
          const resolved = resolveShape(ref, file);
          return flattenShape(resolved.shape, resolved.file);
        });
      }
    }
    const name = r.identity?.id
      ? [r.identity.id, r.identity.name].filter(Boolean).join(" ")
      : r.identity?.name || entry.title;
    const row = {
      ...r,
      slug: entry.id,
      key: r.identity?.key || `${entry.kind}.${entry.id}`,
      name,
    };
    register.records.push(row);
    data.key_pages[row.key] = `x:${kind}:${row.slug}`;
  }
  for (const register of data.registers)
    if (register.kind === "projects" && register.root === "DevProjects")
      for (const rec of register.records)
        data.project_coverage_status[rec.identity.key] = complete(rec)
          ? assess(rec)
          : [];
  const nativeRows = data.registers
    .filter((r: Row) => r.root === "DevProjects")
    .flatMap((r: Row) => r.records);
  Object.assign(
    data,
    catalog(
      store.home,
      discovered.filter((r) => r.root === "DevProjects").map((r) => r.record),
      false, false,
    ),
  );
  data.retrospective_pages = Object.fromEntries(
    nativeRows
      .filter(
        (r: Row) =>
          r.identity?.key?.startsWith("retrospective.") && complete(r),
      )
      .map((r: Row) => [
        r.identity.key,
        retrospectiveRender(
          r,
          data.project_artifact_references[r.identity.key] ?? {},
        ),
      ]),
  );
  archive_registers(data);
  for (const register of data.registers)
    if (
      ["projects", "archived-projects"].includes(register.kind) &&
      register.root === "DevProjects"
    )
      for (const rec of register.records) {
        const intake = nativeRows.find(
            (r: Row) => r.identity?.key === rec.intake,
          ),
          labels = Object.fromEntries(
            (rec.acceptance_criteria ?? []).map((c: Row) => [
              c.id,
              intake?.logistics?.approach?.find(
                (step: Row) => step.id === c.step,
              )?.deliverable?.description ??
                c.step ??
                c.id,
            ]),
          );
        const owners = Object.fromEntries(
          (rec.workers ?? [])
            .filter((w: Row) => w.source?.identity)
            .map((w: Row) => [w.id, w.source.identity]),
        );
        Object.assign(data.project_owner_labels, owners);
        data.project_status_summaries[rec.identity.key] = complete(rec)
          ? status_summary_html(
              rec,
              { labels, owners },
              data.project_coverage_status[rec.identity.key],
            )
          : "";
      }
  data.revision = createHash("sha256")
    .update(
      JSON.stringify([
        discovered.map((r) => r.record),
        data.project_coverage_status,
      ]),
    )
    .digest("hex");
  pageCache.set(store.home,{stamp,value:data});
  return data;
}
export function renderRegistryPage(store: Store) {
  const nonce = randomBytes(24).toString("base64");
  const html = asset("index.html")
    .replace(
      "/*DATA*/null",
      JSON.stringify(registryPageData(store)).replace(/</g, "\\u003c"),
    )
    .replace(
      "/*PROJECT_TIME*/",
      asset("project-time.js") + "\n" + asset("project-navigation.js") + "\n" + asset("registry-live.js"),
    )
    .replace("<script>", `<script nonce="${nonce}">`);
  return { html, nonce };
}
