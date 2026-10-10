import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEngineModelOverrides } from "./engine-model-overrides";
import {
    type WebEngineModelRegistry,
    createEngineModelRegistry,
    createWebEngineModelRegistry,
} from "./engine-model-registry";
import type { EngineModelSlot } from "./engine-model-slots";

// Building a registry resolves every entry in it, so the built-in entries demand provider keys and the custom
// ones demand the OpenAI-compatible base URL. Nothing here reaches a provider - the tests only read the model id
// a slot resolved to - so stub values are enough.
const STUB_ENV: Record<string, string> = {
    GROQ_KEY: "stub-groq-key",
    GEMINI_API_KEY: "stub-gemini-key",
    OPENROUTER_API_KEY: "stub-openrouter-key",
    OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8080/v1",
};

const ORIGINAL_ENV = new Map(Object.keys(STUB_ENV).map((key) => [key, process.env[key]]));

beforeAll(() => {
    for (const [key, value] of Object.entries(STUB_ENV)) {
        process.env[key] = value;
    }
});

afterAll(() => {
    for (const [key, original] of ORIGINAL_ENV) {
        if (original == null) {
            delete process.env[key];
            continue;
        }

        process.env[key] = original;
    }
});

function webSlotModelId(registry: WebEngineModelRegistry, slot: EngineModelSlot): string {
    return registry.getModel({ model: slot, tag: "test" }).modelId;
}

describe("parseEngineModelOverrides", () => {
    it("yields no overrides when the variable is absent, empty or whitespace-only", () => {
        expect(parseEngineModelOverrides(undefined)).toEqual({});
        expect(parseEngineModelOverrides("")).toEqual({});
        expect(parseEngineModelOverrides("   ")).toEqual({});
    });

    it("parses a single slot assignment", () => {
        expect(Object.keys(parseEngineModelOverrides("smart-visual=my-vl"))).toEqual(["smart-visual"]);
    });

    it("parses several slots, tolerating spaces around the assignments", () => {
        expect(Object.keys(parseEngineModelOverrides("fast-visual=my-fast, pointer=my-ground"))).toEqual([
            "fast-visual",
            "pointer",
        ]);
    });

    it("keeps the last assignment when a slot is listed twice", () => {
        const overrides = parseEngineModelOverrides("pointer=first,pointer=second");
        const registry = createWebEngineModelRegistry(undefined, overrides);

        expect(webSlotModelId(registry, "pointer")).toBe("second");
    });

    it("rejects an entry with no assignment, naming the variable and the entry", () => {
        expect(() => parseEngineModelOverrides("smart-visual")).toThrow(/OPENAI_COMPATIBLE_MODEL_SLOTS/);
        expect(() => parseEngineModelOverrides("smart-visual")).toThrow(/"smart-visual"/);
    });

    it("rejects an unknown slot, naming it along with the valid slots", () => {
        expect(() => parseEngineModelOverrides("visual-smart=my-vl")).toThrow(/"visual-smart"/);
        expect(() => parseEngineModelOverrides("visual-smart=my-vl")).toThrow(/pointer/);
    });

    it("rejects a slot whose model id is empty", () => {
        expect(() => parseEngineModelOverrides("smart-visual=  ")).toThrow(/"smart-visual" has no model id/);
    });
});

describe("engine model slot overrides", () => {
    it("serves the overridden model on the targeted slot and leaves the other slots untouched", () => {
        const defaults = createWebEngineModelRegistry();
        const overridden = createWebEngineModelRegistry(undefined, parseEngineModelOverrides("smart-visual=my-vl"));

        expect(webSlotModelId(overridden, "smart-visual")).toBe("my-vl");
        expect(webSlotModelId(overridden, "fast-visual")).toBe(webSlotModelId(defaults, "fast-visual"));
        expect(webSlotModelId(overridden, "fast-text")).toBe(webSlotModelId(defaults, "fast-text"));
        expect(webSlotModelId(overridden, "pointer")).toBe(webSlotModelId(defaults, "pointer"));
    });

    it("serves the built-in models when the variable is unset", () => {
        const defaults = createWebEngineModelRegistry();
        const noOverrides = createWebEngineModelRegistry(undefined, parseEngineModelOverrides(undefined));

        expect(webSlotModelId(noOverrides, "smart-visual")).toBe(webSlotModelId(defaults, "smart-visual"));
        expect(webSlotModelId(noOverrides, "pointer")).toBe(webSlotModelId(defaults, "pointer"));
    });

    it("ignores a pointer override on mobile, where that slot does not exist", () => {
        const overrides = parseEngineModelOverrides("pointer=my-ground,fast-text=my-text");
        const mobile = createEngineModelRegistry(undefined, overrides);

        expect(mobile.getModel({ model: "fast-text", tag: "test" }).modelId).toBe("my-text");
    });
});
