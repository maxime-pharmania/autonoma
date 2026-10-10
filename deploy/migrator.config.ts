import { defineConfig } from "prisma/config";

/**
 * Config for the deploy-time migrator, deliberately standalone: the repo's own
 * `packages/db/prisma.config.ts` imports `./src/env` (and through it the whole workspace), which a
 * migration image must not carry. Everything here reads from `DATABASE_URL`, which every caller
 * (the throwaway Coolify app, the API image's entrypoint) already has in its environment.
 */
export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: { path: "prisma/migrations" },
    datasource: { url: process.env.DATABASE_URL ?? "" },
});
