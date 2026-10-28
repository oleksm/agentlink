/** Original probe records and agent-executed file-mail ping/ack protocol. */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  Agentmsg,
  CONTROLLER,
  probe_result,
  parse,
  type CommandResult,
} from "./agentmsg.js";
import { locked, atomic } from "./records.js";
import { sleep } from "./project_runtime_ports.js";
import type { RecordData } from "./common.js";
export { probe_result };
const read = (home: string, id: string): RecordData | null => {
  if (!/^probe-[0-9a-f]{16}$/.test(id)) return null;
  const path = join(home, "probes", id + ".json");
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
};
function save(home: string, p: RecordData): void {
  atomic(join(home, "probes", p.id + ".json"), JSON.stringify(p, null, 2));
}
export function probe(
  home: string,
  args: RecordData,
): { result: RecordData; output: string; exitCode: number } {
  const mail = new Agentmsg(home);
  let p: RecordData;
  if (args.check) {
    const found = read(home, args.check);
    if (!found) throw Error("unknown probe");
    p = found;
  } else {
    const a = args.a ? mail.canonical(args.a) : "",
      b = args.b ? mail.canonical(args.b) : "";
    if (!a || !b || a === b)
      throw Error("probe requires two different configured agents");
    const c = mail.conf();
    if (!c[a] || !c[b]) throw Error("both agents must be registered");
    const id = "probe-" + randomBytes(8).toString("hex");
    p = {
      id,
      a,
      b,
      created_at: new Date().toISOString(),
      expires: Date.now() / 1000 + 3600,
      requests: {},
    };
    save(home, p);
    for (const name of [a, b]) {
      const message = mail.send([name, "task"], {
        as: CONTROLLER,
        summary:
          "Connection test only. Run agentlink msg probe-send " +
          id +
          " --as " +
          name +
          ". This sends your peer a ping; it must acknowledge. No project work.",
      });
      p.requests[name] = message.id;
    }
    save(home, p);
  }
  const deadline = performance.now() / 1000 + (Number(args.wait) || 0);
  let result: RecordData;
  for (;;) {
    result = probe_result(p, mail.messages());
    if (result.state !== "PENDING" || performance.now() / 1000 >= deadline)
      break;
    sleep(Math.min(1, Math.max(0, deadline - performance.now() / 1000)));
  }
  return {
    result,
    output:
      JSON.stringify(result, null, 2) +
      (result.state !== "PASS"
        ? "\nCheck later: agentlink msg probe --check " + p.id + " --wait 60"
        : ""),
    exitCode: result.state === "PASS" ? 0 : 1,
  };
}
export function probe_actor(
  home: string,
  args: RecordData,
  ack = false,
): string {
  const mail = new Agentmsg(home),
    p = read(home, args.id),
    who = mail.me(args.as_name ? { as: args.as_name } : {});
  if (!p || ![p.a, p.b].includes(who) || Date.now() / 1000 > p.expires)
    throw Error("unknown/expired probe or wrong agent identity");
  const peer = who === p.a ? p.b : p.a;
  locked(join(home, "run", args.id + ".lock"), () => {
    const messages = mail.messages(),
      send = (
        to: string,
        kind: string,
        summary: string,
        extra: RecordData = {},
      ) => mail.send([to, kind], { as: who, summary, ...extra });
    if (ack) {
      const ping = messages.find((m) => m.id === args.message);
      if (
        !ping ||
        ping.from !== peer ||
        ping.to !== who ||
        ping.ref !== p.id ||
        ping.kind !== "task"
      )
        throw Error("ping does not match this probe and recipient");
      if (
        !messages.some(
          (m) => m.kind === "ack" && m.reply_to === ping.id && m.from === who,
        )
      ) {
        send(
          peer,
          "ack",
          "PONG " + p.id + ": " + who + " received " + peer + "'s ping",
          { ref: p.id, "reply-to": ping.id },
        );
        send(peer, "done", "Connection acknowledgement recorded for " + p.id, {
          ref: p.id,
          "reply-to": ping.id,
        });
      }
    } else {
      if (
        !messages.some(
          (m) =>
            m.from === who &&
            m.to === peer &&
            m.ref === p.id &&
            m.kind === "task",
        )
      )
        send(
          peer,
          "task",
          "PING " +
            p.id +
            ". Acknowledge message: agentlink msg probe-ack " +
            p.id +
            " <THIS_MESSAGE_ID> --as " +
            peer +
            ". Substitute this task's actual message id. No project work.",
          { ref: p.id },
        );
      const request = p.requests[who!];
      if (
        request &&
        !messages.some(
          (m) => m.reply_to === request && m.from === who && m.kind === "done",
        )
      )
        send(CONTROLLER, "done", "Ping sent for " + p.id, {
          "reply-to": request,
        });
    }
  });
  return ack
    ? "Acknowledgement recorded"
    : "Ping sent; awaiting peer acknowledgement";
}
export function probe_cli(
  home: string,
  args: string[],
  actor?: string,
): CommandResult | undefined {
  const [command, ...rest] = args;
  if (!["probe", "probe-send", "probe-ack"].includes(command || "")) return;
  const [pos, opt] = parse(rest);
  if (command === "probe") {
    const wait = opt.wait === undefined ? 0 : Number(opt.wait);
    if (!Number.isFinite(wait)) throw Error("--wait requires a number");
    const { output, exitCode } = probe(home, {
      a: pos[0],
      b: pos[1],
      check: opt.check,
      wait,
    });
    return { output, exitCode };
  }
  if (!pos[0] || (command === "probe-ack" && !pos[1]))
    throw Error(
      command === "probe-ack" ? "probe-ack ID MESSAGE" : "probe-send ID",
    );
  return {
    output: probe_actor(
      home,
      { id: pos[0], message: pos[1], as_name: opt.as || actor },
      command === "probe-ack",
    ),
    exitCode: 0,
  };
}

/** Native protocol readiness uses the original probe files and file-mail history. */
export function probe_passed(home: string, name: string): boolean {
  const directory = join(home, "probes");
  if (!existsSync(directory)) return false;
  const messages = new Agentmsg(home).messages();
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .some((file) => {
      const p = read(home, file.slice(0, -5));
      return (
        !!p &&
        [p.a, p.b].includes(name) &&
        probe_result(p, messages).state === "PASS"
      );
    });
}
