import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThinkingCompat } from "../../../src/llm-proxy/llm-proxy-http.router";

// `src/context.ts` throws when TESTING is set (it builds the live services), and the router imports it
// for the handler only. The rewrite under test never reads it, so stand it in rather than boot services.
vi.mock("../../../src/context", () => ({ billingService: {} }));

/**
 * The flag is read per request rather than cached at boot, so a test toggles it on the environment
 * instead of reloading the module.
 */
function withThinkingCompat(value: "true" | "false"): void {
    vi.stubEnv("LLM_PROXY_THINKING_COMPAT", value);
}

/** The flag unset, which is how a deployment that never opted in runs. */
function withoutThinkingCompat(): void {
    vi.unstubAllEnvs();
    delete process.env.LLM_PROXY_THINKING_COMPAT;
}

/** A planner-shaped body: one user turn, plus whatever the test overrides. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "user", content: "plan this" }],
        ...overrides,
    };
}

/**
 * The directive the rewrite is expected to put in the system message, spelled out rather than imported:
 * it is the instruction the model reads, so the test pins its exact wording.
 */
const FORCED_TOOL_CHOICE_DIRECTIVE =
    "Respond with exactly one tool call per turn: call a tool on every turn instead of answering with prose, and call the finish tool once the task is complete.";

describe("applyThinkingCompat", () => {
    afterEach(() => {
        withoutThinkingCompat();
    });

    it('replaces a forced tool_choice of "required" with "auto"', () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(body({ tool_choice: "required" }));
        expect(rewritten.body.tool_choice).toBe("auto");
    });

    it('replaces a tool_choice that pins one function with "auto"', () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(
            body({ tool_choice: { type: "function", function: { name: "run_command" } } }),
        );
        expect(rewritten.body.tool_choice).toBe("auto");
    });

    it("leaves a tool_choice that is not forced alone", () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(body({ tool_choice: "auto" }));
        expect(rewritten.body.tool_choice).toBe("auto");
        expect(rewritten.toolChoiceReplaced).toBe(false);
        expect(rewritten.body.messages).toStrictEqual([{ role: "user", content: "plan this" }]);
        expect(rewritten.systemDirectiveAdded).toBe(false);
    });

    it("restates a replaced tool_choice in a system message that carries text", () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(
            body({
                tool_choice: "required",
                messages: [
                    { role: "system", content: "be terse" },
                    { role: "user", content: "plan this" },
                ],
            }),
        );
        expect(rewritten.body.messages).toStrictEqual([
            { role: "system", content: `be terse\n\n${FORCED_TOOL_CHOICE_DIRECTIVE}` },
            { role: "user", content: "plan this" },
        ]);
        expect(rewritten.toolChoiceReplaced).toBe(true);
        expect(rewritten.systemDirectiveAdded).toBe(true);
    });

    it("adds the directive as a text part to a system message built from parts", () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(
            body({
                tool_choice: "required",
                messages: [
                    {
                        role: "system",
                        content: [
                            { type: "text", text: "be terse" },
                            { type: "image_url", image_url: { url: "https://example.test/plan.png" } },
                        ],
                    },
                    { role: "user", content: "plan this" },
                ],
            }),
        );
        expect(rewritten.body.messages).toStrictEqual([
            {
                role: "system",
                content: [
                    { type: "text", text: "be terse" },
                    { type: "image_url", image_url: { url: "https://example.test/plan.png" } },
                    { type: "text", text: FORCED_TOOL_CHOICE_DIRECTIVE },
                ],
            },
            { role: "user", content: "plan this" },
        ]);
        expect(rewritten.systemDirectiveAdded).toBe(true);
    });

    it("inserts a system message when the request carries none", () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(body({ tool_choice: "required" }));
        expect(rewritten.body.messages).toStrictEqual([
            { role: "system", content: FORCED_TOOL_CHOICE_DIRECTIVE },
            { role: "user", content: "plan this" },
        ]);
        expect(rewritten.systemDirectiveAdded).toBe(true);
    });

    it("keeps a system message it cannot extend and inserts the directive before it", () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(
            body({
                tool_choice: "required",
                messages: [
                    { role: "system", content: { opaque: true } },
                    { role: "user", content: "plan this" },
                ],
            }),
        );
        expect(rewritten.body.messages).toStrictEqual([
            { role: "system", content: FORCED_TOOL_CHOICE_DIRECTIVE },
            { role: "system", content: { opaque: true } },
            { role: "user", content: "plan this" },
        ]);
        expect(rewritten.systemDirectiveAdded).toBe(true);
    });

    it("adds an empty reasoning_content to an assistant message that has none", () => {
        withThinkingCompat("true");
        const rewritten = applyThinkingCompat(
            body({
                messages: [
                    { role: "assistant", content: "here is my plan" },
                    { role: "user", content: "go" },
                ],
            }),
        );
        expect(rewritten.body.messages).toStrictEqual([
            { role: "assistant", content: "here is my plan", reasoning_content: "" },
            { role: "user", content: "go" },
        ]);
        expect(rewritten.adjustedAssistantMessages).toBe(1);
    });

    it("keeps a reasoning_content the caller already provided", () => {
        withThinkingCompat("true");
        const message = { role: "assistant", content: "answer", reasoning_content: "prior reasoning" };
        const rewritten = applyThinkingCompat(body({ messages: [message] }));
        expect(rewritten.body.messages).toStrictEqual([message]);
        expect(rewritten.adjustedAssistantMessages).toBe(0);
    });

    it("leaves user and system messages untouched", () => {
        withThinkingCompat("true");
        const messages = [
            { role: "system", content: "be terse" },
            { role: "user", content: "plan this" },
        ];
        const rewritten = applyThinkingCompat(body({ messages }));
        expect(rewritten.body.messages).toStrictEqual(messages);
        expect(rewritten.adjustedAssistantMessages).toBe(0);
        expect(rewritten.systemDirectiveAdded).toBe(false);
    });

    it("forwards the body untouched while the flag is off", () => {
        withThinkingCompat("false");
        const original = body({
            tool_choice: "required",
            messages: [{ role: "assistant", content: "here is my plan" }],
        });
        const result = applyThinkingCompat(original);
        expect(result.enabled).toBe(false);
        expect(result.body).toBe(original);
        expect(Object.keys(result.body)).toStrictEqual(["model", "messages", "tool_choice"]);
        expect(result.body.messages).toStrictEqual([{ role: "assistant", content: "here is my plan" }]);
        expect(result.systemDirectiveAdded).toBe(false);
    });

    it("forwards the body untouched while the flag is unset", () => {
        withoutThinkingCompat();
        const original = body({ tool_choice: "required" });
        expect(applyThinkingCompat(original).body).toBe(original);
    });

    it("forwards the body untouched when messages is not an array", () => {
        withThinkingCompat("true");
        const original = body({ tool_choice: "required", messages: "not-an-array" });
        const result = applyThinkingCompat(original);
        expect(result.body).toBe(original);
        expect(result.toolChoiceReplaced).toBe(false);
        expect(result.systemDirectiveAdded).toBe(false);
    });

    it("forwards the body untouched when messages is absent", () => {
        withThinkingCompat("true");
        const original: Record<string, unknown> = {
            model: "google/gemini-3-flash-preview",
            tool_choice: "required",
        };
        expect(applyThinkingCompat(original).body).toBe(original);
    });

    it("forwards the body untouched when the rewrite throws", () => {
        withThinkingCompat("true");
        // A message whose property reads throw stands in for a rewrite that fails: the request must still
        // be forwarded with the body we were given, counters and all reading as "nothing rewritten".
        const poisoned = {
            role: "assistant",
            get content(): string {
                throw new Error("poisoned message");
            },
        };
        const original = body({ tool_choice: "required", messages: [poisoned] });
        const result = applyThinkingCompat(original);
        expect(result.body).toBe(original);
        expect(result.adjustedAssistantMessages).toBe(0);
        expect(result.toolChoiceReplaced).toBe(false);
        expect(result.systemDirectiveAdded).toBe(false);
    });
});
