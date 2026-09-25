import { z } from 'zod';

export const ErrorCode = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('mcpex'),
  schemaVersion: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
export const BootstrapResponse = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;
export const ApiError = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;
export const SCHEMA_VERSION = 7;
export const newId = (): string => crypto.randomUUID();
export const TargetAccess = z.enum(['read', 'write', 'readwrite']);
export const TargetInput = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    path: z.string().min(1),
    access: TargetAccess,
  })
  .strict();
export const TargetsInput = z.array(TargetInput).min(1).max(32);
export type TargetInput = z.infer<typeof TargetInput>;
export const targetsJsonSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 32,
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      path: { type: 'string' },
      access: { type: 'string', enum: ['read', 'write', 'readwrite'] },
    },
    required: ['id', 'path', 'access'],
    additionalProperties: false,
  },
} as const;
