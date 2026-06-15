import { LocalTxStatus, TxStatus } from "./status.js";

export function selectValidationTips(sim, validator, approveUntilSlot) {
  const constants = selectionConstants(sim);
  const coneCache = new Map();
  const candidates = validatorCandidates(sim, validator, approveUntilSlot, constants);
  const selected = [];
  const selectedOrdinaryCoverage = new Set();
  const selectedConeCoverage = new Set();
  const selectedEvaluations = [];

  while (selected.length < sim.config.vbTips) {
    let best = null;

    for (const candidate of candidates) {
      if (selected.some((item) => item.tx.id === candidate.tx.id)) continue;
      if (
        !sim.compatibleWithSelected(
          candidate.tx,
          selected.map((item) => item.tx.id),
          { allowSameInputConflicts: true },
        )
      ) {
        continue;
      }

      const evaluation = validatorCandidateEvaluation(
        sim,
        validator,
        candidate,
        approveUntilSlot,
        selectedOrdinaryCoverage,
        selectedConeCoverage,
        coneCache,
        constants,
      );
      if (
        !best ||
        evaluation.score > best.evaluation.score ||
        (Math.abs(evaluation.score - best.evaluation.score) < 0.0001 &&
          sim.nodeTieBreak(validator, candidate.tx) < sim.nodeTieBreak(validator, best.candidate.tx))
      ) {
        best = { candidate, evaluation };
      }
    }

    if (!best || best.evaluation.score <= constants.minimumScore) break;
    selected.push(best.candidate);
    for (const txId of best.evaluation.newOrdinaryCoverage) selectedOrdinaryCoverage.add(txId);
    for (const txId of best.evaluation.cone) selectedConeCoverage.add(txId);
    selectedEvaluations.push(selectionEvaluationDebug(best, sim, validator, approveUntilSlot));
  }

  const rankedCandidates = candidates
    .map((candidate) => ({
      candidate,
      evaluation: validatorCandidateEvaluation(
        sim,
        validator,
        candidate,
        approveUntilSlot,
        new Set(),
        new Set(),
        coneCache,
        constants,
      ),
    }))
    .sort((a, b) => b.evaluation.score - a.evaluation.score);

  return {
    tips: selected.map((candidate) => candidate.tx.id),
    debug: {
      validatorId: validator.id,
      approveUntilSlot,
      approveUntilLocalSlot: sim.localSlotForGlobal(approveUntilSlot),
      candidates: candidates.length,
      ordinaryCandidates: candidates.filter((item) => sim.isOrdinaryTx(item.tx)).length,
      conflictCandidates: candidates.filter((item) => item.tx.conflictGroupId).length,
      rescueCandidates: candidates.filter((item) => item.kinds.has("rescue")).length,
      bridgeCandidates: candidates.filter((item) => item.kinds.has("bridge")).length,
      strategy: "local-impact-past-cone-greedy",
      selectedOrdinary: selected.filter((item) => sim.isOrdinaryTx(item.tx)).length,
      selectedConflict: selected.filter((item) => item.tx.conflictGroupId).length,
      selected: selected.map((item) => tipDebug(item.tx, sim, validator, approveUntilSlot)),
      selectedEvaluations,
      topCandidates: rankedCandidates.slice(0, 16).map((item) => ({
        ...tipDebug(item.candidate.tx, sim, validator, approveUntilSlot),
        kinds: [...item.candidate.kinds],
        coverageScore: round(item.evaluation.score, 6),
        usefulOrdinaryGain: round(item.evaluation.usefulOrdinaryGain, 6),
        rescueGain: round(item.evaluation.rescueGain, 6),
        bridgeConflictGain: round(item.evaluation.bridgeConflictGain, 6),
        conflictPenalty: round(item.evaluation.conflictPenalty, 6),
        duplicatePenalty: round(item.evaluation.duplicatePenalty, 6),
        newOrdinaryCoverage: item.evaluation.newOrdinaryCoverage.length,
        coneOrdinary: item.evaluation.coneOrdinary,
        coneConflict: item.evaluation.coneConflict,
        conflictImpact: item.evaluation.conflictImpact.slice(0, 4),
      })),
    },
  };
}

export function collectLocalPastCone(sim, node, txId, approveUntilSlot, out = new Set()) {
  if (!node || out.has(txId)) return out;
  const tx = sim.txs.get(txId);
  if (!tx) return out;
  if (!node.known.has(tx.id)) return out;
  if (tx.epoch !== sim.epoch || tx.gref !== sim.genesis.id) return out;
  if (tx.slot > approveUntilSlot || tx.status === TxStatus.REJECTED) return out;

  out.add(tx.id);
  for (const parentId of tx.parents || []) {
    collectLocalPastCone(sim, node, parentId, approveUntilSlot, out);
  }
  return out;
}

function validatorCandidates(sim, validator, approveUntilSlot, constants) {
  const byId = new Map();

  for (const txId of validator.known.keys()) {
    const tx = sim.txs.get(txId);
    if (!isLocalPendingTx(sim, validator, tx, approveUntilSlot)) continue;

    const directReference = sim.canValidatorReference(validator, tx, approveUntilSlot);
    if (sim.isOrdinaryTx(tx)) {
      if (directReference && !sim.hasValidatorEligibleChild(validator, tx, approveUntilSlot)) {
        addCandidate(
          byId,
          tx,
          "ordinary-tip",
          ordinaryTipCandidateBoost(sim, tx, approveUntilSlot, constants),
        );
      }
      if (directReference && shouldRescueOrdinary(sim, validator, tx, approveUntilSlot)) {
        addCandidate(byId, tx, "rescue", constants.rescueCandidateBoost);
      }
      continue;
    }

    if (tx.conflictGroupId) {
      const impact = conflictImpactStats(sim, validator, tx, approveUntilSlot, new Set(), constants);
      if (directReference && canConsiderConflict(sim, validator, tx, approveUntilSlot, impact)) {
        addCandidate(
          byId,
          tx,
          impact.dependentCount > 0 ? "bridge" : "conflict-probe",
          impact.dependentCount > 0 ? constants.bridgeCandidateBoost : constants.conflictProbeBoost,
        );
      }
    }
  }

  return [...byId.values()];
}

function isLocalPendingTx(sim, node, tx, approveUntilSlot) {
  return Boolean(
    tx &&
      node?.known?.has(tx.id) &&
      tx.epoch === sim.epoch &&
      tx.gref === sim.genesis.id &&
      tx.slot <= approveUntilSlot &&
      tx.status === TxStatus.PENDING,
  );
}

function addCandidate(byId, tx, kind, boost) {
  const existing = byId.get(tx.id);
  if (existing) {
    existing.kinds.add(kind);
    existing.boost = Math.max(existing.boost, boost);
    return;
  }
  byId.set(tx.id, {
    tx,
    kinds: new Set([kind]),
    boost,
  });
}

function shouldRescueOrdinary(sim, validator, tx, approveUntilSlot) {
  if (!sim.isOrdinaryTx(tx) || tx.status !== TxStatus.PENDING) return false;
  const local = validator.known.get(tx.id);
  if (!local || local.localStatus === LocalTxStatus.LATE) return false;
  if (sim.nodeKnowsValidatorSupport(validator, tx, validator.id)) return false;

  const age = Math.max(0, approveUntilSlot - tx.slot);
  const finalityLag = Math.max(1, sim.config.finalityLagSlots);
  const rescueWindowStart = Math.max(1, finalityLag - 1);
  if (age < rescueWindowStart || age > finalityLag) return false;

  const support = sim.localSupport(validator, tx);
  if (support >= sim.config.supportThreshold) return false;

  const nearEnough = support >= sim.config.supportThreshold * 0.38;
  const lastChance = age >= finalityLag && support > 0;
  return nearEnough || lastChance;
}

function ordinaryTipCandidateBoost(sim, tx, approveUntilSlot, constants) {
  const age = Math.max(0, approveUntilSlot - tx.slot);
  if (age <= 0) return constants.freshOrdinaryTipBoost;
  if (age === 1) return constants.freshOrdinaryTipBoost * 0.72;
  if (age < sim.config.finalityLagSlots) return constants.freshOrdinaryTipBoost * 0.2;
  return 0;
}

function canConsiderConflict(sim, validator, tx, approveUntilSlot, impact) {
  if (!tx.conflictGroupId) return true;
  if (!validator.known.has(tx.id)) return false;
  if (!sim.nodeKnowsInputConflict(validator, tx, approveUntilSlot)) return true;
  if (impact.dependentCount > 0 || impact.dependentGain > 0) return true;
  if (impact.localSupport >= sim.config.supportThreshold * 0.12) return true;
  return impact.freshProbe;
}

function validatorCandidateEvaluation(
  sim,
  validator,
  candidate,
  approveUntilSlot,
  selectedOrdinaryCoverage,
  selectedConeCoverage,
  coneCache,
  constants,
) {
  const cone = cachedLocalPastCone(sim, validator, candidate.tx.id, approveUntilSlot, coneCache);
  let usefulOrdinaryGain = 0;
  let rescueGain = 0;
  let bridgeConflictGain = 0;
  let conflictPenalty = 0;
  let duplicatePenalty = 0;
  let coneOrdinary = 0;
  let coneConflict = 0;
  const newOrdinaryCoverage = [];
  const conflictImpact = [];

  for (const txId of cone) {
    const tx = sim.txs.get(txId);
    if (!tx || tx.epoch !== sim.epoch || tx.gref !== sim.genesis.id) continue;
    if (tx.slot > approveUntilSlot) continue;

    if (sim.isOrdinaryTx(tx)) {
      coneOrdinary += 1;
      if (selectedConeCoverage.has(tx.id)) duplicatePenalty += constants.ordinaryDuplicatePenalty;
      if (
        tx.status === TxStatus.PENDING &&
        !sim.nodeKnowsValidatorSupport(validator, tx, validator.id) &&
        !selectedOrdinaryCoverage.has(tx.id)
      ) {
        const weight = sim.validatorOrdinaryCoverageWeight(validator, tx, approveUntilSlot);
        if (weight > 0) {
          usefulOrdinaryGain += weight;
          if (shouldRescueOrdinary(sim, validator, tx, approveUntilSlot)) {
            rescueGain += weight * constants.rescueGainMultiplier;
          }
          newOrdinaryCoverage.push(tx.id);
        }
      }
      continue;
    }

    if (tx.conflictGroupId) {
      coneConflict += 1;
      if (selectedConeCoverage.has(tx.id)) duplicatePenalty += constants.conflictDuplicatePenalty;
      if (tx.status !== TxStatus.PENDING) continue;

      const impact = conflictImpactStats(
        sim,
        validator,
        tx,
        approveUntilSlot,
        selectedOrdinaryCoverage,
        constants,
      );
      bridgeConflictGain += impact.bridgeGain;
      conflictPenalty += conflictRiskPenalty(sim, validator, tx, approveUntilSlot, impact, constants);
      if (conflictImpact.length < 8) conflictImpact.push(conflictImpactDebug(tx, impact, sim));
    }
  }

  const fallbackScore = sim.tipScore(validator, candidate.tx, approveUntilSlot) * constants.fallbackWeight;
  const age = Math.max(0, approveUntilSlot - candidate.tx.slot);
  const oldDirectPenalty =
    candidate.kinds.has("ordinary-tip") && age >= Math.max(2, sim.config.finalityLagSlots)
      ? constants.oldOrdinaryTipPenalty * (age - sim.config.finalityLagSlots + 1)
      : 0;
  const score =
    usefulOrdinaryGain +
    rescueGain +
    bridgeConflictGain +
    fallbackScore +
    candidate.boost -
    conflictPenalty -
    duplicatePenalty -
    oldDirectPenalty;

  return {
    score,
    usefulOrdinaryGain,
    rescueGain,
    bridgeConflictGain,
    conflictPenalty,
    duplicatePenalty,
    oldDirectPenalty,
    newOrdinaryCoverage,
    cone,
    coneOrdinary,
    coneConflict,
    conflictImpact,
  };
}

function cachedLocalPastCone(sim, validator, txId, approveUntilSlot, cache) {
  const key = `${validator.id}:${approveUntilSlot}:${txId}`;
  if (!cache.has(key)) {
    cache.set(key, [...collectLocalPastCone(sim, validator, txId, approveUntilSlot)]);
  }
  return cache.get(key);
}

function conflictImpactStats(
  sim,
  validator,
  tx,
  approveUntilSlot,
  selectedOrdinaryCoverage,
  constants,
) {
  const age = Math.max(0, approveUntilSlot - tx.slot);
  const localSupport = sim.localSupport(validator, tx);
  const supportNorm = clamp(localSupport / Math.max(0.0001, sim.config.supportThreshold), 0, 1);
  const descendant = sim.knownOrdinaryDescendantStats(
    validator,
    tx,
    approveUntilSlot,
    selectedOrdinaryCoverage,
  );
  const depNorm = clamp(descendant.count / constants.dependencyNormBase, 0, 1);
  const freshness = clamp(1 - age / Math.max(1, sim.config.finalityLagSlots + 1), 0, 1);
  const sibling = localSiblingConflictStats(sim, validator, tx, approveUntilSlot);
  const supportGap = Math.max(0, sibling.bestSupport - localSupport);
  const gapNorm = clamp(supportGap / Math.max(0.0001, sim.config.supportThreshold), 0, 1);
  const deadlinePressure = 1 + Math.min(1.6, (age / Math.max(1, sim.config.finalityLagSlots)) ** 2);
  const freshProbe = age <= 1 && localSupport < sim.config.supportThreshold * 0.18;
  const localSplit = sibling.conflictCount > 0;
  const viability = clamp(
    supportNorm * 0.38 +
      depNorm * 0.52 +
      freshness * 0.16 +
      (localSplit ? 0.08 : 0) -
      gapNorm * 0.36,
    0,
    1,
  );

  let bridgeGain = 0;
  if (descendant.count > 0 || descendant.gain > 0) {
    bridgeGain =
      descendant.gain * 0.46 +
      viability * constants.conflictViabilityWeight +
      deadlinePressure * (0.24 + depNorm * 0.62);
  } else if (freshProbe && !localSplit) {
    bridgeGain = constants.freshConflictProbeGain * freshness;
  } else if (freshProbe && localSplit && localSupport > 0) {
    bridgeGain = constants.freshConflictProbeGain * 0.5 * freshness;
  }

  return {
    age,
    localSupport,
    supportNorm,
    dependentCount: descendant.count,
    dependentGain: descendant.gain,
    depNorm,
    freshness,
    conflictCount: sibling.conflictCount,
    bestSupport: sibling.bestSupport,
    supportGap,
    gapNorm,
    localSplit,
    freshProbe,
    viability,
    bridgeGain: Math.min(constants.maxConflictBridgeGain, bridgeGain),
  };
}

function localSiblingConflictStats(sim, validator, tx, approveUntilSlot) {
  let conflictCount = 0;
  let bestSupport = sim.localSupport(validator, tx);
  for (const txId of validator.known.keys()) {
    const other = sim.txs.get(txId);
    if (!other || other.id === tx.id) continue;
    if (other.epoch !== tx.epoch || other.gref !== tx.gref) continue;
    if (other.slot > approveUntilSlot || other.status === TxStatus.REJECTED) continue;
    if (other.input !== tx.input) continue;
    conflictCount += 1;
    bestSupport = Math.max(bestSupport, sim.localSupport(validator, other));
  }
  return { conflictCount, bestSupport };
}

function conflictRiskPenalty(sim, validator, tx, approveUntilSlot, impact, constants) {
  if (!tx.conflictGroupId) return 0;
  if (!sim.canValidatorSupportConflict(validator, tx, approveUntilSlot)) {
    return constants.unsupportableConflictPenalty;
  }
  if (!impact.localSplit) return impact.dependentCount > 0 ? 0.02 : 0.04;
  if (impact.dependentCount > 0 || impact.dependentGain > 0) {
    return 0.05 + impact.gapNorm * 0.22;
  }

  let penalty = 0.22 + impact.gapNorm * 0.45;
  if (impact.localSupport === 0 && impact.age > 1) penalty += 0.72;
  else if (impact.localSupport < sim.config.supportThreshold * 0.12) penalty += 0.28;
  if (impact.age >= Math.max(1, sim.config.finalityLagSlots - 1)) penalty += 0.16;
  return penalty;
}

function selectionConstants(sim) {
  const finalityLag = Math.max(1, sim.config.finalityLagSlots);
  const txLoad = Math.max(1, sim.config.txPerSlot);
  const validators = Math.max(1, sim.config.validatorCount);
  const vbTips = Math.max(1, sim.config.vbTips);
  const vbPerSlot = Math.max(1, sim.config.validatorBlocksPerSlot);
  const supportBudget = Math.max(1, validators * vbPerSlot * vbTips * finalityLag);
  const normalizedLoad = txLoad / supportBudget;
  const miss = Math.max(0, Math.min(0.35, sim.config.validatorBlockMissChance || 0));
  const rescueScale = 1 + miss * 1.15 + normalizedLoad * 2;
  return {
    dependencyNormBase: Math.max(1, txLoad * finalityLag),
    minimumScore: -0.25,
    fallbackWeight: 0.16,
    ordinaryDuplicatePenalty: 0.025,
    conflictDuplicatePenalty: 0.02,
    rescueGainMultiplier: 0.32 * rescueScale,
    rescueCandidateBoost: 0.1 * rescueScale,
    freshOrdinaryTipBoost: 0.38 + normalizedLoad * 1.2,
    oldOrdinaryTipPenalty: 0.22 + miss * 0.4,
    bridgeCandidateBoost: 0.14,
    conflictProbeBoost: 0.08,
    conflictViabilityWeight: 1.05 + normalizedLoad * 1.6,
    freshConflictProbeGain: 0.22,
    maxConflictBridgeGain: 4.2,
    unsupportableConflictPenalty: 1.15,
  };
}

function selectionEvaluationDebug(best, sim, validator, approveUntilSlot) {
  const item = best.candidate;
  const evaluation = best.evaluation;
  return {
    tx: tipDebug(item.tx, sim, validator, approveUntilSlot),
    kinds: [...item.kinds],
    score: round(evaluation.score, 6),
    usefulOrdinaryGain: round(evaluation.usefulOrdinaryGain, 6),
    rescueGain: round(evaluation.rescueGain, 6),
    bridgeConflictGain: round(evaluation.bridgeConflictGain, 6),
    conflictPenalty: round(evaluation.conflictPenalty, 6),
    duplicatePenalty: round(evaluation.duplicatePenalty, 6),
    oldDirectPenalty: round(evaluation.oldDirectPenalty, 6),
    newOrdinaryCoverage: evaluation.newOrdinaryCoverage.length,
    coneOrdinary: evaluation.coneOrdinary,
    coneConflict: evaluation.coneConflict,
    conflictImpact: evaluation.conflictImpact.slice(0, 6),
  };
}

function conflictImpactDebug(tx, impact, sim) {
  return {
    id: tx.id,
    slot: tx.localSlot,
    globalSlot: tx.slot,
    input: tx.input,
    support: round(impact.localSupport, 6),
    dependents: impact.dependentCount,
    dependentGain: round(impact.dependentGain, 6),
    conflictCount: impact.conflictCount,
    bestSupport: round(impact.bestSupport, 6),
    gap: round(impact.supportGap, 6),
    viability: round(impact.viability, 6),
    bridgeGain: round(impact.bridgeGain, 6),
    freshProbe: impact.freshProbe,
  };
}

function tipDebug(tx, sim, scoringNode, scoringSlot) {
  return {
    id: tx.id,
    kind: txKind(tx),
    slot: tx.localSlot,
    globalSlot: tx.slot,
    status: tx.status,
    support: round(tx.support, 6),
    localSupport: scoringNode ? round(sim.localSupport(scoringNode, tx), 6) : null,
    seen: tx.seenBy.size,
    late: tx.lateBy.size,
    input: tx.input,
    conflictGroupId: tx.conflictGroupId,
    parents: tx.parents,
    score: scoringNode ? round(sim.tipScore(scoringNode, tx, scoringSlot), 6) : null,
  };
}

function txKind(tx) {
  if (tx.attack) return "attack-conflict";
  if (tx.conflictGroupId) return "conflict";
  return "ordinary";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
