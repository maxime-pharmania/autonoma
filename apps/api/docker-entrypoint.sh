#!/bin/sh
set -e

# A deployment that owns its database can apply the migrations before the server starts, so a fresh
# database never gets an API whose schema is older than the code running against it - the failure mode
# that leaves every query erroring on a missing column while the process reports itself healthy.
#
# Left off unless RUN_MIGRATIONS_ON_START=true: an operator who migrates out of band (a dedicated
# migrator, a deployment pipeline) must not have their server change the schema on boot. Read here
# rather than through the app's validated env because this is a container entrypoint decision, not
# application configuration.
#
# `prisma migrate deploy` is idempotent and takes an advisory lock, so several replicas starting at
# once serialize instead of racing, and the second one applies nothing.
if [ "${RUN_MIGRATIONS_ON_START}" = "true" ]; then
    echo "RUN_MIGRATIONS_ON_START=true - applying pending migrations"
    ./node_modules/.bin/prisma migrate deploy --config ./prisma.config.ts
fi

exec "$@"
