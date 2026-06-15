export function readConfigFromForm(doc) {
  const slotDuration = numberValue(doc, "slotDuration", 4);
  const validationDelay = numberValue(doc, "validationDelay", 1.2);
  const validatorCount = numberValue(doc, "validatorCount", 16);
  const txPerSlot = numberValue(doc, "txPerSlot", 8);
  const validatorBlocksPerSlot = numberValue(doc, "vbPerSlot", 1);
  const finalityLagSlots = Math.max(
    numberValue(doc, "finalityLag", 3),
    Math.floor(validationDelay / slotDuration) + 1,
  );
  return {
    seed: 42,
    nodeCount: numberValue(doc, "nodeCount", 100),
    validatorCount,
    txPerSlot,
    slotDuration,
    validationDelay,
    finalityLagSlots,
    slotsPerEpoch: numberValue(doc, "slotsPerEpoch", 24),
    validatorBlocksPerSlot,
    attackNodeCount: numberValue(doc, "attackNodeCount", 5),
    neighborsNear: 6,
    neighborsRandom: 6,
    txParents: 2,
    vbTips: 8,
    supportThreshold: 2 / 3,
    lateGrace: 0.15,
    routeFactorMin: 1.35,
    routeFactorMax: 2.1,
    propagationKmPerSec: 160000,
    defaultBandwidthMbps: 25,
    jitterMs: 55,
    congestionMs: 180,
    congestionSpikeChance: 0.035,
    congestionSpikeMs: 700,
    messageDropChance: 0.003,
    longTailDelayChance: 0.012,
    longTailDelayMinMs: 1600,
    longTailDelayMaxMs: 5200,
    validatorBlockMissChance: dynamicValidatorMissChance(
      validatorCount,
      validatorBlocksPerSlot,
      finalityLagSlots,
      txPerSlot,
    ),
    slowNodeChance: 0.08,
    slowNodeExtraMs: 650,
    fullTxBytes: 1100,
    validationBlockBytes: 420,
    ihaveBytes: 64,
    iwantBytes: 48,
    enableConflictAttack: false,
    maxDrawTx: numberValue(doc, "maxDrawTx", 140),
    maxDrawVb: numberValue(doc, "maxDrawVb", 30),
  };
}

function numberValue(doc, id, fallback) {
  const node = doc.getElementById(id);
  const value = Number(node?.value);
  return Number.isFinite(value) ? value : fallback;
}

function dynamicValidatorMissChance(validatorCount, validatorBlocksPerSlot, finalityLagSlots, txPerSlot) {
  const vbTips = 8;
  const voteBudget = Math.max(
    1,
    validatorCount * Math.max(1, validatorBlocksPerSlot) * Math.max(1, finalityLagSlots),
  );
  const load = txPerSlot / Math.max(1, voteBudget * vbTips);
  const statisticalSlack = 0.5 / Math.sqrt(voteBudget);
  return clamp(0.043 + statisticalSlack + load * 0.45, 0.08, 0.22);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
