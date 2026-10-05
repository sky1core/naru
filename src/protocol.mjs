import { z } from 'zod';

export const maxRequestBytes = 8 * 1024 * 1024;

export class RelayError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const attributeTargetSchema = z.strictObject({
  attribute: z.enum(['id', 'data-testid', 'name', 'type', 'href', 'data-message-id', 'data-message-author-role', 'data-composer-markdown', 'data-chatgpt-composer', 'data-composer-placement', 'data-app-action-sidebar-project-id', 'data-codex-intelligence-trigger', 'data-model-picker-view-toggle', 'data-map-composer-conversation', 'data-reasoning-slider', 'data-model-picker-view']),
  value: z.string(),
});
export const targetSchema = attributeTargetSchema.extend({ scope: attributeTargetSchema.optional() });
const located = { documentId: z.uuid(), target: targetSchema };
export const partSchema = z.strictObject({ index: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), total: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER) })
  .refine(part => part.index <= part.total, 'Part index must not exceed total.');
export const continuationSchema = z.strictObject({ effort: z.enum(['none', 'medium', 'high', 'max', 'pro']).optional(), reviewId: z.uuid(), promptHash: z.string().regex(/^[a-f0-9]{64}$/), answerHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export function validPartLink({ part, continueFrom }) {
  return !part || part.index === 1 || continueFrom !== undefined;
}
export const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('navigate'), url: z.url().refine(isWebURL, 'HTTP(S) URL required') }),
  z.strictObject({ action: z.literal('fill'), ...located, text: z.string() }),
  z.strictObject({ action: z.literal('click'), ...located }),
  z.strictObject({ action: z.literal('press'), ...located, key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight']) }),
  z.strictObject({ action: z.literal('read'), ...located }),
  z.strictObject({ action: z.literal('wait'), ...located, state: z.enum(['present', 'absent']), timeoutMs: z.number().int().min(1).max(120000) }),
  z.strictObject({ action: z.literal('screenshot') }),
  z.strictObject({ action: z.literal('quit') }),
  z.strictObject({ action: z.literal('project.bind'), documentId: z.uuid() }),
  z.strictObject({ action: z.literal('project.open') }),
  z.strictObject({ action: z.literal('review.prepare'), reviewId: z.uuid(), part: partSchema.optional(), continueFrom: continuationSchema.optional(), effort: z.enum(['none', 'medium', 'high', 'max', 'pro']).optional(), question: z.string().refine((text) => text.trim().length > 0),
    files: z.array(z.strictObject({ path: z.string().min(1), content: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })) }).refine(validPartLink, 'Parts after 1 require continueFrom.'),
  z.strictObject({ action: z.literal('review.submit'), reviewId: z.uuid(), documentId: z.uuid() }),
  z.strictObject({ action: z.literal('review.collect'), reviewId: z.uuid(), waitMs: z.number().int().min(0).max(119000) }),
]);
export const requestIdSchema = z.uuid();
export const deadlineMsSchema = z.number().int().min(1).max(120000);
export const defaultReviewDeadlineMs = 120000;
export const requestSchema = z.strictObject({ id: requestIdSchema, deadlineMs: deadlineMsSchema.optional(), command: commandSchema })
  .transform(request => ({ id: request.id,
    deadlineMs: request.deadlineMs === undefined ? (request.command.action.startsWith('review.') ? defaultReviewDeadlineMs : 30000) : request.deadlineMs,
    command: request.command }));

export function isWebURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function publicError(error) {
  return error instanceof RelayError
    ? { code: error.code, message: error.message }
    : { code: 'internal_error', message: 'Unexpected relay error; inspect application stderr.' };
}
