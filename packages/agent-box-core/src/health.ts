import { z } from 'zod';
import { BoxIdSchema } from './primitives.js';

// Bounded codes instead of raw process errors, headers, URLs, or secret-bearing logs.
export const HealthCheckSchema = z.strictObject({
  status: z.enum(['ready', 'not_ready', 'degraded', 'disabled']),
  code: z.enum(['ok', 'starting', 'unavailable', 'credential_missing', 'unauthorized',
    'not_enrolled', 'fallback', 'disabled']),
}).refine(({ status, code }) =>
  status === 'ready' ? code === 'ok' :
    status === 'disabled' ? code === 'disabled' : code !== 'ok' && code !== 'disabled',
'Inconsistent health status and code');
export const BoxHealthSchema = z.strictObject({
  schemaVersion: z.literal(1),
  boxId: BoxIdSchema,
  checkedAt: z.iso.datetime(),
  checks: z.strictObject({
    container: HealthCheckSchema,
    desktop: HealthCheckSchema,
    memory: HealthCheckSchema,
    api: HealthCheckSchema,
    configSource: HealthCheckSchema,
    network: HealthCheckSchema,
  }),
});
export type BoxHealth = z.infer<typeof BoxHealthSchema>;

// Requirements come from operator settings, never from a remote health response.
export function isRegistrationReady(
  health: BoxHealth,
  requirements: { configSourceRequired: boolean; tailscaleEnabled: boolean },
): boolean {
  const { checks } = BoxHealthSchema.parse(health);
  return [checks.container, checks.desktop, checks.memory, checks.api]
    .every((check) => check.status === 'ready') &&
    (!requirements.configSourceRequired || checks.configSource.status === 'ready') &&
    (!requirements.tailscaleEnabled || checks.network.status === 'ready');
}
