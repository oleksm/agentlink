import { createHash } from "node:crypto";
export type RecordData = Record<string, any>;
/** Python json.dumps(sort_keys=True), including its default separators and ASCII escaping. */
export function json_sorted(value: any): string {
  const encode = (v: any): string =>
    v === undefined
      ? "null"
      : v === null
        ? "null"
        : Array.isArray(v)
          ? "[" + v.map(encode).join(", ") + "]"
          : typeof v === "object"
            ? "{" +
              Object.keys(v)
                .sort()
                .map((k) => encode(k) + ": " + encode(v[k]))
                .join(", ") +
              "}"
            : JSON.stringify(v).replace(
                /[\u007f-\uffff]/g,
                (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
              );
  return encode(value);
}
export const sha256 = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export const active_criteria = (rec: RecordData): RecordData[] =>
  rec.acceptance_criteria.filter((c: RecordData) => c.result !== "deferred");
export const delivery = (rec: RecordData, cid: string): RecordData =>
  [...rec.events]
    .reverse()
    .find((e: RecordData) => e.criterion === cid && e.status) || {};
export const state = (rec: RecordData, cid: string): string =>
  delivery(rec, cid).status || "not started";
export function representative(rec: RecordData): string {
  const matches = (rec.workers || []).filter(
    (w: RecordData) => w.source?.identity === rec.identity.submitted_by,
  );
  if (matches.length !== 1)
    throw Error(
      "project needs exactly one temporary requestor representative; never route review to a root",
    );
  return matches[0].id;
}
export const epoch = (value: any): number => {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n / 1000 : 0;
};
