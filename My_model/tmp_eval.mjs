import { Simulator } from "./src/sim/simulator.js";
import { TxStatus } from "./src/sim/status.js";
import {
  startEpochConflictSpamAttack,
  startEpochMultiConflictSpamAttack,
  startEpochWaveConflictSpamAttack,
} from "./src/sim/attacks/conflictAttack.js";

const presets = {
  low: {
    nodeCount: 100,
    validatorCount: 16,
    txPerSlot: 2,
    slotDuration: 4,
    validationDelay: 1.2,
    finalityLagSlots: 3,
    slotsPerEpoch: 24,
    validatorBlocksPerSlot: 1,
    conflictCount: 1,
  },
  medium: {
    nodeCount: 100,
    validatorCount: 16,
    txPerSlot: 8,
    slotDuration: 4,
    validationDelay: 1.2,
    finalityLagSlots: 3,
    slotsPerEpoch: 24,
    validatorBlocksPerSlot: 2,
    conflictCount: 3,
  },
  high: {
    nodeCount: 100,
    validatorCount: 16,
    txPerSlot: 20,
    slotDuration: 4,
    validationDelay: 1.2,
    finalityLagSlots: 5,
    slotsPerEpoch: 24,
    validatorBlocksPerSlot: 3,
    conflictCount: 2,
  },
  stress: {
    nodeCount: 100,
    validatorCount: 16,
    txPerSlot: 20,
    slotDuration: 4,
    validationDelay: 1.2,
    finalityLagSlots: 4,
    slotsPerEpoch: 24,
    validatorBlocksPerSlot: 2,
    conflictCount: 3,
  },
};

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

function makeConfig(values) {
  const cfg = {
    seed: 42,
    attackNodeCount: 5,
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
    slowNodeChance: 0.08,
    slowNodeExtraMs: 650,
    fullTxBytes: 1100,
    validationBlockBytes: 420,
    ihaveBytes: 64,
    iwantBytes: 48,
    enableConflictAttack: false,
    maxDrawTx: 140,
    maxDrawVb: 30,
    ...values,
  };
  cfg.validatorBlockMissChance = dynamicValidatorMissChance(
    cfg.validatorCount,
    cfg.validatorBlocksPerSlot,
    cfg.finalityLagSlots,
    cfg.txPerSlot,
  );
  return cfg;
}

function runCase(
  name,
  values,
  { attack = false, attackMode = "waves", perSlot = values.conflictCount, slots = 30 } = {},
) {
  const config = makeConfig(values);
  const sim = new Simulator(config);
  if (attack) sim.setAutoEpochConflictAttack(true, perSlot, attackMode);
  for (let i = 0; i < slots; i += 1) sim.stepSlot();

  const ordinary = [...sim.txs.values()].filter((tx) => sim.isOrdinaryTx(tx));
  const finalizedOrdinary = ordinary.filter(
    (tx) => tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.REJECTED,
  );
  const accepted = finalizedOrdinary.filter((tx) => tx.status === TxStatus.ACCEPTED).length;
  const rejected = finalizedOrdinary.filter((tx) => tx.status === TxStatus.REJECTED).length;
  const attackTx = [...sim.txs.values()].filter((tx) => tx.attack).length;
  const conflictParents = ordinary.filter((tx) =>
    (tx.parents || []).some((parentId) => sim.txs.get(parentId)?.conflictGroupId),
  ).length;
  const noParents = ordinary.filter((tx) => !tx.parents?.length).length;
  const noParentsAfterOpening = ordinary.filter(
    (tx) => !tx.parents?.length && tx.localSlot !== 0,
  ).length;
  let maxParentAge = 0;
  const oldEdges = ordinary.filter((tx) =>
    (tx.parents || []).some((parentId) => {
      const parent = sim.txs.get(parentId);
      if (!parent) return false;
      maxParentAge = Math.max(maxParentAge, tx.slot - parent.slot);
      return tx.slot - parent.slot > Math.max(1, config.finalityLagSlots - 2);
    }),
  ).length;

  const reasons = new Map();
  for (const tx of finalizedOrdinary) {
    if (tx.status !== TxStatus.REJECTED) continue;
    reasons.set(tx.rejectReason || "unknown", (reasons.get(tx.rejectReason || "unknown") || 0) + 1);
  }

  const loss = finalizedOrdinary.length ? (rejected / finalizedOrdinary.length) * 100 : 0;
  return {
    name,
    attack,
    attackMode: attack ? attackMode : "none",
    perSlot,
    slots,
    txPerSlot: config.txPerSlot,
    vbPerSlot: config.validatorBlocksPerSlot,
    lag: config.finalityLagSlots,
    miss: Number(config.validatorBlockMissChance.toFixed(4)),
    finalized: finalizedOrdinary.length,
    accepted,
    rejected,
    loss: Number(loss.toFixed(2)),
    attackTx,
    conflictParents,
    noParents,
    noParentsAfterOpening,
    maxParentAge,
    oldEdges,
    reasons: Object.fromEntries(reasons),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const scenario = process.argv[2] || "baseline";
const slots = Number(process.argv[3] || 30);

if (scenario === "baseline") {
  for (const [name, values] of Object.entries(presets)) {
    console.log(JSON.stringify(runCase(name, values, { attack: false, slots })));
    for (const attackMode of ["single", "multi", "waves"]) {
      console.log(JSON.stringify(runCase(name, values, { attack: true, attackMode, slots })));
    }
  }
} else if (scenario === "variants") {
  const variants = [
    ["medium-cc2", { ...presets.medium, conflictCount: 2 }],
    ["medium-cc3-lag4", { ...presets.medium, finalityLagSlots: 4, conflictCount: 3 }],
    ["medium-cc3-vb2", { ...presets.medium, validatorBlocksPerSlot: 2, conflictCount: 3 }],
    ["stress-cc4", { ...presets.stress, conflictCount: 4 }],
    ["stress-cc3", { ...presets.stress, conflictCount: 3 }],
    ["stress-cc5-lag5", { ...presets.stress, finalityLagSlots: 5, conflictCount: 5 }],
  ];
  for (const [name, values] of variants) {
    console.log(JSON.stringify(runCase(name, values, { attack: true, slots })));
  }
} else {
  const [name, perSlotRaw, vbRaw, lagRaw, attackModeRaw] = scenario.split(":");
  const base = presets[name];
  if (!base) throw new Error(`Unknown scenario: ${scenario}`);
  const values = {
    ...base,
    conflictCount: Number(perSlotRaw || base.conflictCount),
    validatorBlocksPerSlot: Number(vbRaw || base.validatorBlocksPerSlot),
    finalityLagSlots: Number(lagRaw || base.finalityLagSlots),
  };
  console.log(
    JSON.stringify(
      runCase(scenario, values, {
        attack: true,
        attackMode: attackModeRaw || "waves",
        slots,
      }),
    ),
  );
}
