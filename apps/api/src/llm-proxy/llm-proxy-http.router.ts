import { requireApiKey, type UserAuthVariables } from "@autonoma/auth";
import type { LlmProxyGateReason } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { billingService } from "../context";
import { env } from "../env";

const logger = rootLogger.child({ name: "llmProxyHttpRouter" });

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

// Where this proxy sends its requests, and with which key. Defaults to OpenRouter with this
// deployment's OpenRouter key; a self-host that runs its own gateway sets both instead, so the planner
// spends that operator's key on their own endpoint. OpenRouter's `HTTP-Referer`/`X-Title` attribution
// headers and its `usage.cost` accounting are meaningless there and are simply ignored by the upstream.
const upstreamUrl = env.LLM_PROXY_UPSTREAM_URL ?? OPENROUTER_CHAT_COMPLETIONS_URL;
const upstreamApiKey = env.LLM_PROXY_UPSTREAM_API_KEY ?? env.OPENROUTER_API_KEY;

// Upper bound on a single upstream request. Bounds a hung/stalled OpenRouter
// connection (which would otherwise hold the request and the detached meter
// drain open indefinitely) while staying well above any real planner call.
const UPSTREAM_TIMEOUT_MS = 300_000;

// Default allowlist - the only model the planner CLI uses. The proxy is a free,
// credit-metered gateway, so restricting the routable models is the main guard
// against it being used as a general-purpose LLM API. Override with the
// LLM_PROXY_ALLOWED_MODELS env var (comma-separated) without a deploy.
const LLM_PROXY_DEFAULT_MODELS = ["google/gemini-3-flash-preview"];

const configuredModels =
    env.LLM_PROXY_ALLOWED_MODELS?.split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0) ?? [];
// An empty/whitespace-only override falls back to the defaults rather than
// silently blocking every model with a 400.
const allowedModels = new Set(configuredModels.length > 0 ? configuredModels : LLM_PROXY_DEFAULT_MODELS);

// Per-request caps (all env-overridable). The credit cap is the primary abuse
// bound (see checkLlmProxyGate); these keep a single request cheap so the tiny
// overspend past the cap under concurrency stays negligible.
const FREE_CLI_CREDIT_CAP = env.LLM_PROXY_FREE_CREDIT_CAP;
const MAX_OUTPUT_TOKENS = env.LLM_PROXY_MAX_OUTPUT_TOKENS;
const MAX_REQUEST_BYTES = env.LLM_PROXY_MAX_REQUEST_BYTES;

// How long a streamed response may stay silent before the proxy writes an SSE keepalive comment. Overridable
// per deployment with LLM_PROXY_SSE_KEEPALIVE_MS, `0` to disable (see resolveSseKeepaliveIntervalMs). The
// upstream generates for minutes in thinking mode, and an intermediary in front of this proxy reaps a
// connection that carries no bytes for long enough - observed from the other side as the upstream gateway's
// own `499` on our call, after which the caller's SDK retries the completion we were already receiving. Well
// under the minute-scale idle timeouts such an intermediary applies, and small enough that a client sees
// only a handful of comments per think.
const SSE_KEEPALIVE_DEFAULT_MS = 15_000;

/**
 * `: keepalive\n\n` - an SSE comment. Every SSE parser skips a line that starts with a colon (this proxy's
 * own usage scan included, see captureFromSseLine), but it is still bytes on the wire, which is all an
 * idle-timeout intermediary needs to keep the connection open.
 */
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

// Every gate refusal is a 402 so the planner CLI's error handling (which keys
// friendly "out of credits" messaging off the 402 status) surfaces the right
// hint; the distinct `error` code is for our own logs/analytics.
const GATE_BLOCK_RESPONSES: Record<LlmProxyGateReason, { error: string; message: string }> = {
    out_of_credits: { error: "out_of_credits", message: "You're out of Autonoma credits." },
    grace_period_expired: {
        error: "grace_period_expired",
        message: "Your Autonoma subscription payment is overdue - update billing to continue.",
    },
    free_cli_limit_reached: {
        error: "free_cli_limit_reached",
        message: "You've reached the free planner usage limit. Add credits at https://autonoma.app to continue.",
    },
};

// Accepts the OpenAI/OpenRouter chat-completions body but only pins the fields
// we act on (`model` for the allowlist, `stream` for the response shape,
// `max_tokens` which we clamp). `.passthrough()` preserves every other field so
// the request forwards verbatim.
const ChatCompletionsBodySchema = z
    .object({
        model: z.string(),
        stream: z.boolean().optional(),
        max_tokens: z.number().int().positive().optional(),
    })
    .passthrough();

type ThinkingCompatRewrite = {
    /** The body to forward: the input itself whenever nothing was rewritten. */
    body: Record<string, unknown>;
    /** Whether LLM_PROXY_THINKING_COMPAT is on, i.e. whether the rewrite was attempted at all. */
    enabled: boolean;
    /** Assistant messages that had an empty `reasoning_content` filled in. */
    adjustedAssistantMessages: number;
    /** Whether a forced `tool_choice` was replaced with `"auto"`. */
    toolChoiceReplaced: boolean;
    /** Whether the system message was given the directive that restates a replaced `tool_choice`. */
    systemDirectiveAdded: boolean;
};

/**
 * Whether to rewrite forwarded bodies for an upstream in thinking mode (`LLM_PROXY_THINKING_COMPAT`, off by
 * default: an upstream that is NOT in thinking mode does not expect `reasoning_content` and may reject it,
 * so the rewrite stays opt-in per deployment). Read from the environment on each request and parsed the
 * way `env.ts` parses its stringbools, so a value we do not recognize as truthy reads as off rather than
 * throwing on the request path.
 */
function isThinkingCompatEnabled(): boolean {
    return z.stringbool().catch(false).parse(process.env.LLM_PROXY_THINKING_COMPAT);
}

/**
 * Whether a `tool_choice` value pins one tool, in either the current (`{type: "function", function: {...}}`)
 * or the legacy (`{function: "name"}`) shape.
 */
function isForcingToolChoice(toolChoice: unknown): boolean {
    if (typeof toolChoice !== "object" || toolChoice == null) return false;
    const choice = toolChoice as { type?: unknown; function?: unknown };
    return choice.type === "function" || choice.function != null;
}

function isAssistantMessage(message: unknown): message is Record<string, unknown> {
    return typeof message === "object" && message != null && (message as { role?: unknown }).role === "assistant";
}

function isSystemMessage(message: unknown): message is Record<string, unknown> {
    return typeof message === "object" && message != null && (message as { role?: unknown }).role === "system";
}

/**
 * What a forced `tool_choice` asked for, restated in prose for the upstream that refuses the parameter.
 * `"auto"` alone reads as "answering in prose is fine", so a thinking-mode model ends its turn with no
 * tool call; the planner CLI counts that as a stall and spends a whole extra generation on a nudge.
 */
const FORCED_TOOL_CHOICE_DIRECTIVE =
    "Respond with exactly one tool call per turn: call a tool on every turn instead of answering with prose, and call the finish tool once the task is complete.";

/**
 * The messages to forward once the directive above restates a forced `tool_choice`: it goes on the
 * system message - appended to string content, or as one more text part when the content is a parts
 * array, whose other parts are kept verbatim - and a request that carries no system message gets one at
 * the head. Content of neither shape cannot carry the directive without dropping what the caller sent,
 * so that message is left alone and the directive travels in a system message of its own.
 */
function messagesWithForcedToolChoiceDirective(messages: readonly unknown[]): readonly unknown[] {
    const directivePart = { type: "text", text: FORCED_TOOL_CHOICE_DIRECTIVE };
    const systemIndex = messages.findIndex(isSystemMessage);
    const system = systemIndex === -1 ? undefined : (messages[systemIndex] as Record<string, unknown>);
    if (system != null && typeof system.content === "string") {
        const content = `${system.content}\n\n${FORCED_TOOL_CHOICE_DIRECTIVE}`;
        return messages.map((message, index) => (index === systemIndex ? { ...system, content } : message));
    }
    if (system != null && Array.isArray(system.content)) {
        const content = [...system.content, directivePart];
        return messages.map((message, index) => (index === systemIndex ? { ...system, content } : message));
    }
    return [{ role: "system", content: FORCED_TOOL_CHOICE_DIRECTIVE }, ...messages];
}

/**
 * Rewrite a request body a gateway that runs its upstream in thinking mode rejects twice: a 400 "The
 * `reasoning_content` in the thinking mode must be passed back to the API" when an assistant message
 * carries no `reasoning_content`, then a 400 "Thinking mode does not support this tool_choice" when the
 * request forces `tool_choice: "required"`. Replaying the offending planner body with `tool_choice:
 * "auto"` plus `reasoning_content: ""` on the assistant message returns 200 SSE, which is what this
 * reproduces.
 *
 * The planner CLI forces `tool_choice: "required"` (apps/cli/src/core/agent.ts,
 * apps/cli/src/tools/subagent.ts) and the AI SDK never echoes `reasoning_content`, so without this
 * rewrite every planner call fails against such an upstream.
 *
 * `"auto"` accepts the request but drops the intent the parameter carried, so a replaced `tool_choice`
 * is restated as the system directive below (see FORCED_TOOL_CHOICE_DIRECTIVE) - the only place an
 * upstream in thinking mode still lets us ask for one tool call per turn.
 *
 * A body we cannot rewrite is forwarded untouched rather than dropped: the upstream's own error names
 * the real problem, whereas a local failure here would be opaque on a request we would otherwise simply
 * forward. Callers log one debug line per request from the returned counters.
 */
export function applyThinkingCompat(body: Record<string, unknown>): ThinkingCompatRewrite {
    if (!isThinkingCompatEnabled()) {
        return {
            body,
            enabled: false,
            adjustedAssistantMessages: 0,
            toolChoiceReplaced: false,
            systemDirectiveAdded: false,
        };
    }
    try {
        // Both upstream errors are about `messages`, so without an array of them there is nothing to fix:
        // the body goes through exactly as it arrived, `tool_choice` included.
        const messages: readonly unknown[] | undefined = Array.isArray(body.messages) ? body.messages : undefined;
        let adjustedAssistantMessages = 0;
        let toolChoiceReplaced = false;
        let systemDirectiveAdded = false;
        let rewritten = body;
        if (messages != null) {
            let rewrittenMessages: readonly unknown[] = messages.map((message) => {
                // A value the caller already provided is kept, whatever it holds. Only an absent (or
                // non-string, which the upstream cannot read back) `reasoning_content` is filled in.
                if (!isAssistantMessage(message) || typeof message.reasoning_content === "string") return message;
                adjustedAssistantMessages += 1;
                return { ...message, reasoning_content: "" };
            });
            toolChoiceReplaced = body.tool_choice === "required" || isForcingToolChoice(body.tool_choice);
            if (toolChoiceReplaced) {
                rewrittenMessages = messagesWithForcedToolChoiceDirective(rewrittenMessages);
                systemDirectiveAdded = true;
            }
            rewritten = toolChoiceReplaced
                ? { ...body, messages: rewrittenMessages, tool_choice: "auto" }
                : { ...body, messages: rewrittenMessages };
        }
        return { body: rewritten, enabled: true, adjustedAssistantMessages, toolChoiceReplaced, systemDirectiveAdded };
    } catch (err) {
        // Not reachable from a JSON-parsed body, but a rewrite must never be the reason a forwardable
        // request fails - so the body passes through as-is.
        logger.debug("Thinking-mode compatibility rewrite failed - forwarding the body unchanged", { err });
        return {
            body,
            enabled: true,
            adjustedAssistantMessages: 0,
            toolChoiceReplaced: false,
            systemDirectiveAdded: false,
        };
    }
}

// Tolerant view over OpenRouter responses (streamed chunks and the non-streamed
// body) used only to pull the generation id and the usage cost for metering.
const UsageEnvelopeSchema = z
    .object({
        id: z.string().optional(),
        usage: z
            .object({
                cost: z.number().optional(),
                cost_details: z.object({ upstream_inference_cost: z.number().optional() }).passthrough().optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

type CapturedUsage = { id?: string; cost?: number };

/**
 * The dollar cost OpenRouter actually incurred for a request. For BYOK
 * integrations OpenRouter reports `usage.cost = 0` (the spend lands on the
 * upstream provider key it holds for us), so fall back to the upstream inference
 * cost. Keeps metering correct in both BYOK and normal billing modes.
 */
function effectiveUsageCost(
    usage: { cost?: number; cost_details?: { upstream_inference_cost?: number } } | undefined,
): number | undefined {
    if (usage == null) return undefined;
    if (usage.cost != null && usage.cost > 0) return usage.cost;
    const upstream = usage.cost_details?.upstream_inference_cost;
    if (upstream != null && upstream > 0) return upstream;
    return undefined;
}

export const llmProxyHttpRouter = new Hono<{ Variables: UserAuthVariables }>();

llmProxyHttpRouter.use("*", requireApiKey({ db, appUrl: env.APP_URL }));

// Reject oversized bodies at the edge, before the handler reads them. The cap
// (MAX_REQUEST_BYTES) is sized above a full context-window planner request, so
// this is purely a memory guard, not a spend bound (that's the credit gate
// below): bodyLimit short-circuits on Content-Length when present, and otherwise
// streams the body and aborts the moment it exceeds the cap - so a multi-GB
// payload never buffers unbounded in memory. Runs after auth (the `use("*")`
// above), so it's gated.
llmProxyHttpRouter.use(
    "/chat/completions",
    bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: (c) => c.json({ error: "request_too_large" }, 413) }),
);

llmProxyHttpRouter.post("/chat/completions", async (c) => {
    const { organizationId } = c.var.user;
    logger.info("LLM proxy request received", { organizationId });

    const apiKey = upstreamApiKey;
    if (apiKey == null) {
        logger.error("LLM proxy is unconfigured - OPENROUTER_API_KEY is not set");
        return c.json({ error: "llm_proxy_unconfigured" }, 503);
    }

    // Body size is bounded by the bodyLimit middleware above, so it's safe to buffer here.
    const parsedBody = ChatCompletionsBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsedBody.success) {
        logger.warn("LLM proxy request rejected - invalid body", { organizationId });
        return c.json({ error: "invalid_request" }, 400);
    }

    const { model } = parsedBody.data;
    if (!allowedModels.has(model)) {
        logger.warn("LLM proxy request rejected - model not allowed", { organizationId, model });
        return c.json({ error: "model_not_allowed", model }, 400);
    }

    const gate = await billingService.checkLlmProxyGate(organizationId, FREE_CLI_CREDIT_CAP);
    if (!gate.allowed) {
        logger.info("LLM proxy request blocked", { organizationId, reason: gate.reason });
        return c.json(GATE_BLOCK_RESPONSES[gate.reason], 402);
    }

    const isStreaming = parsedBody.data.stream === true;
    // Clamp the output ceiling (and set it when the caller omits it) so an
    // allowlisted model can't be driven with an unbounded generation. Ask
    // OpenRouter to include usage accounting (incl. dollar cost) so we can meter -
    // for streams this surfaces in a trailing chunk; non-stream in the body.
    const maxTokens = Math.min(parsedBody.data.max_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
    // A no-op returning the body untouched unless LLM_PROXY_THINKING_COMPAT is on (see applyThinkingCompat).
    const thinkingCompat = applyThinkingCompat({ ...parsedBody.data, max_tokens: maxTokens, usage: { include: true } });
    const forwardBody = thinkingCompat.body;
    // One line per request (only when the flag is on): what we rewrote, so an upstream 400 about
    // `tool_choice`/`reasoning_content` can be read against the body we actually sent.
    if (thinkingCompat.enabled) {
        logger.debug("Applied thinking-mode compatibility rewrite", {
            organizationId,
            adjustedAssistantMessages: thinkingCompat.adjustedAssistantMessages,
            toolChoiceReplaced: thinkingCompat.toolChoiceReplaced,
            systemDirectiveAdded: thinkingCompat.systemDirectiveAdded,
        });
    }

    logger.info("Forwarding to OpenRouter", { organizationId, model, isStreaming });

    let upstream: Response;
    // This timer bounds the wait for a response, not the response itself: `AbortSignal.timeout` would do
    // both, and a streamed answer outlives any cap worth setting - a reasoning model generates for
    // minutes, and aborting it mid-flight truncates the answer with nothing the caller can act on. The
    // timer is cleared as soon as the headers arrive on a streamed request, so a stalled upstream is
    // still cut off while it is silent.
    const upstreamAbort = new AbortController();
    // Captured before the call, so the streamed relay below reports a duration comparable with the upstream
    // gateway's own request log line - the `499 | 2m5s` this pairs with.
    const upstreamRequestStartedAtMs = Date.now();
    const headersTimer = setTimeout(() => upstreamAbort.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        upstream = await fetch(upstreamUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": "https://autonoma.app",
                "X-Title": "Autonoma Planner",
            },
            body: JSON.stringify(forwardBody),
            signal: upstreamAbort.signal,
        });
        // A non-streamed body is read immediately below, so the timer stays armed for it.
        if (isStreaming) clearTimeout(headersTimer);
    } catch (err) {
        // Network failure or the timeout above firing. Don't leak detail to the
        // caller; the detached meter drain (if any) errors on the aborted body.
        logger.error("LLM proxy upstream request failed", { organizationId, model, err });
        return c.json({ error: "upstream_error" }, 502);
    }

    if (!upstream.ok || upstream.body == null) {
        // Don't leak OpenRouter's identity or our account's auth/rate-limit state
        // to the caller - log the upstream detail server-side, return a generic 502.
        const detail = await upstream.text().catch(() => "");
        logger.warn("OpenRouter returned an error", { organizationId, model, status: upstream.status, detail });
        return c.json({ error: "upstream_error" }, 502);
    }

    if (isStreaming) {
        // Tee the upstream stream: one branch streams to the client, the other we
        // drain ourselves for metering. Draining the meter branch independently
        // means we still capture usage (and bill) even if the client disconnects
        // mid-stream - tee keeps the source alive as long as one branch is read.
        const [clientBranch, meterBranch] = upstream.body.tee();
        void drainStreamForMetering(meterBranch, organizationId);
        // Only the client branch is relayed to the caller, and only it is wrapped: the meter branch reads
        // the raw upstream bytes, so the keepalive cannot reach the usage scan or the deduction. The wrapper
        // also reports, in one line, how the relay ended (see the callback below).
        const relayedBody = relayUpstreamSseStream(
            clientBranch,
            { keepaliveMs: resolveSseKeepaliveIntervalMs(), startedAtMs: upstreamRequestStartedAtMs },
            (outcome) => {
                // One line per streamed request, on every exit. It is what separates the caller's side going
                // away (client_cancelled: the CLI, or a tunnel in front of this API) from the upstream side
                // going away - upstream_failed, the cut this diagnostic exists for, which reads as no relayed
                // bytes and a duration matching the upstream gateway's own 499. The upstream's line alone
                // cannot say whose client walked away; this one is ours to read.
                logger.info("LLM proxy streamed response ended", {
                    organizationId,
                    model,
                    durationMs: outcome.durationMs,
                    relayedUpstreamBytes: outcome.relayedUpstreamBytes,
                    endReason: outcome.endReason,
                    err: outcome.error,
                });
            },
        );
        return new Response(relayedBody, {
            status: upstream.status,
            headers: {
                "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        });
    }

    const rawText = await upstream.text();
    const parsed = UsageEnvelopeSchema.safeParse(safeJsonParse(rawText));
    await meter(organizationId, {
        id: parsed.success ? parsed.data.id : undefined,
        cost: parsed.success ? effectiveUsageCost(parsed.data.usage) : undefined,
    });
    return new Response(rawText, { status: upstream.status, headers: { "Content-Type": "application/json" } });
});

/**
 * How long to wait between keepalive comments, from `LLM_PROXY_SSE_KEEPALIVE_MS`. Unset, blank (what a
 * rendered template leaves behind) or unreadable reads as the default rather than throwing on the request
 * path; `0` disables the keepalive. Read from the environment on each request - the way
 * LLM_PROXY_THINKING_COMPAT is - so a deployment can silence it without a redeploy.
 */
export function resolveSseKeepaliveIntervalMs(): number {
    const raw = process.env.LLM_PROXY_SSE_KEEPALIVE_MS?.trim();
    if (raw == null || raw.length === 0) return SSE_KEEPALIVE_DEFAULT_MS;
    const parsed = z.coerce.number().int().nonnegative().safeParse(raw);
    if (!parsed.success) {
        logger.warn("Ignoring an unreadable LLM_PROXY_SSE_KEEPALIVE_MS - using the default keepalive interval", {
            value: raw,
            defaultMs: SSE_KEEPALIVE_DEFAULT_MS,
        });
        return SSE_KEEPALIVE_DEFAULT_MS;
    }
    return parsed.data;
}

/**
 * How a streamed relay ended, and what it saw on the way - the evidence that tells a caller's own
 * abandonment apart from a connection an intermediary cut (see the log in the streaming branch of the handler).
 */
export type SseRelayOutcome = {
    /** Wall-clock ms from the upstream request to the end of the relay: the number to read against the
     * upstream gateway's own request log line for the same call. */
    durationMs: number;
    /** Whether the answer had started, i.e. whether any upstream byte reached the caller. */
    relayedUpstreamBytes: boolean;
    /** Why the relay stopped: the upstream stream ended, it failed (a connection cut lands here), or the
     * caller's connection went away first. */
    endReason: "upstream_finished" | "upstream_failed" | "client_cancelled";
    /** The failure that ended an `upstream_failed` relay, or the cancellation reason when a runtime gave
     * one - both are what a log line needs to name the cause. */
    error?: unknown;
};

export type SseRelayOptions = {
    /** Keepalive interval in ms. `<= 0` writes no comment and arms no timer. */
    keepaliveMs: number;
    /** When this proxy started the upstream request, for `durationMs`. */
    startedAtMs: number;
};

/**
 * Relay a streamed upstream body to the caller, and report once how it ended.
 *
 * While the upstream has not produced its first byte, every `keepaliveMs` writes an SSE keepalive comment: an
 * intermediary in front of this proxy reaps a connection that carries no bytes for long enough, and a cut
 * reply to a long reasoning turn makes the caller's SDK retry the completion we were already receiving (see
 * SSE_KEEPALIVE_DEFAULT_MS). The keepalive is a wrapper, never a splice: upstream bytes reach the client in
 * order and unchanged, and a comment can only be written ahead of the first one, because that byte stops the
 * timer before being forwarded. The timer is stopped on every exit - first byte, end of stream, upstream
 * failure, caller cancellation - so nothing outlives the response. `keepaliveMs <= 0` arms no timer and
 * writes no comment, which is the whole of the disabled case.
 *
 * `onEnd` is called exactly once, whichever way the relay stopped. It must never be the reason a relay
 * breaks, so a throwing observer is logged and swallowed. Backpressure stays the source's: a chunk is read
 * only as the caller consumes one.
 */
export function relayUpstreamSseStream(
    source: ReadableStream<Uint8Array>,
    options: SseRelayOptions,
    onEnd: (outcome: SseRelayOutcome) => void,
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let relayedUpstreamBytes = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let ended = false;
    const stopKeepalive = (): void => {
        if (timer == null) return;
        clearInterval(timer);
        timer = undefined;
    };
    const end = (endReason: SseRelayOutcome["endReason"], error?: unknown): void => {
        if (ended) return;
        ended = true;
        stopKeepalive();
        try {
            onEnd({
                durationMs: Date.now() - options.startedAtMs,
                relayedUpstreamBytes,
                endReason,
                error,
            });
        } catch (err) {
            logger.debug("Failed to report how a streamed response ended", { err });
        }
    };
    return new ReadableStream<Uint8Array>({
        start(controller) {
            if (options.keepaliveMs <= 0) return;
            timer = setInterval(() => {
                try {
                    controller.enqueue(SSE_KEEPALIVE_FRAME);
                } catch {
                    // The caller cancelled between this beat firing and the callback running: `cancel`
                    // below has already stopped us. A beat that lands too late is not worth a log line.
                    stopKeepalive();
                }
            }, options.keepaliveMs);
            // An idle connection's keepalive must never be the reason the process stays alive.
            timer.unref();
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    end("upstream_finished");
                    controller.close();
                    return;
                }
                // Before forwarding the byte, never after: the keepalive fills the silence ahead of real
                // data, so a comment must never land inside the upstream flow.
                relayedUpstreamBytes = true;
                stopKeepalive();
                controller.enqueue(value);
            } catch (err) {
                // An upstream failure - a cut connection surfaces here - or a beat racing the caller's
                // cancellation. Either way the relay is over, and the timer must not survive it.
                end("upstream_failed", err);
                controller.error(err);
            }
        },
        cancel(reason) {
            // The runtimes cancel a response body when its connection goes away, so this is the caller
            // (or whatever sits between us and it) hanging up before the upstream was done.
            end("client_cancelled", reason);
            // Release the upstream branch, deliberately without awaiting it: one branch of a teed body only
            // settles once the other is cancelled too, and the meter branch keeps reading the upstream to the
            // end on purpose (so the request still bills). Nothing here may wait on that.
            void reader.cancel(reason).catch(() => undefined);
        },
    });
}

/**
 * Read an SSE stream to completion, scanning for the trailing usage chunk, then
 * meter the captured cost. Detached from the client response (see the tee at the
 * call site) so metering runs to completion regardless of client cancellation.
 */
async function drainStreamForMetering(stream: ReadableStream<Uint8Array>, organizationId: string): Promise<void> {
    const decoder = new TextDecoder();
    const captured: CapturedUsage = {};
    let buffer = "";
    const reader = stream.getReader();

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) captureFromSseLine(line, captured);
        }
        captureFromSseLine(buffer, captured);
        await meter(organizationId, captured);
    } catch (err) {
        logger.error("Failed while draining stream for LLM proxy metering", { organizationId, err });
    } finally {
        reader.releaseLock();
    }
}

function captureFromSseLine(line: string, captured: CapturedUsage): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") return;
    const parsed = UsageEnvelopeSchema.safeParse(safeJsonParse(data));
    if (!parsed.success) return;
    if (parsed.data.id != null) captured.id = parsed.data.id;
    const cost = effectiveUsageCost(parsed.data.usage);
    if (cost != null) captured.cost = cost;
}

async function meter(organizationId: string, captured: CapturedUsage): Promise<void> {
    if (captured.cost == null || !(captured.cost > 0)) {
        logger.warn("No usage cost captured for LLM proxy request - skipping deduction", { organizationId });
        return;
    }
    // Deduction keys on the OpenRouter generation id for idempotency. Without it
    // we'd have to mint a synthetic id, which a re-delivery could double-charge,
    // so skip (log) rather than risk an unbounded charge.
    if (captured.id == null) {
        logger.warn("No OpenRouter generation id captured for LLM proxy request - skipping deduction", {
            organizationId,
        });
        return;
    }
    try {
        await billingService.deductCreditsForLlmProxy(organizationId, captured.cost, captured.id);
    } catch (err) {
        logger.error("Failed to deduct LLM proxy credits", { organizationId, requestId: captured.id, err });
    }
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (err) {
        logger.debug("Failed to parse JSON from OpenRouter response", { err });
        return undefined;
    }
}
