import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  clientPrefix: 'VITE_',
  client: {
    VITE_ENABLE_LEARN_MODE: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => v === true || v === 'true'),
    VITE_POSTHOG_KEY: z.string().optional(),
    VITE_POSTHOG_HOST: z.string().optional(),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})

export const ENABLE_LEARN_MODE = env.VITE_ENABLE_LEARN_MODE
