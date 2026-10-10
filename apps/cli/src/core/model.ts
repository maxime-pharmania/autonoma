import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { readEnv } from "../env";
import { resolveApiUrl } from "./api-url";

export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

// Passed as the AI SDK's `maxRetries` on every model call. The SDK default of 2 gave up on
// transient provider blips after 3 attempts; 10 rides them out. The SDK handles the backoff and
// only retries retryable (429/5xx/network) errors, failing fast on 4xx.
export const AI_MAX_RETRIES = 10;

// One singleton per endpoint kind: a provider is never reused across modes, and neither is built
// before a call needs it - building the managed one eagerly would turn the missing-token error into
// an import error.
let proxyProvider: ReturnType<typeof createOpenRouter> | undefined;
let customProvider: ReturnType<typeof createOpenAICompatible> | undefined;

/**
 * Build the model provider against Autonoma's managed LLM proxy. The CLI no
 * longer needs an OpenRouter key: it authenticates with the Autonoma API token
 * (the same key the web app injects, or AUTONOMA_API_TOKEN), and our API
 * forwards to OpenRouter on our key, metering the org's credits. The OpenRouter
 * AI-SDK provider posts to `${baseURL}/chat/completions`, which the proxy serves.
 */
function getProxyProvider() {
    if (proxyProvider != null) return proxyProvider;

    const token = readEnv().AUTONOMA_API_TOKEN?.trim();
    if (!token) {
        throw new Error("Not authenticated - launch the planner from the Autonoma app, or set AUTONOMA_API_TOKEN.");
    }

    const apiUrl = resolveApiUrl(readEnv().AUTONOMA_API_URL);
    proxyProvider = createOpenRouter({ apiKey: token, baseURL: `${apiUrl}/v1/llm-proxy` });
    return proxyProvider;
}

/**
 * Build the model provider against the operator's own OpenAI-compatible endpoint.
 * No Autonoma token is involved: the CLI talks to the endpoint directly, on the
 * operator's compute. The key is optional because a locally hosted endpoint
 * usually needs none, and the endpoint's provider posts to `${baseURL}/chat/completions`.
 */
function getCustomProvider(baseURL: string) {
    if (customProvider != null) return customProvider;

    customProvider = createOpenAICompatible({
        name: "openai-compatible",
        baseURL,
        apiKey: readEnv().OPENAI_COMPATIBLE_API_KEY,
    });
    return customProvider;
}

/**
 * The model to call: the operator's OpenAI-compatible endpoint when
 * OPENAI_COMPATIBLE_BASE_URL is set, the managed proxy otherwise. Only the endpoint
 * differs - the id always comes from the same knob (`--model` / OPENROUTER_MODEL /
 * DEFAULT_MODEL), so pointing the planner elsewhere does not rename its models.
 */
export function getModel(modelId?: string) {
    const id = modelId ?? readEnv().OPENROUTER_MODEL ?? DEFAULT_MODEL;
    const customBaseUrl = readEnv().OPENAI_COMPATIBLE_BASE_URL?.trim();

    if (customBaseUrl != null && customBaseUrl !== "") return getCustomProvider(customBaseUrl).languageModel(id);

    return getProxyProvider().languageModel(id);
}

/**
 * The model a step runs on. An explicitly injected model wins - the evals build
 * and meter their own against a provider directly - otherwise one is built from
 * the id (or the default). Folds the `input.model ?? getModel(input.modelId)`
 * that every agent entry point used to repeat, so the fallback lives in one place.
 */
export function resolveModel(input: { model?: LanguageModel; modelId?: string }): LanguageModel {
    return input.model ?? getModel(input.modelId);
}
