/** Public ORC durable-domain entry. Role services are not part of this module. */

export type * from './types.ts'
export {
  OrcCorrelationId,
  OrcFindingId,
  OrcNodeId,
  OrcRunId,
  OrcTaskId,
  applyOrc,
  emptyOrcState,
  isOrcEventType,
  projectOrc,
} from './projection.ts'
