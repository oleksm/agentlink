import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { registryPageData, registryPageStamp } from "./registry-page.js";
import { acquireDirectoryLock } from "./locks.js";
import { mkdirSync } from "node:fs";
import { Records } from "./standard-workflow/records.js";
import * as ownerActions from "./standard-workflow/project_owner_actions.js";
import { catalog } from "./standard-workflow/project_files.js";
import {
  configureNativeWorkspace,
} from "./standard-workflow/platform.js";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import {renderPublication,publication} from './standard-workflow/page_publish.js';
import {existsSync,statSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,extname} from 'node:path';
import {NativeRegistry} from './standard-workflow/native_registry.js';

const assets = new Map([
  [
    "/api/project-actions.js",
    ["project-actions.js", "text/javascript; charset=utf-8"],
  ],
  [
    "/api/dev-projects.js",
    ["registry-live.js", "text/javascript; charset=utf-8"],
  ],
]);
export function createRegistryServer(store: Store): Server {
  configureNativeWorkspace(store, "project-manager");
  const records = new Records(store.home);
  const registry = new NativeRegistry(store.home);
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const address = req.socket.localPort;
      const hosts = [`127.0.0.1:${address}`, `localhost:${address}`];
      if (
        !hosts.includes(req.headers.host ?? "") ||
        (req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`)
      )
        return respond(403, { error: "Local same-origin access required" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/api/state") {
        const native = records.list();
        return respond(200, {
          name: store.config().name,
          revision: registryPageData(store).revision,
          token,
          projects: native.filter((r) => r.identity.key.startsWith("project.")),
          intakes: native.filter((r) => r.identity.key.startsWith("intake.")),
          retrospectives: native.filter((r) =>
            r.identity.key.startsWith("retrospective."),
          ),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/dev-projects")
        return respond(200, registryPageData(store));
      if (
        req.method === "GET" &&
        /^\/api\/projects\/[a-z][a-z0-9-]{0,62}\/actions$/.test(url.pathname)
      ) {
        try {
          return respond(200, {
            ...ownerActions.snapshot(
              records.read("project." + url.pathname.split("/")[3]!),
            ),
            token,
          });
        } catch (error) {
          return respond(404, { error: (error as Error).message });
        }
      }
      if (
        req.method === "GET" &&
        /^\/api\/files\/[a-f0-9]{24}$/.test(url.pathname)
      ) {
        const key = "doc:" + url.pathname.split("/").at(-1)!,
          files = catalog(store.home, records.list(), true);
        const path = files.project_file_paths[key];
        if (!path) return respond(404, { error: "Unknown referenced file" });
        if (url.searchParams.get("download") !== "1")
          return respond(200, { key, html: files.project_documents[key] });
        const data = readFileSync(path);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="artifact"',
          "Cache-Control": "no-store",
        });
        res.end(data);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/registry")
        return respond(
          200,
          registry.view({
            kind: url.searchParams.get("kind") ?? undefined,
            root: url.searchParams.get("root") ?? undefined,
          }),
        );
      if (req.method === "GET" && url.pathname === "/api/registry/check")
        return respond(200, registry.check());
      if (req.method === "GET" && url.pathname === "/api/registry/schemas")
        return respond(200, registry.schemas());
      if (req.method === "GET" && url.pathname === "/api/registry/record") {
        const key = url.searchParams.get("key") ?? "";
        return respond(
          200,
          /^(project|intake|retrospective)\./.test(key)
            ? records.read(key)
            : registry.get(key).record,
        );
      }
      if (req.method === "GET" && url.pathname === "/health")
        return respond(200, {
          ok: true,
          pid: process.pid,

        });
      if (
        req.method === "GET" &&
        /^\/api\/evidence\/[a-f0-9]{64}$/.test(url.pathname)
      ) {
        const digest = url.pathname.split("/").at(-1)!;
        const proof = records
          .list()
          .flatMap((r) => r.evidence ?? [])
          .find((e) => e.sha256 === digest && typeof e.location === "string");
        if (!proof) return respond(404, { error: "Unknown evidence" });
        const data = readFileSync(proof.location);
        if (createHash("sha256").update(data).digest("hex") !== digest)
          return respond(409, {
            error: "Evidence snapshot changed; cannot serve verified evidence",
          });
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="evidence"',
          "Cache-Control": "no-store",
        });
        res.end(data);
        return;
      }
      if (
        req.method === "POST" &&
        /^\/api\/projects\/[a-z][a-z0-9-]{0,62}\/actions$/.test(url.pathname)
      ) {
        const supplied = req.headers["x-owner-token"];
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          typeof supplied !== "string" ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return respond(403, { error: "Owner session required" });
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          return respond(415, { error: "JSON required" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 20000)
            return respond(413, { error: "Request too large" });
        }
        const input = JSON.parse(body);
        if (!input || typeof input !== "object" || Array.isArray(input))
          return respond(400, { error: "Expected an object" });
        const name = url.pathname.split("/")[3]!;
        try {
          const result = ownerActions.submit(name, input, store.home);
          setImmediate(() => {
            try {
            } catch (error) {
              console.error(
                "Registry rebuild failed:",
                (error as Error).message,
              );
            }
          });
          return respond(200, {
            ...result,
            token,
            saved: true,
            message:
              "Saved to the project. Workflow notification and page refresh follow automatically.",
          });
        } catch (error) {
          return respond(409, { error: (error as Error).message });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/registry-page") {
        const etag='"'+registryPageStamp(store)+'"';res.setHeader('ETag',etag);
        res.setHeader('Cache-Control','no-cache');res.setHeader('Vary','Accept-Encoding');
        if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
        const body=JSON.stringify(registryPageData(store));res.setHeader('Content-Type','application/json');
        if(/\bgzip\b/.test(req.headers['accept-encoding']||'')){res.setHeader('Content-Encoding','gzip');res.end(gzipSync(body));}else res.end(body);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const { html, nonce } = renderPublication(store);
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'self'; script-src 'self' 'nonce-${nonce}'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
        );
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          html.replace(
            "</body>",
            '<script src="/api/project-actions.js"></script></body>',
          ),
        );
        return;
      }
      const asset = assets.get(url.pathname);
      if (req.method === "GET" && asset) {
        res.writeHead(200, {
          "Content-Type": asset[1]!,
          "Cache-Control": "no-store",
        });
        res.end(
          readFileSync(
            fileURLToPath(new URL(`../web/${asset[0]}`, import.meta.url)),
          ),
        );
        return;
      }
      const spec=publication(store.home);
      if(req.method==="GET"&&spec&&!url.pathname.startsWith('/api/')){
       const candidate=resolve(spec.directory,'.'+decodeURIComponent(url.pathname));
       if(existsSync(candidate)){const file=realpathSync(candidate),rel=relative(spec.directory,file);if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&statSync(file).isFile()){const mime:Record<string,string>={'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.css':'text/css','.js':'text/javascript','.json':'application/json','.yaml':'text/plain','.html':'text/html'};res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));return;}}
      }
      respond(404, { error: "Not found" });
    } catch (error) {
      respond(400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return server;
}
export async function serve(
  store: Store,
  options: { port?: number; workflow?: boolean; headless?: boolean } = {},
): Promise<Server> {
  const config = store.config();
  mkdirSync(join(store.home, "runtime"), { recursive: true });
  const unlock = acquireDirectoryLock(
    join(store.home, "runtime/controller.lock"),
  );
  let released = false,
    closed = false,
    busy = false;
  const release = () => {
    if (!released) {
      released = true;
      unlock();
    }
  };
  let server: Server;
  try {
    server = (options.headless ?? config.headless) ? createServer((req,res)=>{
      res.setHeader("Content-Type","application/json");
      if(req.method==="GET" && req.url==="/health") res.end(JSON.stringify({ok:true,pid:process.pid}));
      else {res.statusCode=404;res.end(JSON.stringify({error:"Headless controller"}));}
    }) : createRegistryServer(store);
  } catch (error) {
    release();
    throw error;
  }
  server.once("close", () => {
    closed = true;
    if (!busy) release();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? config.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    release();
    throw error;
  }
  if (options.workflow) {
    let mailController: ReturnType<typeof spawn> | undefined;
    let mailRestart: ReturnType<typeof setTimeout> | undefined;
    const startMail = () => {
      if (closed) return;
      mailController = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./cli.js", import.meta.url)),
          "--home",
          store.home,
          "msg",
          "serve",
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      mailController.on("error", (error) =>
        console.error("Mail controller:", error),
      );
      mailController.once("close", (code, signal) => {
        if (closed) return;
        console.error("Mail controller stopped:", code ?? signal);
        mailRestart = setTimeout(startMail, 5000);
        mailRestart.unref();
      });
    };
    startMail();
    server.once("close", () => {
      clearTimeout(mailRestart);
      mailController?.kill("SIGTERM");
      const child=mailController;
      const force=setTimeout(()=>{if(child && child.exitCode===null)child.kill("SIGKILL");},2000);force.unref();
    });
    const cycle = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        // Workflow work is synchronous and can be slow; never block Registry HTTP requests.
        await new Promise<void>((resolve,reject)=>{
          const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),'--home',store.home,'--as','project-manager','workflow','tick','--all'],{stdio:['ignore','inherit','inherit']});
          child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Workflow process exited '+code)));
        });
      } catch (error) {
        console.error("Control cycle failed:", (error as Error).message);
      } finally {
        busy = false;
        if (closed) release();
      }
    };
    const timer = setInterval(() => {
      void cycle();
    }, config.tickSeconds * 1000);
    void cycle();
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }
  return server;
}
