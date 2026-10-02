import { z } from 'zod';
import { FlavorSchema, HttpsEndpointSchema, NameSchema, RelativePathSchema } from './primitives.js';

export const MemoryConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('embedded') }),
  z.strictObject({ mode: z.literal('file') }),
  z.strictObject({ mode: z.literal('external'), endpoint: HttpsEndpointSchema }),
]);

// Flavor applications extend this strict common envelope with their own settings.
// No runtime bindings, executable hooks, or arbitrary environment maps belong here.
export const AgentBoxConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  flavor: FlavorSchema,
  identity: z.strictObject({ name: NameSchema }),
  persona: z.strictObject({ instructionsFile: RelativePathSchema }).optional(),
  memory: MemoryConfigSchema,
  network: z.strictObject({ tailscale: z.boolean() }),
});
export type AgentBoxConfig = z.infer<typeof AgentBoxConfigSchema>;
