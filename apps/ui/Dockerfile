# --- Stage 1: build the SPA ----------------------------------------------------
# The build context is the repo root (Coolify passes base_directory=/), so the whole
# workspace is present and the UI resolves its workspace dependencies from source:
# @autonoma/blacklight and @autonoma/types export ./src, and @autonoma/api only
# exports "./router" as types pointing at src/routes/router.ts. That is why nothing
# but the UI itself has to be built here.
FROM node:24-alpine AS builder

# corepack reads the pnpm version from the root package.json (packageManager), which
# is the version the lockfile was written with.
RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

# Declared after the install so that changing a build arg does not invalidate the
# dependency layer.
#
# Vite inlines import.meta.env.VITE_* at build time and reads them from the process
# environment (vite's envDir is the repo root, and .dockerignore keeps every .env out
# of the context), so each one has to be promoted from build arg to environment
# variable before `vite build` runs. An empty value is not an error: apps/ui/src/env.ts
# treats "" as unset and falls back to the defaults written there.
#
# Values the deployment must supply rather than inherit from those defaults:
#   VITE_API_URL          the API origin the SPA calls; the default localhost:4000 is
#                         only ever right on a developer machine.
#   VITE_SENTRY_URL       Sentry web origin, needed for readable stack links.
#   VITE_SENTRY_DSN       without it the SPA ships with no error reporting.
#   VITE_POSTHOG_KEY      without it the SPA ships with no analytics.
#   VITE_TEMPORAL_URL     without it the workflow UI has no Temporal endpoint to link to.
# VITE_INTERNAL_DOMAIN and VITE_TEMPORAL_NAMESPACE have usable defaults ("autonoma.app"
# and "default") and only need overriding on a deployment that differs from them.
#
# BuildKit flags every ARG/ENV named like a credential, including VITE_POSTHOG_KEY; the
# warning is expected and harmless, since a VITE_ variable is compiled into the bundle
# that every visitor downloads anyway.
ARG VITE_API_URL
ARG VITE_INTERNAL_DOMAIN
ARG VITE_TEMPORAL_URL
ARG VITE_TEMPORAL_NAMESPACE
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_URL
ARG VITE_POSTHOG_KEY
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_INTERNAL_DOMAIN=${VITE_INTERNAL_DOMAIN} \
    VITE_TEMPORAL_URL=${VITE_TEMPORAL_URL} \
    VITE_TEMPORAL_NAMESPACE=${VITE_TEMPORAL_NAMESPACE} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_SENTRY_URL=${VITE_SENTRY_URL} \
    VITE_POSTHOG_KEY=${VITE_POSTHOG_KEY}

RUN pnpm --filter @autonoma/ui build

# --- Stage 2: serve the built SPA ---------------------------------------------
FROM nginx:alpine
# Paths are relative to the repo root, which is the build context.
COPY apps/ui/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/apps/ui/dist/ /usr/share/nginx/html/

EXPOSE 3000

# The official entrypoint rewrites the template with envsubst once, at container start,
# and only for variables that exist in the environment then: NGINX_ENVSUBST_FILTER keeps
# it away from nginx's own $host, $remote_addr, ... . API_UPSTREAM is what the template
# interpolates into `proxy_pass http://${API_UPSTREAM}` (bare host[:port], no scheme), so
# the deployment has to set it on the container (a Coolify environment variable of the
# app); if it is missing the literal placeholder survives into the generated config and
# nginx refuses to start. nginx also resolves that hostname at startup, so it has to be
# resolvable from the container at that moment.
ENV NGINX_ENVSUBST_FILTER=API_UPSTREAM
