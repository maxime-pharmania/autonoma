import { env as aiEnv } from "@autonoma/ai/env";
import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv, aiEnv, storageEnv],
    server: {
        /**
         * Serve engine model slots from the OpenAI-compatible endpoint (`OPENAI_COMPATIBLE_BASE_URL` /
         * `OPENAI_COMPATIBLE_API_KEY`, inherited from `@autonoma/ai/env`) instead of their built-in models, as
         * a comma-separated list of `slot=modelId` pairs - e.g. `smart-visual=my-vl`. Unset leaves every slot on
         * its built-in model. The `pointer` slot exists on web only, so naming it here is ignored; see the
         * engine README for the slot list.
         */
        OPENAI_COMPATIBLE_MODEL_SLOTS: z.string().optional(),
        APPIUM_HOST: z.string().optional(),
        APPIUM_PORT: z.string().optional(),
        APPIUM_MJPEG_PORT: z.string().optional(),
        APPIUM_SKIP_INSTALLATION: z.stringbool().optional().default(true),
        DEVICE_NAME: z.string().optional(),
        APPIUM_SYSTEM_PORT: z.string().optional(),
        IOS_PLATFORM_VERSION: z.string().optional(),
        ANDROID_DAEMON_HOSTS: z.string().optional(),
        IOS_DAEMON_HOSTS: z.string().optional(),
        SKIP_DEVICE_DATE_UPDATE: z.stringbool().optional().default(false),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
