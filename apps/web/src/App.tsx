import { useEffect, useRef } from "react";
import { AnnouncerProvider } from "./hooks/useAnnounce.js";
import { ConfigProvider, useConfig } from "./hooks/useConfig.js";
import { Notice } from "./components/Notice.js";
import { PlaybooksScreen } from "./screens/Playbooks.js";
import { ReviewScreen } from "./screens/Review.js";
import { StartScreen } from "./screens/Start.js";
import { TokenGate } from "./screens/TokenGate.js";
import { useRoute, type Route } from "./router.js";
import { ServicesProvider, useServices, useTokenState, type Services } from "./services.js";

export function App(props: { services: Services }) {
  return (
    <ServicesProvider services={props.services}>
      <AnnouncerProvider>
        <Shell />
      </AnnouncerProvider>
    </ServicesProvider>
  );
}

function Shell() {
  const { tokens } = useServices();
  const { state, reload } = useConfig();
  const tokenState = useTokenState();
  const route = useRoute();
  const main = useRef<HTMLElement>(null);

  // A new screen starts at its top and a screen reader hears its heading: focus goes to the page.
  const routeKey = route.name === "review" ? `review:${route.id}` : route.name;
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    main.current?.focus();
  }, [routeKey]);

  const config = state.status === "ready" ? state.config : null;
  const needsToken =
    config !== null &&
    (tokenState.demanded ||
      tokenState.refused ||
      (config.authRequired && tokenState.token === null));

  return (
    <div className="shell">
      <button type="button" className="skip-link" onClick={() => main.current?.focus()}>
        Skip to the page content
      </button>
      <header className="site-header">
        <a className="brand" href="#/">
          Clausewise
        </a>
        {config !== null && !needsToken ? (
          <nav className="site-nav" aria-label="Main">
            <a href="#/" {...current(route, "start", "review")}>
              Reviews
            </a>
            <a href="#/playbooks" {...current(route, "playbooks")}>
              Playbooks
            </a>
          </nav>
        ) : null}
        {tokenState.token !== null ? (
          <button type="button" className="link-button" onClick={() => tokens.clear()}>
            Forget the access token
          </button>
        ) : null}
      </header>

      <main id="main" ref={main} tabIndex={-1} className="page">
        {state.status === "loading" ? (
          <p className="muted" aria-busy="true">
            Connecting to the server...
          </p>
        ) : null}
        {state.status === "error" ? (
          <Notice kind="error" title="Clausewise could not reach its server">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={reload}>
              Try again
            </button>
          </Notice>
        ) : null}
        {config !== null ? (
          needsToken ? (
            <TokenGate />
          ) : (
            <ConfigProvider config={config}>
              <RouteView route={route} />
            </ConfigProvider>
          )
        ) : null}
      </main>

      <footer className="site-footer">
        <p>
          Findings come from a language model and can be wrong. Read every one before you rely on
          it. Clausewise is not legal advice.
          {config === null ? "" : ` Version ${config.version}.`}
        </p>
      </footer>
    </div>
  );
}

function current(route: Route, ...names: Route["name"][]): { "aria-current"?: "page" } {
  return names.includes(route.name) ? { "aria-current": "page" } : {};
}

function RouteView(props: { route: Route }) {
  const { route } = props;
  switch (route.name) {
    case "start":
      return <StartScreen />;
    case "review":
      return <ReviewScreen key={route.id} reviewId={route.id} />;
    case "playbooks":
      return <PlaybooksScreen />;
    case "not-found":
      return (
        <div>
          <h1>There is nothing at this address</h1>
          <p>
            <a href="#/">Go to the start page</a>
          </p>
        </div>
      );
  }
}
