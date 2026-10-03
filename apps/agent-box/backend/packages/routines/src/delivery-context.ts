import type {
  RoutineDeliveryOperations,
  DeliveryOperation,
  DeliveryOperationSpec,
} from "./delivery-operations.js";
/** Receipt lookup can observe and confirm the original operations, never admit work. */
export interface DeliveryOperationReader {
  list(): DeliveryOperation[];
  confirm(index: number, receipt: string): DeliveryOperation;
}
export interface DeliveryOperationWriter extends DeliveryOperationReader {
  prepare(plan: readonly DeliveryOperationSpec[]): DeliveryOperation[];
  claim(index: number): DeliveryOperation;
  reject(index: number): DeliveryOperation;
}
export function operationReader(
  operations: RoutineDeliveryOperations,
  id: string,
  attemptId: string,
  guard: () => void,
): DeliveryOperationReader {
  return Object.freeze({
    list: () => {
      guard();
      return operations.list(id);
    },
    confirm: (index: number, receipt: string) => {
      guard();
      return operations.confirm(id, attemptId, index, receipt);
    },
  });
}
export function operationWriter(
  operations: RoutineDeliveryOperations,
  id: string,
  attemptId: string,
  guard: () => void,
): DeliveryOperationWriter {
  return Object.freeze({
    ...operationReader(operations, id, attemptId, guard),
    prepare: (plan: readonly DeliveryOperationSpec[]) => {
      guard();
      return operations.prepare(id, attemptId, plan);
    },
    claim: (index: number) => {
      guard();
      return operations.claim(id, attemptId, index);
    },
    reject: (index: number) => {
      guard();
      return operations.reject(id, attemptId, index);
    },
  });
}

import type {
  RoutineDeliveryUploadJournal,
  UploadJournalEntry,
  UploadScope,
  UploadPhase,
} from "./delivery-upload-journal.js";
export interface DeliveryUploadReader {
  get(index: number): UploadJournalEntry | undefined;
  confirm(index: number, receipt: string): DeliveryOperation;
  assertWorkspaceAvailable(workspaceId: string): void;
  pauseWorkspace(workspaceId: string, retryAfterMs?: number): void;
}
export interface DeliveryUploadWriter extends DeliveryUploadReader {
  prepare(index: number, scope: UploadScope): UploadJournalEntry;
  intent(index: number, phase: UploadPhase): UploadJournalEntry;
  allocated(
    index: number,
    response: { fileId: string; uploadUrl: string },
  ): UploadJournalEntry;
  uploaded(index: number): UploadJournalEntry;
  reject(index: number, phase: UploadPhase): UploadJournalEntry;
}
export function uploadReader(
  journal: RoutineDeliveryUploadJournal,
  id: string,
  attemptId: string,
  guard: () => void,
): DeliveryUploadReader {
  return Object.freeze({
    get: (index: number) => {
      guard();
      return journal.get(id, attemptId, index);
    },
    confirm: (index: number, receipt: string) => {
      guard();
      return journal.confirm(id, attemptId, index, receipt);
    },
    assertWorkspaceAvailable: (workspaceId: string) => {
      guard();
      journal.assertWorkspaceAvailable(workspaceId);
    },
    pauseWorkspace: (workspaceId: string, retryAfterMs?: number) => {
      guard();
      journal.pauseWorkspace(workspaceId, retryAfterMs);
    },
  });
}
export function uploadWriter(
  journal: RoutineDeliveryUploadJournal,
  id: string,
  attemptId: string,
  guard: () => void,
): DeliveryUploadWriter {
  return Object.freeze({
    ...uploadReader(journal, id, attemptId, guard),
    prepare: (index: number, scope: UploadScope) => {
      guard();
      return journal.prepare(id, attemptId, index, scope);
    },
    intent: (index: number, phase: UploadPhase) => {
      guard();
      return journal.intent(id, attemptId, index, phase);
    },
    allocated: (
      index: number,
      response: { fileId: string; uploadUrl: string },
    ) => {
      guard();
      return journal.allocated(id, attemptId, index, response);
    },
    uploaded: (index: number) => {
      guard();
      return journal.uploaded(id, attemptId, index);
    },
    reject: (index: number, phase: UploadPhase) => {
      guard();
      return journal.reject(id, attemptId, index, phase);
    },
  });
}
