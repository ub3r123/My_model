export class SimulationLogger {
  constructor() {
    this.active = false;
    this.name = "";
    this.url = "";
    this.seq = 1;
    this.buffer = [];
    this.flushing = false;
    this.lastError = "";
  }

  async begin(sim) {
    if (this.active) await this.close(sim, "restart");

    this.active = false;
    this.name = "";
    this.url = "";
    this.seq = 1;
    this.buffer = [];
    this.lastError = "";

    const response = await fetch("/api/log/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "simulation-run",
        createdAt: new Date().toISOString(),
        initial: snapshotSimulation(sim),
      }),
    });

    if (!response.ok) {
      throw new Error(`log start failed: ${response.status}`);
    }

    const result = await response.json();
    this.name = result.name;
    this.url = result.url;
    this.active = true;
    this.write("run-start", { snapshot: snapshotSimulation(sim) });
    await this.flush();
    return result;
  }

  write(type, payload = {}) {
    if (!this.active) return;
    this.buffer.push({
      seq: this.seq,
      type,
      wallTime: new Date().toISOString(),
      ...payload,
    });
    this.seq += 1;
  }

  async flush() {
    if (!this.active || this.flushing || !this.buffer.length) return;
    this.flushing = true;
    try {
      while (this.buffer.length) {
        const events = this.buffer.splice(0, 400);
        const response = await fetch("/api/log/append", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: this.name, events }),
        });
        if (!response.ok) {
          this.buffer.unshift(...events);
          throw new Error(`log append failed: ${response.status}`);
        }
      }
      this.lastError = "";
    } catch (error) {
      this.lastError = error.message;
      throw error;
    } finally {
      this.flushing = false;
    }
  }

  async close(sim, reason = "pause") {
    if (!this.active) return null;
    this.write("run-close", {
      reason,
      snapshot: snapshotSimulation(sim),
    });
    await this.flush();
    this.active = false;
    return { name: this.name, url: this.url };
  }

  reset() {
    this.active = false;
    this.name = "";
    this.url = "";
    this.seq = 1;
    this.buffer = [];
    this.flushing = false;
    this.lastError = "";
  }
}

function snapshotSimulation(sim) {
  const metrics = sim.metrics();
  return {
    time: round(sim.time),
    epoch: metrics.epoch,
    slot: metrics.slot,
    globalSlot: metrics.globalSlot,
    genesis: metrics.genesis,
    config: sim.config,
    metrics,
    validators: sim.validators.map((node) => ({
      id: node.id,
      city: node.city,
      stake: round(node.stake, 6),
      peers: node.peers.length,
    })),
    nodes: sim.nodes.map((node) => ({
      id: node.id,
      city: node.city,
      validator: node.validator,
      stake: round(node.stake, 6),
      peers: node.peers.length,
      accessMs: round(node.accessMs),
      bandwidthMbps: round(node.bandwidthMbps),
    })),
    attackNodes: sim.attackNodes.map((node) => ({
      id: node.id,
      city: node.city,
      peers: node.peers.length,
      accessMs: round(node.accessMs),
      bandwidthMbps: round(node.bandwidthMbps),
    })),
  };
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
