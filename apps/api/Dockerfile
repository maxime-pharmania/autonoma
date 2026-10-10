# syntax=docker/dockerfile:1

# Build stage: the API bundle (tsup) is produced here, because .dockerignore keeps
# every dist/ out of the build context, so the runtime image can never receive a
# prebuilt one from the host.
FROM platformatic/node-caged:25-alpine AS builder

WORKDIR /app

# The base image ships npm only; the workspace is pinned to pnpm (packageManager in
# the root package.json), so install that exact version rather than relying on corepack.
RUN npm install -g pnpm@12.3.1

# prisma generate only needs a well-formed URL, never a reachable database; the value
# is overridable so a build can point at the real one without editing this file.
ARG DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
ENV DATABASE_URL=$DATABASE_URL

# Copy the whole workspace: pnpm resolves the lockfile against every importer listed
# in the context, so partial manifests would make --frozen-lockfile fail.
COPY . .

# '@autonoma/api...' selects the API and its transitive workspace dependencies; the
# db package's postinstall generates the Prisma client into packages/db/src/generated.
RUN pnpm install --frozen-lockfile --filter @autonoma/api...

RUN pnpm --filter @autonoma/api build


# Runtime stage: the tsup bundle inlines every dependency except Node builtins
# (tsup's noExternal [/.*/] overshadows the external list in tsup.config.ts), so the
# image only needs Node and the bundle.
FROM platformatic/node-caged:25-alpine

WORKDIR /app

COPY --from=builder /app/apps/api/dist ./dist

# The migrations ride along with the server so a deployment can bring its own database up to date before
# serving it (see docker-entrypoint.sh). They come from the repo rather than from the workspace install:
# `prisma migrate deploy` needs the schema, its migrations, and a config, and the workspace's own
# packages/db/prisma.config.ts pulls in the whole workspace through `./src/env`.
COPY packages/db/prisma ./prisma
COPY deploy/migrator.config.ts ./prisma.config.ts
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# An explicit manifest, not `npm init -y`: the install needs one, and `"type": "module"` states what the
# ESM bundle in dist/ already is, so Node never has to detect it. Prisma is installed into the image's
# own workspace rather than globally because the config above imports "prisma/config", which Node
# resolves from the config's directory.
RUN printf '{"name":"autonoma-api","private":true,"type":"module"}\n' > package.json \
    && npm install prisma@7.9.0 \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
# node-caged alpine images ship no unprivileged user (unlike node:alpine),
# so create one to match the jobs' Dockerfiles.
RUN adduser -D -u 1000 node
USER node
EXPOSE 4000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
