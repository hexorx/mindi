import { z } from 'zod';
import { AgentBoxConfigSchema, parseContract } from '@mindi/agent-box-core';

export const HermesConfigSchema = AgentBoxConfigSchema.extend({
  flavor: z.literal('hermes'),
  hermes: z.strictObject({ model: z.string().trim().min(1).max(256) }).optional(),
});
export type HermesConfig = z.infer<typeof HermesConfigSchema>;

export function parseHermesConfig(input: unknown): HermesConfig {
  return parseContract(HermesConfigSchema, input);
}
