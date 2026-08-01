import { z } from "zod";

import { idSchema } from "../ids";
import { policySchema } from "./policy";

export const boardSchema = z.object({
  id: idSchema("board"),
  name: z.string().min(1).max(120),
  ownerId: idSchema("user"),
  policy: policySchema,
  /** Unix epoch milliseconds. */
  createdAt: z.number().int().nonnegative(),
});

export type Board = z.infer<typeof boardSchema>;
