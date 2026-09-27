import { z } from 'zod';
import { BoxIdSchema, ContentHashSchema, FlavorSchema, HttpsEndpointSchema, ImageDigestSchema, SecretReferenceSchema } from './primitives.js';

export const RegistrationSchema = z.strictObject({ companyId: z.uuid().transform((value) => value.toLowerCase()), agentId: z.uuid().transform((value) => value.toLowerCase()) });
export const RosterBoxSchema = z.strictObject({
  boxId: BoxIdSchema,
  flavor: FlavorSchema,
  endpoint: HttpsEndpointSchema,
  imageDigest: ImageDigestSchema,
  // Resolved Git commit or content hash for local/packaged configuration.
  configRevision: z.union([z.string().regex(/^[a-f0-9]{40}$/), ContentHashSchema]),
  apiCredentialRef: SecretReferenceSchema,
  // Claims only: consumers must live-probe before registration.
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(32)
    .refine((items) => new Set(items).size === items.length, 'Duplicate capability'),
  registration: RegistrationSchema.nullable(),
});
export const RosterSchema = z.strictObject({
  schemaVersion: z.literal(1),
  boxes: z.array(RosterBoxSchema).min(1).max(1000),
}).superRefine(({ boxes }, ctx) => {
  for (const field of ['boxId', 'endpoint'] as const) {
    const seen = new Set<string>();
    for (const box of boxes) {
      if (field === 'endpoint' && !HttpsEndpointSchema.safeParse(box.endpoint).success) continue;
      const value = field === 'endpoint' ? new URL(box.endpoint).href.replace(/\/$/, '') : box[field];
      if (seen.has(value)) ctx.addIssue({ code: 'custom', message: 'Duplicate box identity or endpoint' });
      seen.add(value);
    }
  }
  const registrations = boxes.flatMap((box) => box.registration ? [box.registration.agentId] : []);
  if (new Set(registrations).size !== registrations.length)
    ctx.addIssue({ code: 'custom', message: 'Agent registered to multiple boxes' });
});
export type RosterBox = z.infer<typeof RosterBoxSchema>;
export type Roster = z.infer<typeof RosterSchema>;
