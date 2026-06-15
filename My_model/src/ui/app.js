import { Simulator } from "../sim/simulator.js";
import {
  startConflictSpamAttack,
  startMultiConflictSpamAttack,
  startWaveConflictSpamAttack,
} from "../sim/attacks/conflictAttack.js";
import { pct, shortId } from "../sim/utils.js";
import { saveChartImages } from "./chartImages.js";
import { formatTx, GraphView } from "./graphView.js";
import { MeasurementRecorder } from "./measurements.js";
import { SimulationLogger } from "./simLogger.js";

let sim = null;
let graph = null;
const recorder = new MeasurementRecorder();
const simLogger = new SimulationLogger();
let timer = null;
let currentView = "aggregate";
let epochMode = "current";

const els = {};

const PARAMETER_PRESETS = {
  low: {
    label: "Low: 2 tx / 4s = 0.5 tx/s, single conflict spam",
    attackMode: "single",
    values: {
      nodeCount: 100,
      validatorCount: 16,
      txPerSlot: 2,
      slotDuration: 4,
      validationDelay: 1.2,
      finalityLag: 3,
      slotsPerEpoch: 24,
      vbPerSlot: 1,
      conflictCount: 1,
      maxDrawTx: 100,
      maxDrawVb: 20,
    },
  },
  medium: {
    label: "Medium: 8 tx / 4s = 2 tx/s, 9 conflict tx/slot",
    attackMode: "waves",
    values: {
      nodeCount: 100,
      validatorCount: 16,
      txPerSlot: 8,
      slotDuration: 4,
      validationDelay: 1.2,
      finalityLag: 3,
      slotsPerEpoch: 24,
      vbPerSlot: 2,
      conflictCount: 3,
      maxDrawTx: 140,
      maxDrawVb: 30,
    },
  },
  high: {
    label: "High: 20 tx / 4s = 5 tx/s, 6 conflict tx/slot",
    attackMode: "waves",
    values: {
      nodeCount: 100,
      validatorCount: 16,
      txPerSlot: 20,
      slotDuration: 4,
      validationDelay: 1.2,
      finalityLag: 5,
      slotsPerEpoch: 24,
      vbPerSlot: 3,
      conflictCount: 2,
      maxDrawTx: 180,
      maxDrawVb: 70,
    },
  },
  stress: {
    label: "Stress: 20 tx / 4s = 5 tx/s, 9 conflict tx/slot",
    attackMode: "waves",
    values: {
      nodeCount: 100,
      validatorCount: 16,
      txPerSlot: 20,
      slotDuration: 4,
      validationDelay: 1.2,
      finalityLag: 4,
      slotsPerEpoch: 24,
      vbPerSlot: 2,
      conflictCount: 3,
      maxDrawTx: 220,
      maxDrawVb: 60,
    },
  },
};

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  sim = Simulator.fromDocument(document);
  sim.setLogger(simLogger);
  graph = new GraphView(els.canvas, (txId) => {
    sim.selectedTxId = txId;
    render();
  });
  fillViewSelect();
  bindControls();
  render();
});

function bindElements() {
  const ids = [
    "startBtn",
    "pauseBtn",
    "stepBtn",
    "resetBtn",
    "chartsBtn",
    "chartExportText",
    "logText",
    "slotText",
    "epochText",
    "genesisText",
    "acceptedBar",
    "rejectedBar",
    "pendingBar",
    "acceptedText",
    "rejectedText",
    "pendingText",
    "txCountText",
    "lateText",
    "vbText",
    "rotationText",
    "conflictText",
    "attackNodeText",
    "activeAttackText",
    "selectedText",
    "vbList",
    "viewSelect",
    "epochSelect",
    "vbDisplay",
    "conflictCount",
    "attackMode",
    "autoEpochAttack",
    "conflictBtn",
    "attackText",
    "presetLowBtn",
    "presetMediumBtn",
    "presetHighBtn",
    "presetStressBtn",
    "presetText",
  ];
  for (const id of ids) els[id] = document.getElementById(id);
  els.canvas = document.getElementById("dagCanvas");
}

function bindControls() {
  els.startBtn.addEventListener("click", start);
  els.pauseBtn.addEventListener("click", () => pause());
  els.chartsBtn.addEventListener("click", exportChartImages);
  els.stepBtn.addEventListener("click", async () => {
    await pause();
    step();
  });
  els.resetBtn.addEventListener("click", reset);
  els.viewSelect.addEventListener("change", () => {
    currentView = els.viewSelect.value;
    render();
  });
  els.epochSelect.addEventListener("change", () => {
    epochMode = els.epochSelect.value;
    render();
  });
  els.vbDisplay.addEventListener("change", render);
  els.conflictBtn.addEventListener("click", runConflictAttack);
  els.autoEpochAttack.addEventListener("change", updateAutoEpochAttack);
  els.conflictCount.addEventListener("change", updateAutoEpochAttack);
  els.attackMode.addEventListener("change", updateAutoEpochAttack);
  els.presetLowBtn.addEventListener("click", () => applyParameterPreset("low"));
  els.presetMediumBtn.addEventListener("click", () => applyParameterPreset("medium"));
  els.presetHighBtn.addEventListener("click", () => applyParameterPreset("high"));
  els.presetStressBtn.addEventListener("click", () => applyParameterPreset("stress"));
}

async function applyParameterPreset(name) {
  const preset = PARAMETER_PRESETS[name];
  if (!preset) return;
  for (const [id, value] of Object.entries(preset.values)) {
    const field = document.getElementById(id);
    if (field) field.value = value;
  }
  if (els.attackMode) els.attackMode.value = preset.attackMode || "waves";
  if (els.presetText) els.presetText.textContent = preset.label;
  await reset();
}

async function start() {
  if (timer) return;
  els.chartExportText.textContent = "";
  els.logText.textContent = "log: starting...";

  try {
    updateAutoEpochAttack();
    const logFile = await simLogger.begin(sim);
    recorder.begin(sim);
    timer = window.setInterval(step, 550);
    showLogLink(logFile, "log:");
  } catch (error) {
    els.logText.textContent = `log failed: ${error.message}`;
  }
  render();
}

async function pause(reason = "pause") {
  const wasRunning = Boolean(timer);
  if (timer) window.clearInterval(timer);
  timer = null;
  if (wasRunning) {
    recorder.close(sim);
    try {
      const logFile = await simLogger.close(sim, reason);
      if (logFile) showLogLink(logFile, "log saved:");
    } catch (error) {
      els.logText.textContent = `log failed: ${error.message}`;
    }
  }
  render();
}

async function reset() {
  await pause("reset");
  recorder.reset();
  simLogger.reset();
  sim = Simulator.fromDocument(document);
  sim.setLogger(simLogger);
  updateAutoEpochAttack();
  currentView = "aggregate";
  epochMode = "current";
  els.attackText.textContent = "";
  els.chartExportText.textContent = "";
  els.logText.textContent = "";
  fillViewSelect();
  els.epochSelect.value = epochMode;
  render();
}

function step() {
  updateAutoEpochAttack();
  sim.stepSlot();
  recorder.capture(sim);
  if (simLogger.buffer.length >= 200) {
    simLogger.flush().catch((error) => {
      els.logText.textContent = `log failed: ${error.message}`;
    });
  }
  render();
}

async function exportChartImages() {
  if (timer || !recorder.canRender()) return;
  els.chartsBtn.disabled = true;
  els.chartExportText.textContent = "Создаю PNG...";
  try {
    const result = await saveChartImages(recorder.samples, recorder.summary());
    els.chartExportText.innerHTML = result.files
      .map((file) => `<a href="${file.url}" target="_blank">${file.name}</a>`)
      .join("<br />");
  } catch (error) {
    els.chartExportText.textContent = error.message;
  } finally {
    render();
  }
}

function showLogLink(file, prefix) {
  if (!file?.url) return;
  els.logText.innerHTML = `${prefix} <a href="${file.url}" target="_blank">${file.name}</a>`;
}

function runConflictAttack() {
  const mode = selectedAttackMode();
  const startAttack =
    mode === "waves"
      ? startWaveConflictSpamAttack
      : mode === "multi"
        ? startMultiConflictSpamAttack
        : startConflictSpamAttack;
  const result = startAttack(sim, { perSlot: Number(els.conflictCount.value) });
  if (result.started) {
    const campaign = result.campaign;
    const label = attackModeLabel(mode);
    const inputText = mode === "single" ? `input ${campaign.input}` : "inputs per slot";
    const rateText =
      mode === "waves"
        ? `${campaign.perSlot} conflict tx/wave, 3 waves/slot`
        : `${campaign.perSlot} conflict tx/slot`;
    els.attackText.textContent =
      `${campaign.id}: ${label}, ${rateText}, ${inputText}, slots ${campaign.localStartSlot}-${campaign.localEndSlot}`;
  } else {
    els.attackText.textContent = result.reason;
  }
  render();
}

function updateAutoEpochAttack() {
  if (!sim || !els.autoEpochAttack) return;
  const enabled = Boolean(els.autoEpochAttack.checked);
  const perSlot = Number(els.conflictCount.value);
  const mode = selectedAttackMode();
  sim.setAutoEpochConflictAttack(enabled, perSlot, mode);
  if (enabled) {
    const label = attackModeLabel(mode);
    const rateText =
      mode === "waves"
        ? `${Math.max(1, Math.floor(perSlot || 1))} conflict tx/wave, 3 waves/slot`
        : `${Math.max(1, Math.floor(perSlot || 1))} conflict tx/slot`;
    els.attackText.textContent =
      `auto epoch ${label}: ${rateText} from slot 0 to epoch end`;
  }
}

function selectedAttackMode() {
  return ["single", "multi", "waves"].includes(els.attackMode.value)
    ? els.attackMode.value
    : "single";
}

function attackModeLabel(mode) {
  if (mode === "waves") return "three-wave multi-input geo spam";
  if (mode === "multi") return "multi-input geo spam";
  return "single-input geo spam";
}

function fillViewSelect() {
  els.viewSelect.innerHTML = "";
  const aggregate = document.createElement("option");
  aggregate.value = "aggregate";
  aggregate.textContent = "aggregate";
  els.viewSelect.appendChild(aggregate);

  for (const node of sim.nodes) {
    const option = document.createElement("option");
    option.value = String(node.id);
    option.textContent = node.validator
      ? `node-${node.id} validator`
      : `node-${node.id}`;
    els.viewSelect.appendChild(option);
  }
  els.viewSelect.value = currentView;
}

function render() {
  const m = sim.metrics();
  els.slotText.textContent = `${m.slot}${m.waitingEpochEnd ? " (epoch closing)" : ""}`;
  els.epochText.textContent = m.epoch;
  els.genesisText.textContent = m.genesis;
  els.txCountText.textContent = m.totalTx;
  els.lateText.textContent = m.lateObservations;
  els.vbText.textContent = m.validationBlocks;
  els.rotationText.textContent = m.rotations;
  els.conflictText.textContent = m.conflictLost;
  els.attackNodeText.textContent = m.attackNodes;
  els.activeAttackText.textContent = m.activeConflictCampaigns;
  els.chartsBtn.disabled = Boolean(timer) || !recorder.canRender();

  setBar("accepted", m.acceptedPct);
  setBar("rejected", m.rejectedPct);
  setBar("pending", m.pendingPct);

  graph.render(sim, currentView, epochMode, els.vbDisplay.value);
  els.selectedText.textContent = formatTx(sim, sim.selectedTx(), currentView);
  renderValidationBlocks();
}

function setBar(name, value) {
  els[`${name}Bar`].style.width = pct(value);
  els[`${name}Text`].textContent = pct(value);
}

function renderValidationBlocks() {
  els.vbList.innerHTML = "";
  for (const vb of sim.recentValidationBlocks()) {
    const item = document.createElement("div");
    item.className = "vb-item";
    item.innerHTML = [
      `<b>${vb.id}</b> slot ${vb.localSlot ?? vb.slot}`,
      `epoch/slot ${vb.epoch}/${vb.localSlot ?? vb.slot}`,
      `created at ${(vb.createdAt ?? 0).toFixed(3)}s`,
      `approves up to slot ${vb.approveUntilSlot}`,
      `validator node-${vb.validatorId}`,
      `stake ${pct(vb.stake)}`,
      `tips ${vb.tips.map(shortId).join(", ") || "-"}`,
      `covers ${vb.covered.length} tx`,
    ].join("<br />");
    els.vbList.appendChild(item);
  }
}
