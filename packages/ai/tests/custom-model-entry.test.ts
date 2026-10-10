import { afterEach, describe, expect, it } from "vitest";
import { createCustomModelEntry } from "../src/registry/custom-model-entry";
import { ModelRegistry, NotAVideoModelError } from "../src/registry/model-registry";
import { resolveOpenAiCompatibleConfig } from "../src/registry/openai-compatible-config";
import { newModelUsage } from "../src/registry/usage";

// Under Vitest `@autonoma/ai/env` is `process.env` itself (createEnv skips validation and returns its
// runtimeEnv unchanged), so stubbing the process value here is what the provider actually reads.
const BASE_URL_ENV = "OPENAI_COMPATIBLE_BASE_URL";
const API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";

describe("resolveOpenAiCompatibleConfig", () => {
    const originalBaseUrl = process.env[BASE_URL_ENV];
    const originalApiKey = process.env[API_KEY_ENV];

    afterEach(() => {
        restoreEnv(BASE_URL_ENV, originalBaseUrl);
        restoreEnv(API_KEY_ENV, originalApiKey);
    });

    it("names the missing variable when no endpoint is configured", () => {
        delete process.env[BASE_URL_ENV];

        expect(() => resolveOpenAiCompatibleConfig()).toThrow(BASE_URL_ENV);
    });

    it("returns the configured endpoint, with the key optional", () => {
        process.env[BASE_URL_ENV] = "http://127.0.0.1:8080/v1";
        delete process.env[API_KEY_ENV];

        expect(resolveOpenAiCompatibleConfig()).toEqual({
            baseURL: "http://127.0.0.1:8080/v1",
            apiKey: undefined,
        });
    });

    it("returns the configured key when one is set", () => {
        process.env[BASE_URL_ENV] = "http://127.0.0.1:8080/v1";
        process.env[API_KEY_ENV] = "endpoint-key";

        expect(resolveOpenAiCompatibleConfig()).toEqual({
            baseURL: "http://127.0.0.1:8080/v1",
            apiKey: "endpoint-key",
        });
    });
});

describe("createCustomModelEntry", () => {
    const originalBaseUrl = process.env[BASE_URL_ENV];

    afterEach(() => restoreEnv(BASE_URL_ENV, originalBaseUrl));

    it("resolves the entry's model through the configured endpoint", () => {
        process.env[BASE_URL_ENV] = "http://127.0.0.1:8080/v1";
        const registry = new ModelRegistry({ models: { custom: createCustomModelEntry("my-model") } });

        const model = registry.getModel({ model: "custom", tag: "test" });

        expect(model.modelId).toBe("my-model");
    });

    it("bills nothing, so an endpoint that omits usage still meters", () => {
        expect(createCustomModelEntry("my-model").pricing(newModelUsage())).toBe(0);
    });

    it("is not video-capable, so a recording is never handed to it", () => {
        process.env[BASE_URL_ENV] = "http://127.0.0.1:8080/v1";
        const registry = new ModelRegistry({ models: { custom: createCustomModelEntry("my-model") } });

        expect(() => registry.getVideoModel({ model: "custom", tag: "test" })).toThrow(NotAVideoModelError);
    });
});

function restoreEnv(key: string, value: string | undefined) {
    if (value == null) {
        delete process.env[key];
        return;
    }

    process.env[key] = value;
}
