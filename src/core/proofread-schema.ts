import { z } from "zod";

// The provider must return editable tokens, not a sentence hidden in one group.
// Multiple IDs are allowed only for a single corrected token, e.g. ChatGPT.
export const proofreadSchema = z.object({ groups: z.array(z.object({
  wordIds: z.array(z.string()).min(1).max(40),
  text: z.string().min(1).max(400).regex(/^\S+$/),
})).min(1).max(220) });
