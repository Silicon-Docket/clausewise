import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { ObjectGenerator } from "@clausewise/llm";
import {
  createReviewService,
  runWorker,
  type ReviewWorkerDeps,
  type User,
} from "@clausewise/service";
import { memoryBlobs, memoryQueue, memoryRecords } from "@clausewise/service/memory";
import { directoryPlaybooks } from "@clausewise/service/node";
import { createHandler, type Authenticator } from "./handler.js";

export interface LocalOptions {
  playbooksDir: string;
  generator: ObjectGenerator;
  limits?: ReviewWorkerDeps["limits"];
  /** Default 8787. 0 picks a free port. */
  port?: number;
  onError?: (error: unknown) => void;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_USER: User = { id: "local" };

/**
 * The only sign-in local mode has: the request must come from this machine and name this server
 * by its loopback address. The Host check stops a web page in the user's own browser from reaching
 * the server through a domain that resolves to 127.0.0.1 (DNS rebinding), which the address check
 * alone would let through.
 */
export function loopbackAuthenticator(port: () => number): Authenticator {
  return async (request: IncomingMessage) => {
    const remote = request.socket.remoteAddress;
    if (remote === undefined || !LOOPBACK_ADDRESSES.has(remote)) return undefined;
    const host = request.headers.host?.toLowerCase();
    const allowed = [`127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`];
    return host !== undefined && allowed.includes(host) ? LOCAL_USER : undefined;
  };
}

/**
 * Runs Clausewise on this machine: the API on 127.0.0.1 only, the worker in the same process, and
 * everything kept in memory until the process stops. This is for trying the web flow and for
 * development. Anything reachable from another machine needs Entra ID sign-in.
 */
export async function startLocal(options: LocalOptions): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const deps = {
    records: memoryRecords(),
    contracts: memoryBlobs(),
    results: memoryBlobs(),
    queue: memoryQueue(),
    playbooks: directoryPlaybooks(options.playbooksDir),
  };
  const service = createReviewService(deps);
  let port = 0;
  const handler = createHandler({
    service,
    authenticate: loopbackAuthenticator(() => port),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  const stop = new AbortController();
  const worker = runWorker({
    queue: deps.queue,
    deps: {
      ...deps,
      generator: options.generator,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    },
    signal: stop.signal,
    idleMs: 200,
    ...(options.onError === undefined ? {} : { onError: (_id, error) => options.onError?.(error) }),
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      stop.abort(new Error("The local server is stopping."));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker;
    },
  };
}
