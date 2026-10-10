import { zeroCostFunction } from "./costs";
import type { ModelEntry } from "./model-entries";
import { type LLMProvider, type OpenAiCompatibleProvider, openAiCompatibleProvider } from "./providers";

/**
 * A registry entry served by the configured OpenAI-compatible endpoint.
 *
 * Priced at zero: the endpoint is one the operator hosts, so there is no published per-token rate for us to
 * attribute - and the registry requires a pricing function per entry, which `zeroCostFunction` provides without
 * demanding token usage the endpoint may not report.
 *
 * Declares no `createUploader`, so an entry built here is not video-capable: `ModelRegistry.getVideoModel`
 * throws `NotAVideoModelError` instead of handing a recording to an endpoint whose support for a `video_url`
 * part is unknown, where a dropped video would read as confident evidence that nothing was on screen. Keep a
 * video-capable capability (e.g. `smart-video` in the diffs pipeline) on its built-in entry.
 */
export function createCustomModelEntry(
    modelId: string,
    provider: LLMProvider<OpenAiCompatibleProvider> = openAiCompatibleProvider,
): ModelEntry {
    return {
        createModel: () => provider.getModel(modelId),
        pricing: zeroCostFunction,
    };
}
