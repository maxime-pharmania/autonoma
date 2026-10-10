import { env } from "../env";

/**
 * Read the configured OpenAI-compatible endpoint. Throws rather than returning a half-built config: the AI SDK
 * provider requires a base URL, and a missing one is a deployment mistake that should name the variable that
 * fixes it instead of surfacing as a request to an empty URL.
 */
export function resolveOpenAiCompatibleConfig() {
    const baseURL = env.OPENAI_COMPATIBLE_BASE_URL;
    if (baseURL == null) {
        throw new Error(
            "OPENAI_COMPATIBLE_BASE_URL is not set - it is required to build a model entry on the " +
                "OpenAI-compatible endpoint.",
        );
    }

    return { baseURL, apiKey: env.OPENAI_COMPATIBLE_API_KEY };
}
