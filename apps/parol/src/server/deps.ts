import type { Repository } from "../store/index.js";
import type { Services } from "../services/types.js";

export interface AppConfig {
  /**
   * The demo identity mechanism: pick a seeded user from a list, no password. It is not
   * authentication. It is on only when PAROL_DEMO_IDENTITY=1, and then the server binds to
   * 127.0.0.1 and nothing else.
   */
  demoIdentity: boolean;
  /** Signs the session cookie and the CSRF tokens. Generated at start-up when not given. */
  cookieSecret: string;
  /** Whether the connection is https, so the session cookie gets `Secure`. */
  secureCookies: boolean;
  /** Largest accepted upload body, in bytes. */
  maxUploadBytes: number;
  /**
   * Single-person demo: one user may both prepare and review, and the memo says so. The route
   * layer reads it so the role table it checks is the same one the services check. Absent means
   * off, which is the setting for every real use.
   */
  relaxedSegregation?: boolean;
}

export interface AppDeps {
  repo: Repository;
  services: Services;
  config: AppConfig;
  now: () => Date;
}
