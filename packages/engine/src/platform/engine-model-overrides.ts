import { createCustomModelEntry } from "@autonoma/ai";
import { type EngineModelSlotOverrides, formatEngineModelSlots, isEngineModelSlot } from "./engine-model-slots";

/** The variable this parser reads, named in every error so a bad value points at the fix. */
const SLOTS_VARIABLE = "OPENAI_COMPATIBLE_MODEL_SLOTS";

const ASSIGNMENT_SEPARATOR = "=";
const LIST_SEPARATOR = ",";

/**
 * Parse `OPENAI_COMPATIBLE_MODEL_SLOTS` - a comma-separated list of `slot=modelId` pairs, e.g.
 * `smart-visual=my-vl,pointer=my-ground` - into per-slot registry overrides served by the OpenAI-compatible
 * endpoint (`createCustomModelEntry`).
 *
 * An absent, empty or whitespace-only value yields no overrides, so a deployment that never sets the variable
 * keeps every built-in model. A malformed entry throws instead of being skipped: a slot left on its built-in
 * model after an operator asked for their own is a run that quietly uses a model nobody chose.
 */
export function parseEngineModelOverrides(raw: string | undefined): EngineModelSlotOverrides {
    if (raw == null || raw.trim() === "") return {};

    const overrides: EngineModelSlotOverrides = {};

    for (const assignment of raw.split(LIST_SEPARATOR)) {
        const separatorIndex = assignment.indexOf(ASSIGNMENT_SEPARATOR);
        if (separatorIndex === -1) throw new Error(invalidEntryMessage(assignment, 'expected "slot=modelId"'));

        const slotId = assignment.slice(0, separatorIndex).trim();
        const modelId = assignment.slice(separatorIndex + 1).trim();

        if (!isEngineModelSlot(slotId)) throw new Error(invalidEntryMessage(assignment, `unknown slot "${slotId}"`));
        if (modelId === "") throw new Error(invalidEntryMessage(assignment, `"${slotId}" has no model id`));

        // A slot listed twice keeps the last assignment, so the end of the list stays authoritative - the natural
        // reading when a model id is corrected without deleting the entry it replaces.
        overrides[slotId] = createCustomModelEntry(modelId);
    }

    return overrides;
}

function invalidEntryMessage(assignment: string, problem: string): string {
    return (
        `${SLOTS_VARIABLE} is invalid: ${problem} in "${assignment}". Expected a comma-separated list of ` +
        `slot=modelId pairs; valid slots are: ${formatEngineModelSlots()}.`
    );
}
