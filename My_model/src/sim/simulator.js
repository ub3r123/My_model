import { readConfigFromForm } from "./config.js";
import {
  activeConflictCampaigns,
  createScheduledConflictTx,
  startEpochConflictSpamAttack,
  startEpochMultiConflictSpamAttack,
  startEpochWaveConflictSpamAttack,
  scheduleConflictSpamForSlot,
} from "./attacks/conflictAttack.js";
import { makeGenesis, makeTransaction, commitUtxos } from "./ledger.js";
import { buildAttackNodes, buildNodes, networkDelaySeconds } from "./network.js";
import { LocalTxStatus, MessageType, TxStatus } from "./status.js";
import { clamp, mulberry32, stableHashNumber } from "./utils.js";
import { collectLocalPastCone, selectValidationTips } from "./validatorSelection.js";

const GENESIS_HEADER_BYTES = 256;
const GENESIS_ACCOUNT_BYTES = 96;

export class Simulator {
  constructor(config) {
    this.config = config;
    this.random = mulberry32(config.seed);
    this.time = 0;
    this.slot = 0;
    this.epoch = 0;
    this.epochSlot = 0;
    this.epochStartSlot = 0;
    this.epochEndSlot = null;
    this.waitingEpochEnd = false;
    this.lastFinalized = emptyFinalizedStats(0, 0, 0);
    this.rotations = 0;
    this.nextTxId = 1;
    this.nextVbId = 1;
    this.events = [];
    this.messageStats = { sent: 0, bytes: 0 };
    this.nextAttackId = 1;
    this.attackCampaigns = [];
    this.txs = new Map();
    this.validationBlocks = [];
    this.validationBlockById = new Map();
    this.finalizedSlots = new Set();
    this.genesis = makeGenesis();
    this.utxos = new Set(this.genesis.utxos);
    this.allCreatedUtxos = new Set(this.utxos);
    this.reservedInputs = new Set();
    this.nodes = buildNodes(config);
    this.attackNodes = buildAttackNodes(config, this.nodes);
    this.validators = [];
    this.selectedTxId = null;
    this.logger = null;
    this.lastValidatorSelection = null;
    this.autoEpochConflictAttack = false;
    this.autoEpochConflictPerSlot = 3;
    this.autoEpochConflictMode = "single";
    this.autoEpochAttackStarted = new Set();

    this.assignValidators();
  }

  static fromDocument(doc) {
    return new Simulator(readConfigFromForm(doc));
  }

  setLogger(logger) {
    this.logger = logger;
  }

  setAutoEpochConflictAttack(
    enabled,
    perSlot = this.autoEpochConflictPerSlot,
    mode = this.autoEpochConflictMode,
  ) {
    this.autoEpochConflictAttack = Boolean(enabled);
    this.autoEpochConflictPerSlot = Math.max(1, Math.floor(Number(perSlot) || 1));
    this.autoEpochConflictMode = ["single", "multi", "waves"].includes(mode) ? mode : "single";
  }

  trace(type, payload = {}) {
    if (!this.logger) return;
    this.logger.write(type, {
      simTime: round(this.time),
      epoch: this.epoch,
      slot: this.localSlotForGlobal(this.slot),
      globalSlot: this.slot,
      genesis: this.genesis.id,
      ...payload,
    });
  }

  localSlotForGlobal(slot) {
    return Math.max(0, slot - this.epochStartSlot);
  }

  assignValidators() {
    const ids = [];
    while (ids.length < Math.min(this.config.validatorCount, this.nodes.length)) {
      const id = Math.floor(this.random() * this.nodes.length);
      if (!ids.includes(id)) ids.push(id);
    }

    const weights = ids.map(() => 0.5 + this.random());
    const total = weights.reduce((a, b) => a + b, 0);
    ids.forEach((id, index) => {
      this.nodes[id].validator = true;
      this.nodes[id].stake = weights[index] / total;
      this.validators.push(this.nodes[id]);
    });
  }

  stepSlot() {
    const slotStart = this.slot * this.config.slotDuration;
    const slotEnd = slotStart + this.config.slotDuration;
    this.time = slotStart;
    const startMessages = { ...this.messageStats };

    this.trace("slot-start", {
      slotStart: round(slotStart),
      slotEnd: round(slotEnd),
      waitingEpochEnd: this.waitingEpochEnd,
      activeCampaigns: activeConflictCampaigns(this).map((campaign) =>
        campaignSnapshot(campaign, this),
      ),
    });

    if (!this.waitingEpochEnd) this.scheduleSlotTransactions(slotStart, slotEnd);
    if (!this.waitingEpochEnd) this.maybeStartAutoEpochConflictAttack();
    if (!this.waitingEpochEnd) {
      scheduleConflictSpamForSlot(this, this.slot, slotStart, slotEnd);
    }
    this.scheduleValidationBlocksForSlot(this.slot, this.epoch, slotStart, slotEnd);

    this.runEventsUntil(slotEnd);
    this.time = slotEnd;
    this.finalizeMatureSlot();

    if (!this.waitingEpochEnd) {
      this.epochSlot += 1;
      if (this.epochSlot >= this.config.slotsPerEpoch) {
        this.waitingEpochEnd = true;
        this.epochEndSlot = this.slot;
      }
    }

    this.tryRotateEpoch();
    this.trace("slot-end", {
      metrics: compactMetrics(this.metrics()),
      messagesSent: this.messageStats.sent - startMessages.sent,
      messageBytes: this.messageStats.bytes - startMessages.bytes,
      queuedEvents: this.events.length,
    });
    this.slot += 1;
  }

  scheduleSlotTransactions(slotStart, slotEnd) {
    const normalNodes = this.nodes.filter((n) => !n.validator);
    const times = [];
    for (let i = 0; i < this.config.txPerSlot; i += 1) {
      const offset = 0.08 + this.random() * 0.84;
      times.push(slotStart + offset * (slotEnd - slotStart));
    }
    times.sort((a, b) => a - b);

    for (const at of times) {
      const creator = normalNodes[Math.floor(this.random() * normalNodes.length)];
      heapPush(this.events, {
        at,
        kind: "CREATE_TX",
        creatorId: creator.id,
      });
    }
  }

  createTransactionNow(creatorId) {
    const creator = this.nodes[creatorId];
    if (!creator) return;
    let parents = this.selectTipsForNode(creator, this.config.txParents);
    if (!parents.length) {
      this.syncNodeViewFromPeers(creator, this.parentRecoveryPeerLimit());
      parents = this.selectTipsForNode(creator, this.config.txParents);
    }
    if (!parents.length && !this.canCreateWithoutParents()) {
      this.trace("tx-skipped", {
        creator: nodeSnapshot(creator),
        reason: "no fresh parents available",
      });
      return;
    }
    const tx = makeTransaction(this, creator.id, parents);
    this.txs.set(tx.id, tx);
    this.rememberTx(creator, tx, this.time, LocalTxStatus.ON_TIME);
    this.broadcastFullTx(creator.id, tx.id, null, true);
    this.trace("tx-created", {
      tx: txSnapshot(tx, this),
      creator: nodeSnapshot(creator),
    });
  }

  canCreateWithoutParents() {
    if (this.slot !== this.epochStartSlot) return false;
    for (const tx of this.txs.values()) {
      if (tx.epoch === this.epoch && tx.gref === this.genesis.id && tx.status !== TxStatus.REJECTED) {
        return false;
      }
    }
    return true;
  }

  parentRecoveryPeerLimit() {
    return Math.max(4, this.config.neighborsNear + this.config.neighborsRandom);
  }

  createSlotTransactions() {
    const normalNodes = this.nodes.filter((n) => !n.validator);
    for (let i = 0; i < this.config.txPerSlot; i += 1) {
      const creator = normalNodes[Math.floor(this.random() * normalNodes.length)];
      this.createTransactionNow(creator.id);
    }
  }

  maybeStartAutoEpochConflictAttack() {
    if (!this.autoEpochConflictAttack) return;
    if (this.slot !== this.epochStartSlot) return;
    const key = `${this.epoch}:${this.genesis.id}`;
    if (this.autoEpochAttackStarted.has(key)) return;
    const startAttack =
      this.autoEpochConflictMode === "waves"
        ? startEpochWaveConflictSpamAttack
        : this.autoEpochConflictMode === "multi"
          ? startEpochMultiConflictSpamAttack
          : startEpochConflictSpamAttack;
    const result = startAttack(this, {
      perSlot: this.autoEpochConflictPerSlot,
    });
    this.autoEpochAttackStarted.add(key);
    this.trace("auto-epoch-attack", {
      enabled: true,
      mode: this.autoEpochConflictMode,
      perSlot: this.autoEpochConflictPerSlot,
      started: result.started,
      reason: result.reason,
      campaign: result.campaign ? campaignSnapshot(result.campaign, this) : null,
    });
  }

  broadcastFullTx(fromId, txId, exceptId, firstHop = false) {
    const from = this.nodeById(fromId);
    if (!from) return;
    const peers = from.peers.filter((id) => id !== exceptId);
    const fullBudget = firstHop ? Math.min(3, peers.length) : 0;

    peers.forEach((peerId, index) => {
      if (index < fullBudget) {
        this.scheduleMessage(fromId, peerId, MessageType.TX_FULL, txId, this.config.fullTxBytes);
      } else {
        this.scheduleMessage(fromId, peerId, MessageType.IHAVE, txId, this.config.ihaveBytes);
      }
    });
  }

  broadcastValidationBlock(fromId, vbId, exceptId, firstHop = false) {
    const from = this.nodeById(fromId);
    if (!from) return;
    const peers = from.peers.filter((id) => id !== exceptId);
    const fullBudget = firstHop ? Math.min(3, peers.length) : 0;

    peers.forEach((peerId, index) => {
      if (index < fullBudget) {
        this.scheduleMessage(
          fromId,
          peerId,
          MessageType.VB_FULL,
          vbId,
          this.config.validationBlockBytes,
        );
      } else {
        this.scheduleMessage(fromId, peerId, MessageType.VB_IHAVE, vbId, this.config.ihaveBytes);
      }
    });
  }

  scheduleMessage(fromId, toId, type, txId, bytes) {
    const fromNode = this.nodeById(fromId);
    const toNode = this.nodeById(toId);
    if (!fromNode || !toNode) return;
    if (this.random() < (this.config.messageDropChance || 0)) return;
    this.messageStats.sent += 1;
    this.messageStats.bytes += bytes;
    const delay = networkDelaySeconds(
      fromNode,
      toNode,
      bytes,
      this.config,
      this.random,
    );
    heapPush(this.events, {
      at: this.time + delay,
      fromId,
      toId,
      type,
      txId,
      bytes,
    });
  }

  runEventsUntil(endTime) {
    while (this.events.length && this.events[0].at <= endTime) {
      const event = heapPop(this.events);
      this.time = event.at;
      this.handleEvent(event);
    }
  }

  handleEvent(event) {
    if (event.kind === "CREATE_TX") {
      this.createTransactionNow(event.creatorId);
      return;
    }
    if (event.kind === "CREATE_VB") {
      this.createValidationBlockNow(event.slot, event.validatorId, event.epoch);
      return;
    }
    if (event.kind === "CREATE_ATTACK_CONFLICT") {
      createScheduledConflictTx(this, event.campaignId, event.slot, {
        waveIndex: event.waveIndex,
        waveLabel: event.waveLabel,
      });
      return;
    }
    this.handleMessage(event);
  }

  enqueueEvent(event) {
    heapPush(this.events, event);
  }

  handleMessage(event) {
    if (event.type === MessageType.VB_IHAVE) {
      const node = this.nodeById(event.toId);
      if (!node) return;
      if (!node.knownVbs.has(event.txId)) {
        this.scheduleMessage(event.toId, event.fromId, MessageType.VB_IWANT, event.txId, this.config.iwantBytes);
      }
      return;
    }

    if (event.type === MessageType.VB_IWANT) {
      const node = this.nodeById(event.toId);
      if (!node?.knownVbs?.has(event.txId)) return;
      this.scheduleMessage(
        event.toId,
        event.fromId,
        MessageType.VB_FULL,
        event.txId,
        this.config.validationBlockBytes,
      );
      return;
    }

    if (event.type === MessageType.VB_FULL) {
      const node = this.nodeById(event.toId);
      const vb = this.validationBlockById.get(event.txId);
      if (!node || !vb || vb.epoch !== this.epoch) return;
      if (!this.rememberValidationBlock(node, vb)) return;
      this.requestMissingValidationBlockTips(node, vb, event.fromId);
      this.broadcastValidationBlock(event.toId, vb.id, event.fromId, false);
      return;
    }

    if (event.type === MessageType.IHAVE) {
      const node = this.nodeById(event.toId);
      if (!node) return;
      if (!node.known.has(event.txId)) {
        this.scheduleMessage(event.toId, event.fromId, MessageType.IWANT, event.txId, this.config.iwantBytes);
      }
      return;
    }

    if (event.type === MessageType.IWANT) {
      const node = this.nodeById(event.toId);
      if (!node?.known?.has(event.txId)) return;
      this.scheduleMessage(event.toId, event.fromId, MessageType.TX_FULL, event.txId, this.config.fullTxBytes);
      return;
    }

    const tx = this.txs.get(event.txId);
    if (!tx) return;
    if (tx.epoch !== this.epoch || tx.gref !== this.genesis.id) return;

    const node = this.nodeById(event.toId);
    if (!node) return;
    if (node.known.has(tx.id)) return;

    const late = this.isLateForOwnSlot(tx, event.at);
    this.rememberTx(node, tx, event.at, late ? LocalTxStatus.LATE : LocalTxStatus.ON_TIME, event.fromId);
    this.broadcastFullTx(event.toId, tx.id, event.fromId, false);
  }

  rememberTx(node, tx, receivedAt, localStatus, sourceHintId = null) {
    node.known.set(tx.id, { receivedAt, localStatus });
    node.requestedTxAt?.delete?.(tx.id);
    if (!node.attack) tx.seenBy.add(node.id);
    if (localStatus === LocalTxStatus.LATE) tx.lateBy.add(node.id);

    for (const parentId of tx.parents) {
      if (!node.children.has(parentId)) node.children.set(parentId, new Set());
      node.children.get(parentId).add(tx.id);
    }

    this.refreshLocalSupportForTx(node, tx.id);
    this.requestMissingPastCone(node, tx, sourceHintId, this.slot);
  }

  requestMissingValidationBlockTips(node, vb, sourceHintId = null) {
    let requested = 0;
    for (const tipId of vb.tips || []) {
      const tx = this.txs.get(tipId);
      if (!tx || tx.epoch !== this.epoch || tx.gref !== this.genesis.id) continue;
      if (!node.known.has(tipId)) {
        if (this.requestMissingTx(node, tipId, sourceHintId)) requested += 1;
        continue;
      }
      requested += this.requestMissingPastCone(node, tx, sourceHintId, vb.approveUntilSlot);
    }
    return requested;
  }

  requestMissingPastCone(node, tx, sourceHintId = null, scoringSlot = this.slot, visited = new Set()) {
    if (!node || !tx || visited.has(tx.id)) return 0;
    visited.add(tx.id);
    if (tx.epoch !== this.epoch || tx.gref !== this.genesis.id) return 0;
    if (tx.slot > scoringSlot || tx.status === TxStatus.REJECTED) return 0;

    let requested = 0;
    for (const parentId of tx.parents || []) {
      const parent = this.txs.get(parentId);
      if (!parent || parent.epoch !== this.epoch || parent.gref !== this.genesis.id) continue;
      if (!node.known.has(parentId)) {
        if (this.requestMissingTx(node, parentId, sourceHintId)) requested += 1;
        continue;
      }
      requested += this.requestMissingPastCone(node, parent, sourceHintId, scoringSlot, visited);
    }
    return requested;
  }

  requestMissingTx(node, txId, sourceHintId = null) {
    if (!node || node.known.has(txId)) return false;
    if (!node.requestedTxAt) node.requestedTxAt = new Map();
    const lastRequestAt = node.requestedTxAt.get(txId);
    if (
      Number.isFinite(lastRequestAt) &&
      this.time - lastRequestAt < this.solidificationRetryInterval()
    ) {
      return false;
    }
    node.requestedTxAt.set(txId, this.time);

    const targets = [];
    if (sourceHintId !== null && sourceHintId !== undefined && sourceHintId !== node.id) {
      targets.push(sourceHintId);
    }
    const peerTargets = [...(node.peers || [])]
      .filter((peerId) => peerId !== node.id && !targets.includes(peerId))
      .sort((a, b) => this.missingRequestRank(node, txId, a) - this.missingRequestRank(node, txId, b))
      .slice(0, 3);
    targets.push(...peerTargets);

    for (const targetId of targets) {
      this.scheduleMessage(node.id, targetId, MessageType.IWANT, txId, this.config.iwantBytes);
    }
    this.trace("missing-past-request", {
      nodeId: node.id,
      txId,
      sourceHintId,
      targets,
    });
    return targets.length > 0;
  }

  missingRequestRank(node, txId, peerId) {
    return stableHashNumber(`${node.id}:${txId}:${peerId}`);
  }

  solidificationRetryInterval() {
    return Math.max(0.08, Math.min(0.75, this.config.slotDuration * 0.18));
  }

  rememberValidationBlock(node, vb) {
    if (!node || !vb || node.knownVbs.has(vb.id)) return false;
    node.knownVbs.add(vb.id);
    if (!node.attack) {
      if (!vb.seenBy) vb.seenBy = new Set();
      vb.seenBy.add(node.id);
    }
    for (const txId of vb.supported || []) {
      if (node.known.has(txId)) this.addLocalSupport(node, txId, vb.validatorId);
    }
    return true;
  }

  refreshLocalSupportForTx(node, txId) {
    if (!node?.known?.has(txId)) return;
    for (const vbId of node.knownVbs || []) {
      const vb = this.validationBlockById.get(vbId);
      if (vb?.supported?.includes(txId)) this.addLocalSupport(node, txId, vb.validatorId);
    }
  }

  addLocalSupport(node, txId, validatorId) {
    if (!node.localSupportValidators.has(txId)) node.localSupportValidators.set(txId, new Set());
    node.localSupportValidators.get(txId).add(validatorId);
  }

  localSupportValidators(node, tx) {
    if (!node || !tx) return new Set();
    return node.localSupportValidators.get(tx.id) || new Set();
  }

  localSupport(node, tx) {
    let support = 0;
    for (const validatorId of this.localSupportValidators(node, tx)) {
      support += this.nodeById(validatorId)?.stake || 0;
    }
    return clamp(support, 0, 1);
  }

  nodeKnowsValidatorSupport(node, tx, validatorId) {
    return this.localSupportValidators(node, tx).has(validatorId);
  }

  isLateForOwnSlot(tx, at) {
    const validationDeadline =
      (tx.slot + 1) * this.config.slotDuration + this.config.validationDelay;
    return at > validationDeadline + this.config.lateGrace;
  }

  selectTipsForNode(node, count) {
    const pendingCandidates = [];
    const fallbackCandidates = [];
    for (const txId of node.known.keys()) {
      const tx = this.txs.get(txId);
      if (!tx || tx.epoch !== this.epoch || tx.gref !== this.genesis.id) continue;
      if (
        !this.canReferenceTx(node, tx, this.slot, {
          allowLatePromising: false,
          avoidRiskyOrdinary: !node.attack,
          conflictPolicy: node.attack ? "attack" : "ordinary",
        })
      ) {
        continue;
      }
      if (this.hasNodeEligibleChild(node, tx, this.slot)) continue;
      if (tx.status === TxStatus.PENDING) {
        pendingCandidates.push(tx);
      } else if (tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.CONFLICT_LOST) {
        fallbackCandidates.push(tx);
      }
    }

    const candidates = pendingCandidates.length ? pendingCandidates : fallbackCandidates;
    candidates.sort((a, b) => this.compareTips(node, a, b, this.slot));

    const selected = [];
    for (const tx of candidates) {
      if (selected.length >= count) break;
      if (this.compatibleWithSelected(tx, selected)) selected.push(tx.id);
    }
    return selected;
  }

  canReferenceTx(node, tx, scoringSlot = this.slot, options = {}) {
    if (tx.status === TxStatus.REJECTED) return false;
    const local = node.known.get(tx.id);
    if (!local) return false;
    if (
      local.localStatus === LocalTxStatus.LATE &&
      tx.status === TxStatus.PENDING &&
      !(options.allowLatePromising && this.isPromisingOrdinaryTx(node, tx, scoringSlot))
    ) {
      return false;
    }
    if (
      options.enforceFreshWindow !== false &&
      this.isTooOldForDirectReference(tx, scoringSlot, options.maxDirectAgeSlots)
    ) {
      this.requestMissingPastCone(node, tx, null, scoringSlot);
      return false;
    }
    const conflictPolicy = options.conflictPolicy ?? "ordinary";
    if (this.shouldIgnoreConflict(node, tx, scoringSlot, conflictPolicy)) {
      return false;
    }
    if (options.avoidRiskyOrdinary && this.shouldAvoidRiskyOrdinaryParent(node, tx, scoringSlot)) {
      return false;
    }
    for (const parentId of tx.parents) {
      const parent = this.txs.get(parentId);
      if (parent?.status === TxStatus.REJECTED) return false;
      if (!node.known.has(parentId)) {
        this.requestMissingTx(node, parentId, null);
        return false;
      }
    }
    if (
      options.requireCompleteCone !== false &&
      !this.hasCompleteLocalPastCone(node, tx, scoringSlot)
    ) {
      this.requestMissingPastCone(node, tx, null, scoringSlot);
      return false;
    }
    return !this.hasIgnoredConflictAncestor(node, tx, scoringSlot, conflictPolicy);
  }

  hasCompleteLocalPastCone(node, tx, scoringSlot = this.slot, visited = new Set()) {
    if (!node || !tx) return false;
    if (visited.has(tx.id)) return true;
    visited.add(tx.id);
    if (tx.epoch !== this.epoch || tx.gref !== this.genesis.id) return false;
    if (tx.slot > scoringSlot || tx.status === TxStatus.REJECTED) return false;
    if (!node.known.has(tx.id)) return false;

    for (const parentId of tx.parents || []) {
      const parent = this.txs.get(parentId);
      if (!parent) return false;
      if (!node.known.has(parentId)) return false;
      if (!this.hasCompleteLocalPastCone(node, parent, scoringSlot, visited)) return false;
    }
    return true;
  }

  shouldAvoidRiskyOrdinaryParent(node, tx, scoringSlot = this.slot) {
    if (!this.isOrdinaryTx(tx) || tx.status !== TxStatus.PENDING) return false;
    const local = node.known.get(tx.id);
    if (!local) return true;
    if (local.localStatus === LocalTxStatus.LATE) return true;

    const age = Math.max(0, scoringSlot - tx.slot);
    if (age <= 0) return false;

    const support = this.localSupport(node, tx);
    const floor = this.ordinaryParentSupportFloor(age);
    return support < floor;
  }

  ordinaryParentSupportFloor(age) {
    const threshold = this.config.supportThreshold;
    const lag = Math.max(1, this.config.finalityLagSlots);
    const miss = clamp(this.config.validatorBlockMissChance || 0, 0, 0.35);
    const progress = clamp(age / lag, 0, 1);
    if (age >= lag - 1) return threshold * (0.88 + miss * 0.22);
    if (age <= 1) return 0;
    if (age >= 1) return threshold * (0.16 + progress * 0.34 + miss * 0.14);
    return 0;
  }

  isTooOldForDirectReference(tx, scoringSlot = this.slot, maxAge = this.maxDirectParentAgeSlots()) {
    if (!tx) return false;
    const age = Math.max(0, scoringSlot - tx.slot);
    return age > maxAge;
  }

  maxDirectParentAgeSlots() {
    return Math.max(1, this.config.finalityLagSlots - 2);
  }

  hasIgnoredConflictAncestor(node, tx, scoringSlot, policy, visited = new Set()) {
    if (!tx || policy === "attack") return false;
    for (const parentId of tx.parents) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const parent = this.txs.get(parentId);
      if (!parent) continue;
      if (!node.known.has(parentId)) continue;
      if (
        parent.conflictGroupId &&
        this.shouldIgnoreConflict(node, parent, scoringSlot, policy)
      ) {
        return true;
      }
      if (this.hasIgnoredConflictAncestor(node, parent, scoringSlot, policy, visited)) {
        return true;
      }
    }
    return false;
  }

  compatibleWithSelected(tx, selected, options = {}) {
    if (!tx.input) return true;
    return selected.every((id) => {
      const other = this.txs.get(id);
      if (other?.input !== tx.input) return true;
      return Boolean(options.allowSameInputConflicts && tx.conflictGroupId && other.conflictGroupId);
    });
  }

  tipScore(node, tx, scoringSlot = this.slot) {
    const age = Math.max(0, scoringSlot - tx.slot);
    const expected = age === 0 ? 0.05 : age === 1 ? 0.33 : 0.55;
    const support = this.localSupport(node, tx);
    const ageFit = support >= expected ? 0.18 : -0.08;
    const local = node.known.get(tx.id);
    const latePenalty =
      local?.localStatus === LocalTxStatus.LATE
        ? this.isPromisingOrdinaryTx(node, tx, scoringSlot)
          ? 0.18
          : 1
        : 0;
    const finalizedParentPenalty =
      (tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.CONFLICT_LOST) && age >= 1
        ? Math.min(0.95, 0.34 + age * 0.16)
        : 0;
    const freshPendingOrdinaryBoost =
      this.isOrdinaryTx(tx) && tx.status === TxStatus.PENDING && age <= 1 ? 0.24 : 0;
    return (
      support +
      ageFit +
      this.freshFrontBias(tx, scoringSlot) -
      this.oldFrontPenalty(tx, scoringSlot) +
      freshPendingOrdinaryBoost -
      finalizedParentPenalty +
      this.ordinaryRescueBias(node, tx, scoringSlot) +
      this.conflictTipBias(node, tx, scoringSlot) -
      latePenalty
    );
  }

  freshFrontBias(tx, scoringSlot = this.slot) {
    const age = Math.max(0, scoringSlot - tx.slot);
    if (age <= 0) return 0.42;
    if (age === 1) return 0.24;
    if (age < this.config.finalityLagSlots) return 0.08;
    return 0;
  }

  oldFrontPenalty(tx, scoringSlot = this.slot) {
    const age = Math.max(0, scoringSlot - tx.slot);
    if (age <= this.config.finalityLagSlots) return 0;
    const over = age - this.config.finalityLagSlots;
    const acceptedPenalty =
      tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.CONFLICT_LOST ? 0.18 : 0.1;
    return Math.min(0.85, acceptedPenalty + over * 0.12);
  }

  conflictTipBias(node, tx, scoringSlot = this.slot) {
    if (!tx.conflictGroupId) return 0;
    if (!this.nodeKnowsInputConflict(node, tx, scoringSlot)) return 0;
    if (tx.status === TxStatus.CONFLICT_LOST) return 0.05;
    const support = this.localSupport(node, tx);
    if (support >= 0.08) return 0.12 + support * 0.35;
    if (support > 0) return 0.04 + support * 0.25;
    return scoringSlot === tx.slot ? 0.08 : -0.45;
  }

  ordinaryRescueBias(node, tx, scoringSlot = this.slot) {
    if (!this.isOrdinaryTx(tx) || tx.status !== TxStatus.PENDING) return 0;
    const local = node.known.get(tx.id);
    if (!local || local.localStatus === LocalTxStatus.LATE) return 0;
    const age = Math.max(0, scoringSlot - tx.slot);
    const support = this.localSupport(node, tx);
    if (age >= Math.max(1, this.config.finalityLagSlots - 1) && support < this.config.supportThreshold) {
      return 0.55;
    }
    if (age >= 1 && support < 0.34) return 0.22;
    return 0;
  }

  isPromisingOrdinaryTx(node, tx, scoringSlot = this.slot) {
    if (!this.isOrdinaryTx(tx) || tx.status !== TxStatus.PENDING) return false;
    const age = Math.max(0, scoringSlot - tx.slot);
    if (age < 1) return false;
    return this.localSupport(node, tx) > 0;
  }

  isOrdinaryTx(tx) {
    return Boolean(tx && !tx.attack && !tx.conflictGroupId);
  }

  hasNodeEligibleChild(node, tx, scoringSlot = this.slot) {
    const children = node.children.get(tx.id);
    if (!children) return false;
    for (const childId of children) {
      const child = this.txs.get(childId);
      if (!child || child.slot > scoringSlot || child.status === TxStatus.REJECTED) continue;
      if (!node.known.has(child.id)) continue;

      if (this.isOrdinaryTx(tx) && child.conflictGroupId) {
        if (!this.nodeKnowsInputConflict(node, child, scoringSlot)) return true;
        if (this.isStrongConflictForNode(node, child, scoringSlot)) return true;
        continue;
      }

      if (
        this.canReferenceTx(node, child, scoringSlot, {
          allowLatePromising: true,
          avoidRiskyOrdinary: !node.attack,
          conflictPolicy: node.attack ? "attack" : "ordinary",
        })
      ) {
        return true;
      }
    }
    return false;
  }

  isStrongConflictForNode(node, tx, scoringSlot = this.slot) {
    if (!tx.conflictGroupId) return false;
    if (
      !this.canReferenceTx(node, tx, scoringSlot, {
        allowLatePromising: true,
        conflictPolicy: node.attack ? "attack" : "ordinary",
      })
    ) {
      return false;
    }
    return this.localSupport(node, tx) >= this.strongConflictChildThreshold();
  }

  nodeKnowsInputConflict(node, tx, scoringSlot = this.slot) {
    if (!tx.input) return false;
    for (const txId of node.known.keys()) {
      const other = this.txs.get(txId);
      if (!other || other.id === tx.id) continue;
      if (other.epoch !== tx.epoch || other.gref !== tx.gref) continue;
      if (other.slot > scoringSlot) continue;
      if (other.status === TxStatus.REJECTED) continue;
      if (other.input === tx.input) return true;
    }
    return false;
  }

  shouldIgnoreConflict(node, tx, scoringSlot, policy = "ordinary") {
    if (!tx.conflictGroupId || tx.status !== TxStatus.PENDING) return false;
    if (policy === "attack") return false;
    if (!this.nodeKnowsInputConflict(node, tx, scoringSlot)) return false;

    const txSupport = this.localSupport(node, tx);
    let bestSupport = txSupport;
    let conflictCount = 0;
    for (const txId of node.known.keys()) {
      const other = this.txs.get(txId);
      if (!other || other.id === tx.id) continue;
      if (other.epoch !== tx.epoch || other.gref !== tx.gref) continue;
      if (other.slot > scoringSlot) continue;
      if (other.status === TxStatus.REJECTED) continue;
      if (other.input !== tx.input) continue;
      conflictCount += 1;
      bestSupport = Math.max(bestSupport, this.localSupport(node, other));
    }

    if (
      this.isConflictLikelyConfirmableForNode(node, tx, scoringSlot, policy, {
        bestSupport,
        conflictCount,
        txSupport,
      })
    ) {
      return false;
    }

    if (policy === "validator") {
      if (txSupport === 0 && scoringSlot === tx.slot) return false;
      if (txSupport === 0) return true;
      return bestSupport >= this.config.supportThreshold && txSupport + 0.22 < bestSupport;
    }

    if (txSupport === 0 && scoringSlot === tx.slot) return false;
    if (txSupport === 0) return true;
    if (txSupport < 0.04 && conflictCount > 0) return true;
    return bestSupport >= 0.22 && txSupport + 0.16 < bestSupport;
  }

  isConflictLikelyConfirmableForNode(node, tx, scoringSlot, policy = "ordinary", stats = null) {
    if (!tx.conflictGroupId) return true;
    if (tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.CONFLICT_LOST) return true;
    if (!this.nodeKnowsInputConflict(node, tx, scoringSlot)) return true;

    const txSupport = stats?.txSupport ?? this.localSupport(node, tx);
    const bestSupport = stats?.bestSupport ?? txSupport;
    const conflictCount = stats?.conflictCount ?? 0;
    const losingGap = policy === "validator" ? 0.28 : 0.18;
    if (conflictCount > 0 && bestSupport >= 0.34 && txSupport + losingGap < bestSupport) {
      return false;
    }

    const threshold = this.conflictViableSupportThreshold(tx, scoringSlot);
    if (txSupport >= threshold) return true;
    if (this.isFreshConflictProbe(tx, scoringSlot)) return true;

    const hasOrdinaryDescendant = this.hasKnownOrdinaryDescendant(node, tx, scoringSlot);
    if (policy === "validator") return hasOrdinaryDescendant;
    return hasOrdinaryDescendant && txSupport >= threshold * 0.75;
  }

  conflictViableSupportThreshold(tx, scoringSlot) {
    const age = Math.max(0, scoringSlot - tx.slot);
    const threshold = this.config.supportThreshold;
    if (age <= 0) return threshold * 0.08;
    if (age === 1) return threshold * 0.18;
    if (age < this.config.finalityLagSlots) return threshold * 0.32;
    return threshold * 0.5;
  }

  strongConflictChildThreshold() {
    return 0.18;
  }

  isFreshConflictProbe(tx, scoringSlot = this.slot) {
    if (!tx?.conflictGroupId) return false;
    const age = Math.max(0, scoringSlot - tx.slot);
    return age <= 1;
  }

  compareTips(node, a, b, scoringSlot) {
    const scoreDiff = this.tipScore(node, b, scoringSlot) - this.tipScore(node, a, scoringSlot);
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    const supportDiff = this.localSupport(node, b) - this.localSupport(node, a);
    if (Math.abs(supportDiff) > 0.0001) return supportDiff;
    if (a.conflictGroupId && b.conflictGroupId && a.input === b.input) {
      return a.hash - b.hash;
    }
    return a.hash - b.hash;
  }

  scheduleValidationBlocksForSlot(slot, epoch, slotStart, slotEnd) {
    const duration = slotEnd - slotStart;
    const count = this.config.validatorBlocksPerSlot;
    for (const validator of this.validators) {
      for (let n = 0; n < count; n += 1) {
        const isLast = n === count - 1;
        const base = (n + 1) / (count + 1);
        const jitter = (this.random() - 0.5) * 0.06;
        const at = isLast
          ? slotEnd + this.config.validationDelay
          : slotStart + Math.max(0.02, Math.min(0.96, base + jitter)) * duration;
        heapPush(this.events, {
          at,
          kind: "CREATE_VB",
          slot,
          epoch,
          validatorId: validator.id,
        });
      }
    }
  }

  createValidationBlockNow(slot, validatorId, epoch = this.epoch) {
    if (epoch !== this.epoch) return;
    const validator = this.nodes[validatorId];
    if (!validator || !validator.validator) return;
    if (this.random() < (this.config.validatorBlockMissChance || 0)) {
      this.trace("validation-block-missed", {
        slot: this.localSlotForGlobal(slot),
        globalSlot: slot,
        validatorId: validator.id,
        reason: "network/validator miss",
      });
      return;
    }
    const tips = this.selectTipsForValidator(validator, slot);
    const vb = {
      id: `vb-${String(this.nextVbId).padStart(5, "0")}`,
      slot,
      localSlot: this.localSlotForGlobal(slot),
      approveUntilSlot: slot,
      epoch: this.epoch,
      validatorId: validator.id,
      stake: validator.stake,
      tips,
      covered: [],
      createdAt: this.time,
      seenBy: new Set(),
    };
    this.nextVbId += 1;
    this.applyValidationBlock(vb);
    this.validationBlocks.push(vb);
    this.validationBlockById.set(vb.id, vb);
    this.rememberValidationBlock(validator, vb);
    this.broadcastValidationBlock(validator.id, vb.id, null, true);
    this.trace("validation-block", {
      vb: validationBlockSnapshot(vb, this),
      selection: compactValidatorSelection(this.lastValidatorSelection),
    });
  }

  selectTipsForValidator(validator, approveUntilSlot) {
    const result = selectValidationTips(this, validator, approveUntilSlot);
    this.lastValidatorSelection = result.debug;
    return result.tips;
  }

  validatorOrdinaryCoverageWeight(validator, tx, approveUntilSlot) {
    if (!this.isOrdinaryTx(tx) || tx.status !== TxStatus.PENDING) return 0;
    const age = Math.max(0, approveUntilSlot - tx.slot);
    const support = this.localSupport(validator, tx);

    const missingSupport = Math.max(0, this.config.supportThreshold - support);
    const missingRatio = missingSupport / this.config.supportThreshold;
    const nearFinalityAge = Math.max(1, this.config.finalityLagSlots - 1);
    const supportBudget = Math.max(
      1,
      this.config.validatorCount *
        Math.max(1, this.config.validatorBlocksPerSlot) *
        Math.max(1, this.config.vbTips) *
        Math.max(1, this.config.finalityLagSlots),
    );
    const load = this.config.txPerSlot / supportBudget;
    const miss = clamp(this.config.validatorBlockMissChance || 0, 0, 0.35);
    const pressureScale = 1 + miss * 1.5 + load * 2.5;
    const finalityPressure =
      age >= nearFinalityAge
        ? 3.8 * pressureScale
        : age >= nearFinalityAge - 1
          ? 2.45 * pressureScale
          : age >= 1
            ? 1.25 * pressureScale
            : 0.55;
    const nearMissBoost =
      support > 0 && missingSupport > 0 && missingSupport <= this.largestValidatorStake() * 1.15
        ? 0.75
        : 0;
    const supportNeed =
      support >= this.config.supportThreshold ? 0.08 : 0.48 + missingRatio + nearMissBoost;
    return finalityPressure * supportNeed;
  }

  largestValidatorStake() {
    return this.validators.reduce((max, validator) => Math.max(max, validator.stake || 0), 0);
  }

  knownOrdinaryDescendantStats(node, tx, approveUntilSlot, selectedOrdinaryCoverage = new Set()) {
    const stats = { count: 0, gain: 0 };
    const stack = [...(node.children.get(tx.id) || [])];
    const visited = new Set();
    while (stack.length) {
      const childId = stack.pop();
      if (visited.has(childId)) continue;
      visited.add(childId);
      const child = this.txs.get(childId);
      if (!child || child.slot > approveUntilSlot || child.status === TxStatus.REJECTED) continue;
      if (!node.known.has(child.id)) continue;

      if (this.isOrdinaryTx(child)) {
        stats.count += 1;
        if (
          child.status === TxStatus.PENDING &&
          !this.nodeKnowsValidatorSupport(node, child, node.id) &&
          !selectedOrdinaryCoverage.has(child.id)
        ) {
          stats.gain += this.validatorOrdinaryCoverageWeight(node, child, approveUntilSlot);
        }
      }

      for (const nextId of node.children.get(child.id) || []) stack.push(nextId);
    }
    return stats;
  }

  nodeTieBreak(node, tx) {
    const nodeId = typeof node.id === "number" ? node.id : stableHashNumber(String(node.id));
    return ((tx.hash ^ Math.imul(nodeId + 1, 2654435761)) >>> 0) / 4294967296;
  }

  canValidatorReference(validator, tx, approveUntilSlot) {
    const local = validator.known.get(tx.id);
    if (!local) return false;
    if (tx.slot > approveUntilSlot) return false;
    if (local.localStatus === LocalTxStatus.LATE && tx.status === TxStatus.PENDING) return false;
    return this.canReferenceTx(validator, tx, approveUntilSlot, {
      conflictPolicy: "validator",
      maxDirectAgeSlots: Math.max(1, this.config.finalityLagSlots),
    });
  }

  hasValidatorEligibleChild(validator, tx, approveUntilSlot) {
    const children = validator.children.get(tx.id);
    if (!children) return false;
    for (const childId of children) {
      const child = this.txs.get(childId);
      if (!child || child.slot > approveUntilSlot || child.status === TxStatus.REJECTED) continue;
      if (!validator.known.has(child.id)) continue;

      if (this.isOrdinaryTx(tx) && child.conflictGroupId) {
        if (this.isStrongConflictChild(validator, child, approveUntilSlot)) return true;
        continue;
      }

      if (this.canValidatorReference(validator, child, approveUntilSlot)) return true;
    }
    return false;
  }

  isStrongConflictChild(validator, tx, approveUntilSlot) {
    if (!tx.conflictGroupId) return false;
    if (!this.canValidatorReference(validator, tx, approveUntilSlot)) return false;
    if (!this.canValidatorSupportConflict(validator, tx, approveUntilSlot)) return false;
    return this.localSupport(validator, tx) >= this.strongConflictChildThreshold();
  }

  canValidatorSupportConflict(validator, tx, approveUntilSlot) {
    if (!tx.conflictGroupId) return true;
    if (!validator?.known.has(tx.id)) return false;
    if (tx.slot > approveUntilSlot || tx.status === TxStatus.REJECTED) return false;
    if (this.hasKnownOrdinaryDescendant(validator, tx, approveUntilSlot)) return true;
    if (this.isFreshConflictProbe(tx, approveUntilSlot)) return true;
    return !this.shouldIgnoreConflict(validator, tx, approveUntilSlot, "validator");
  }

  hasKnownOrdinaryDescendant(node, tx, approveUntilSlot, visited = new Set()) {
    const children = node.children.get(tx.id);
    if (!children) return false;
    for (const childId of children) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      const child = this.txs.get(childId);
      if (!child || child.slot > approveUntilSlot || child.status === TxStatus.REJECTED) continue;
      if (!node.known.has(child.id)) continue;
      if (this.isOrdinaryTx(child)) return true;
      if (this.hasKnownOrdinaryDescendant(node, child, approveUntilSlot, visited)) return true;
    }
    return false;
  }

  applyValidationBlock(vb) {
    const covered = new Set();
    const validator = this.nodes[vb.validatorId];
    for (const tipId of vb.tips) {
      collectLocalPastCone(this, validator, tipId, vb.approveUntilSlot, covered);
    }
    vb.covered = [...covered];
    const supported = new Set();
    const supportSummary = {
      coveredOrdinary: 0,
      coveredConflict: 0,
      coveredAttack: 0,
      supportedOrdinary: 0,
      supportedConflict: 0,
      supportedAttack: 0,
      skippedWeakConflicts: [],
    };

    for (const txId of covered) {
      const tx = this.txs.get(txId);
      if (!tx) continue;
      if (this.isOrdinaryTx(tx)) supportSummary.coveredOrdinary += 1;
      if (tx.conflictGroupId) supportSummary.coveredConflict += 1;
      if (tx.attack) supportSummary.coveredAttack += 1;
      if (tx.status !== TxStatus.PENDING) continue;
      if (tx.conflictGroupId && !this.canValidatorSupportConflict(validator, tx, vb.approveUntilSlot)) {
        if (supportSummary.skippedWeakConflicts.length < 30) {
          supportSummary.skippedWeakConflicts.push(tipDebug(tx, this, validator, vb.approveUntilSlot));
        }
        continue;
      }
      tx.vbCoveredBy.add(vb.id);
      if (!tx.supportValidators.has(vb.validatorId)) {
        tx.supportValidators.add(vb.validatorId);
        tx.support = clamp(tx.support + vb.stake, 0, 1);
        supported.add(tx.id);
        if (this.isOrdinaryTx(tx)) supportSummary.supportedOrdinary += 1;
        if (tx.conflictGroupId) supportSummary.supportedConflict += 1;
        if (tx.attack) supportSummary.supportedAttack += 1;
      }
    }
    vb.supported = [...supported];
    vb.supportSummary = supportSummary;
  }

  finalizeMatureSlot() {
    this.lastFinalized = emptyFinalizedStats(this.epoch, this.localSlotForGlobal(this.slot), this.slot);
    const targetSlot = this.slot - this.config.finalityLagSlots;
    if (targetSlot < 0 || this.finalizedSlots.has(targetSlot)) return;

    const txs = [...this.txs.values()].filter(
      (tx) => tx.slot === targetSlot && tx.epoch === this.epoch,
    );
    const targetSample = txs[0] || null;
    this.lastFinalized.targetEpoch = targetSample?.epoch ?? this.epoch;
    this.lastFinalized.targetLocalSlot =
      targetSample?.localSlot ?? this.localSlotForGlobal(targetSlot);
    this.lastFinalized.targetGlobalSlot = targetSlot;

    if (!txs.length) {
      this.finalizedSlots.add(targetSlot);
      this.trace("finalize-slot", {
        ...this.lastFinalized,
        empty: true,
        reasonCounts: {},
        txs: [],
      });
      return;
    }

    const candidates = new Set(
      txs
        .filter((tx) => tx.support >= this.config.supportThreshold)
        .map((tx) => tx.id),
    );

    const ordered = txs
      .filter((tx) => candidates.has(tx.id))
      .sort((a, b) => b.support - a.support || a.hash - b.hash);

    for (const tx of txs) {
      if (!candidates.has(tx.id)) {
        tx.status = TxStatus.REJECTED;
        tx.rejectReason = "support < 2/3 in its finalization window";
        if (tx.input) this.releaseInputReservation(tx.input);
      }
    }

    for (const tx of ordered) {
      if (!this.parentsAreAcceptedObjects(tx, candidates)) {
        tx.status = TxStatus.REJECTED;
        tx.rejectReason = "parent is not accepted DAG object";
        if (tx.input) this.releaseInputReservation(tx.input);
        continue;
      }

      if (!tx.input || !this.inputCanExist(tx.input)) {
        tx.status = TxStatus.REJECTED;
        tx.rejectReason = "input is missing or comes from rejected output";
        if (tx.input) this.releaseInputReservation(tx.input);
        continue;
      }

      if (this.utxos.has(tx.input)) {
        this.utxos.delete(tx.input);
        this.utxos.add(tx.output);
        this.allCreatedUtxos.add(tx.output);
        tx.status = TxStatus.ACCEPTED;
        this.reservedInputs.delete(tx.input);
      } else {
        const conflictAware = Boolean(tx.conflictGroupId || this.config.enableConflictAttack);
        tx.status = conflictAware ? TxStatus.CONFLICT_LOST : TxStatus.REJECTED;
        tx.rejectReason = conflictAware
          ? "accepted DAG object, but lost UTXO conflict"
          : "input already spent";
        this.reservedInputs.delete(tx.input);
      }
    }

    this.finalizedSlots.add(targetSlot);
    this.lastFinalized.finalizedTotal = txs.length;
    this.lastFinalized.finalizedAccepted = txs.filter(
      (tx) => tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.CONFLICT_LOST,
    ).length;
    this.lastFinalized.finalizedRejected = txs.filter(
      (tx) => tx.status === TxStatus.REJECTED,
    ).length;
    this.lastFinalized.acceptedPct =
      this.lastFinalized.finalizedTotal > 0
        ? (this.lastFinalized.finalizedAccepted / this.lastFinalized.finalizedTotal) * 100
        : 0;

    const ordinaryTxs = txs.filter((tx) => !tx.attack && !tx.conflictGroupId);
    this.lastFinalized.ordinaryFinalizedTotal = ordinaryTxs.length;
    this.lastFinalized.ordinaryFinalizedAccepted = ordinaryTxs.filter(
      (tx) => tx.status === TxStatus.ACCEPTED,
    ).length;
    this.lastFinalized.ordinaryFinalizedRejected = ordinaryTxs.filter(
      (tx) => tx.status === TxStatus.REJECTED,
    ).length;
    this.lastFinalized.ordinaryAcceptedPct =
      this.lastFinalized.ordinaryFinalizedTotal > 0
        ? (this.lastFinalized.ordinaryFinalizedAccepted /
            this.lastFinalized.ordinaryFinalizedTotal) *
          100
        : 0;

    const conflictTxs = txs.filter((tx) => tx.conflictGroupId);
    this.lastFinalized.conflictFinalizedTotal = conflictTxs.length;
    this.lastFinalized.conflictFinalizedAccepted = conflictTxs.filter(
      (tx) => tx.status === TxStatus.ACCEPTED || tx.status === TxStatus.CONFLICT_LOST,
    ).length;
    this.lastFinalized.conflictFinalizedRejected = conflictTxs.filter(
      (tx) => tx.status === TxStatus.REJECTED,
    ).length;
    this.lastFinalized.conflictAcceptedPct =
      this.lastFinalized.conflictFinalizedTotal > 0
        ? (this.lastFinalized.conflictFinalizedAccepted /
            this.lastFinalized.conflictFinalizedTotal) *
          100
        : 0;
    const diagnostics = this.finalizationDiagnostics(txs);

    this.trace("finalize-slot", {
      ...this.lastFinalized,
      empty: false,
      reasonCounts: rejectReasonCounts(txs),
      diagnostics,
      txs: txs.map((tx) => finalizationTxSnapshot(tx, this)),
    });

    for (const node of this.nodes) {
      for (const tx of txs) {
        const local = node.known.get(tx.id);
        if (local) local.localStatus = LocalTxStatus.FINALIZED;
      }
    }
  }

  finalizationDiagnostics(txs) {
    const threshold = this.config.supportThreshold;
    const maxStake = this.largestValidatorStake();
    const rejectedOrdinary = txs.filter((tx) => this.isOrdinaryTx(tx) && tx.status === TxStatus.REJECTED);
    const nearMissOrdinary = rejectedOrdinary.filter(
      (tx) =>
        tx.rejectReason === "support < 2/3 in its finalization window" &&
        tx.support >= threshold - maxStake * 1.25,
    );
    const cascadeOrdinary = rejectedOrdinary.filter(
      (tx) => tx.rejectReason === "parent is not accepted DAG object",
    );

    return {
      ordinaryRejected: rejectedOrdinary.length,
      nearMissOrdinary: nearMissOrdinary.length,
      cascadeOrdinary: cascadeOrdinary.length,
      nearMissSamples: nearMissOrdinary.slice(0, 10).map((tx) => this.finalizationDiagnosticTx(tx)),
      cascadeSamples: cascadeOrdinary.slice(0, 10).map((tx) => this.finalizationDiagnosticTx(tx)),
    };
  }

  finalizationDiagnosticTx(tx) {
    const threshold = this.config.supportThreshold;
    return {
      id: tx.id,
      slot: tx.localSlot,
      globalSlot: tx.slot,
      status: tx.status,
      reason: tx.rejectReason,
      support: round(tx.support, 6),
      missingSupport: round(Math.max(0, threshold - tx.support), 6),
      supportValidators: [...tx.supportValidators],
      seen: tx.seenBy.size,
      late: tx.lateBy.size,
      parents: tx.parents.map((parentId) => {
        const parent = this.txs.get(parentId);
        return parent
          ? {
              id: parent.id,
              slot: parent.localSlot,
              globalSlot: parent.slot,
              status: parent.status,
              support: round(parent.support, 6),
              missingSupport: round(Math.max(0, threshold - parent.support), 6),
              reason: parent.rejectReason,
            }
          : { id: parentId, missing: true };
      }),
      missingValidators: this.validators
        .filter((validator) => !tx.supportValidators.has(validator.id))
        .map((validator) => {
          const local = validator.known.get(tx.id);
          const deadline = (tx.slot + 1) * this.config.slotDuration + this.config.validationDelay;
          return {
            id: validator.id,
            stake: round(validator.stake, 6),
            known: Boolean(local),
            localStatus: local?.localStatus ?? LocalTxStatus.UNKNOWN,
            receivedAt: local ? round(local.receivedAt) : null,
            beforeDeadline: local ? local.receivedAt <= deadline + this.config.lateGrace : false,
          };
        })
        .slice(0, 12),
    };
  }

  parentsAreAcceptedObjects(tx, currentCandidates) {
    for (const parentId of tx.parents) {
      const parent = this.txs.get(parentId);
      if (!parent) return false;
      const acceptedNow = currentCandidates.has(parentId);
      const alreadyOk =
        parent.status === TxStatus.ACCEPTED || parent.status === TxStatus.CONFLICT_LOST;
      if (!acceptedNow && !alreadyOk) return false;
    }
    return true;
  }

  inputCanExist(inputId) {
    return this.allCreatedUtxos.has(inputId);
  }

  tryRotateEpoch() {
    if (!this.waitingEpochEnd) return;
    if (this.epochEndSlot === null || !this.finalizedSlots.has(this.epochEndSlot)) return;

    const previous = {
      epoch: this.epoch,
      genesis: this.genesis.id,
      epochEndSlot: this.epochEndSlot,
      epochEndLocalSlot: this.localSlotForGlobal(this.epochEndSlot),
      utxos: this.utxos.size,
      txs: this.txs.size,
    };
    const stateCommit = commitUtxos(this.utxos);
    this.rotations += 1;
    this.epoch += 1;
    this.epochSlot = 0;
    this.epochStartSlot = this.slot + 1;
    this.epochEndSlot = null;
    this.waitingEpochEnd = false;
    this.genesis = {
      id: `G${this.epoch}`,
      epoch: this.epoch,
      prev: this.genesis.id,
      stateCommit,
      utxos: new Set(this.utxos),
    };
    this.finalizedSlots.clear();
    this.reservedInputs.clear();

    for (const node of this.nodes) {
      node.known.clear();
      node.children.clear();
      node.knownVbs.clear();
      node.localSupportValidators.clear();
    }
    for (const node of this.attackNodes) {
      node.known.clear();
      node.children.clear();
      node.knownVbs.clear();
      node.localSupportValidators.clear();
    }

    this.trace("epoch-rotate", {
      previous,
      next: {
        epoch: this.epoch,
        genesis: this.genesis.id,
        stateCommit,
        epochStartSlot: this.epochStartSlot,
        utxos: this.utxos.size,
      },
    });
  }

  metrics() {
    const txs = [...this.txs.values()];
    const total = txs.length || 1;
    const count = (status) => txs.filter((tx) => tx.status === status).length;
    const acceptedStrict = count(TxStatus.ACCEPTED);
    const conflictLost = count(TxStatus.CONFLICT_LOST);
    const acceptedDag = acceptedStrict + conflictLost;
    const rejected = count(TxStatus.REJECTED);
    const pending = count(TxStatus.PENDING);
    const lateObservations = txs.reduce((sum, tx) => sum + tx.lateBy.size, 0);
    const attackLoss = this.attackOrdinaryLossMetrics();
    return {
      globalSlot: this.slot,
      slot: this.localSlotForGlobal(this.slot),
      epoch: this.epoch,
      genesis: this.genesis.id,
      lastFinalized: this.lastFinalized,
      totalTx: txs.length,
      accepted: acceptedDag,
      acceptedStrict,
      rejected,
      pending,
      conflictLost,
      acceptedPct: acceptedDag / total,
      rejectedPct: rejected / total,
      pendingPct: pending / total,
      conflictLostPct: conflictLost / total,
      attackConflicts: txs.filter((tx) => tx.conflictGroupId).length,
      activeConflictCampaigns: activeConflictCampaigns(this).length,
      attackNodes: this.attackNodes.length,
      attackOrdinaryTotal: attackLoss.total,
      attackOrdinaryDecided: attackLoss.decided,
      attackOrdinaryRejected: attackLoss.rejected,
      attackOrdinaryPending: attackLoss.pending,
      attackOrdinaryLostPct: attackLoss.lostPct,
      lateObservations,
      validationBlocks: this.validationBlocks.length,
      rotations: this.rotations,
      waitingEpochEnd: this.waitingEpochEnd,
    };
  }

  attackOrdinaryLossMetrics() {
    const campaigns = this.attackCampaigns.filter((campaign) =>
      String(campaign.type).includes("CONFLICT_SPAM"),
    );
    if (!campaigns.length) {
      return { total: 0, decided: 0, rejected: 0, pending: 0, lostPct: null };
    }

    const txIds = new Set();
    for (const campaign of campaigns) {
      for (const tx of this.txs.values()) {
        if (tx.attack || tx.conflictGroupId) continue;
        if (tx.epoch !== campaign.epoch || tx.gref !== campaign.gref) continue;
        if (tx.slot < campaign.startSlot || tx.slot > campaign.endSlot) continue;
        txIds.add(tx.id);
      }
    }

    let rejected = 0;
    let pending = 0;
    let decided = 0;
    for (const txId of txIds) {
      const tx = this.txs.get(txId);
      if (!tx) continue;
      if (tx.status === TxStatus.PENDING) {
        pending += 1;
        continue;
      }
      decided += 1;
      if (tx.status === TxStatus.REJECTED) rejected += 1;
    }

    return {
      total: txIds.size,
      decided,
      rejected,
      pending,
      lostPct: decided > 0 ? rejected / decided : null,
    };
  }

  visibleTransactions(viewNodeId = "aggregate", epochMode = "current") {
    const txs = [...this.txs.values()];
    const visible =
      viewNodeId === "aggregate"
        ? txs
        : txs.filter((tx) => this.nodes[Number(viewNodeId)]?.known.has(tx.id));
    const scoped =
      epochMode === "current"
        ? visible.filter((tx) => tx.epoch === this.epoch && tx.gref === this.genesis.id)
        : visible;
    return scoped.slice(-this.config.maxDrawTx);
  }

  selectedTx() {
    return this.selectedTxId ? this.txs.get(this.selectedTxId) : null;
  }

  recentValidationBlocks(limit = 8) {
    return this.validationBlocks.slice(-limit).reverse();
  }

  visibleValidationBlocks(viewNodeId = "aggregate", epochMode = "current") {
    const blocks =
      viewNodeId === "aggregate"
        ? this.validationBlocks
        : this.validationBlocks.filter((vb) => vb.validatorId === Number(viewNodeId));
    const scoped = epochMode === "current" ? blocks.filter((vb) => vb.epoch === this.epoch) : blocks;
    return scoped.slice(-this.config.maxDrawVb);
  }

  ledgerMemoryEstimateBytes() {
    let knownEntries = 0;
    let childLinks = 0;
    let localValidatorVotes = 0;
    for (const node of this.nodes) {
      for (const txId of node.known.keys()) {
        if (this.txCountsInLedgerMemory(txId)) knownEntries += 1;
      }
      for (const [txId, validators] of node.localSupportValidators.entries()) {
        if (this.txCountsInLedgerMemory(txId)) localValidatorVotes += validators.size;
      }
      for (const [parentId, children] of node.children.entries()) {
        if (!this.txCountsInLedgerMemory(parentId)) continue;
        for (const childId of children) {
          if (this.txCountsInLedgerMemory(childId)) childLinks += 1;
        }
      }
    }

    let parentLinks = 0;
    let vbCoverRefs = 0;
    let conflictMetadata = 0;
    for (const tx of this.txs.values()) {
      if (!this.txCountsInLedgerMemory(tx.id)) continue;
      parentLinks += tx.parents.length;
      vbCoverRefs += tx.vbCoveredBy.size;
      if (tx.conflictGroupId) conflictMetadata += 1;
    }

    const vbLinks = this.validationBlocks.reduce(
      (sum, vb) =>
        sum +
        vb.tips.filter((txId) => this.txCountsInLedgerMemory(txId)).length +
        vb.covered.filter((txId) => this.txCountsInLedgerMemory(txId)).length,
      0,
    );
    const retainedTxCount = [...this.txs.keys()].filter((txId) =>
      this.txCountsInLedgerMemory(txId),
    ).length;

    return (
      retainedTxCount * 440 +
      parentLinks * 32 +
      localValidatorVotes * 20 +
      vbCoverRefs * 20 +
      conflictMetadata * 48 +
      knownEntries * 64 +
      childLinks * 28 +
      this.validationBlocks.length * 280 +
      vbLinks * 16 +
      this.utxos.size * 56 +
      this.allCreatedUtxos.size * 32 +
      this.reservedInputs.size * 32
    );
  }

  memoryEstimateBytes() {
    return this.ledgerMemoryEstimateBytes();
  }

  nodeLedgerMemoryStats(nodeId, includePreviousEpochs = false) {
    const node = this.nodes.find((item) => item.id === nodeId);
    if (!node) {
      return {
        bytes: 0,
        retainedTx: 0,
        pendingTx: 0,
        acceptedTx: 0,
        rejectedTx: 0,
        knownVbs: 0,
      };
    }

    const wasSeen = (tx) =>
      includePreviousEpochs ? tx.seenBy.has(node.id) : node.known.has(tx.id);
    const observed = [...this.txs.values()].filter(wasSeen);
    const retained = observed.filter((tx) => tx.status !== TxStatus.REJECTED);
    const retainedIds = new Set(retained.map((tx) => tx.id));
    const knownVbs = includePreviousEpochs
      ? this.validationBlocks.filter((vb) => vb.seenBy?.has(node.id))
      : [...node.knownVbs]
          .map((vbId) => this.validationBlockById.get(vbId))
          .filter(Boolean);

    let parentLinks = 0;
    let conflictMetadata = 0;
    for (const tx of retained) {
      parentLinks += tx.parents.filter((parentId) => retainedIds.has(parentId)).length;
      if (tx.conflictGroupId) conflictMetadata += 1;
    }

    let localValidatorVotes = 0;
    if (includePreviousEpochs) {
      for (const vb of knownVbs) {
        localValidatorVotes += (vb.supported || []).filter((txId) =>
          retainedIds.has(txId),
        ).length;
      }
    } else {
      for (const [txId, validators] of node.localSupportValidators.entries()) {
        if (retainedIds.has(txId)) localValidatorVotes += validators.size;
      }
    }

    let childLinks = 0;
    if (includePreviousEpochs) {
      for (const tx of retained) {
        childLinks += tx.parents.filter((parentId) => retainedIds.has(parentId)).length;
      }
    } else {
      for (const [parentId, children] of node.children.entries()) {
        if (!retainedIds.has(parentId)) continue;
        for (const childId of children) {
          if (retainedIds.has(childId)) childLinks += 1;
        }
      }
    }

    let vbLinks = 0;
    for (const vb of knownVbs) {
      vbLinks += (vb.tips || []).filter((txId) => retainedIds.has(txId)).length;
      vbLinks += (vb.covered || []).filter((txId) => retainedIds.has(txId)).length;
    }

    const bytes =
      retained.length * 440 +
      retained.length * 64 +
      parentLinks * 32 +
      localValidatorVotes * 20 +
      conflictMetadata * 48 +
      childLinks * 28 +
      knownVbs.length * 280 +
      vbLinks * 16 +
      this.genesisMemoryEstimateBytes(includePreviousEpochs);

    return {
      bytes,
      retainedTx: retained.length,
      pendingTx: observed.filter((tx) => tx.status === TxStatus.PENDING).length,
      acceptedTx: observed.filter((tx) => tx.status === TxStatus.ACCEPTED).length,
      rejectedTx: observed.filter(
        (tx) => tx.status === TxStatus.REJECTED || tx.status === TxStatus.CONFLICT_LOST,
      ).length,
      knownVbs: knownVbs.length,
    };
  }

  genesisMemoryEstimateBytes(withoutRotation = false) {
    const genesisHeaders = withoutRotation ? 1 : this.rotations + 1;
    return (
      genesisHeaders * GENESIS_HEADER_BYTES +
      this.config.nodeCount * GENESIS_ACCOUNT_BYTES
    );
  }

  txCountsInLedgerMemory(txId) {
    const tx = this.txs.get(txId);
    return Boolean(tx && tx.status !== TxStatus.REJECTED);
  }

  releaseInputReservation(input) {
    const attackUsesInput = this.attackCampaigns.some((campaign) => {
      if (!campaign.active) return false;
      if (campaign.input === input) return true;
      for (const group of campaign.slotGroups?.values?.() || []) {
        if (group.input === input) return true;
      }
      return false;
    });
    if (!attackUsesInput) this.reservedInputs.delete(input);
  }

  nodeById(id) {
    if (typeof id === "number") return this.nodes[id];
    if (typeof id === "string" && id.startsWith("atk-")) {
      return this.attackNodes.find((node) => node.id === id);
    }
    const numeric = Number(id);
    return Number.isInteger(numeric) ? this.nodes[numeric] : null;
  }

  syncAttackNodeView(attackNode) {
    if (!attackNode?.attack) return;
    for (const peerId of attackNode.peers) {
      const peer = this.nodes[peerId];
      if (!peer) continue;
      for (const [txId, local] of peer.known.entries()) {
        if (attackNode.known.has(txId)) continue;
        attackNode.known.set(txId, {
          receivedAt: local.receivedAt,
          localStatus: local.localStatus,
        });
      }
      for (const vbId of peer.knownVbs || []) {
        attackNode.knownVbs.add(vbId);
      }
    }

    attackNode.children.clear();
    for (const txId of attackNode.known.keys()) {
      const tx = this.txs.get(txId);
      if (!tx) continue;
      for (const parentId of tx.parents) {
        if (!attackNode.children.has(parentId)) attackNode.children.set(parentId, new Set());
        attackNode.children.get(parentId).add(txId);
      }
      this.refreshLocalSupportForTx(attackNode, txId);
    }
  }

  syncNodeViewFromPeers(node, peerLimit = 4) {
    if (!node || node.attack) return;
    for (const peerId of node.peers.slice(0, peerLimit)) {
      const peer = this.nodes[peerId];
      if (!peer) continue;
      for (const [txId, local] of peer.known.entries()) {
        if (node.known.has(txId)) continue;
        node.known.set(txId, {
          receivedAt: Math.max(local.receivedAt, this.time),
          localStatus: local.localStatus,
        });
      }
      for (const vbId of peer.knownVbs || []) {
        node.knownVbs.add(vbId);
      }
    }

    node.children.clear();
    for (const txId of node.known.keys()) {
      const tx = this.txs.get(txId);
      if (!tx) continue;
      for (const parentId of tx.parents) {
        if (!node.children.has(parentId)) node.children.set(parentId, new Set());
        node.children.get(parentId).add(txId);
      }
      this.refreshLocalSupportForTx(node, txId);
    }
  }
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].at <= item.at) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = item;
}

function heapPop(heap) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let i = 0;
    while (true) {
      let child = i * 2 + 1;
      if (child >= heap.length) break;
      const right = child + 1;
      if (right < heap.length && heap[right].at < heap[child].at) child = right;
      if (heap[child].at >= last.at) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
  }
  return first;
}

function compactMetrics(metrics) {
  return {
    epoch: metrics.epoch,
    slot: metrics.slot,
    globalSlot: metrics.globalSlot,
    genesis: metrics.genesis,
    totalTx: metrics.totalTx,
    accepted: metrics.accepted,
    rejected: metrics.rejected,
    pending: metrics.pending,
    conflictLost: metrics.conflictLost,
    attackConflicts: metrics.attackConflicts,
    activeConflictCampaigns: metrics.activeConflictCampaigns,
    attackOrdinaryTotal: metrics.attackOrdinaryTotal,
    attackOrdinaryDecided: metrics.attackOrdinaryDecided,
    attackOrdinaryRejected: metrics.attackOrdinaryRejected,
    attackOrdinaryPending: metrics.attackOrdinaryPending,
    attackOrdinaryLostPct:
      metrics.attackOrdinaryLostPct === null ? null : round(metrics.attackOrdinaryLostPct, 6),
    lateObservations: metrics.lateObservations,
    validationBlocks: metrics.validationBlocks,
    rotations: metrics.rotations,
    waitingEpochEnd: metrics.waitingEpochEnd,
    lastFinalized: metrics.lastFinalized,
  };
}

function nodeSnapshot(node) {
  return {
    id: node.id,
    city: node.city,
    validator: Boolean(node.validator),
    attack: Boolean(node.attack),
    stake: round(node.stake, 6),
    peers: node.peers.length,
    known: node.known.size,
    knownVbs: node.knownVbs?.size || 0,
  };
}

function txSnapshot(tx, sim) {
  return {
    id: tx.id,
    kind: txKind(tx),
    epoch: tx.epoch,
    slot: tx.localSlot,
    globalSlot: tx.slot,
    gref: tx.gref,
    status: tx.status,
    support: round(tx.support, 6),
    supportValidators: [...tx.supportValidators],
    supportValidatorCount: tx.supportValidators.size,
    seen: tx.seenBy.size,
    seenPct: round(tx.seenBy.size / Math.max(1, sim.nodes.length), 6),
    late: tx.lateBy.size,
    vbCoveredByCount: tx.vbCoveredBy.size,
    creatorId: tx.creatorId,
    input: tx.input,
    output: tx.output,
    parents: tx.parents,
    conflictGroupId: tx.conflictGroupId,
    attack: tx.attack,
    rejectReason: tx.rejectReason,
    createdAt: round(tx.createdAt),
  };
}

function tipDebug(tx, sim, scoringNode = null, scoringSlot = sim.slot) {
  const node = scoringNode || sim.nodeById(tx.creatorId) || sim.validators[0];
  return {
    id: tx.id,
    kind: txKind(tx),
    slot: tx.localSlot,
    globalSlot: tx.slot,
    status: tx.status,
    support: round(tx.support, 6),
    localSupport: node ? round(sim.localSupport(node, tx), 6) : null,
    seen: tx.seenBy.size,
    late: tx.lateBy.size,
    input: tx.input,
    conflictGroupId: tx.conflictGroupId,
    parents: tx.parents,
    score: node ? round(sim.tipScore(node, tx, scoringSlot), 6) : null,
  };
}

function validationBlockSnapshot(vb, sim) {
  const validator = sim.nodeById(vb.validatorId);
  return {
    id: vb.id,
    epoch: vb.epoch,
    slot: vb.localSlot,
    globalSlot: vb.slot,
    approveUntilSlot: sim.localSlotForGlobal(vb.approveUntilSlot),
    approveUntilGlobalSlot: vb.approveUntilSlot,
    validatorId: vb.validatorId,
    stake: round(vb.stake, 6),
    createdAt: round(vb.createdAt),
    tips: vb.tips.map((id) => {
      const tx = sim.txs.get(id);
      return tx ? tipDebug(tx, sim, validator, vb.approveUntilSlot) : { id, missing: true };
    }),
    covered: vb.covered.length,
    supported: vb.supported?.length || 0,
    supportSummary: vb.supportSummary,
  };
}

function compactValidatorSelection(selection) {
  if (!selection) return null;
  return {
    validatorId: selection.validatorId,
    approveUntilSlot: selection.approveUntilSlot,
    approveUntilLocalSlot: selection.approveUntilLocalSlot,
    candidates: selection.candidates,
    ordinaryCandidates: selection.ordinaryCandidates,
    conflictCandidates: selection.conflictCandidates,
    rescueCandidates: selection.rescueCandidates,
    bridgeCandidates: selection.bridgeCandidates,
    strategy: selection.strategy,
    selectedOrdinary: selection.selectedOrdinary,
    selectedConflict: selection.selectedConflict,
    selected: selection.selected,
    selectedEvaluations: (selection.selectedEvaluations || []).map((item) => ({
      tx: item.tx,
      kinds: item.kinds,
      score: item.score,
      usefulOrdinaryGain: item.usefulOrdinaryGain,
      rescueGain: item.rescueGain,
      bridgeConflictGain: item.bridgeConflictGain,
      conflictPenalty: item.conflictPenalty,
      duplicatePenalty: item.duplicatePenalty,
      newOrdinaryCoverage: item.newOrdinaryCoverage,
      coneOrdinary: item.coneOrdinary,
      coneConflict: item.coneConflict,
    })),
    topCandidates: (selection.topCandidates || []).slice(0, 4).map((item) => ({
      id: item.id,
      kind: item.kind,
      slot: item.slot,
      globalSlot: item.globalSlot,
      status: item.status,
      support: item.support,
      localSupport: item.localSupport,
      conflictGroupId: item.conflictGroupId,
      kinds: item.kinds,
      coverageScore: item.coverageScore,
      usefulOrdinaryGain: item.usefulOrdinaryGain,
      rescueGain: item.rescueGain,
      bridgeConflictGain: item.bridgeConflictGain,
      conflictPenalty: item.conflictPenalty,
      duplicatePenalty: item.duplicatePenalty,
      newOrdinaryCoverage: item.newOrdinaryCoverage,
      coneOrdinary: item.coneOrdinary,
      coneConflict: item.coneConflict,
    })),
  };
}

function rejectReasonCounts(txs) {
  const counts = {};
  for (const tx of txs) {
    if (tx.status !== TxStatus.REJECTED) continue;
    const reason = tx.rejectReason || "unknown";
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function finalizationTxSnapshot(tx, sim) {
  return {
    ...txSnapshot(tx, sim),
    parents: tx.parents.map((parentId) => {
      const parent = sim.txs.get(parentId);
      return parent
        ? {
            id: parent.id,
            kind: txKind(parent),
            status: parent.status,
            support: round(parent.support, 6),
            slot: parent.localSlot,
            globalSlot: parent.slot,
            seen: parent.seenBy.size,
            rejectReason: parent.rejectReason,
          }
        : { id: parentId, missing: true };
    }),
    directChildren: directChildren(tx, sim),
  };
}

function directChildren(tx, sim) {
  const children = [];
  for (const child of sim.txs.values()) {
    if (!child.parents.includes(tx.id)) continue;
    children.push({
      id: child.id,
      kind: txKind(child),
      status: child.status,
      support: round(child.support, 6),
      slot: child.localSlot,
      globalSlot: child.slot,
      conflictGroupId: child.conflictGroupId,
    });
    if (children.length >= 30) break;
  }
  return children;
}

function campaignSnapshot(campaign, sim) {
  return {
    id: campaign.id,
    type: campaign.type,
    input: campaign.input,
    perSlot: campaign.perSlot,
    epoch: campaign.epoch,
    startSlot: sim.localSlotForGlobal(campaign.startSlot),
    endSlot: sim.localSlotForGlobal(campaign.endSlot),
    globalStartSlot: campaign.startSlot,
    globalEndSlot: campaign.endSlot,
    sourceMode: campaign.sourceMode,
    created: campaign.created,
    active: campaign.active,
  };
}

function txKind(tx) {
  if (tx.attack) return "attack-conflict";
  if (tx.conflictGroupId) return "conflict";
  return "ordinary";
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function emptyFinalizedStats(processedEpoch, processedLocalSlot, processedGlobalSlot) {
  return {
    processedEpoch,
    processedLocalSlot,
    processedGlobalSlot,
    targetEpoch: null,
    targetLocalSlot: null,
    targetGlobalSlot: null,
    finalizedTotal: 0,
    finalizedAccepted: 0,
    finalizedRejected: 0,
    acceptedPct: 0,
    ordinaryFinalizedTotal: 0,
    ordinaryFinalizedAccepted: 0,
    ordinaryFinalizedRejected: 0,
    ordinaryAcceptedPct: 0,
    conflictFinalizedTotal: 0,
    conflictFinalizedAccepted: 0,
    conflictFinalizedRejected: 0,
    conflictAcceptedPct: 0,
  };
}
