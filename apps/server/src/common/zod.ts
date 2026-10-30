import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validates untrusted input against a shared @bpmix/api schema, answering 400 with what was wrong. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)));
  return parsed.data;
}
