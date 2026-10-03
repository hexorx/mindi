import { createHash } from "node:crypto";
import {
  taskOutputManifest,
  type TaskOutputMetadata,
} from "@mindi/agent-runtime/task-outputs";
import type { RoutineExternalDelivery } from "./external-delivery.js";
export interface DeliveryOutputContent {
  metadata: TaskOutputMetadata;
  bytes: Uint8Array;
}
export type DeliveryOutputResolver = (
  delivery: RoutineExternalDelivery,
  id: string,
) => Promise<DeliveryOutputContent>;
export interface DeliveryOutputReader {
  read(id: string): Promise<DeliveryOutputContent>;
}
/** Each callback is restricted to a frozen delivery and the lifetime of its send. */
export function deliveryOutputReader(
  delivery: RoutineExternalDelivery,
  resolve: DeliveryOutputResolver,
  guard: () => void,
): DeliveryOutputReader {
  const frozen = structuredClone(delivery);
  const scope = frozen.outputs?.[0]?.scope;
  if (!scope || scope.profileId !== frozen.profileId)
    throw Error("Invalid delivery output scope");
  const manifest = taskOutputManifest(frozen.outputs, scope);
  return Object.freeze({
    async read(id: string) {
      guard();
      const metadata = manifest.find((file) => file.id === id);
      if (!metadata) throw Error("Delivery output unavailable");
      const result = await resolve(structuredClone(frozen), id);
      guard();
      const admitted = taskOutputManifest([result.metadata], scope)[0]!;
      const bytes = Uint8Array.from(result.bytes);
      if (
        JSON.stringify(admitted) !== JSON.stringify(metadata) ||
        bytes.length !== metadata.size ||
        createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
      )
        throw Error("Delivery output integrity mismatch");
      return { metadata: structuredClone(metadata), bytes };
    },
  });
}
