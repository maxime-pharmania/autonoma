import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_MODEL } from "../../src/core/model";

/**
 * Which endpoint serves the model is decided by OPENAI_COMPATIBLE_BASE_URL alone.
 * The difference that matters is an outcome rather than a flag: the managed proxy
 * refuses to build a model without an Autonoma token, the operator's own endpoint
 * does not need one.
 */
const ENDPOINT_VARS = [
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
    "AUTONOMA_API_TOKEN",
    "OPENROUTER_MODEL",
    "AUTONOMA_API_URL",
] as const;

const originalEnv = { ...process.env };

beforeEach(() => {
    for (const key of ENDPOINT_VARS) delete process.env[key];
    // Model providers are memoized per endpoint kind, so each test needs its own module instance.
    vi.resetModules();
});

afterEach(() => {
    process.env = { ...originalEnv };
});

interface ResolvedModel {
    modelId: string;
    provider: string;
}

/** `LanguageModel` also names an id-only string, so the fields are read back behind a check. */
function isResolvedModel(model: LanguageModel): model is LanguageModel & ResolvedModel {
    return typeof model !== "string";
}

/** Resolve a model the way a step does; a synchronous throw surfaces as a rejection. */
async function loadModel(modelId?: string): Promise<ResolvedModel> {
    const { getModel } = await import("../../src/core/model");
    const model = getModel(modelId);

    if (!isResolvedModel(model)) throw new Error("expected a resolved model, got an id");

    return model;
}

describe("getModel on the managed proxy", () => {
    test("has no model to offer without an Autonoma token", async () => {
        await expect(loadModel()).rejects.toThrow("Not authenticated");
    });

    test("takes the id from the argument, then the env, then the default", async () => {
        process.env.AUTONOMA_API_TOKEN = "ask_test";

        expect((await loadModel()).modelId).toBe(DEFAULT_MODEL);
        expect((await loadModel("vendor/model")).modelId).toBe("vendor/model");

        process.env.OPENROUTER_MODEL = "vendor/from-env";
        expect((await loadModel()).modelId).toBe("vendor/from-env");
    });
});

describe("getModel on a configured OpenAI-compatible endpoint", () => {
    test("builds the custom provider without an Autonoma token in sight", async () => {
        process.env.OPENAI_COMPATIBLE_BASE_URL = "http://localhost:8000/v1";

        const model = await loadModel("my-model");

        expect(model.modelId).toBe("my-model");
        expect(model.provider).toBe("openai-compatible.chat");
    });

    test("still takes the id from the same knob", async () => {
        process.env.OPENAI_COMPATIBLE_BASE_URL = "http://localhost:8000/v1";
        process.env.OPENROUTER_MODEL = "vendor/from-env";

        expect((await loadModel()).modelId).toBe("vendor/from-env");
    });

    test("treats an empty base URL as no endpoint at all", async () => {
        process.env.OPENAI_COMPATIBLE_BASE_URL = "";

        await expect(loadModel()).rejects.toThrow("Not authenticated");
    });

    // One memoized provider per endpoint kind: dropping the endpoint has to fall back to the
    // proxy, never reuse the endpoint's model against a host the run no longer talks to.
    test("does not reuse the endpoint's provider once the endpoint is gone", async () => {
        process.env.OPENAI_COMPATIBLE_BASE_URL = "http://localhost:8000/v1";
        await loadModel("my-model");

        delete process.env.OPENAI_COMPATIBLE_BASE_URL;

        await expect(loadModel("my-model")).rejects.toThrow("Not authenticated");
    });
});
