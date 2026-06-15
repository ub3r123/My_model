import { LocalTxStatus, TxStatus } from "../sim/status.js";
import { pct, shortId } from "../sim/utils.js";

const COLORS = {
  [TxStatus.PENDING]: "#8b949e",
  [TxStatus.ACCEPTED]: "#4cc38a",
  [TxStatus.REJECTED]: "#ef6461",
  [TxStatus.CONFLICT_LOST]: "#f3a53b",
};

const GENESIS_COLOR = "#f4d35e";
const VB_COLOR = "#9b5de5";
const ATTACK_COLOR = "#ff9f1c";
const PARENT_HIGHLIGHT = "#4ea1ff";
const CHILD_HIGHLIGHT = "#22d3ee";
const TRAIN_SLOT_WIDTH = 150;
const TRAIN_LEFT = 90;
const TRAIN_RIGHT = 90;

export class GraphView {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onSelect = onSelect;
    this.positions = new Map();
    this.vbPositions = new Map();
    this.yMemory = new Map();
    this.genesisPosition = null;
    this.lastSim = null;
    this.lastView = "aggregate";
    this.lastEpochMode = "current";
    this.lastVbDisplay = "compact";
    this.highlightParents = new Set();
    this.highlightChildren = new Set();
    this.followRight = true;
    this.programmaticScroll = false;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener("click", (event) => this.handleClick(event));
    canvas.parentElement?.addEventListener("scroll", () => this.handleScroll());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(600, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(360, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.lastSim) this.render(this.lastSim, this.lastView, this.lastEpochMode, this.lastVbDisplay);
  }

  render(sim, viewNodeId, epochMode = "current", vbDisplay = "compact") {
    if (this.lastSim && this.lastSim !== sim) {
      this.yMemory.clear();
      this.followRight = true;
    }
    this.lastSim = sim;
    this.lastView = viewNodeId;
    this.lastEpochMode = epochMode;
    this.lastVbDisplay = vbDisplay;
    this.highlightParents = selectedParents(sim);
    this.highlightChildren = selectedChildren(sim);
    const viewportWidth = Math.max(
      600,
      Math.floor(this.canvas.parentElement?.clientWidth || this.canvas.getBoundingClientRect().width),
    );
    const trainWindow = makeTrainWindow(sim, epochMode);
    const contentWidth = trainContentWidth(trainWindow, viewportWidth);
    const txs = visibleTransactionsInWindow(
      sim,
      viewNodeId,
      epochMode,
      trainWindow.minSlot,
      trainWindow.maxSlot,
    );
    const rawVbs = visibleValidationBlocksInWindow(
      sim,
      viewNodeId,
      epochMode,
      trainWindow.minSlot,
      trainWindow.maxSlot,
    );
    const vbs = vbDisplay === "hidden" ? [] : rawVbs;
    this.positions.clear();
    this.vbPositions.clear();

    const slotLabels = makeSlotLabels(
      sim,
      txs,
      vbs,
      trainWindow.minSlot,
      trainWindow.maxSlot,
      epochMode,
    );
    const minSlot = trainWindow.minSlot;
    const maxSlot = trainWindow.maxSlot;
    const height = Math.max(
      680,
      Math.floor(this.canvas.parentElement?.clientHeight || this.canvas.getBoundingClientRect().height),
    );
    const currentCssWidth = Number.parseFloat(this.canvas.style.width || "0");
    const currentCssHeight = Number.parseFloat(this.canvas.style.height || "0");
    if (Math.abs(currentCssWidth - contentWidth) > 2 || Math.abs(currentCssHeight - height) > 2) {
      this.canvas.style.width = `${contentWidth}px`;
      this.canvas.style.height = `${height}px`;
      this.resize();
      return;
    }
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b1014";
    ctx.fillRect(0, 0, width, height);

    const orderedTxs = [...txs].sort((a, b) => a.createdAt - b.createdAt || a.hash - b.hash);
    const top = 102;
    const bottom = 56;
    const slotX = (slot) => TRAIN_LEFT + (slot - minSlot + 0.7) * TRAIN_SLOT_WIDTH;
    const genesisSlot = sim.epochStartSlot - 0.65;
    this.genesisPosition = {
      x: slotX(genesisSlot),
      y: top + (height - top - bottom) / 2,
      r: 10,
    };

    this.drawSlotGrid(ctx, minSlot, maxSlot, top, width, height, bottom, slotX, slotLabels);
    this.drawLegend(ctx, vbDisplay);

    this.layoutTransactions(sim, orderedTxs, top, bottom, width, height, slotX);

    for (const vb of vbs) {
      const slotTime = (vb.createdAt ?? vb.slot * sim.config.slotDuration) / sim.config.slotDuration;
      const x = slotX(slotTime);
      const lane = vb.validatorId % 5;
      const y = 30 + lane * 10;
      this.vbPositions.set(vb.id, { x, y, r: vbDisplay === "full" ? 5 : 3.5 });
    }

    ctx.save();
    ctx.lineWidth = 1;
    for (const tx of txs) {
      const from = this.positions.get(tx.id);
      if (!from) continue;
      if (!tx.parents.length && this.genesisPosition) {
        drawCurve(ctx, from, this.genesisPosition, "rgba(244, 211, 94, 0.32)");
      }
      for (const parentId of tx.parents) {
        const to = this.positions.get(parentId);
        if (!to) continue;
        const opacity = 0.08 + 0.32 * (tx.seenBy.size / sim.nodes.length);
        const selectedParentEdge = sim.selectedTxId === tx.id && this.highlightParents.has(parentId);
        const selectedChildEdge = this.highlightChildren.has(tx.id) && parentId === sim.selectedTxId;
        drawCurve(
          ctx,
          from,
          to,
          selectedParentEdge
            ? "rgba(78, 161, 255, 0.95)"
            : selectedChildEdge
              ? "rgba(34, 211, 238, 0.95)"
              : `rgba(140, 160, 172, ${opacity})`,
          selectedParentEdge || selectedChildEdge ? 2.4 : 1,
        );
      }
    }

    if (vbDisplay === "full") {
      for (const vb of vbs) {
        const from = this.vbPositions.get(vb.id);
        if (!from) continue;
        for (const tipId of vb.tips) {
          const to = this.positions.get(tipId);
          if (to) drawCurve(ctx, from, to, "rgba(155, 93, 229, 0.2)");
        }
      }
    }
    ctx.restore();

    this.drawGenesis(ctx, sim);
    for (const vb of vbs) this.drawValidationBlock(ctx, vb, vbDisplay);
    for (const tx of txs) {
      this.drawNode(ctx, sim, tx, viewNodeId);
    }

    if (!txs.length) {
      ctx.fillStyle = "#748493";
      ctx.font = "14px Segoe UI";
      ctx.fillText("Пока нет транзакций.", 62, top + 4);
    }
    this.scrollToRightIfFollowing();
  }

  layoutTransactions(sim, txs, top, bottom, width, height, slotX) {
    const minY = top + 34;
    const maxY = height - bottom - 24;
    const usedBySlot = new Map();

    for (const tx of txs) {
      const slotTime = tx.createdAt / sim.config.slotDuration;
      const x = slotX(slotTime);
      const key = yMemoryKey(tx);
      let y = this.yMemory.get(key);

      if (!Number.isFinite(y)) {
        const spread = ((tx.hash % 1000) / 999) * (maxY - minY);
        const targetY = minY + spread;
        const drift = (((tx.hash >>> 9) % 17) - 8) * 2;
        const used = usedBySlot.get(tx.slot) || [];
        y = findOpenY(targetY + drift, used, minY, maxY, 16);
        this.yMemory.set(key, y);
      }

      y = Math.max(minY, Math.min(maxY, y));
      const used = usedBySlot.get(tx.slot) || [];
      const seenRatio = tx.seenBy.size / sim.nodes.length;
      const r = 3.1 + 4.1 * seenRatio;
      this.positions.set(tx.id, { x, y, r });
      used.push(y);
      usedBySlot.set(tx.slot, used);
    }
  }

  drawSlotGrid(ctx, minSlot, maxSlot, top, width, height, bottom, slotX, slotLabels) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "#71808c";
    ctx.font = "11px Segoe UI";
    for (let slot = minSlot; slot <= maxSlot; slot += 1) {
      const x = slotX(slot);
      if (x < -TRAIN_SLOT_WIDTH || x > width + TRAIN_SLOT_WIDTH) continue;
      ctx.beginPath();
      ctx.moveTo(x, top - 14);
      ctx.lineTo(x, height - bottom + 8);
      ctx.stroke();
      const label = slotLabels.get(slot) ?? String(slot);
      ctx.fillText(label, x - Math.min(24, ctx.measureText(label).width / 2), height - 20);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.11)";
    ctx.beginPath();
    ctx.moveTo(0, height - bottom + 8);
    ctx.lineTo(width, height - bottom + 8);
    ctx.stroke();
    ctx.restore();
  }

  drawLegend(ctx, vbDisplay) {
    const items = [
      ["genesis", GENESIS_COLOR],
      ["accepted", COLORS[TxStatus.ACCEPTED]],
      ["rejected", COLORS[TxStatus.REJECTED]],
      ["pending", COLORS[TxStatus.PENDING]],
    ];
    if (vbDisplay !== "hidden") items.push(["validation block", VB_COLOR]);
    items.push(["attack tx", ATTACK_COLOR]);
    ctx.save();
    ctx.font = "11px Segoe UI";
    let x = 16;
    for (const [label, color] of items) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 6, 14, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#aab7c2";
      ctx.fillText(label, x + 16, 18);
      x += ctx.measureText(label).width + 35;
    }
    ctx.restore();
  }

  drawGenesis(ctx, sim) {
    const p = this.genesisPosition;
    if (!p) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = GENESIS_COLOR;
    ctx.strokeStyle = "#101418";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -p.r);
    ctx.lineTo(p.r, 0);
    ctx.lineTo(0, p.r);
    ctx.lineTo(-p.r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#dce6ee";
    ctx.font = "11px Segoe UI";
    ctx.fillText(sim.genesis.id, p.r + 7, 4);
    ctx.restore();
  }

  drawValidationBlock(ctx, vb, vbDisplay) {
    const p = this.vbPositions.get(vb.id);
    if (!p) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = vbDisplay === "full" ? 0.72 : 0.42;
    ctx.fillStyle = VB_COLOR;
    ctx.strokeStyle = "#e9d8fd";
    ctx.lineWidth = vbDisplay === "full" ? 1.2 : 0.8;
    ctx.beginPath();
    ctx.rect(-p.r, -p.r, p.r * 2, p.r * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#b9c5cf";
    ctx.font = "9px Segoe UI";
    if (vbDisplay === "full" && this.vbPositions.size <= 30) {
      ctx.fillText(vb.id.replace("vb-", ""), p.r + 3, 3);
    }
    ctx.restore();
  }

  drawNode(ctx, sim, tx, viewNodeId) {
    const p = this.positions.get(tx.id);
    if (!p) return;

    const seenPct = tx.seenBy.size / sim.nodes.length;
    const color = COLORS[tx.status] || "#9ca3af";
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = tx.status === TxStatus.REJECTED ? 0.72 : 0.95;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "#0b1014";
    ctx.lineWidth = 2;
    ctx.stroke();

    const isParentHighlighted = this.highlightParents.has(tx.id);
    const isChildHighlighted = this.highlightChildren.has(tx.id);

    if (tx.attack) {
      ctx.strokeStyle = ATTACK_COLOR;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 5.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ATTACK_COLOR;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - p.r - 10);
      ctx.lineTo(p.x - 3.5, p.y - p.r - 4.5);
      ctx.lineTo(p.x + 3.5, p.y - p.r - 4.5);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = "#e9f2f7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * tx.support);
    ctx.stroke();

    if (viewNodeId !== "aggregate") {
      const local = sim.nodes[Number(viewNodeId)]?.known.get(tx.id);
      if (local?.localStatus === LocalTxStatus.LATE) {
        ctx.strokeStyle = "#ef6461";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 7, 0, Math.PI * 2);
      ctx.stroke();
      }
    }

    if (isParentHighlighted) {
      ctx.strokeStyle = PARENT_HIGHLIGHT;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#d8ecff";
      ctx.font = "bold 10px Segoe UI";
      ctx.fillText(shortId(tx.id).replace("tx-", ""), p.x + p.r + 7, p.y - 6);
    }

    if (isChildHighlighted) {
      ctx.strokeStyle = CHILD_HIGHLIGHT;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 6.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#bff6ff";
      ctx.font = "bold 10px Segoe UI";
      ctx.fillText(shortId(tx.id).replace("tx-", ""), p.x + p.r + 7, p.y + 12);
    }

    if (sim.selectedTxId === tx.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (sim.config.maxDrawTx <= 60 && p.r > 8) {
      ctx.fillStyle = "#dce6ee";
      ctx.font = "10px Segoe UI";
      ctx.fillText(shortId(tx.id).replace("tx-", ""), p.x + p.r + 5, p.y + 3);
    }

    ctx.restore();
  }

  handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const [txId, p] of this.positions) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < p.r + 9 && d < bestD) {
        best = txId;
        bestD = d;
      }
    }
    if (best) this.onSelect(best);
  }

  handleScroll() {
    if (this.programmaticScroll) return;
    const scroller = this.canvas.parentElement;
    if (!scroller) return;
    this.followRight = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 32;
  }

  scrollToRightIfFollowing() {
    const scroller = this.canvas.parentElement;
    if (!scroller || !this.followRight) return;
    this.programmaticScroll = true;
    scroller.scrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    requestAnimationFrame(() => {
      this.programmaticScroll = false;
    });
  }
}

export function formatTx(sim, tx, viewNodeId) {
  if (!tx) return "Выбери вершину на графе.";
  const local =
    viewNodeId === "aggregate" ? null : sim.nodes[Number(viewNodeId)]?.known.get(tx.id);
  const lines = [
    `${tx.id}`,
    `status: ${tx.status}`,
    `epoch/slot: ${tx.epoch}/${tx.localSlot ?? tx.slot}`,
    `created at: ${tx.createdAt.toFixed(3)}s`,
    `support: ${pct(tx.support)} (${tx.supportValidators.size} validators)`,
    `seen: ${tx.seenBy.size}/${sim.nodes.length} (${pct(tx.seenBy.size / sim.nodes.length)})`,
    `late local observations: ${tx.lateBy.size}`,
    `creator: ${typeof tx.creatorId === "string" ? tx.creatorId : `node-${tx.creatorId}`}`,
    `gref: ${tx.gref}`,
    `input: ${tx.input}`,
    `output: ${tx.output}`,
    `parents: ${tx.parents.length ? tx.parents.join(", ") : "-"}`,
  ];
  if (local) {
    lines.push(`local status: ${local.localStatus}`);
    lines.push(`received at: ${local.receivedAt.toFixed(3)}s`);
  }
  if (tx.attack) {
    lines.push(`attack: ${tx.attack.type}`);
    lines.push(`attack group: ${tx.attack.groupId}`);
    lines.push(`attack index: ${tx.attack.index}`);
    if (tx.attack.startSlot !== undefined) {
      lines.push(
        `attack window: slots ${tx.attack.localStartSlot ?? tx.attack.startSlot}-${tx.attack.localEndSlot ?? tx.attack.endSlot}`,
      );
    }
    if (tx.attack.originCity) lines.push(`origin: ${tx.attack.originCity}`);
    if (tx.attack.sourceMode) lines.push(`source mode: ${tx.attack.sourceMode}`);
  }
  if (tx.rejectReason) lines.push(`note: ${tx.rejectReason}`);
  return lines.join("\n");
}

function drawCurve(ctx, from, to, strokeStyle, lineWidth = 1) {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  const midX = (from.x + to.x) / 2;
  ctx.bezierCurveTo(midX, from.y, midX, to.y, to.x, to.y);
  ctx.stroke();

  const angle = Math.atan2(to.y - from.y, to.x - midX);
  const size = 4;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - 0.45) * size, to.y - Math.sin(angle - 0.45) * size);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle + 0.45) * size, to.y - Math.sin(angle + 0.45) * size);
  ctx.stroke();
}

function findOpenY(targetY, used, minY, maxY, minGap) {
  const clamped = Math.max(minY, Math.min(maxY, targetY));
  if (used.every((y) => Math.abs(y - clamped) >= minGap)) return clamped;

  for (let step = minGap; step < maxY - minY + minGap; step += minGap) {
    const up = clamped - step;
    if (up >= minY && used.every((y) => Math.abs(y - up) >= minGap)) return up;
    const down = clamped + step;
    if (down <= maxY && used.every((y) => Math.abs(y - down) >= minGap)) return down;
  }
  return clamped;
}

function selectedParents(sim) {
  const tx = sim.selectedTx();
  return new Set(tx?.parents || []);
}

function selectedChildren(sim) {
  const selected = sim.selectedTx();
  if (!selected) return new Set();
  const children = new Set();
  for (const tx of sim.txs.values()) {
    if (tx.parents?.includes(selected.id)) children.add(tx.id);
  }
  return children;
}

function yMemoryKey(tx) {
  return `${tx.gref}:${tx.id}`;
}

function makeTrainWindow(sim, epochMode) {
  const maxSlot = sim.slot;
  const minSlot =
    epochMode === "current"
      ? sim.epochStartSlot
      : Math.max(0, maxSlot - Math.max(sim.config.slotsPerEpoch, 36));
  return {
    minSlot: Math.max(0, Math.min(minSlot, maxSlot)),
    maxSlot,
  };
}

function trainContentWidth(trainWindow, viewportWidth) {
  const slots = Math.max(1, trainWindow.maxSlot - trainWindow.minSlot + 1);
  return Math.max(
    viewportWidth,
    TRAIN_LEFT + TRAIN_RIGHT + Math.ceil((slots + 0.9) * TRAIN_SLOT_WIDTH),
  );
}

function visibleTransactionsInWindow(sim, viewNodeId, epochMode, minSlot, maxSlot) {
  const all = [...sim.txs.values()];
  const visible =
    viewNodeId === "aggregate"
      ? all
      : all.filter((tx) => sim.nodes[Number(viewNodeId)]?.known.has(tx.id));
  return visible
    .filter((tx) => tx.slot >= minSlot && tx.slot <= maxSlot)
    .filter((tx) => epochMode !== "current" || (tx.epoch === sim.epoch && tx.gref === sim.genesis.id));
}

function visibleValidationBlocksInWindow(sim, viewNodeId, epochMode, minSlot, maxSlot) {
  const all =
    viewNodeId === "aggregate"
      ? sim.validationBlocks
      : sim.validationBlocks.filter((vb) => vb.validatorId === Number(viewNodeId));
  return all
    .filter((vb) => vb.slot >= minSlot && vb.slot <= maxSlot)
    .filter((vb) => epochMode !== "current" || vb.epoch === sim.epoch);
}

function makeSlotLabels(sim, txs, vbs, minSlot, maxSlot, epochMode) {
  const labels = new Map();
  for (const tx of txs) {
    labels.set(tx.slot, `E${tx.epoch}/S${tx.localSlot ?? tx.slot}`);
  }
  for (const vb of vbs) {
    labels.set(vb.slot, `E${vb.epoch}/S${vb.localSlot ?? vb.slot}`);
  }
  if (epochMode === "current") {
    for (let slot = minSlot; slot <= maxSlot; slot += 1) {
      labels.set(slot, `E${sim.epoch}/S${sim.localSlotForGlobal(slot)}`);
    }
  } else {
    labels.set(sim.slot, `E${sim.epoch}/S${sim.localSlotForGlobal(sim.slot)}`);
  }
  return labels;
}
