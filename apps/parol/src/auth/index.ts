/**
 * Everything a route or a page needs from the authentication and authorization layer, from one
 * place. `AuthorizedMatter` can be named here but only `authorizeMatter` and
 * `authorizeMatterDelete` make one.
 */
export { MATTER_ACTIONS, roleAllows, type MatterAction } from "./actions.js";
export { authorizeMatter, authorizeMatterDelete, type AuthorizeConfig } from "./authorize.js";
export {
  ANON_COOKIE,
  CSRF_HEADER,
  CsrfError,
  csrfToken,
  isUnsafeMethod,
  verifyCsrf,
} from "./csrf.js";
export {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  clearSession,
  issueSession,
  readPrincipal,
} from "./identity.js";
export type { AuthorizedMatter, Principal } from "./types.js";
