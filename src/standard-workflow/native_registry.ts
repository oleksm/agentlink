import { statSync, realpathSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  dirname,
  basename,
  isAbsolute,
  sep,
} from "node:path";
import { parse, stringify } from "yaml";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { atomic, locked } from "./records.js";
import { update_status, check_record } from "./projects.js";
import { assign } from "./project_ids.js";
import type { RecordData as Row } from "./common.js";
export interface NativeRecord {
  key: string;
  name: string;
  path: string;
  record: Row;
  schema: string | null;
  root: string;
  kind: string;
}
export interface RegistryFilter {
  kind?: string;
  root?: string;
}
export interface SchemaRecord {
  path: string;
  schema: Row;
}
const object = (v: any): v is Row =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const repr = (v: any) =>
  typeof v === "string" ? JSON.stringify(v) : String(v);
const same = (a: any, b: any): boolean => isDeepStrictEqual(a, b);
const types: Record<string, (v: any) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: Array.isArray,
  object,
  null: (v) => v === null,
};
const UNIT =
  /^(deg|[(/ ]*((kg|mol|rad|Pa|Sv|m|s|K|W|N|J|V|S|T|A|1)(\^0\.5|[0-9])?[()/ ]*)+)$/;
function files(dir: string, ancestors = new Set<string>()): string[] {
 if (!existsSync(dir)) return [];
 const real=realpathSync(dir); if(ancestors.has(real)) return [];
 const next=new Set([...ancestors,real]);
 return readdirSync(dir,{withFileTypes:true}).filter(e=>e.name!=='.git'&&e.name!=='.ids').flatMap(e=>{const p=join(dir,e.name),st=e.isSymbolicLink()?statSync(p):e;return st.isDirectory()?files(p,next):st.isFile()&&e.name.endsWith('.yaml')?[p]:[];}).sort();
}
/** Generic schema rules used by the original registry tools, without application checks. */
export class NativeRegistry {
  readonly tree: string;
  constructor(readonly home: string) {
    this.home = resolve(home);
    this.tree = join(this.home, "registry");
  }
  private inside(path: string): string {
    const full = resolve(path),
      rel = relative(this.tree, full);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw Error("Registry path is outside the registry: " + path);
    return full;
  }
  schema(path: string): Row {
    return parse(readFileSync(this.inside(path), "utf8"), {
      maxAliasCount: 10000,
    });
  }
  resolve(ref: string, here: string): [Row, string] {
    const split = ref.indexOf("#"),
      file = split < 0 ? ref : ref.slice(0, split),
      pointer = split < 0 ? "" : ref.slice(split + 1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(file))
      throw Error("Schema references must be local: " + ref);
    const path = this.inside(file ? resolve(dirname(here), file) : here);
    let node = this.schema(path);
    for (const step of pointer.split("/").filter(Boolean))
      node = node[step.replace(/~1/g, "/").replace(/~0/g, "~")];
    return [node, path];
  }
  schemas(): SchemaRecord[] {
    return files(this.tree)
      .filter((p) => p.endsWith(".schema.yaml"))
      .map((path) => ({ path, schema: this.schema(path) }));
  }
  schemaFor(kind: string): SchemaRecord {
    const match = this.schemas().find((s) =>
      (s.schema["x-kind"] ?? []).includes(kind),
    );
    if (!match) throw Error("no schema says x-kind " + kind);
    return match;
  }
  schemaNamed(path: string): string | null {
    const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "",
      m = /^# yaml-language-server: \$schema=(\S+)/.exec(first);
    return m ? this.inside(resolve(dirname(path), m[1]!)) : null;
  }
  records(filter: RegistryFilter = {}): NativeRecord[] {
    const out: NativeRecord[] = [];
    for (const path of files(this.tree)) {
            const discoveryParts = relative(this.tree,path).split(sep);
            if(discoveryParts[0] === "DevProjects" && discoveryParts[1] !== "metadata" && !path.endsWith(".schema.yaml")) continue;
      if (
        path.endsWith(".schema.yaml") ||
        relative(this.tree, path).split(sep).includes("schema")
      )
        continue;
      let record;
      try {
        record = parse(readFileSync(path, "utf8"), { maxAliasCount: 10000 });
      } catch {
        continue;
      }
      const identity =
        object(record) && object(record.identity) ? record.identity : null;
      if (typeof identity?.key !== "string" || !identity.key) continue;
      const key = identity.key,
        kind = key.split(".")[0]!,
        root = relative(this.tree, path).split(sep)[0]!;
      if (
        (filter.kind && filter.kind !== kind) ||
        (filter.root && filter.root !== root)
      )
        continue;
      out.push({
        key,
        name: identity.name ?? "",
        path,
        record,
        schema: this.schemaNamed(path),
        root,
        kind,
      });
    }
    return out;
  }
  get(key: string): NativeRecord {
    const item = this.records().find((r) => r.key === key);
    if (!item) throw Error("no record " + key);
    return item;
  }
  find(words: string | string[], filter: RegistryFilter = {}): NativeRecord[] {
    const terms = (Array.isArray(words) ? words : words.split(/\s+/))
      .filter(Boolean)
      .map((w) => w.toLowerCase());
    return this.records(filter)
      .filter((r) =>
        terms.every((w) => (r.key + " " + r.name).toLowerCase().includes(w)),
      )
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  flattened(sch: Row, here: string): [Record<string, [Row, string]>, string[]] {
    const props: Record<string, [Row, string]> = Object.fromEntries(
        Object.entries(sch.properties ?? {}).map(([k, p]) => [
          k,
          [p as Row, here],
        ]),
      ),
      required: string[] = [...(sch.required ?? [])];
    for (let shape of sch.allOf ?? []) {
      let path = here;
      if (object(shape) && shape.$ref)
        [shape, path] = this.resolve(shape.$ref, here);
      const [p2, r2] = this.flattened(shape, path);
      for (const [k, [pv, where]] of Object.entries(p2)) {
        if (Object.hasOwn(props, k)) {
          if (
            object(pv) &&
            pv.required &&
            object(props[k]![0]) &&
            !pv.type &&
            !pv.$ref
          ) {
            let [base, bpath] = props[k]!;
            if (base.$ref) [base, bpath] = this.resolve(base.$ref, bpath);
            props[k] = [
              {
                ...base,
                required: [
                  ...new Set([...(base.required ?? []), ...pv.required]),
                ],
              },
              bpath,
            ];
          }
          continue;
        }
        if (
          object(pv) &&
          !["type", "$ref", "oneOf", "enum", "properties", "const"].some(
            (x) => x in pv,
          )
        )
          continue;
        props[k] = [pv, where];
      }
      for (const r of r2)
        if (!required.includes(r) && Object.hasOwn(props, r)) required.push(r);
    }
    return [props, required];
  }
  validateValue(v: any, sch: Row, here: string, at = ""): string[] {
    if (!object(sch)) return [];
    if (sch.$ref) {
      const [target, path] = this.resolve(sch.$ref, here);
      return this.validateValue(v, target, path, at);
    }
    const out: string[] = [],
      where = at || "the record",
      t = sch.type;
    if (t != null && !(Array.isArray(t) ? t : [t]).some((x) => types[x]?.(v)))
      return [
        `${where}: should be ${Array.isArray(t) ? t.join(" or ") : (/^[aeiou]/.test(t) ? "an " : "a ") + t}, is ${repr(v)}`.slice(
          0,
          200,
        ),
      ];
    if (sch.enum && !sch.enum.some((x: any) => same(x, v)))
      out.push(`${where}: ${repr(v)} is not one of ${sch.enum.join(", ")}`);
    if ("const" in sch && !same(v, sch.const))
      out.push(`${where}: should be ${repr(sch.const)}`);
    if (typeof v === "string") {
      if (sch.pattern && !new RegExp(sch.pattern).test(v))
        out.push(`${where}: ${repr(v)} does not match ${sch.pattern}`);
      if ("minLength" in sch && [...v].length < sch.minLength)
        out.push(`${where}: too short`);
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) out.push(`${where}: must be finite`);
      if ("minimum" in sch && v < sch.minimum)
        out.push(`${where}: ${v} is below ${sch.minimum}`);
      if ("exclusiveMinimum" in sch && v <= sch.exclusiveMinimum)
        out.push(`${where}: ${v} is not above ${sch.exclusiveMinimum}`);
      if ("maximum" in sch && v > sch.maximum)
        out.push(`${where}: ${v} is above ${sch.maximum}`);
    }
    if (Array.isArray(v)) {
      if ("minItems" in sch && v.length < sch.minItems)
        out.push(`${where}: needs at least ${sch.minItems}`);
      if ("maxItems" in sch && v.length > sch.maxItems)
        out.push(`${where}: takes at most ${sch.maxItems}`);
      if (sch.items)
        v.forEach((x, i) =>
          out.push(...this.validateValue(x, sch.items, here, `${at}[${i}]`)),
        );
    }
    if (object(v)) {
      const [props, required] = this.flattened(sch, here);
      for (const k of required)
        if (!Object.hasOwn(v, k)) out.push(`${where}: no ${k}`);
      for (const [k, x] of Object.entries(v)) {
        const prop = props[k],
          location = at ? at + "." + k : k;
        if (prop)
          out.push(...this.validateValue(x, prop[0], prop[1], location));
        else if (sch.additionalProperties === false)
          out.push(`${where}: unknown field '${k}'`);
        else if (object(sch.additionalProperties))
          out.push(
            ...this.validateValue(x, sch.additionalProperties, here, location),
          );
      }
    }
    for (const key of ["anyOf", "oneOf"])
      if (
        sch[key] &&
        !sch[key].some((s: Row) => !this.validateValue(v, s, here, at).length)
      )
        out.push(`${where}: fits none of its alternatives`);
    if (!object(v))
      for (const shape of sch.allOf ?? [])
        out.push(...this.validateValue(v, shape, here, at));
    return out;
  }
  validate(
    record: Row,
    schemaPath?: string,
  ): { valid: boolean; errors: string[]; schema: string } {
    const path = schemaPath
        ? this.inside(schemaPath)
        : this.schemaFor(record.identity?.key?.split(".")[0] ?? "").path,
      errors = this.validateValue(record, this.schema(path), path);
    return { valid: !errors.length, errors, schema: path };
  }
  references(
    value: any,
    sch: Row,
    here: string,
    at = "",
  ): Array<{ path: string; key: any; kinds: string[] }> {
    if (!object(sch)) return [];
    if (sch.$ref) {
      const [target, path] = this.resolve(sch.$ref, here);
      return this.references(value, target, path, at);
    }
    const result: Array<{ path: string; key: any; kinds: string[] }> = [];
    for (const key of ["oneOf", "anyOf"]) {
      const alt = (sch[key] ?? []).find(
        (a: Row) => !this.validateValue(value, a, here).length,
      );
      if (alt) result.push(...this.references(value, alt, here, at));
    }
    if (Array.isArray(value) && sch.items)
      value.forEach((x, i) => {
        if (sch.items["x-ref"])
          result.push({
            path: `${at}[${i}]`,
            key: x,
            kinds: sch.items["x-ref"],
          });
        else result.push(...this.references(x, sch.items, here, `${at}[${i}]`));
      });
    if (object(value)) {
      const [flat] = this.flattened(sch, here);
      for (const [k, x] of Object.entries(value)) {
        let [s, h] = flat[k] ?? [null, here];
        if (s?.$ref) [s, h] = this.resolve(s.$ref, h);
        const location = at ? at + "." + k : k;
        if (s?.["x-ref"])
          result.push({ path: location, key: x, kinds: s["x-ref"] });
        else if (s) result.push(...this.references(x, s, h, location));
      }
    }
    return result;
  }
  refs(key: string): Row {
    const item = this.get(key),
      schema = item.schema ?? this.schemaFor(item.kind).path,
      records = this.records(),
      keys = new Set(records.map((r) => r.key));
    return {
      key,
      outgoing: this.references(item.record, this.schema(schema), schema).map(
        (r) => ({
          ...r,
          exists: keys.has(r.key),
          valid:
            keys.has(r.key) && r.kinds.includes(String(r.key).split(".")[0]!),
        }),
      ),
      incoming: records.flatMap((r) => {
        const sp = r.schema ?? this.schemaFor(r.kind).path;
        return this.references(r.record, this.schema(sp), sp)
          .filter((x) => x.key === key)
          .map((x) => ({ from: r.key, path: x.path }));
      }),
    };
  }
  units(sch: any, at = ""): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    if (Array.isArray(sch)) {
      for (const x of sch) out.push(...this.units(x, at));
    } else if (object(sch)) {
      if ("x-unit" in sch && !UNIT.test(String(sch["x-unit"])))
        out.push([at, String(sch["x-unit"])]);
      for (const [k, x] of Object.entries(sch))
        out.push(...this.units(x, at ? at + "." + k : k));
    }
    return out;
  }
  lint(
    sch: Row,
    name: string,
    at = "",
    unit = false,
    top = true,
  ): Array<[string, string]> {
    if (!object(sch)) return [];
    const out: Array<[string, string]> = [],
      t = sch.type;
    if (top && sch.properties && !sch["x-kind"])
      out.push([
        at || "the schema",
        "says no x-kind: the kind of record it holds",
      ]);
    if (
      (t === "object" || sch.properties) &&
      !sch.$ref &&
      sch.additionalProperties !== false
    )
      out.push([
        at || "the schema",
        "an open object: additionalProperties must be false",
      ]);
    for (const key of ["oneOf", "anyOf"])
      for (const a of sch[key] ?? [])
        if (
          name !== "standard.schema.yaml" &&
          !(object(a) && "const" in (a.properties?.kind ?? {}))
        ) {
          out.push([
            at,
            key + ": each shape must have a `kind` that is a constant",
          ]);
          break;
        }
    unit = unit || "x-unit" in sch || "x-unit-from" in sch;
    const numeric =
      t === "number" ||
      (Array.isArray(t) && t.includes("number")) ||
      String(sch.$ref ?? "").endsWith("number_or_null");
    if (
      numeric &&
      !unit &&
      !["standard.schema.yaml", "law.schema.yaml"].includes(name) &&
      !at.endsWith("#number_or_null")
    )
      out.push([
        at,
        'a number with no x-unit (a pure number says x-unit: "1")',
      ]);
    for (const [k, x] of Object.entries(sch.properties ?? {}))
      out.push(
        ...this.lint(x as Row, name, at ? at + "." + k : k, false, false),
      );
    for (const [k, x] of Object.entries(sch.definitions ?? {}))
      out.push(...this.lint(x as Row, name, at + "#" + k, false, false));
    if (object(sch.items))
      out.push(...this.lint(sch.items, name, at + "[]", unit, false));
    for (const key of ["oneOf", "anyOf"])
      for (const a of sch[key] ?? [])
        out.push(...this.lint(a, name, at, unit, false));
    return out;
  }
  check(filter: RegistryFilter = {}): Row {
    const all = this.records(),
      keys = new Map<string, string>(),
      errors: Array<{ file: string; error: string }> = [];
    const discoveredPaths = new Set(all.map((r) => r.path));
    for (const path of files(this.tree)) {
            const discoveryParts = relative(this.tree,path).split(sep);
            if(discoveryParts[0] === "DevProjects" && discoveryParts[1] !== "metadata" && !path.endsWith(".schema.yaml")) continue;
      const parts = relative(this.tree, path).split(sep);
      if (
        parts.length < 2 ||
        path.endsWith(".schema.yaml") ||
        parts.some((p) =>
          ["schema", "sources", "logos", "icons"].includes(p),
        ) ||
        (parts[0] === "DevProjects" &&
          ["retrospectives", "postmortems"].includes(parts[1]!)) ||
        (filter.root && parts[0] !== filter.root) ||
        discoveredPaths.has(path)
      )
        continue;
      try {
        const sp = this.schemaNamed(path);
        if (!sp || !existsSync(sp)) {
          errors.push({ file: path, error: "no schema holds it" });
          continue;
        }
        const record = parse(readFileSync(path, "utf8"), {
          maxAliasCount: 10000,
        });
        errors.push(
          ...this.validateValue(record, this.schema(sp), sp).map((error) => ({
            file: path,
            error,
          })),
        );
        if (typeof record?.identity?.key !== "string")
          errors.push({ file: path, error: "key: missing identity.key" });
      } catch (e) {
        errors.push({ file: path, error: (e as Error).message });
      }
    }
    for (const r of all) {
      if (keys.has(r.key))
        errors.push({
          file: r.path,
          error: `key: ${r.key} is also ${keys.get(r.key)}'s`,
        });
      keys.set(r.key, r.path);
    }
    for (const r of this.records(filter)) {
      try {
        if (!r.schema) {
          errors.push({
            file: r.path,
            error: "record names no schema on its first line",
          });
          continue;
        }
        const schema = this.schema(r.schema),
          structural = this.validateValue(r.record, schema, r.schema);
        errors.push(...structural.map((error) => ({ file: r.path, error })));
        if (!/^[a-z][a-z-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(r.key))
          errors.push({
            file: r.path,
            error:
              "key: must be <kind>.<name> in lower case, words joined by -",
          });
        if (!(schema["x-kind"] ?? []).includes(r.kind))
          errors.push({
            file: r.path,
            error: "key: " + r.key + " is not of its schema's kind",
          });
        if (!structural.length)
          errors.push(
            ...check_record(r.record).map((error) => ({ file: r.path, error })),
          );
        for (const ref of this.references(r.record, schema, r.schema)) {
          if (!keys.has(ref.key))
            errors.push({
              file: r.path,
              error: `${ref.path}: ${repr(ref.key)} is no record's key`,
            });
          else if (!ref.kinds.includes(String(ref.key).split(".")[0]!))
            errors.push({
              file: r.path,
              error: `${ref.path}: ${ref.key} is not ${ref.kinds.join(" or ")}`,
            });
        }
      } catch (e) {
        errors.push({ file: r.path, error: (e as Error).message });
      }
    }
    for (const { path, schema } of this.schemas().filter(
      (s) =>
        !filter.root ||
        relative(this.tree, s.path).split(sep)[0] === filter.root,
    )) {
      errors.push(
        ...this.lint(schema, basename(path)).map(([at, error]) => ({
          file: path,
          error: at + ": " + error,
        })),
        ...this.units(schema).map(([at, unit]) => ({
          file: path,
          error: `${at}: x-unit ${repr(unit)} is not an SI unit (or deg)`,
        })),
      );
    }
    return {
      valid: !errors.length,
      errors,
      records: this.records(filter).length,
    };
  }
  ownership(): Record<string, Row> {
    const path = join(this.tree, "generated.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  generated(path: string, dotted?: string): string | null {
    const owned =
      this.ownership()[relative(this.home, resolve(path)).split(sep).join("/")];
    if (
      !owned ||
      (dotted &&
        owned.keys?.length &&
        !owned.keys.some(
          (k: string) =>
            dotted === k ||
            dotted.startsWith(k + ".") ||
            k.startsWith(dotted + "."),
        ))
    )
      return null;
    return (
      owned.by + (owned.keys?.length ? " (" + owned.keys.join(", ") + ")" : "")
    );
  }
  own(path: string, by: string, keys?: string[]): void {
    path = this.inside(isAbsolute(path) ? path : join(this.tree, path));
    locked(join(this.tree, ".ownership"), () => {
      const owned = this.ownership();
      owned[relative(this.home, path).split(sep).join("/")] = {
        by,
        ...(keys?.length ? { keys } : {}),
      };
      atomic(
        join(this.tree, "generated.json"),
        JSON.stringify(owned, null, 2) + "\n",
      );
    });
  }
  new(
    kind: string,
    slug: string,
    opt: { root?: string; folder?: string } = {},
  ): NativeRecord {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(slug)) throw Error("Invalid record slug");
    const source =
        this.schemas().find(
          (s) =>
            (s.schema["x-kind"] ?? []).includes(kind) &&
            (!opt.root ||
              relative(this.tree, s.path).split(sep)[0] === opt.root),
        ) ?? this.schemaFor(kind),
      match = /^(?:standards|registry)\/([^<]+?)\/</.exec(
        source.schema.description ?? "",
      ),
      home = match ? join(this.tree, match[1]!) : null;
    let folder: string | undefined;
    if (opt.folder) {
      const first = opt.folder.split("/")[0]!;
      folder =
        existsSync(join(this.tree, first)) && /^[A-Z]/.test(first)
          ? join(this.tree, opt.folder)
          : home
            ? join(home, opt.folder)
            : undefined;
      if (!folder) throw Error("--folder must be a path from a registry root");
    } else
      folder =
        home ??
        this.records()
          .find((r) => r.kind === kind)
          ?.path.replace(/[^/]+$/, "");
    if (!folder)
      throw Error(
        `no ${kind} record yet to tell its folder: pass --folder=<dir>`,
      );
    const path = this.inside(join(folder, slug + ".yaml"));
    return locked(join(this.tree, ".new"), () => {
      if (existsSync(path)) throw Error(relative(this.home, path) + " exists");
      const text = slug.replaceAll("-", " "),
        record: Row = {
          identity: {
            key: kind + "." + slug,
            name: text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase(),
          },
        };
      for (const k of source.schema.required ?? [])
        if (k !== "identity") record[k] = null;
      for (const k of source.schema.properties?.identity?.required ?? [])
        record.identity[k] ??= "TODO";
      if (["project", "intake", "retrospective"].includes(kind))
        assign(record, this.home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        "# yaml-language-server: $schema=" +
          relative(dirname(path), source.path).split(sep).join("/") +
          "\n" +
          stringify(record, { lineWidth: 200 }),
        { flag: "wx" },
      );
      return {
        key: record.identity.key,
        name: record.identity.name,
        path,
        record,
        schema: source.path,
        root: relative(this.tree, path).split(sep)[0]!,
        kind,
      };
    });
  }
  set(key: string, dotted: string, yamlText: string): NativeRecord {
    return locked(join(this.tree, ".edit"), () => {
      const item = this.get(key),
        owner = this.generated(item.path, dotted);
      if (owner)
        throw Error(
          relative(this.home, item.path) +
            " is generated by " +
            owner +
            ": change it there and rerun it",
        );
      const first = readFileSync(item.path, "utf8").split("\n", 1)[0]!,
        value = parse(yamlText),
        rec = item.record;
      if (
        ["project", "intake", "retrospective"].includes(item.kind) &&
        ["identity", "identity.id"].includes(dotted)
      ) {
        const proposed = object(value) ? value.id : value;
        if (proposed !== rec.identity.id)
          throw Error("identity.id is permanent; it cannot be changed");
      }
      if (
        item.kind === "project" &&
        (dotted === "status" || dotted.startsWith("status."))
      ) {
        if (
          !update_status(
            rec,
            dotted === "status" ? value : { [dotted.slice(7)]: value },
          )
        )
          return item;
      } else {
        let node: any = rec;
        const parts = dotted.split(".");
        for (const part of parts.slice(0, -1)) {
          if (Array.isArray(node)) node = node[Number(part)];
          else {
            if (!Object.hasOwn(node, part))
              Object.defineProperty(node, part, {
                value: {},
                writable: true,
                enumerable: true,
                configurable: true,
              });
            node = node[part];
          }
        }
        const end = parts.at(-1)!;
        if (Array.isArray(node) && end === "+") node.push(value);
        else if (Array.isArray(node)) node[Number(end)] = value;
        else
          Object.defineProperty(node, end, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
      }
      atomic(
        item.path,
        (first.startsWith("#") ? first + "\n" : "") +
          stringify(rec, { lineWidth: 230 }),
      );
      return item;
    });
  }
  put(record: Row, opt: { path?: string; schema?: string } = {}): NativeRecord {
    const key = record.identity?.key;
    if (typeof key !== "string" || !key.includes("."))
      throw Error("Expected original identity.key");
    const old = this.records().find((r) => r.key === key);
    if (old) {
      if (this.generated(old.path)) throw Error("Record is generated: " + key);
      if (
        ["project", "intake", "retrospective"].includes(old.kind) &&
        record.identity.id !== old.record.identity.id
      )
        throw Error("identity.id is permanent; it cannot be changed");
    }
    const kind = key.split(".")[0]!,
      schema = opt.schema
        ? this.inside(resolve(this.tree, opt.schema))
        : (old?.schema ?? this.schemaFor(kind).path),
      path = opt.path ? this.inside(resolve(this.tree, opt.path)) : old?.path;
    if (!path)
      throw Error("New record put requires --path relative/to/record.yaml");
    const validation = this.validate(record, schema);
    if (!validation.valid) throw Error(validation.errors.join("; "));
    atomic(
      path,
      "# yaml-language-server: $schema=" +
        relative(dirname(path), schema).split(sep).join("/") +
        "\n" +
        stringify(record, { lineWidth: 230 }),
    );
    return this.get(key);
  }
  view(filter: RegistryFilter = {}): Row {
    return {
      records: this.records(filter).map((r) => r.record),
      files: this.records(filter).map((r) => ({
        key: r.key,
        path: r.path,
        schema: r.schema,
        generated: this.generated(r.path),
      })),
      schemas: this.schemas(),
      ownership: this.ownership(),
    };
  }
}
export function nativeRegistryCli(home: string, args: string[]): unknown {
  const r = new NativeRegistry(home),
    { positionals: p, values: v } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        kind: { type: "string" },
        root: { type: "string" },
        folder: { type: "string" },
        file: { type: "string" },
        path: { type: "string" },
        schema: { type: "string" },
        by: { type: "string" },
        keys: { type: "string" },
        paths: { type: "string" },
      },
    }),
    [command, key, dotted, value] = p,
    filter = { kind: v.kind, root: v.root };
  switch (command) {
    case "list":
      return r.records(filter).map((x) => x.record);
    case "find":
      return r.find(p.slice(1), filter);
    case "get":
    case "show":
      if (!key) throw Error("Record key required");
      return (
        "# " +
        relative(home, r.get(key).path) +
        (r.generated(r.get(key).path)
          ? "   (generated by " +
            r.generated(r.get(key).path) +
            ": change it there and rerun it)"
          : "   (hand-written: edit here or with registry set)") +
        "\n" +
        readFileSync(r.get(key).path, "utf8")
      );
    case "new":
      if (!key || !dotted) throw Error("new KIND SLUG");
      return r.new(key, dotted, { root: v.root, folder: v.folder });
    case "set":
      if (!key || !dotted || value === undefined)
        throw Error("set KEY PATH YAML_VALUE");
      return r.set(key, dotted, value);
    case "put":
      if (!v.file) throw Error("--file required");
      return r.put(parse(readFileSync(v.file, "utf8")), {
        path: v.path,
        schema: v.schema,
      });
    case "validate":
      if (v.file)
        return r.validate(
          parse(readFileSync(v.file, "utf8")),
          v.schema ? resolve(r.tree, v.schema) : undefined,
        );
      {
        const records = p.slice(1).map((k) => {
          const item = r.get(k);
          return {
            key: k,
            ...r.validate(item.record, item.schema ?? undefined),
          };
        });
        return { valid: records.every((record) => record.valid), records };
      }
    case "check":
      return r.check(filter);
    case "refs":
      if (!key) throw Error("Record key required");
      return r.refs(key);
    case "view":
      return r.view(filter);
    case "schema-list":
      return r.schemas();
    case "schema-show":
      if (!key) throw Error("Schema kind required");
      return r.schemaFor(key);
    case "schema-lint":
      return r
        .schemas()
        .flatMap((s) =>
          r
            .lint(s.schema, basename(s.path))
            .map(([path, error]) => ({ file: s.path, path, error })),
        );
    case "own":
      if (!key || !v.by) throw Error("own KEY --by TOOL [--keys FIELD,...]");
      r.own(r.get(key).path, v.by, (v.keys ?? v.paths)?.split(","));
      return r.ownership();
    default:
      throw Error(
        "Native registry commands: list, find, show, new, set, put, validate, check, refs, view, schema-list, schema-show, schema-lint, own",
      );
  }
}
