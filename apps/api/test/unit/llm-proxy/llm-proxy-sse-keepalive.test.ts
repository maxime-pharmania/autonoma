import type * as LoggerModule from "@autonoma/logger";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
    SseRelayOutcome,
    llmProxyHttpRouter as LlmProxyHttpRouter,
    relayUpstreamSseStream,
    resolveSseKeepaliveIntervalMs,
} from "../../../src/llm-proxy/llm-proxy-http.router";

const TEST_ORGANIZATION_ID = "org_test";
const TEST_MODEL = "google/gemini-3-flash-preview";

/** The keepalive comment the proxy writes while the upstream is silent, byte for byte. */
const KEEPALIVE = ": keepalive\n\n";

/** The one line the proxy writes at the end of a streamed response, whichever way it ended. */
const END_LOG = "LLM proxy streamed response ended";

/** One upstream SSE chunk carrying usage OpenRouter's way, so the request has something to meter. */
const USAGE_CHUNK = 'data: {"id":"gen_keepalive","usage":{"cost":0.0012}}\n\n';

/**
 * The upstream reply the proxy is pointed at, created per request so a test drives the stream by hand:
 * `send` at the moment it wants bytes, `close` when the answer is over.
 */
type TestUpstream = { response: Response; send: (text: string) => void; close: () => void };

const encoder = new TextEncoder();

/**
 * `src/context.ts` builds the live billing/DB services and throws when TESTING is set (see
 * vitest.config.ts), so stand in a billing service whose two proxy calls are spies: reading back what a
 * request metered is the only way to check the keepalive left the usage scan alone.
 */
const billing = vi.hoisted(() => ({
    checkLlmProxyGate: vi.fn(async () => ({ allowed: true })),
    deductCreditsForLlmProxy: vi.fn(async () => undefined),
}));
vi.mock("../../../src/context", () => ({ billingService: billing }));

// The router is behind `requireApiKey`; the tests are about what happens downstream of a caller that
// authenticated, so the middleware stands in for that (and keeps the auth services out of the test).
vi.mock("@autonoma/auth", () => ({
    requireApiKey:
        () =>
        async (c: { set: (key: "user", value: { organizationId: string }) => void }, next: () => Promise<void>) => {
            c.set("user", { organizationId: "org_test" });
            await next();
        },
}));

/**
 * The router logs through a child of the root logger, which a test cannot reach. Keeping the real module and
 * replacing only `logger` gives the router a spy: reading back its one end-of-stream line is the point of the
 * diagnostics under test.
 */
const logger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));
vi.mock("@autonoma/logger", async (importOriginal) => {
    const actual = await importOriginal<typeof LoggerModule>();
    return { ...actual, logger: { ...actual.logger, child: () => logger } };
});

/** The upstream API key is read once, at module scope, so it has to be in place before the import below. */
vi.hoisted(() => {
    process.env.LLM_PROXY_UPSTREAM_API_KEY = "test-upstream-key";
});

const originalKeepaliveEnv = process.env.LLM_PROXY_SSE_KEEPALIVE_MS;

let router: typeof LlmProxyHttpRouter;
let relay: typeof relayUpstreamSseStream;
let resolveInterval: typeof resolveSseKeepaliveIntervalMs;

beforeAll(async () => {
    const module = await import("../../../src/llm-proxy/llm-proxy-http.router");
    router = module.llmProxyHttpRouter;
    relay = module.relayUpstreamSseStream;
    resolveInterval = module.resolveSseKeepaliveIntervalMs;
});

afterAll(() => {
    if (originalKeepaliveEnv == null) delete process.env.LLM_PROXY_SSE_KEEPALIVE_MS;
    else process.env.LLM_PROXY_SSE_KEEPALIVE_MS = originalKeepaliveEnv;
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

/** An upstream whose body never produces a byte until the test says so - i.e. a model in thinking mode. */
function silentUpstream(onCancel?: () => void): TestUpstream {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        },
        // A cancelled source is a released one: the relay must propagate the caller's cancellation.
        cancel: () => onCancel?.(),
    });
    return {
        response: new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        send: (text) => controller.enqueue(encoder.encode(text)),
        // Tolerated after a cancellation: the test closes a source the relay may already have released.
        close: () => {
            try {
                controller.close();
            } catch {
                /* already cancelled */
            }
        },
    };
}

/** A relayed upstream body, with the outcomes it reported. */
function relayed(
    source: ReadableStream<Uint8Array>,
    keepaliveMs: number,
): { body: ReadableStream<Uint8Array>; outcomes: SseRelayOutcome[] } {
    const outcomes: SseRelayOutcome[] = [];
    const body = relay(source, { keepaliveMs, startedAtMs: Date.now() }, (outcome) => outcomes.push(outcome));
    return { body, outcomes };
}

/** Point the proxy's `fetch` at `response` and never at the network. */
function stubUpstream(response: Response): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
    );
}

function postChatCompletions(body: Record<string, unknown>): Promise<Response> {
    return router.request("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TEST_MODEL, ...body }),
    });
}

/** Every end-of-stream line the router logged, with its fields. */
function streamEndLines(): Record<string, unknown>[] {
    return logger.info.mock.calls
        .filter(([message]) => message === END_LOG)
        .map(([, fields]) => fields as Record<string, unknown>);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A non-streamed upstream reply whose body takes a while to arrive, long enough for a stray keepalive to show. */
function delayedJsonBody(body: string, status: number): Response {
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            await sleep(50);
            controller.enqueue(encoder.encode(body));
            controller.close();
        },
    });
    return new Response(stream, { status, headers: { "Content-Type": "application/json" } });
}

describe("relayUpstreamSseStream", () => {
    it("writes keepalive comments while the upstream is silent, then the upstream bytes unchanged", async () => {
        vi.useFakeTimers();
        const upstream = silentUpstream();
        const { body, outcomes } = relayed(upstream.response.body!, 1000);
        const textPromise = new Response(body).text();

        await vi.advanceTimersByTimeAsync(3000);
        upstream.send(USAGE_CHUNK);
        upstream.close();

        expect(await textPromise).toBe(KEEPALIVE + KEEPALIVE + KEEPALIVE + USAGE_CHUNK);
        // Duration, what the caller saw, and why the relay stopped - in one report, for a relay that ran to the
        // end of the upstream's answer.
        expect(outcomes).toStrictEqual([
            { durationMs: 3000, relayedUpstreamBytes: true, endReason: "upstream_finished", error: undefined },
        ]);
    });

    it("stops the keepalive on the first upstream byte, so no comment lands inside the upstream flow", async () => {
        vi.useFakeTimers();
        const upstream = silentUpstream();
        const { body, outcomes } = relayed(upstream.response.body!, 1000);
        const textPromise = new Response(body).text();

        await vi.advanceTimersByTimeAsync(1000);
        upstream.send("data: first\n\n");
        await vi.advanceTimersByTimeAsync(10_000);
        upstream.send("data: second\n\n");
        upstream.close();

        expect(await textPromise).toBe(`${KEEPALIVE}data: first\n\ndata: second\n\n`);
        expect(outcomes).toStrictEqual([
            { durationMs: 11_000, relayedUpstreamBytes: true, endReason: "upstream_finished", error: undefined },
        ]);
    });

    it("stops its timer when the upstream stream ends", async () => {
        vi.useFakeTimers();
        const upstream = silentUpstream();
        const { body } = relayed(upstream.response.body!, 1000);
        expect(vi.getTimerCount()).toBe(1);

        const textPromise = new Response(body).text();
        await vi.advanceTimersByTimeAsync(1000);
        upstream.close();
        await textPromise;

        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops its timer and reports the failure when the upstream stream fails", async () => {
        vi.useFakeTimers();
        const failure = new Error("upstream blew up");
        let fail!: (err: unknown) => void;
        const broken = new ReadableStream<Uint8Array>({
            start(controller) {
                fail = (err) => controller.error(err);
            },
        });
        const { body, outcomes } = relayed(broken, 1000);
        const textPromise = new Response(body).text();

        await vi.advanceTimersByTimeAsync(1000);
        fail(failure);

        await expect(textPromise).rejects.toThrow("upstream blew up");
        expect(vi.getTimerCount()).toBe(0);
        expect(outcomes).toStrictEqual([
            { durationMs: 1000, relayedUpstreamBytes: false, endReason: "upstream_failed", error: failure },
        ]);
    });

    it("stops its timer and releases the source when the caller cancels", async () => {
        vi.useFakeTimers();
        let sourceCancelled = false;
        const upstream = silentUpstream(() => {
            sourceCancelled = true;
        });
        const { body, outcomes } = relayed(upstream.response.body!, 1000);
        const reader = body.getReader();

        await vi.advanceTimersByTimeAsync(1000);
        await reader.cancel("caller hung up");
        // The upstream branch is cancelled too: nothing keeps generating for a caller that is gone.
        expect(sourceCancelled).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        // ...and an upstream that ends afterwards does not report a second time.
        upstream.close();
        await Promise.resolve();
        expect(outcomes).toStrictEqual([
            { durationMs: 1000, relayedUpstreamBytes: false, endReason: "client_cancelled", error: "caller hung up" },
        ]);
    });

    it("reports the duration against when the upstream request started", async () => {
        vi.useFakeTimers();
        const upstream = silentUpstream();
        const outcomes: SseRelayOutcome[] = [];
        const body = relay(upstream.response.body!, { keepaliveMs: 0, startedAtMs: Date.now() - 1234 }, (outcome) =>
            outcomes.push(outcome),
        );

        const textPromise = new Response(body).text();
        upstream.send(USAGE_CHUNK);
        upstream.close();
        await textPromise;

        expect(outcomes[0]?.durationMs).toBe(1234);
    });

    it("arms no timer and writes no comment when the interval disables the keepalive", async () => {
        vi.useFakeTimers();
        const upstream = silentUpstream();
        const { body, outcomes } = relayed(upstream.response.body!, 0);
        expect(vi.getTimerCount()).toBe(0);

        const textPromise = new Response(body).text();
        await vi.advanceTimersByTimeAsync(60_000);
        upstream.send(USAGE_CHUNK);
        upstream.close();

        expect(await textPromise).toBe(USAGE_CHUNK);
        expect(vi.getTimerCount()).toBe(0);
        expect(outcomes).toStrictEqual([
            { durationMs: 60_000, relayedUpstreamBytes: true, endReason: "upstream_finished", error: undefined },
        ]);
    });
});

describe("resolveSseKeepaliveIntervalMs", () => {
    it("defaults to 15s when the variable is unset", () => {
        delete process.env.LLM_PROXY_SSE_KEEPALIVE_MS;
        expect(resolveInterval()).toBe(15_000);
    });

    it("defaults to 15s when the variable is blank - what a rendered template leaves behind", () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "");
        expect(resolveInterval()).toBe(15_000);
    });

    it("defaults to 15s when the variable is unreadable, rather than failing the request", () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "not-a-number");
        expect(resolveInterval()).toBe(15_000);
    });

    it("reads the configured interval and the disabling 0", () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "2000");
        expect(resolveInterval()).toBe(2000);
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "0");
        expect(resolveInterval()).toBe(0);
    });
});

describe("LLM proxy SSE keepalive", () => {
    it("keeps a silently thinking upstream alive and meters the usage it eventually reports", async () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "20");
        const upstream = silentUpstream();
        stubUpstream(upstream.response);

        const response = await postChatCompletions({ stream: true });
        const textPromise = response.text();
        await sleep(200);
        upstream.send(USAGE_CHUNK);
        upstream.close();
        const text = await textPromise;

        // The reply is keepalive comments, then the upstream body verbatim - nothing else, in that order.
        expect(text.startsWith(KEEPALIVE)).toBe(true);
        expect(text.endsWith(USAGE_CHUNK)).toBe(true);
        expect(text.replaceAll(KEEPALIVE, "")).toBe(USAGE_CHUNK);
        // ...and the usage in that body still meters, exactly as it would without the comment.
        await vi.waitFor(() =>
            expect(billing.deductCreditsForLlmProxy).toHaveBeenCalledWith(
                TEST_ORGANIZATION_ID,
                0.0012,
                "gen_keepalive",
            ),
        );
    });

    it("injects nothing ahead of an upstream that answers quickly", async () => {
        // The keepalive is armed for a full minute: nothing may be written ahead of an answer that arrives in
        // milliseconds, which is what every non-thinking turn looks like.
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "60000");
        const upstream = silentUpstream();
        upstream.send(USAGE_CHUNK);
        upstream.close();
        stubUpstream(upstream.response);

        const response = await postChatCompletions({ stream: true });

        expect(await response.text()).toBe(USAGE_CHUNK);
        await vi.waitFor(() =>
            expect(billing.deductCreditsForLlmProxy).toHaveBeenCalledWith(
                TEST_ORGANIZATION_ID,
                0.0012,
                "gen_keepalive",
            ),
        );
    });

    it("writes no keepalive while the flag is 0", async () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "0");
        const upstream = silentUpstream();
        stubUpstream(upstream.response);

        const response = await postChatCompletions({ stream: true });
        const textPromise = response.text();
        await sleep(100);
        upstream.send(USAGE_CHUNK);
        upstream.close();

        expect(await textPromise).toBe(USAGE_CHUNK);
    });

    it("meters the same usage whether or not a keepalive comment preceded the body", async () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "20");
        const slow = silentUpstream();
        stubUpstream(slow.response);
        const slowResponse = await postChatCompletions({ stream: true });
        const slowText = slowResponse.text();
        await sleep(100);
        slow.send(USAGE_CHUNK);
        slow.close();
        expect(await slowText).toContain(KEEPALIVE);

        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "0");
        const fast = silentUpstream();
        fast.send(USAGE_CHUNK);
        fast.close();
        stubUpstream(fast.response);
        const fastResponse = await postChatCompletions({ stream: true });
        const fastText = await fastResponse.text();
        expect(fastText).toBe(USAGE_CHUNK);

        await vi.waitFor(() => expect(billing.deductCreditsForLlmProxy).toHaveBeenCalledTimes(2));
        const [slowCall, fastCall] = billing.deductCreditsForLlmProxy.mock.calls;
        expect(slowCall).toStrictEqual(fastCall);
    });

    it("leaves a non-streamed upstream body byte for byte alone, success or error", async () => {
        // Enabled and tiny: a non-streamed request must not be wrapped at all, however long the upstream takes.
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "1");
        const usageBody = JSON.stringify({
            id: "gen_plain",
            choices: [{ message: { role: "assistant", content: "plan" } }],
            usage: { cost: 0.002 },
        });
        stubUpstream(delayedJsonBody(usageBody, 200));
        const ok = await postChatCompletions({ stream: false });

        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe(usageBody);
        await vi.waitFor(() =>
            expect(billing.deductCreditsForLlmProxy).toHaveBeenCalledWith(TEST_ORGANIZATION_ID, 0.002, "gen_plain"),
        );

        stubUpstream(delayedJsonBody('{"error":{"message":"no such model"}}', 400));
        const failed = await postChatCompletions({ stream: false });

        expect(failed.status).toBe(502);
        expect(await failed.text()).toBe('{"error":"upstream_error"}');
        expect(streamEndLines()).toStrictEqual([]);
    });

    it("logs one line when a streamed response ends normally", async () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "0");
        const upstream = silentUpstream();
        upstream.send(USAGE_CHUNK);
        upstream.close();
        stubUpstream(upstream.response);

        const response = await postChatCompletions({ stream: true });
        expect(await response.text()).toBe(USAGE_CHUNK);

        expect(streamEndLines()).toStrictEqual([
            {
                organizationId: TEST_ORGANIZATION_ID,
                model: TEST_MODEL,
                durationMs: expect.any(Number),
                relayedUpstreamBytes: true,
                endReason: "upstream_finished",
                err: undefined,
            },
        ]);
    });

    it("logs one line, and only one, when the caller is cut off before the answer starts", async () => {
        vi.stubEnv("LLM_PROXY_SSE_KEEPALIVE_MS", "0");
        const upstream = silentUpstream();
        stubUpstream(upstream.response);

        const response = await postChatCompletions({ stream: true });
        await response.body!.cancel("caller hung up");

        // Cut before any upstream byte, reported as the caller's doing - the shape an intermediary's cut of a
        // silent stream does NOT take (that one arrives as upstream_failed, see the relay's own tests).
        expect(streamEndLines()).toStrictEqual([
            {
                organizationId: TEST_ORGANIZATION_ID,
                model: TEST_MODEL,
                durationMs: expect.any(Number),
                relayedUpstreamBytes: false,
                endReason: "client_cancelled",
                err: "caller hung up",
            },
        ]);

        // The upstream ending after the caller left does not add a second line.
        upstream.close();
        await Promise.resolve();
        expect(streamEndLines()).toHaveLength(1);
    });
});
