import { createServer, type Server } from "node:http";
import { NotAVideoModelError } from "@autonoma/ai";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openModelSession } from "../../../src/analysis/ai/model-session";

// @autonoma/ai skips its env validation under VITEST, so the shared video entry has no Google key; it builds a
// GoogleGenAI client eagerly when the session's registry is constructed, and that client rejects an absent key.
vi.hoisted(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
});

const CHAT_COMPLETIONS_STUB_REPLY = "hello from the endpoint";
const CHAT_COMPLETIONS_STUB_USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

interface ChatCompletionsStub {
    baseUrl: string;
    requestPaths: string[];
    requestBodies: string[];
}

const openStubs: Server[] = [];

afterEach(async () => {
    await Promise.all(openStubs.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    openStubs.length = 0;
});

/** A minimal OpenAI chat-completions endpoint, so a test can observe what a session actually sends. */
function startChatCompletionsStub(): Promise<ChatCompletionsStub> {
    const requestPaths: string[] = [];
    const requestBodies: string[] = [];

    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            requestPaths.push(req.url ?? "");
            requestBodies.push(Buffer.concat(chunks).toString());

            const body = {
                id: "chatcmpl-stub",
                object: "chat.completion",
                created: 0,
                model: "custom-classifier",
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: CHAT_COMPLETIONS_STUB_REPLY },
                        finish_reason: "stop",
                    },
                ],
                usage: CHAT_COMPLETIONS_STUB_USAGE,
            };

            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        });
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            openStubs.push(server);
            const address = server.address();
            const port = typeof address === "object" && address != null ? address.port : 0;
            resolve({ baseUrl: `http://127.0.0.1:${port}`, requestPaths, requestBodies });
        });
    });
}

describe("openModelSession", () => {
    it("resolves an id outside the native table to chat-completions instead of throwing", () => {
        const session = openModelSession({ openaiApiKey: "test-key", classifierModelId: "custom-classifier" });

        const model = session.getModel({ model: "classifier", tag: "analysis-classifier" });

        expect(model.modelId).toBe("custom-classifier");
        expect(model.provider).toBe("openai.chat");
    });

    it("routes a reasoning capability at the configured endpoint and meters it at zero cost", async () => {
        const stub = await startChatCompletionsStub();
        const session = openModelSession({
            openaiApiKey: "test-key",
            openAiBaseUrl: `${stub.baseUrl}/v1`,
            classifierModelId: "custom-classifier",
        });

        const result = await generateText({
            model: session.getModel({ model: "classifier", tag: "analysis-classifier" }),
            prompt: "hello",
        });

        expect(result.text).toBe(CHAT_COMPLETIONS_STUB_REPLY);
        expect(stub.requestPaths).toEqual(["/v1/chat/completions"]);
        expect(stub.requestBodies[0]).toContain("custom-classifier");

        const records = session.costCollector.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]?.model).toBe("custom-classifier");
        expect(records[0]?.costMicrodollars).toBe(0);
    });

    it("still fails on an unknown video model id", () => {
        expect(() => openModelSession({ openaiApiKey: "test-key", videoModelId: "not-a-video-model" })).toThrow(
            /Unknown video model id/,
        );
    });

    it("keeps the reasoning capabilities non-video", () => {
        const session = openModelSession({ openaiApiKey: "test-key", classifierModelId: "custom-classifier" });

        expect(() => session.getVideoModel({ model: "classifier", tag: "analysis-classifier" })).toThrow(
            NotAVideoModelError,
        );
    });
});
