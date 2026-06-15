import { makeTransaction } from "../ledger.js";
import { LocalTxStatus, TxStatus } from "../status.js";

export function createConflictBurst(sim, options = {}) {
  const count = Math.max(2, Math.floor(options.count ?? 2));
  const sourceNodes = attackSourceNodes(sim);
  const input = chooseConflictInput(sim);

  if (!input || !sourceNodes.length) {
    return {
      created: 0,
      groupId: null,
      input: null,
      reason: "no spendable input for conflict attack",
    };
  }

  sim.nextAttackId = (sim.nextAttackId ?? 1) + 1;
  const groupId = `cf-${String(sim.nextAttackId - 1).padStart(4, "0")}`;
  const start = Math.floor(sim.random() * sourceNodes.length);
  const created = [];
  const fallback = {
    anchorParents: chooseAttackAnchorParents(sim, sourceNodes),
    lastParents: [],
  };

  sim.reservedInputs.add(input);

  for (let i = 0; i < count; i += 1) {
    const creator = sourceNodes[(start + i) % sourceNodes.length];
    sim.syncAttackNodeView(creator);
    const parents = selectAttackParents(sim, creator, fallback);
    if (!parents.length) continue;
    const tx = makeTransaction(sim, creator.id, parents, {
      input,
      reserveInput: false,
      conflictGroupId: groupId,
      attack: {
        type: "CONFLICT_BURST",
        groupId,
        index: i + 1,
        size: count,
      },
    });

    sim.txs.set(tx.id, tx);
    sim.rememberTx(creator, tx, sim.time, LocalTxStatus.ON_TIME);
    sim.broadcastFullTx(creator.id, tx.id, null, true);
    created.push(tx.id);
    if (parents.length) fallback.lastParents = parents;
  }

  return {
    created: created.length,
    groupId,
    input,
    txIds: created,
    reason: "",
  };
}

export function startConflictSpamAttack(sim, options = {}) {
  const perSlot = Math.max(1, Math.floor(options.perSlot ?? 3));
  const input = chooseConflictInput(sim);
  const sourceNodes = attackSourceNodes(sim);
  const startSlot = Math.max(0, Math.floor(options.startSlot ?? sim.slot));
  const endSlot = Math.max(
    startSlot,
    Math.floor(options.endSlot ?? startSlot + sim.config.finalityLagSlots),
  );
  const type = options.type || "CONFLICT_SPAM";

  if (!input || !sourceNodes.length) {
    return {
      started: false,
      reason: "no spendable input for conflict attack",
    };
  }

  sim.nextAttackId = (sim.nextAttackId ?? 1) + 1;
  const campaign = {
    id: `cf-${String(sim.nextAttackId - 1).padStart(4, "0")}`,
    type,
    input,
    perSlot,
    epoch: sim.epoch,
    gref: sim.genesis.id,
    startSlot,
    endSlot,
    localStartSlot: sim.localSlotForGlobal(startSlot),
    localEndSlot: sim.localSlotForGlobal(endSlot),
    sourceMode: "geo-round-robin",
    sourceNodeIds: sourceNodes.map((node) => node.id),
    anchorParents: chooseAttackAnchorParents(sim, sourceNodes),
    lastParents: [],
    created: 0,
    active: true,
  };

  sim.reservedInputs.add(input);
  sim.attackCampaigns.push(campaign);
  sim.trace?.("attack-start", {
    campaign: campaignLog(campaign),
  });

  return {
    started: true,
    campaign,
    reason: "",
  };
}

export function startEpochConflictSpamAttack(sim, options = {}) {
  const existing = sim.attackCampaigns.find(
    (campaign) =>
      campaign.type === "EPOCH_CONFLICT_SPAM" &&
      campaign.epoch === sim.epoch &&
      campaign.gref === sim.genesis.id,
  );
  if (existing) {
    return {
      started: false,
      campaign: existing,
      reason: "epoch conflict spam is already scheduled",
    };
  }

  const startSlot = sim.epochStartSlot;
  const endSlot = sim.epochStartSlot + sim.config.slotsPerEpoch - 1;
  if (sim.slot !== startSlot) {
    return {
      started: false,
      campaign: null,
      reason: "waiting for epoch slot 0",
    };
  }

  return startConflictSpamAttack(sim, {
    perSlot: options.perSlot,
    startSlot,
    endSlot,
    type: "EPOCH_CONFLICT_SPAM",
  });
}

export function startMultiConflictSpamAttack(sim, options = {}) {
  const minPerSlot = Math.max(1, Math.floor(options.minPerSlot ?? 2));
  const perSlot = Math.max(minPerSlot, Math.floor(options.perSlot ?? 3));
  const sourceNodes = attackSourceNodes(sim);
  const startSlot = Math.max(0, Math.floor(options.startSlot ?? sim.slot));
  const endSlot = Math.max(
    startSlot,
    Math.floor(options.endSlot ?? sim.epochStartSlot + sim.config.slotsPerEpoch - 1),
  );
  const type = options.type || "MULTI_CONFLICT_SPAM";

  if (!sourceNodes.length) {
    return {
      started: false,
      reason: "no attack nodes for conflict attack",
    };
  }

  if (!hasSpendableConflictInput(sim)) {
    return {
      started: false,
      reason: "no spendable input for conflict attack",
    };
  }

  sim.nextAttackId = (sim.nextAttackId ?? 1) + 1;
  const idPrefix = options.idPrefix || "mf";
  const campaign = {
    id: `${idPrefix}-${String(sim.nextAttackId - 1).padStart(4, "0")}`,
    type,
    input: "per-slot",
    perSlot,
    epoch: sim.epoch,
    gref: sim.genesis.id,
    startSlot,
    endSlot,
    localStartSlot: sim.localSlotForGlobal(startSlot),
    localEndSlot: sim.localSlotForGlobal(endSlot),
    sourceMode: "geo-round-robin",
    sourceNodeIds: sourceNodes.map((node) => node.id),
    waveOffsets: normalizeWaveOffsets(options.waveOffsets),
    slotGroups: new Map(),
    usedInputs: new Set(),
    created: 0,
    active: true,
  };

  sim.attackCampaigns.push(campaign);
  sim.trace?.("attack-start", {
    campaign: campaignLog(campaign),
  });

  return {
    started: true,
    campaign,
    reason: "",
  };
}

export function startWaveConflictSpamAttack(sim, options = {}) {
  return startMultiConflictSpamAttack(sim, {
    ...options,
    type: options.type || "WAVE_MULTI_CONFLICT_SPAM",
    idPrefix: options.idPrefix || "wf",
    minPerSlot: options.minPerSlot || 1,
    waveOffsets: options.waveOffsets || [0.06, 0.5, 0.88],
  });
}

export function startEpochMultiConflictSpamAttack(sim, options = {}) {
  const existing = sim.attackCampaigns.find(
    (campaign) =>
      campaign.type === "EPOCH_MULTI_CONFLICT_SPAM" &&
      campaign.epoch === sim.epoch &&
      campaign.gref === sim.genesis.id,
  );
  if (existing) {
    return {
      started: false,
      campaign: existing,
      reason: "epoch multi conflict spam is already scheduled",
    };
  }

  const startSlot = sim.epochStartSlot;
  const endSlot = sim.epochStartSlot + sim.config.slotsPerEpoch - 1;
  if (sim.slot !== startSlot) {
    return {
      started: false,
      campaign: null,
      reason: "waiting for epoch slot 0",
    };
  }

  return startMultiConflictSpamAttack(sim, {
    perSlot: options.perSlot,
    startSlot,
    endSlot,
    type: "EPOCH_MULTI_CONFLICT_SPAM",
  });
}

export function startEpochWaveConflictSpamAttack(sim, options = {}) {
  const existing = sim.attackCampaigns.find(
    (campaign) =>
      campaign.type === "EPOCH_WAVE_MULTI_CONFLICT_SPAM" &&
      campaign.epoch === sim.epoch &&
      campaign.gref === sim.genesis.id,
  );
  if (existing) {
    return {
      started: false,
      campaign: existing,
      reason: "epoch wave conflict spam is already scheduled",
    };
  }

  const startSlot = sim.epochStartSlot;
  const endSlot = sim.epochStartSlot + sim.config.slotsPerEpoch - 1;
  if (sim.slot !== startSlot) {
    return {
      started: false,
      campaign: null,
      reason: "waiting for epoch slot 0",
    };
  }

  return startWaveConflictSpamAttack(sim, {
    perSlot: options.perSlot,
    startSlot,
    endSlot,
    type: "EPOCH_WAVE_MULTI_CONFLICT_SPAM",
  });
}

export function scheduleConflictSpamForSlot(sim, slot, slotStart, slotEnd) {
  for (const campaign of sim.attackCampaigns) {
    if (!campaign.active) continue;
    if (slot < campaign.startSlot) continue;
    if (campaign.epoch !== sim.epoch || campaign.gref !== sim.genesis.id) {
      campaign.active = false;
      releaseCampaignInputs(sim, campaign);
      sim.trace?.("attack-end", {
        reason: "epoch changed",
        campaign: campaignLog(campaign),
      });
      continue;
    }
    if (slot > campaign.endSlot) {
      campaign.active = false;
      releaseCampaignInputs(sim, campaign);
      sim.trace?.("attack-end", {
        reason: "window ended",
        campaign: campaignLog(campaign),
      });
      continue;
    }

    const duration = slotEnd - slotStart;
    const waves = campaign.waveOffsets?.length ? campaign.waveOffsets : null;
    if (waves) {
      for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
        scheduleConflictWave(sim, campaign, slot, slotStart, duration, waves[waveIndex], waveIndex);
      }
    } else {
      for (let i = 0; i < campaign.perSlot; i += 1) {
        const earlyWindow = Math.min(0.18, Math.max(0.06, campaign.perSlot * 0.015));
        const base =
          campaign.perSlot === 1 ? 0.012 : 0.008 + (i / Math.max(1, campaign.perSlot - 1)) * earlyWindow;
        const jitter = (sim.random() - 0.5) * 0.012;
        const offset = Math.max(0.005, Math.min(0.22, base + jitter));
        sim.enqueueEvent({
          at: slotStart + offset * duration,
          kind: "CREATE_ATTACK_CONFLICT",
          campaignId: campaign.id,
          slot,
        });
      }
    }
  }
}

function scheduleConflictWave(sim, campaign, slot, slotStart, duration, waveOffset, waveIndex) {
  const spread = Math.min(0.08, Math.max(0.024, campaign.perSlot * 0.008));
  for (let i = 0; i < campaign.perSlot; i += 1) {
    const base =
      campaign.perSlot === 1
        ? waveOffset
        : waveOffset - spread / 2 + (i / Math.max(1, campaign.perSlot - 1)) * spread;
    const jitter = (sim.random() - 0.5) * 0.01;
    const offset = clampUnit(base + jitter, 0.005, 0.965);
    sim.enqueueEvent({
      at: slotStart + offset * duration,
      kind: "CREATE_ATTACK_CONFLICT",
      campaignId: campaign.id,
      slot,
      waveIndex,
      waveLabel: waveLabelForIndex(waveIndex),
    });
  }
}

export function createScheduledConflictTx(sim, campaignId, eventSlot = sim.slot, eventMeta = {}) {
  const campaign = sim.attackCampaigns.find((item) => item.id === campaignId);
  if (!campaign?.active) return null;
  if (campaign.epoch !== sim.epoch || campaign.gref !== sim.genesis.id) return null;
  if (sim.slot > campaign.endSlot) {
    campaign.active = false;
    return null;
  }

  const target = slotConflictTarget(sim, campaign, eventSlot);
  if (!target) return null;

  const txIndex = target.created + 1;
  const creator = conflictCreatorForIndex(sim, target, txIndex);
  if (!creator) return null;
  sim.syncAttackNodeView(creator);
  const parents = selectAttackParents(sim, creator, target);
  if (!parents.length) {
    retryConflictTx(sim, campaign, eventSlot, eventMeta);
    return null;
  }
  target.created = txIndex;
  if (target !== campaign) campaign.created += 1;

  const tx = makeTransaction(sim, creator.id, parents, {
    input: target.input,
    reserveInput: false,
    conflictGroupId: target.id,
    attack: {
      type: target.type,
      campaignId: campaign.id,
      groupId: target.id,
      index: txIndex,
      perSlot: target.perSlot,
      startSlot: target.startSlot,
      endSlot: target.endSlot,
      localStartSlot: target.localStartSlot,
      localEndSlot: target.localEndSlot,
      sourceMode: target.sourceMode,
      sourceIndex: txIndex,
      originCity: creator.city,
      waveIndex: eventMeta.waveIndex,
      waveLabel: eventMeta.waveLabel,
    },
  });

  sim.txs.set(tx.id, tx);
  sim.rememberTx(creator, tx, sim.time, LocalTxStatus.ON_TIME);
  sim.broadcastFullTx(creator.id, tx.id, null, true);
  sim.trace?.("attack-tx-created", {
    campaign: campaignLog(campaign),
    tx: {
      id: tx.id,
      slot: tx.localSlot,
      globalSlot: tx.slot,
      epoch: tx.epoch,
      input: tx.input,
      parents: tx.parents,
      creatorId: tx.creatorId,
      attack: tx.attack,
      conflictGroupId: tx.conflictGroupId,
    },
  });
  if (parents.length) target.lastParents = parents;
  return tx;
}

export function activeConflictCampaigns(sim) {
  return sim.attackCampaigns.filter((campaign) => campaign.active);
}

function chooseConflictInput(sim) {
  const source = [...sim.utxos].filter((id) => !sim.reservedInputs.has(id));
  if (!source.length) return null;
  return source[Math.floor(sim.random() * source.length)];
}

function hasSpendableConflictInput(sim) {
  return [...sim.utxos].some((id) => !sim.reservedInputs.has(id));
}

function normalizeWaveOffsets(offsets) {
  if (!Array.isArray(offsets) || !offsets.length) return null;
  return offsets
    .map((offset) => Number(offset))
    .filter((offset) => Number.isFinite(offset))
    .map((offset) => clampUnit(offset, 0.005, 0.965));
}

function clampUnit(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function waveLabelForIndex(index) {
  if (index === 0) return "early";
  if (index === 1) return "middle";
  if (index === 2) return "late";
  return `wave-${index + 1}`;
}

function attackSourceNodes(sim) {
  return sim.attackNodes || [];
}

function conflictCreatorForIndex(sim, campaign, txIndex) {
  const ids = campaign.sourceNodeIds || [];
  const nodes = ids.map((id) => sim.nodeById(id)).filter(Boolean);
  const source = nodes.length ? nodes : attackSourceNodes(sim);
  if (!source.length) return null;
  return source[(txIndex - 1) % source.length];
}

function slotConflictTarget(sim, campaign, slot) {
  if (!isMultiConflictCampaign(campaign)) return campaign;
  if (slot < campaign.startSlot || slot > campaign.endSlot) return null;
  if (!campaign.slotGroups) campaign.slotGroups = new Map();
  const existing = campaign.slotGroups.get(slot);
  if (existing) return existing;

  const input = chooseCampaignConflictInput(sim, campaign);
  if (!input) return null;
  const localSlot = sim.localSlotForGlobal(slot);
  const group = {
    id: `${campaign.id}-s${String(localSlot).padStart(3, "0")}`,
    type: campaign.waveOffsets?.length ? "WAVE_MULTI_CONFLICT_SLOT" : "MULTI_CONFLICT_SLOT",
    input,
    perSlot: campaign.perSlot,
    epoch: campaign.epoch,
    gref: campaign.gref,
    startSlot: slot,
    endSlot: slot,
    localStartSlot: localSlot,
    localEndSlot: localSlot,
    sourceMode: campaign.sourceMode,
    sourceNodeIds: campaign.sourceNodeIds,
    waveOffsets: campaign.waveOffsets,
    anchorParents: chooseAttackAnchorParents(sim, attackSourceNodes(sim)),
    lastParents: [],
    created: 0,
  };
  sim.reservedInputs.add(input);
  campaign.usedInputs.add(input);
  campaign.slotGroups.set(slot, group);
  sim.trace?.("attack-slot-group", {
    campaign: campaignLog(campaign),
    group: campaignLog(group),
  });
  return group;
}

function isMultiConflictCampaign(campaign) {
  return String(campaign?.type || "").includes("MULTI_CONFLICT");
}

function releaseCampaignInputs(sim, campaign) {
  if (campaign.input && campaign.input !== "per-slot") sim.releaseInputReservation(campaign.input);
  for (const group of campaign.slotGroups?.values?.() || []) {
    if (group.input) sim.releaseInputReservation(group.input);
  }
}

function chooseCampaignConflictInput(sim, campaign) {
  const used = campaign.usedInputs || new Set();
  const source = [...sim.utxos].filter(
    (id) => !sim.reservedInputs.has(id) && !used.has(id),
  );
  if (!source.length) return null;
  return source[Math.floor(sim.random() * source.length)];
}

function selectAttackParents(sim, creator, fallback) {
  const direct = normalizeAttackParents(sim, sim.selectTipsForNode(creator, sim.config.txParents));
  if (direct.length) return direct;

  const last = cleanParents(sim, creator, fallback.lastParents);
  if (last.length) return last;

  const anchor = cleanParents(sim, creator, fallback.anchorParents);
  if (anchor.length) return anchor;

  fallback.anchorParents = chooseAttackAnchorParents(sim, [creator]);
  return fallback.anchorParents;
}

function chooseAttackAnchorParents(sim, sourceNodes) {
  for (const node of sourceNodes) {
    sim.syncAttackNodeView(node);
    const parents = normalizeAttackParents(sim, sim.selectTipsForNode(node, sim.config.txParents));
    if (parents.length) return parents;
  }
  return [];
}

function retryConflictTx(sim, campaign, eventSlot = sim.slot, eventMeta = {}) {
  const slotEnd = (eventSlot + 1) * sim.config.slotDuration;
  const retryDelay = Math.min(0.25, sim.config.slotDuration * 0.06);
  const at = sim.time + retryDelay;
  if (at >= slotEnd - 0.02 || eventSlot > campaign.endSlot) return;
  sim.enqueueEvent({
    at,
    kind: "CREATE_ATTACK_CONFLICT",
    campaignId: campaign.id,
    slot: eventSlot,
    waveIndex: eventMeta.waveIndex,
    waveLabel: eventMeta.waveLabel,
  });
}

function cleanParents(sim, node, parents = []) {
  return parents.filter((id) => {
    const tx = sim.txs.get(id);
    return (
      tx &&
      tx.epoch === sim.epoch &&
      tx.gref === sim.genesis.id &&
      tx.status !== TxStatus.REJECTED &&
      sim.canReferenceTx(node, tx, sim.slot, {
        conflictPolicy: "attack",
        requireCompleteCone: false,
      })
    );
  });
}

function normalizeAttackParents(sim, parents = []) {
  const out = [];
  const seen = new Set();
  for (const parentId of parents) {
    const tx = sim.txs.get(parentId);
    const directParents = tx?.conflictGroupId && tx.parents.length ? tx.parents : [parentId];
    for (const id of directParents) {
      if (seen.has(id)) continue;
      const parent = sim.txs.get(id);
      if (!parent || parent.epoch !== sim.epoch || parent.gref !== sim.genesis.id) continue;
      if (parent.status === TxStatus.REJECTED) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= sim.config.txParents) return out;
    }
  }
  return out;
}

function campaignLog(campaign) {
  return {
    id: campaign.id,
    type: campaign.type,
    input: campaign.input,
    perSlot: campaign.perSlot,
    epoch: campaign.epoch,
    startSlot: campaign.localStartSlot,
    endSlot: campaign.localEndSlot,
    globalStartSlot: campaign.startSlot,
    globalEndSlot: campaign.endSlot,
    sourceMode: campaign.sourceMode,
    waves: campaign.waveOffsets,
    sources: campaign.sourceNodeIds,
    created: campaign.created,
    active: campaign.active,
  };
}
