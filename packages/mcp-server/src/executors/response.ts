import { z } from "zod";

export const ExternalExecutionResponseSchema = z
  .object({
    result: z.unknown(),
    uiPayload: z.unknown().optional(),
  })
  .strict();
