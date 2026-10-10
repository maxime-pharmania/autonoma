import type { ModelEntry } from "@autonoma/ai";

/**
 * Every model slot an engine registry can serve, in the order error messages list them. This is the single
 * source of truth for the vocabulary: {@link isEngineModelSlot} and {@link formatEngineModelSlots} derive from
 * it, so a slot added here is immediately assignable and documented at every call site. The `pointer` (grounding)
 * slot is served by web only.
 */
export const ENGINE_MODEL_SLOT_IDS = ["fast-visual", "smart-visual", "fast-text", "pointer"] as const;

export type EngineModelSlot = (typeof ENGINE_MODEL_SLOT_IDS)[number];

/** Registry entries to serve in place of the built-in model of the slots they name. */
export type EngineModelSlotOverrides = Partial<Record<EngineModelSlot, ModelEntry>>;

const ENGINE_MODEL_SLOT_ID_SET: ReadonlySet<string> = new Set(ENGINE_MODEL_SLOT_IDS);

export function isEngineModelSlot(value: string): value is EngineModelSlot {
    return ENGINE_MODEL_SLOT_ID_SET.has(value);
}

export function formatEngineModelSlots(): string {
    return ENGINE_MODEL_SLOT_IDS.join(", ");
}
