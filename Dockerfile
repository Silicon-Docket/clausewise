# The Clausewise server image: the web app, the worker and the migrate job, chosen by the
# command (web unless told otherwise). One image, so all three always run the same release.
#
#   docker build -t clausewise-server .
#   docker run clausewise-server worker
#
# It runs only in azure mode and needs the settings in deploy/azure/README.md. Base images are
# pinned by digest; update them on purpose, not by rebuilding.

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /src
# The lockfile alone is enough to fetch every package, so this layer is reused until it changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# The release this image is, as its SBOM (/app/sbom.cdx.json) names it.
ARG CLAUSEWISE_VERSION=dev
RUN pnpm install --frozen-lockfile --offline && pnpm bundle:server /out

# No shell and no package manager: only Node, CA certificates and the bundles.
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
LABEL org.opencontainers.image.title="Clausewise server" \
      org.opencontainers.image.description="Clausewise web app, review worker and database migrations, for Azure Container Apps" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/Silicon-Docket/clausewise"
WORKDIR /app
COPY --from=build /out/ /app/
ENV NODE_ENV=production CLAUSEWISE_WEB_MODE=azure
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "/app/server.mjs"]
CMD ["web"]
