import { z } from 'zod';
import { BoxIdSchema, NameSchema } from './primitives.js';

export const BoxIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  boxId: BoxIdSchema,
  name: NameSchema,
});
export type BoxIdentity = z.infer<typeof BoxIdentitySchema>;

// Call only for first boot; the runtime must persist this separately from config.
export function createBoxIdentity(name: string): BoxIdentity {
  return BoxIdentitySchema.parse({ schemaVersion: 1, boxId: globalThis.crypto.randomUUID(), name });
}

export function renameBoxIdentity(identity: BoxIdentity, name: string): BoxIdentity {
  return BoxIdentitySchema.parse({ ...identity, name });
}

export function memoryBankId(boxId: string): string {
  return `box-${BoxIdSchema.parse(boxId)}`;
}
