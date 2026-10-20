// Run by proxy.test.ts in a fresh Node process: makes real fetch calls under the environment the
// parent set up and says what envProxyFor predicted for each, so the two can be compared.
import { envProxyFor } from "../src/proxy.js";

const cases = JSON.parse(process.argv[2] ?? "[]") as { url: string; noProxy?: string }[];

for (const { url, noProxy } of cases) {
  if (noProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = noProxy;
  const predicted = envProxyFor(new URL(url));
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    // The parent only looks at whether a proxy saw the request.
  }
  console.log(JSON.stringify({ url, predicted: predicted ?? null }));
}
