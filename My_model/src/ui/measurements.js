export class MeasurementRecorder {
  constructor() {
    this.samples = [];
    this.active = false;
    this.closed = false;
    this.startedAtSlot = 0;
    this.observedNodeId = null;
  }

  begin(sim) {
    if (!this.samples.length) {
      this.startedAtSlot = sim.metrics().globalSlot;
      this.observedNodeId = selectObservedNodeId(sim);
    }
    this.active = true;
    this.closed = false;
    this.capture(sim);
  }

  capture(sim) {
    if (!this.active) return;
    const metrics = sim.metrics();
    const memory = readMemoryMb(sim, this.observedNodeId);
    const finalized = metrics.lastFinalized;
    this.samples.push({
      index: this.samples.length,
      slot: metrics.slot,
      globalSlot: metrics.globalSlot,
      epoch: metrics.epoch,
      time: sim.time,
      accepted: metrics.accepted,
      rejected: metrics.rejected,
      pending: metrics.pending,
      totalTx: metrics.totalTx,
      finalizedProcessedEpoch: finalized?.processedEpoch ?? null,
      finalizedProcessedSlot: finalized?.processedLocalSlot ?? null,
      finalizedProcessedGlobalSlot: finalized?.processedGlobalSlot ?? null,
      finalizedTargetEpoch: finalized?.targetEpoch ?? null,
      finalizedTargetSlot: finalized?.targetLocalSlot ?? null,
      finalizedTargetGlobalSlot: finalized?.targetGlobalSlot ?? null,
      finalizedTotal: finalized?.finalizedTotal ?? 0,
      finalizedAccepted: finalized?.finalizedAccepted ?? 0,
      finalizedRejected: finalized?.finalizedRejected ?? 0,
      finalizedAcceptedPct: finalized?.acceptedPct ?? 0,
      ordinaryFinalizedTotal: finalized?.ordinaryFinalizedTotal ?? 0,
      ordinaryFinalizedAccepted: finalized?.ordinaryFinalizedAccepted ?? 0,
      ordinaryFinalizedRejected: finalized?.ordinaryFinalizedRejected ?? 0,
      ordinaryAcceptedPct: finalized?.ordinaryAcceptedPct ?? 0,
      conflictFinalizedTotal: finalized?.conflictFinalizedTotal ?? 0,
      conflictFinalizedAccepted: finalized?.conflictFinalizedAccepted ?? 0,
      conflictFinalizedRejected: finalized?.conflictFinalizedRejected ?? 0,
      conflictAcceptedPct: finalized?.conflictAcceptedPct ?? 0,
      finalizedLabel:
        finalized?.processedGlobalSlot === null || finalized?.processedGlobalSlot === undefined
          ? ""
          : `E${finalized.processedEpoch}/S${finalized.processedLocalSlot}`,
      attackOrdinaryTotal: metrics.attackOrdinaryTotal,
      attackOrdinaryDecided: metrics.attackOrdinaryDecided,
      attackOrdinaryRejected: metrics.attackOrdinaryRejected,
      attackOrdinaryPending: metrics.attackOrdinaryPending,
      attackOrdinaryLostPct:
        metrics.attackOrdinaryLostPct === null ? null : metrics.attackOrdinaryLostPct * 100,
      ledgerMemoryMb: memory.ledgerMemoryMb,
      memoryMb: memory.ledgerMemoryMb,
      memoryWithoutRotationMb: memory.memoryWithoutRotationMb,
      observedNodeId: this.observedNodeId,
      observedNodePendingTx: memory.pendingTx,
      observedNodeAcceptedTx: memory.acceptedTx,
      observedNodeRejectedTx: memory.rejectedTx,
      memoryKind: "local node ledger estimate, rejected pruned",
    });
  }

  close(sim) {
    if (!this.active) return;
    this.capture(sim);
    this.active = false;
    this.closed = this.samples.length > 1;
  }

  reset() {
    this.samples = [];
    this.active = false;
    this.closed = false;
    this.observedNodeId = null;
  }

  canRender() {
    return this.closed && this.samples.length > 1;
  }

  summary() {
    if (!this.samples.length) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    return {
      samples: this.samples.length,
      slots: last.globalSlot - first.globalSlot,
      acceptedDelta: last.accepted - first.accepted,
      rejectedDelta: last.rejected - first.rejected,
      pendingDelta: last.pending - first.pending,
      attackOrdinaryTotal: last.attackOrdinaryTotal,
      attackOrdinaryDecided: last.attackOrdinaryDecided,
      attackOrdinaryRejected: last.attackOrdinaryRejected,
      attackOrdinaryLostPct: last.attackOrdinaryLostPct,
      memoryDeltaMb: last.memoryMb - first.memoryMb,
      memoryKind: last.memoryKind,
      observedNodeId: last.observedNodeId,
    };
  }
}

function readMemoryMb(sim, nodeId) {
  const current = sim.nodeLedgerMemoryStats(nodeId, false);
  const withoutRotation = sim.nodeLedgerMemoryStats(nodeId, true);
  return {
    ledgerMemoryMb: bytesToMb(current.bytes),
    memoryWithoutRotationMb: bytesToMb(withoutRotation.bytes),
    pendingTx: withoutRotation.pendingTx,
    acceptedTx: withoutRotation.acceptedTx,
    rejectedTx: withoutRotation.rejectedTx,
  };
}

function selectObservedNodeId(sim) {
  const nodeCount = sim.nodes.length;
  if (!nodeCount) return null;
  const seed = Number(sim.config.seed) || 0;
  const mixed = Math.imul((seed ^ 0x9e3779b9) >>> 0, 2654435761) >>> 0;
  return sim.nodes[mixed % nodeCount].id;
}

function bytesToMb(bytes) {
  return bytes / (1024 * 1024);
}
