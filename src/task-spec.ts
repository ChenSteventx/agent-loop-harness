import { z } from "zod";

const nonEmptyStrings = z.array(z.string().trim().min(1)).min(1);

export const taskSpecSchema = z
  .object({
    id: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    acceptance: nonEmptyStrings,
    scope: z.array(z.string().trim().min(1)).optional(),
    outOfScope: z.array(z.string().trim().min(1)).optional(),
    risk: z.enum(["low", "medium", "high"]),
    verification: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          argv: z.tuple([z.string().trim().min(1)]).rest(z.string()),
        }),
      )
      .min(1),
  })
  .strict();

export type TaskSpec = z.infer<typeof taskSpecSchema>;

export function parseTaskSpec(input: unknown): TaskSpec {
  return taskSpecSchema.parse(input);
}
