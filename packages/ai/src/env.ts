import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        GROQ_KEY: z.string().min(1),
        GEMINI_API_KEY: z.string().min(1),
        OPENROUTER_API_KEY: z.string().min(1),
        // An endpoint that speaks the OpenAI chat-completions API (vLLM, LiteLLM, Ollama, a gateway), used to
        // serve models in place of the built-in providers. Both are optional: a deployment that never builds a
        // custom model entry never needs an endpoint, and one that does fails with the variable name rather than
        // reaching a provider with an empty base URL. The key is optional because a locally hosted endpoint
        // usually needs none.
        OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
        OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env["VITEST"] != null,
});
