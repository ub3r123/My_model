import { TxStatus } from "./status.js";
import { stableHashNumber } from "./utils.js";

const INITIAL_UTXO_COUNT = 5000;

export function makeGenesis() {
  const utxos = new Set();
  for (let i = 0; i < INITIAL_UTXO_COUNT; i += 1) utxos.add(`u0-${i}`);
  return {
    id: "G0",
    epoch: 0,
    prev: null,
    stateCommit: commitUtxos(utxos),
    utxos,
  };
}

export function makeTransaction(sim, creatorId, parents, options = {}) {
  const id = `tx-${String(sim.nextTxId).padStart(5, "0")}`;
  sim.nextTxId += 1;

  const input = options.input ?? chooseInput(sim);
  if (input && options.reserveInput !== false) sim.reservedInputs.add(input);
  const output = `u${sim.epoch}-${id}`;

  return {
    id,
    hash: stableHashNumber(id),
    creatorId,
    epoch: sim.epoch,
    slot: sim.slot,
    localSlot: sim.epochSlot,
    gref: sim.genesis.id,
    parents,
    input,
    output,
    createdAt: sim.time,
    status: TxStatus.PENDING,
    support: 0,
    supportValidators: new Set(),
    seenBy: new Set(),
    lateBy: new Set(),
    vbCoveredBy: new Set(),
    rejectReason: "",
    attack: options.attack ?? null,
    conflictGroupId: options.conflictGroupId ?? null,
  };
}

export function commitUtxos(utxos) {
  const sorted = [...utxos].sort();
  let h = 2166136261;
  for (const id of sorted) {
    h ^= stableHashNumber(id);
    h = Math.imul(h, 16777619);
  }
  return `root-${(h >>> 0).toString(16)}`;
}

function chooseInput(sim) {
  const source = [...sim.utxos].filter((id) => !sim.reservedInputs.has(id));
  if (!source.length) return null;
  return source[Math.floor(sim.random() * source.length)];
}
