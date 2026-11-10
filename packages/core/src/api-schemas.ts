/**
 * Runtime validation of request bodies. Each schema is checked against the contract in
 * api-types.ts at compile time, so the two cannot drift apart.
 */
import { z } from 'zod';
import {
  API_LIMITS,
  type ChallengeRequest,
  type CreateLinkRequest,
  type PreviewRequest,
  type UpdateLinkRequest,
  type VerifyRequest,
} from './api-types';

const url = z.string().min(1).max(2048);
const title = z.string().trim().min(1).max(API_LIMITS.titleOverrideMaxLength);
const description = z.string().trim().max(API_LIMITS.descriptionOverrideMaxLength);

export const previewRequestSchema = z.object({ url }) satisfies z.ZodType<PreviewRequest>;

export const challengeRequestSchema = z.object({
  url,
  action: z.enum(['claim', 'rotate']),
}) satisfies z.ZodType<ChallengeRequest>;

export const verifyRequestSchema = z.object({
  url,
  nonce: z.string().min(1).max(64),
  claimToken: z.string().min(1).max(128),
}) satisfies z.ZodType<VerifyRequest>;

export const createLinkRequestSchema = z.object({
  url,
  slug: z.string().max(200).optional(),
  fast: z.boolean().optional(),
  overrides: z.object({ title: title.optional(), description: description.optional() }).optional(),
}) satisfies z.ZodType<CreateLinkRequest>;

export const updateLinkRequestSchema = z.object({
  slug: z.string().max(200).optional(),
  overrides: z
    .object({ title: title.nullable().optional(), description: description.nullable().optional() })
    .optional(),
  fast: z.boolean().optional(),
  canonicalMode: z.enum(['self', 'notion']).optional(),
}) satisfies z.ZodType<UpdateLinkRequest>;
