import { azureServiceDeps, readIdentity, readPostgres, readStorage } from "@clausewise/azure";
import { createObjectGenerator, loadLlmConfig, type ObjectGenerator } from "@clausewise/llm";
import { runWorker, type JobOutcome, type ReviewWorkerDeps } from "@clausewise/service";
import { directoryPlaybooks } from "@clausewise/service/node";

type Env = Record<string, string | undefined>;

export interface AzureWorkerOptions {
  env: Env;
  playbooksDir: string;
  /** For tests: the model. Default: the one the environment configures. */
  generator?: ObjectGenerator;
  /** For tests: the network to Azure Storage and to the token service. */
  fetch?: typeof globalThis.fetch;
  idleMs?: number;
  onOutcome?: (reviewId: string, outcome: JobOutcome) => void;
  onError?: (reviewId: string, error: unknown) => void;
  onInvalidJob?: () => void;
}

/**
 * The worker as it runs in the firm's Azure tenant: it takes review jobs off the queue and runs
 * them against Blob Storage and PostgreSQL, signed in as the worker's own managed identity, with
 * the model the environment configures (azure-openai, keyless, in the deployment). Every setting
 * is read and checked before the first job is taken.
 */
export function startAzureWorker(options: AzureWorkerOptions): {
  disclosure: string;
  stop(): Promise<void>;
} {
  const identity = readIdentity(options.env);
  const storage = readStorage(options.env);
  const postgres = readPostgres(options.env);

  let generator = options.generator;
  let limits: ReviewWorkerDeps["limits"] = {};
  if (generator === undefined) {
    const config = loadLlmConfig(options.env);
    generator = createObjectGenerator(config);
    limits = {
      concurrency: config.concurrency,
      ...(config.maxContextTokens === undefined
        ? {}
        : { maxContextTokens: config.maxContextTokens }),
    };
  }

  const { pool, queue, ...stores } = azureServiceDeps(identity, storage, postgres, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onInvalidJob === undefined ? {} : { onInvalidJob: options.onInvalidJob }),
  });
  const stopping = new AbortController();
  const loop = runWorker({
    queue,
    deps: { ...stores, playbooks: directoryPlaybooks(options.playbooksDir), generator, limits },
    signal: stopping.signal,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.onOutcome === undefined ? {} : { onOutcome: options.onOutcome }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  return {
    disclosure: generator.disclosure,
    async stop() {
      // A review in progress is handed back to the queue, for another worker to take at once.
      stopping.abort(new Error("The worker is stopping."));
      await loop;
      await pool.end();
    },
  };
}
