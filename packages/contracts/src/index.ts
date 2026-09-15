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
export const SCHEMA_VERSION = 4;
export const newId = (): string => crypto.randomUUID();
