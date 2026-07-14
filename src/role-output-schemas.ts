import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const authorOutputSchema = z.object({
  summary: z.string().trim().min(1),
  changedFiles: z.array(z.string().trim().min(1)),
}).strict();

export type AuthorOutput = z.infer<typeof authorOutputSchema>;

export interface RoleOutputSchemas {
  author: string;
  explorer: string;
  reviewer: string;
}

export function defaultRoleOutputSchemas(): RoleOutputSchemas {
  const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  return {
    author: resolve(schemaDirectory, "author-output.schema.json"),
    explorer: resolve(schemaDirectory, "explorer-output.schema.json"),
    reviewer: resolve(schemaDirectory, "reviewer-output.schema.json"),
  };
}
