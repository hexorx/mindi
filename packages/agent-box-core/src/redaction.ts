import { z } from 'zod';

export const REDACTED = '[REDACTED]';
const secretField = /secret|token|password|passwd|credential|authorization|cookie|(?:private|api|access|signing|encryption|auth).*key/i;

// Defense in depth for JSON logs: pass all loaded runtime secret values too.
// This cannot discover unknown secrets embedded in arbitrary prose.
export function redact(value: unknown, secretValues: readonly string[] = []): unknown {
  const secrets = [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length);
  const seen = new WeakSet<object>();
  function visit(input: unknown): unknown {
    if (typeof input === 'string') {
      return secrets.reduce((text, secret) => text.split(secret).join(REDACTED), input);
    }
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);
    const output = Array.isArray(input) ? input.map(visit) : Object.fromEntries(
      Object.entries(input).map(([key, item]) => [
        visit(key) as string, secretField.test(key) ? REDACTED : visit(item),
      ]),
    );
    seen.delete(input);
    return output;
  }
  return visit(value);
}

// Raw Zod issues may include unknown field names. Never expose them in diagnostics.
export function parseContract<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Invalid agent-box contract');
  return result.data;
}
