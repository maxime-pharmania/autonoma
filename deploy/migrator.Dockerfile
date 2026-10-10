# syntax=docker/dockerfile:1

# Applies the Prisma migrations to a database on the same Docker network, without exposing that
# database to anything else. The API image carries the same two pieces (deploy/migrator.config.ts and
# packages/db/prisma) for deployments that migrate themselves; this image exists for the database that
# has to be brought up to date while the API that would migrate it is not yet running.
FROM node:24-alpine

WORKDIR /app

# Installed into the image's own workspace rather than globally: the config file below imports
# "prisma/config", which Node resolves from the config's directory, so a global install is invisible to
# it ("Cannot find module 'prisma/config'"). Pinned to the version the repo locks (pnpm-workspace.yaml),
# so the migrations applied here cannot drift from the client that reads the schema at runtime.
RUN npm init -y > /dev/null && npm install prisma@7.9.0

COPY deploy/migrator.config.ts ./prisma.config.ts
COPY packages/db/prisma ./prisma

# `migrate deploy` is idempotent, so re-running the container is a no-op rather than an error. The
# process then stays alive: Coolify reports the logs of a running container, and a one-shot container
# that has already exited reads as a failure with nothing to show for it.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --config ./prisma.config.ts && echo MIGRATIONS_APPLIED && tail -f /dev/null"]
