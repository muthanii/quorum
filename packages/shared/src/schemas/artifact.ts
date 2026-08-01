import { z } from "zod";

import { idSchema } from "../ids";

export const ARTIFACT_TYPES = ["doc", "table"] as const;

export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

/** The artifact's `meta` Y.Map, as plain JSON. */
export const artifactMetaSchema = z.object({
  type: artifactTypeSchema,
  title: z.string().min(1).max(200),
  /** Canvas position and size, px. */
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** Set when an agent authored the artifact; absent for human-created ones. */
  authorAgentId: idSchema("agent").optional(),
  /** Unix epoch milliseconds. */
  createdAt: z.number().int().nonnegative(),
});

export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;

/** Table body as plain JSON (Y.Map with cols Y.Array + rows Y.Array<Y.Map>). */
export const tableBodySchema = z.object({
  cols: z.array(z.string()),
  /** One record per row, keyed by column name. */
  rows: z.array(z.record(z.string())),
});

export type TableBody = z.infer<typeof tableBodySchema>;

/**
 * A full artifact snapshot as plain JSON: body is the Y.Text string for
 * "doc", the {cols, rows} object for "table". The refinement pins body shape
 * to meta.type.
 */
export const artifactSchema = z
  .object({
    id: idSchema("artifact"),
    meta: artifactMetaSchema,
    body: z.union([z.string(), tableBodySchema]),
  })
  .superRefine((artifact, ctx) => {
    const isText = typeof artifact.body === "string";
    if (artifact.meta.type === "doc" && !isText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: 'a "doc" artifact body must be a string',
      });
    }
    if (artifact.meta.type === "table" && isText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: 'a "table" artifact body must be {cols, rows}',
      });
    }
  });

export type Artifact = z.infer<typeof artifactSchema>;
