import { z } from "zod";

import { idSchema } from "../ids";

export const MEMBER_ROLES = ["owner", "editor", "viewer"] as const;

export const memberRoleSchema = z.enum(MEMBER_ROLES);

export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberSchema = z.object({
  id: idSchema("member"),
  boardId: idSchema("board"),
  userId: idSchema("user"),
  name: z.string().min(1).max(80),
  role: memberRoleSchema,
  /** Unix epoch ms of last activity — drives the "active" quorum window. */
  lastSeenAt: z.number().int().nonnegative(),
});

export type Member = z.infer<typeof memberSchema>;
