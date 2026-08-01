import { z } from "zod";

import { idSchema } from "../ids";

export const MESSAGE_ROLES = ["human", "agent", "system"] as const;

export const messageRoleSchema = z.enum(MESSAGE_ROLES);

export type MessageRole = z.infer<typeof messageRoleSchema>;

/** One entry of the board's append-only group chat (Y.Doc "chat" array). */
export const messageSchema = z.object({
  id: idSchema("message"),
  role: messageRoleSchema,
  /** usr_… for humans, agt_… for agents, "system" for system notices. */
  authorId: z.string().min(1),
  name: z.string().min(1).max(80),
  content: z.string(),
  /** Unix epoch milliseconds. */
  createdAt: z.number().int().nonnegative(),
  /** Mentioned agent/user ids (@mention targets). */
  mentions: z.array(z.string().min(1)).default([]),
});

export type Message = z.infer<typeof messageSchema>;
export type MessageInput = z.input<typeof messageSchema>;
