# Clausewise: the server and the web app in one image.
#
#   docker build -t clausewise .
#
# Two stages. "build" installs from the lock file, builds the web app, bundles the server and
# starts the result once to see that it answers. "runtime" copies only what runs: the bundle, the
# two packages it cannot contain, the web app, the playbooks and the licence files. No source,
# test, fixture, evaluation or environment file is copied into it.
#
# The base image is pinned by tag and minor version. To pin it by digest as well, pass
#   --build-arg NODE_IMAGE=node:22.23-bookworm-slim@sha256:<digest>
ARG NODE_IMAGE=node:22.23-bookworm-slim

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

# pnpm comes from Corepack, at the version the packageManager field of package.json names. The
# default would ask before downloading it, which a build cannot answer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /src

# The manifests first, so that the install layer is rebuilt only when a dependency changes. The
# lock file lists every project of the workspace, so every project needs its manifest here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY evals/package.json evals/
COPY packages/api/package.json packages/api/
COPY packages/docx/package.json packages/docx/
COPY packages/llm/package.json packages/llm/
COPY packages/playbook/package.json packages/playbook/
COPY packages/review/package.json packages/review/

# Build scripts of dependencies do not run: pnpm 10 skips them unless the workspace allows them,
# and this one allows none.
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
COPY playbooks playbooks
COPY LICENSE NOTICE ./

RUN pnpm --filter @clausewise/web build \
 && pnpm --filter @clausewise/server build

# pnpm 10 deploys a workspace package only when the workspace injects its packages, unless it is
# asked for the older way. The older way keeps the versions of the lock file and copies the
# workspace packages in. The bundle contains them already, so the folder is then cut down to the
# two packages it still loads (see apps/server/build.mjs).
RUN pnpm --filter @clausewise/server deploy --legacy --prod /deploy \
 && node apps/server/build.mjs prune /deploy

# The tree as the final stage will have it, started once with the settings the image makes.
RUN mkdir /app \
 && cp -a /deploy/node_modules /app/node_modules \
 && cp -a apps/server/dist /app/dist \
 && cp -a apps/web/dist /app/web \
 && cp -a playbooks /app/playbooks \
 && cp LICENSE NOTICE /app/ \
 && node apps/server/build.mjs check /app

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Clausewise" \
      org.opencontainers.image.description="Self-hosted contract review and redlining" \
      org.opencontainers.image.licenses="Apache-2.0"

# HOST is the address inside the container. The container's port is reachable from outside only
# where the person who starts it publishes it (docker-compose.yml publishes it on 127.0.0.1).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CLAUSEWISE_DATA_DIR=/data \
    CLAUSEWISE_PLAYBOOKS_DIR=/app/playbooks \
    CLAUSEWISE_WEB_DIR=/app/web

WORKDIR /app
COPY --from=build /app /app

# Documents and the embedded database live here. The folder is made before VOLUME so that a new
# volume starts out owned by the node user, which the server runs as.
RUN mkdir /data && chown node:node /data && chmod 700 /data
VOLUME /data

USER node
EXPOSE 8787

# No curl in the image: Node asks for /healthz itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The server stops itself on SIGTERM. Start the container with an init process (docker run
# --init, or init: true in Compose) so that nothing it starts can be left as a zombie.
CMD ["node", "dist/main.mjs"]
