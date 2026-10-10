---
title: Environment Variables
description: Complete reference for every environment variable used across the Autonoma AI monorepo - API server, frontend, AI services, database, storage, logging, billing, and infrastructure.
---

## Quick Start - Minimum for Local Development

To get the API and UI running locally, you need a surprisingly small set of variables. Copy `.env.example` to `.env` at the repo root and fill in these essentials:

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/autonoma

# Redis
REDIS_URL=redis://localhost:6379

# API server
API_PORT=4000
SCENARIO_ENCRYPTION_KEY=any-string-at-least-1-char

# Google OAuth (create credentials at console.cloud.google.com)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# GitHub OAuth (optional - create an OAuth app at github.com/settings/developers)
GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret

# AI model keys (needed for test execution)
GEMINI_API_KEY=your-gemini-key
GROQ_KEY=your-groq-key
OPENROUTER_API_KEY=your-openrouter-key

# S3-compatible storage (can use MinIO locally)
S3_BUCKET=autonoma-local
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
```

Everything else has sensible defaults or is optional for local development. The sections below cover every variable in detail.

## How Environment Variables Work in This Project

Every app and package defines its environment variables in a dedicated `env.ts` file using [`createEnv` from `@t3-oss/env-core`](https://env.t3.gg/). This gives you:

- **Zod validation at startup** - the process crashes immediately if a required variable is missing or malformed, rather than failing mysteriously at runtime.
- **Type safety** - `env.DATABASE_URL` is typed as `string`, not `string | undefined`. No more `process.env.DATABASE_URL!` casts.
- **Composability** - packages export their `env` object, and apps extend them. For example, the API server's `env.ts` extends the database, storage, logger, and billing envs, inheriting all their variables.

You should **never read `process.env` directly** in application code. Always import from the nearest `env.ts`:

```ts
// Good
import { env } from "./env";
const port = env.API_PORT;

// Bad - bypasses validation
const port = process.env.API_PORT;
```

The `emptyStringAsUndefined: true` option is enabled everywhere, so setting a variable to an empty string is treated the same as not setting it at all.

For boolean variables, the codebase uses `z.stringbool()` which accepts `"true"`, `"false"`, `"1"`, `"0"`, `"yes"`, and `"no"`.

---

## Core API Server

**Source:** `apps/api/src/env.ts`

The API server extends the database, storage, logger, and billing environments, so all variables from those sections apply here too.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_PORT` | Yes | - | Port the API server listens on. Typically `4000`. |
| `INTERNAL_DOMAIN` | No | `autonoma.app` | Internal domain used for routing and service discovery. |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated list of CORS origins. Must include the frontend URL. |
| `SCENARIO_ENCRYPTION_KEY` | Yes | - | Key used to encrypt scenario data. Any non-empty string works for local dev. |
| `GOOGLE_CLIENT_ID` | Yes | - | OAuth 2.0 client ID from Google Cloud Console. Required for user authentication. |
| `GOOGLE_CLIENT_SECRET` | Yes | - | OAuth 2.0 client secret from Google Cloud Console. |
| `GITHUB_CLIENT_ID` | No | - | Client ID of a GitHub OAuth app, enabling GitHub sign-in. Callback URL: `<BETTER_AUTH_URL>/v1/auth/callback/github`. Not the same as `GITHUB_APP_*`. |
| `GITHUB_CLIENT_SECRET` | No | - | Client secret of that GitHub OAuth app. GitHub sign-in is offered only when both this and `GITHUB_CLIENT_ID` are set. |
| `AGENT_VERSION` | No | `latest` | Version tag for the execution agent. Used when dispatching engine jobs. |
| `POSTHOG_KEY` | No | - | PostHog project API key for server-side analytics. Omit to disable analytics. |
| `POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingestion endpoint. Override for self-hosted PostHog instances. |
| `OPENROUTER_API_KEY` | No | - | Server-side OpenRouter key the managed LLM proxy (`/v1/llm-proxy`, planner CLI) forwards requests with. The proxy returns `503` without it. |
| `LLM_PROXY_ENABLED` | No | `false` | Master switch for the managed LLM proxy. The route mounts only when this and `STRIPE_ENABLED` are both `true`, so usage is always metered. |
| `LLM_PROXY_ALLOWED_MODELS` | No | `google/gemini-3-flash-preview` | Comma-separated allowlist of OpenRouter model ids the proxy may route. Empty falls back to the default. |
| `REDIS_URL` | Yes | - | Redis connection string (e.g., `redis://localhost:6379`). Used for device locking, caching, and pub/sub. |
| `TESTING` | No | `false` | Set to `true` in test environments. Prevents importing certain modules. Not for general use. |
| `ENGINE_BILLING_SECRET` | No | - | Shared secret for authenticating billing calls from the engine. |

---

## Frontend (UI)

**Source:** `apps/ui/src/env.ts`

The frontend uses Vite's `import.meta.env` and requires the `VITE_` prefix for all variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VITE_API_URL` | No | `http://localhost:4000` | URL of the API server. The frontend makes all tRPC calls to this address. |
| `VITE_INTERNAL_DOMAIN` | No | `autonoma.app` | Internal domain, used for UI routing logic. |
| `VITE_TEMPORAL_URL` | No | - | URL of the Temporal UI. When set, enables links to workflow runs in the dashboard. |
| `VITE_SENTRY_DSN` | No | - | Sentry DSN for frontend error tracking. Omit to disable Sentry in the browser. |
| `VITE_SENTRY_URL` | No | - | Sentry organization URL. Used for linking to Sentry issues from the UI. |
| `VITE_POSTHOG_KEY` | No | - | PostHog project API key for frontend analytics. Omit to disable analytics. PostHog events are proxied through the API server at `/rs` (feature flags at `/flags`) to bypass ad blockers. |

---

## Test Planner CLI (`apps/cli`)

**Source:** `apps/cli/src/env.ts`

The planner CLI calls models through Autonoma's managed LLM proxy and authorizes with `AUTONOMA_API_TOKEN` (see [Test Planner](/test-planner/)). Point it at an endpoint you host instead and it talks to that endpoint directly, with no Autonoma token involved:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_COMPATIBLE_BASE_URL` | No | - | Base URL of an endpoint that speaks the OpenAI chat-completions API. When set, every model call goes straight there instead of through the managed proxy, so the run needs no Autonoma token to reach a model. |
| `OPENAI_COMPATIBLE_API_KEY` | No | - | Key for that endpoint. Usually unnecessary for a locally hosted one. |

Which endpoint serves the model does not change how the model is named: the id still comes from `--model`, else `OPENROUTER_MODEL`, else `google/gemini-3-flash-preview`.

---

## Database

**Source:** `packages/db/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string. Format: `postgresql://user:password@host:port/database`. Used by Prisma for all database operations. |

:::note
For local development, a typical value is `postgresql://postgres:postgres@localhost:5432/autonoma`. Make sure PostgreSQL is running and the database exists before starting the API.
:::

---

## AI Services

**Source:** `packages/ai/src/env.ts`

These keys are required by the execution engines (web and mobile) and any service that runs AI inference. The API server does not run inference itself, so it needs none of them.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | - | Google Gemini API key. Used for the primary model (Gemini 3 Flash/Pro), point detection, object detection, and visual condition checking. |
| `GROQ_KEY` | Yes | - | Groq API key. Used for fast inference with open-source models (e.g., GPT-OSS-120B). |
| `OPENROUTER_API_KEY` | Yes | - | OpenRouter API key. Provides access to Ministral-8B and serves as a fallback provider for open-source models. |

:::note
Validation is skipped when running in Vitest (`VITEST` env var is set), so you do not need these keys to run unit tests.
:::

### Custom Model Endpoint

**Source:** `packages/ai/src/env.ts` for the endpoint, `packages/engine-web/src/platform/env.ts` and `packages/engine-mobile/src/platform/env.ts` for the slot map.

A deployment that runs its own inference (vLLM, LiteLLM, Ollama, TGI, a gateway) can serve the engine's model slots from that endpoint instead of the built-in providers. The endpoint must speak the OpenAI chat-completions API.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_COMPATIBLE_BASE_URL` | No | - | Base URL of the endpoint, e.g. `http://localhost:8000/v1`. Required only to build a custom model entry - with it unset, every slot keeps its built-in model. |
| `OPENAI_COMPATIBLE_API_KEY` | No | - | Key for that endpoint. Often unnecessary for a locally hosted one. |
| `OPENAI_COMPATIBLE_MODEL_SLOTS` | No | - | Comma-separated `slot=modelId` pairs serving those engine slots from the endpoint. Valid slots: `fast-visual`, `smart-visual`, `fast-text`, `pointer` (`pointer` is web-only - mobile ignores it). A slot that is not listed keeps its built-in model. |

```bash
OPENAI_COMPATIBLE_BASE_URL=http://localhost:8000/v1
OPENAI_COMPATIBLE_MODEL_SLOTS="smart-visual=my-vl,pointer=my-ground"
```

A malformed entry - an unknown slot name, a missing `=`, an empty model id - fails the run and names `OPENAI_COMPATIBLE_MODEL_SLOTS` in the error, rather than being skipped, so a run never quietly keeps a built-in model the operator asked to replace.

Each listed slot is served by `createCustomModelEntry` (`packages/ai/src/registry/custom-model-entry.ts`), which returns an ordinary registry entry built on the endpoint. Two of its properties matter when choosing what to reroute:

- **It is priced at zero.** The endpoint is your own compute, so there is no published per-token rate to attribute - and the entry never reads token usage, which an endpoint that omits usage from its responses would otherwise trip over.
- **It is not video-capable.** The entry declares no uploader, so `getVideoModel` throws `NotAVideoModelError` rather than handing a recording to an endpoint whose support for a `video_url` part is unknown, where a dropped video would read as confident evidence that nothing was on screen. Keep any capability that sends a recording (the diffs pipeline's `smart-video`, for example) on its built-in entry.

With none of these variables set, nothing changes: every slot keeps the built-in model it uses today.

---

## Storage (S3)

**Source:** `packages/storage/src/env.ts`

Used for storing screenshots, video recordings, test artifacts, and other binary assets.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `S3_BUCKET` | Yes | - | S3 bucket name for storing artifacts. |
| `S3_REGION` | Yes | - | AWS region of the S3 bucket (e.g., `us-east-1`). |
| `S3_ACCESS_KEY_ID` | Yes | - | AWS access key ID (or MinIO equivalent) for S3 authentication. |
| `S3_SECRET_ACCESS_KEY` | Yes | - | AWS secret access key (or MinIO equivalent) for S3 authentication. |

:::tip[Local development with MinIO]
You can run [MinIO](https://min.io/) locally as an S3-compatible object store. The default credentials are `minioadmin`/`minioadmin`. Point `S3_REGION` to any valid region string (e.g., `us-east-1`) and create a bucket matching your `S3_BUCKET` value.
:::

---

## Logging and Observability

**Source:** `packages/logger/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Node environment. Accepts `development`, `production`, or `test`. Affects log formatting and behavior. |
| `SENTRY_DSN` | No | - | Sentry DSN for backend error tracking and performance monitoring. Omit to disable Sentry. |
| `SENTRY_ENV` | No | `production` | Sentry environment tag (e.g., `staging`, `production`). |
| `SENTRY_RELEASE` | No | `unknown` | Sentry release identifier. Typically set to the git SHA or version tag in CI. |
| `DEBUG` | No | - | Debug filter string. When set, enables verbose debug logging for matching namespaces (e.g., `autonoma:*`). |

---

## Billing (Stripe)

**Source:** `packages/billing/src/env.ts`

Billing is entirely optional. When `STRIPE_ENABLED` is `false` (the default), all billing features are disabled and no other Stripe variables are needed.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `STRIPE_ENABLED` | No | `false` | Master switch for billing. Set to `true` to enable Stripe integration. |
| `STRIPE_SECRET_KEY` | No | - | Stripe secret API key. Required when `STRIPE_ENABLED` is `true`. |
| `STRIPE_WEBHOOK_SECRET` | No | - | Stripe webhook signing secret for verifying incoming webhook events. Required when `STRIPE_ENABLED` is `true`. |
| `BILLING_GRACE_PERIOD_DAYS` | No | `3` | Number of days after a subscription lapses before access is revoked. |
| `APP_URL` | No | `http://localhost:3000` | Frontend application URL. Used in Stripe checkout redirect URLs and billing emails. |

---

## Kubernetes and Workflows

**Source:** `packages/k8s/src/env.ts` and `packages/workflow/src/env.ts`

These variables are only needed in production or when running engine jobs on Kubernetes. Not required for local development.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NAMESPACE` | Yes (in K8s) | `local` (API) | Kubernetes namespace this environment runs in - `production`, `beta`, or a per-PR alpha namespace. Used by `@autonoma/k8s` to deploy jobs, and by the API to namespace session keys. See the warning below. |

:::danger[`NAMESPACE` is a session boundary, not just a deploy target]
Every environment shares one Redis, and sessions live **only** there - `storeSessionInDatabase` is off. The API prefixes its session keys with `better-auth:<NAMESPACE>:` (`apps/api/src/auth.ts`), so two environments sharing a value share one session store: a session minted by an alpha, running unreviewed PR code, would be a valid production session. Changing the value invalidates every session in the environment that adopts it.
:::

The workflow package also reads:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string. The workflow package needs direct DB access for job coordination. |
| `SENTRY_ENV` | No | - | Sentry environment tag for workflow jobs. |

---

## Engine - Web (Playwright)

**Source:** `packages/engine-web/src/platform/env.ts` and `packages/engine-web/src/execution-agent/env.ts`

The web engine extends the AI, database, logger, and storage environments. All variables from those sections apply.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `REMOTE_BROWSER_URL` | No | - | WebSocket URL of a remote browser instance (e.g., Browserless or Playwright remote). When omitted, launches a local Chromium browser. |
| `HEADLESS` | No | - | Set to any value to run Playwright in headless mode. When omitted, the browser window is visible (useful for local debugging). |

---

## Engine - Mobile (Appium)

**Source:** `packages/engine-mobile/src/platform/env.ts`

The mobile engine extends the AI, database, logger, and storage environments. All variables from those sections apply.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `APPIUM_HOST` | No | - | Hostname of the Appium server. |
| `APPIUM_PORT` | No | - | Port of the Appium server. |
| `APPIUM_MJPEG_PORT` | No | - | Port for the Appium MJPEG video stream. Used for live frame capture during test execution. |
| `APPIUM_SYSTEM_PORT` | No | - | System port used by Appium's UiAutomator2 (Android) or WebDriverAgent (iOS). |
| `APPIUM_SKIP_INSTALLATION` | No | `true` | When `true`, skips reinstalling the app before each test. Speeds up repeated runs on the same device. |
| `DEVICE_NAME` | No | - | Name of the target device or emulator (e.g., `iPhone 15 Pro`, `Pixel 7`). |
| `IOS_PLATFORM_VERSION` | No | - | iOS version to target (e.g., `17.2`). Required for iOS testing. |
| `ANDROID_DAEMON_HOSTS` | No | - | Comma-separated list of Android daemon host addresses for distributed device access. |
| `IOS_DAEMON_HOSTS` | No | - | Comma-separated list of iOS daemon host addresses for distributed device access. |
| `SKIP_DEVICE_DATE_UPDATE` | No | `false` | When `true`, skips updating the device date/time before tests. Useful when the device clock is already correct. |

---

## Jobs

### Execution Agent Runner

**Source:** `packages/engine/src/execution-agent/runner/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ARTIFACT_DIR` | No | - | Local directory for saving test artifacts (screenshots, videos, step logs). Used by the local runner during development. |

### Run Completion Notification

**Source:** `apps/jobs/run-completion-notification/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string. |
| `API_URL` | No | - | API server URL for callbacks. |
| `ENGINE_BILLING_SECRET` | No | - | Shared secret for authenticating billing-related calls. |
| `STRIPE_ENABLED` | No | `false` | Whether to process billing events on run completion. |

### Worker - Diffs

**Source:** `apps/workers/diffs/src/env.ts`

Diffs analysis and resolution run as Temporal activities in the `@autonoma/worker-diffs` worker. AI model keys come from the AI Services section; this worker adds the GitHub App credentials it needs to clone repositories and read PRs. Its analysis capabilities (classifier, reporter, impact) are served by `api.openai.com` and authenticated with `OPENAI_API_KEY` unless `OPENAI_BASE_URL` points them elsewhere.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | Yes | - | GitHub App ID for repository access. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | - | GitHub App private key, base64-encoded PEM (`cat key.pem \| base64`). |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | - | GitHub App webhook secret for verifying events. |
| `GITHUB_APP_SLUG` | Yes | - | GitHub App slug (URL-friendly name). |
| `OPENAI_BASE_URL` | No | - | Base URL of an endpoint that speaks the OpenAI chat-completions API, serving the classifier, reporter and impact capabilities instead of `api.openai.com`. Authenticated with the worker's `OPENAI_API_KEY`. Unset leaves them on OpenAI. |
| `SENTRY_DSN_WORKER_DIFFS` | No | - | Sentry DSN for the diffs worker. |

Each capability keeps its own model-id override, so an endpoint's own ids are named without a deploy: `INVESTIGATION_CLASSIFIER_MODEL`, `INVESTIGATION_REPORTER_MODEL` and `INVESTIGATION_IMPACT_MODEL`. An id the model session does not tabulate is called over chat-completions.

---

## GitHub App

These variables appear in `.env.example` and are used by the API server and the diffs worker for GitHub integration features (repository connections, PR-triggered test runs).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | No | - | GitHub App ID. Required for GitHub integration features. |
| `GITHUB_APP_PRIVATE_KEY` | No | - | GitHub App private key, base64-encoded PEM (`cat key.pem \| base64`). Decoded at boot. |
| `GITHUB_APP_WEBHOOK_SECRET` | No | - | Secret for verifying GitHub webhook payloads. |
| `GITHUB_APP_SLUG` | No | - | GitHub App slug (URL-friendly name). Used for generating installation links. |

---

## Authentication

These variables are referenced in `.env.example` for the Better Auth integration used by the API server.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | - | Secret key for Better Auth session signing. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | Yes | - | Root origin of the API server (e.g., `http://localhost:4000`). Used by Better Auth for callback URLs. Origin only - see the warning below. |
| `OAUTH_PROXY_PRODUCTION_URL` | No | - | The one origin whose OAuth callback is registered with the providers, for the whole fleet. Every deployed environment sets the same value. Leave unset locally. |
| `OAUTH_PROXY_SECRET` | No | `BETTER_AUTH_SECRET` | Encrypts the profile payload the proxy hands back to the originating environment. Every participating environment must share the same value. |

:::caution[`BETTER_AUTH_URL` takes an origin, not a path]
Better Auth is mounted with basePath `/v1/auth` and appends that itself. A value like `https://yourdomain.com/v1` makes every auth endpoint 404.
:::

### OAuth proxying

A provider only redirects to callback URLs registered with it ahead of time, and an alpha environment's hostname is minted per PR - so it can never be one of them. Instead, every deployed environment sends the provider **production's** callback URL and gets the resulting profile handed back, encrypted and short-lived, at its own origin, where it mints its own session. Production's own `APP_URL` matches `OAUTH_PROXY_PRODUCTION_URL`, so it skips proxying and serves the callback for the fleet.

Two things about this are easy to get wrong:

- **Leave both unset locally.** Local dev has its own OAuth apps, and enabling the proxy would mean configuring production to hand encrypted session payloads to a developer's machine.
- **`OAUTH_PROXY_PRODUCTION_URL` is not a plain on/off switch.** Setting it without every participating environment sharing the same `OAUTH_PROXY_SECRET` breaks sign-in on the non-production environments.

`OAUTH_PROXY_SECRET` is deliberately separate from `BETTER_AUTH_SECRET`: it is shared across environments, so a leak must not also be able to forge sessions. It falls back to `BETTER_AUTH_SECRET` when unset, which works but widens the blast radius.

---

## Tips for Local Development

**What you can skip entirely:**

- **Billing** - Leave `STRIPE_ENABLED=false` (the default). No Stripe keys needed.
- **Analytics** - Omit `POSTHOG_KEY` and `VITE_POSTHOG_KEY`. Analytics calls become no-ops.
- **Sentry** - Omit `SENTRY_DSN` and `VITE_SENTRY_DSN`. Error tracking is disabled gracefully.
- **Kubernetes** - Omit `NAMESPACE`. The API defaults it to `local`; only `@autonoma/k8s` needs a real one.
- **OAuth proxying** - Omit `OAUTH_PROXY_PRODUCTION_URL` and `OAUTH_PROXY_SECRET`. Local dev signs in against its own OAuth apps.
- **GitHub App** - Omit all `GITHUB_APP_*` variables unless you are working on GitHub integration.
- **Custom model endpoint** - Omit `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL_SLOTS` and `OPENAI_BASE_URL`. Every model slot keeps its built-in model, and the diffs worker stays on `api.openai.com`.
- **Temporal** - Omit `VITE_TEMPORAL_URL`. The UI hides workflow links when this is unset.

**What uses defaults that just work:**

- `ALLOWED_ORIGINS` defaults to `http://localhost:3000` - correct for local dev.
- `VITE_API_URL` defaults to `http://localhost:4000` - correct for local dev.
- `APP_URL` defaults to `http://localhost:3000` - correct for local dev.
- `NODE_ENV` defaults to `development`.
- `AGENT_VERSION` defaults to `latest`.

**What you must provide:**

- `DATABASE_URL` - there is no default. You need a running PostgreSQL instance.
- `REDIS_URL` - there is no default. You need a running Redis instance.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` - required for authentication. Create OAuth credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` - optional. Set both to add GitHub as a second sign-in option; see [Development Setup](/development/setup/) for the OAuth app steps.
- `SCENARIO_ENCRYPTION_KEY` - any non-empty string works locally.
- `BETTER_AUTH_SECRET` - generate one with `openssl rand -hex 32`.
- `BETTER_AUTH_URL` - set to `http://localhost:4000`. The origin only; appending `/v1` 404s every auth endpoint.
- AI keys (`GEMINI_API_KEY`, `GROQ_KEY`, `OPENROUTER_API_KEY`) - required if you are running test execution. Not needed if you are only working on the UI or API without triggering test runs.
- S3 credentials - required for artifact storage. Use MinIO locally.
