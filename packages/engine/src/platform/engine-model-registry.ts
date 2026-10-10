import { type CostCollector, MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import type { EngineModelSlot, EngineModelSlotOverrides } from "./engine-model-slots";

// Built-in entries for the slots shared by every platform's registry. Kept as one source so web and mobile
// can't silently drift on the non-`smart-visual` models; each platform overrides only what differs
// (`smart-visual`, and web's extra `pointer`).
const SHARED_MODEL_SLOTS = {
    "fast-visual": MODEL_ENTRIES.MINISTRAL_8B,
    "fast-text": MODEL_ENTRIES.GPT_OSS_120B,
} as const;

/** Slots served by the mobile registry: every engine slot except web's grounding `pointer`. */
export type EngineModelRegistry = ModelRegistry<Exclude<EngineModelSlot, "pointer">>;

export function createEngineModelRegistry(
    costCollector?: CostCollector,
    overrides?: EngineModelSlotOverrides,
): EngineModelRegistry {
    return new ModelRegistry({
        models: {
            "fast-visual": overrides?.["fast-visual"] ?? SHARED_MODEL_SLOTS["fast-visual"],
            "fast-text": overrides?.["fast-text"] ?? SHARED_MODEL_SLOTS["fast-text"],
            "smart-visual": overrides?.["smart-visual"] ?? MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
        },
        monitoring: costCollector?.createMonitoringCallbacks(),
    });
}

/**
 * Web registry. Adds a dedicated `pointer` slot (grounding) separate from `smart-visual`
 * (agent-loop / assert / text-extraction) so the two can use different models: Gemini-3.5-flash-lite
 * drives the loop, Qwen3-VL-32B does the grounding. Web-only - mobile stays on
 * {@link createEngineModelRegistry}, which serves no `pointer` slot and so ignores a `pointer` override
 * rather than failing on it.
 */
export type WebEngineModelRegistry = ModelRegistry<EngineModelSlot>;

export function createWebEngineModelRegistry(
    costCollector?: CostCollector,
    overrides?: EngineModelSlotOverrides,
): WebEngineModelRegistry {
    return new ModelRegistry({
        models: {
            "fast-visual": overrides?.["fast-visual"] ?? SHARED_MODEL_SLOTS["fast-visual"],
            "fast-text": overrides?.["fast-text"] ?? SHARED_MODEL_SLOTS["fast-text"],
            "smart-visual": overrides?.["smart-visual"] ?? MODEL_ENTRIES.GEMINI_3_5_FLASH_LITE,
            pointer: overrides?.["pointer"] ?? MODEL_ENTRIES.QWEN3_VL_32B,
        },
        monitoring: costCollector?.createMonitoringCallbacks(),
    });
}
