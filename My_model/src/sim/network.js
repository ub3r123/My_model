import { distanceKm, mulberry32, pickWeighted } from "./utils.js";

const CITIES = [
  { name: "Moscow", lat: 55.75, lon: 37.62, weight: 13, spread: 0.55, accessBiasMs: 6 },
  { name: "SPB", lat: 59.93, lon: 30.31, weight: 9, spread: 0.5, accessBiasMs: 7 },
  { name: "Kazan", lat: 55.79, lon: 49.12, weight: 6, spread: 0.45, accessBiasMs: 9 },
  { name: "Ekaterinburg", lat: 56.84, lon: 60.61, weight: 6, spread: 0.55, accessBiasMs: 10 },
  { name: "Novosibirsk", lat: 55.01, lon: 82.93, weight: 5, spread: 0.55, accessBiasMs: 12 },
  { name: "Berlin", lat: 52.52, lon: 13.4, weight: 7, spread: 0.45, accessBiasMs: 6 },
  { name: "Frankfurt", lat: 50.11, lon: 8.68, weight: 8, spread: 0.35, accessBiasMs: 4 },
  { name: "Paris", lat: 48.85, lon: 2.35, weight: 6, spread: 0.45, accessBiasMs: 6 },
  { name: "London", lat: 51.51, lon: -0.13, weight: 7, spread: 0.45, accessBiasMs: 5 },
  { name: "Amsterdam", lat: 52.37, lon: 4.9, weight: 5, spread: 0.35, accessBiasMs: 4 },
  { name: "New York", lat: 40.71, lon: -74.01, weight: 7, spread: 0.5, accessBiasMs: 7 },
  { name: "Virginia", lat: 39.04, lon: -77.49, weight: 6, spread: 0.35, accessBiasMs: 4 },
  { name: "San Francisco", lat: 37.77, lon: -122.42, weight: 4, spread: 0.5, accessBiasMs: 8 },
  { name: "Singapore", lat: 1.35, lon: 103.82, weight: 4, spread: 0.3, accessBiasMs: 5 },
  { name: "Tokyo", lat: 35.68, lon: 139.76, weight: 5, spread: 0.4, accessBiasMs: 6 },
];

const ATTACK_CITY_ORDER = [
  "Moscow",
  "Tokyo",
  "New York",
  "Frankfurt",
  "Singapore",
  "San Francisco",
  "London",
  "Novosibirsk",
];

export function buildNodes(config) {
  const random = mulberry32(config.seed + 17);
  const nodes = [];

  for (let i = 0; i < config.nodeCount; i += 1) {
    const city = pickWeighted(CITIES, (item) => item.weight, random);
    const slow = random() < config.slowNodeChance;
    const accessMs =
      city.accessBiasMs +
      7 +
      random() ** 2 * 45 +
      (slow ? 80 + random() * config.slowNodeExtraMs : 0);
    const bandwidthMbps = slow ? 2 + random() * 8 : 18 + random() ** 2 * 110;
    nodes.push({
      id: i,
      name: `node-${i}`,
      city: city.name,
      lat: city.lat + (random() - 0.5) * city.spread,
      lon: city.lon + (random() - 0.5) * city.spread,
      accessMs,
      bandwidthMbps,
      validator: false,
      stake: 0,
      peers: [],
      known: new Map(),
      children: new Map(),
      knownVbs: new Set(),
      localSupportValidators: new Map(),
    });
  }

  for (const node of nodes) {
    const nearest = nodes
      .filter((other) => other.id !== node.id)
      .map((other) => ({ other, d: distanceKm(node, other) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, config.neighborsNear)
      .map((x) => x.other.id);

    for (const id of nearest) connect(nodes, node.id, id);

    while (node.peers.length < config.neighborsNear + config.neighborsRandom) {
      const id = Math.floor(random() * nodes.length);
      if (id !== node.id) connect(nodes, node.id, id);
    }
  }

  return nodes;
}

export function buildAttackNodes(config, nodes) {
  const random = mulberry32(config.seed + 991);
  const count = Math.max(0, Math.floor(config.attackNodeCount || 0));
  const attackNodes = [];

  for (let i = 0; i < count; i += 1) {
    const city = attackCityForIndex(i) ?? pickWeighted(CITIES, (item) => item.weight, random);
    const position = nodeSafePosition(city, random);
    const node = {
      id: `atk-${i}`,
      name: `attacker-${i}`,
      city: city.name,
      lat: position.lat,
      lon: position.lon,
      accessMs: city.accessBiasMs + 5 + random() ** 2 * 25,
      bandwidthMbps: 60 + random() ** 2 * 180,
      validator: false,
      attack: true,
      stake: 0,
      peers: attackPeers(position, nodes, config, random),
      known: new Map(),
      children: new Map(),
      knownVbs: new Set(),
      localSupportValidators: new Map(),
    };
    attackNodes.push(node);
  }

  return attackNodes;
}

function attackCityForIndex(index) {
  const name = ATTACK_CITY_ORDER[index % ATTACK_CITY_ORDER.length];
  return CITIES.find((city) => city.name === name) ?? null;
}

export function networkDelaySeconds(from, to, bytes, config, random) {
  const dist = distanceKm(from, to);
  const route =
    config.routeFactorMin + random() * (config.routeFactorMax - config.routeFactorMin);
  const propagation = (dist * route) / config.propagationKmPerSec;
  const bandwidthMbps = Math.max(
    0.5,
    Math.min(from.bandwidthMbps || config.defaultBandwidthMbps, to.bandwidthMbps || config.defaultBandwidthMbps),
  );
  const bandwidth = bandwidthMbps * 1_000_000;
  const transmit = (bytes * 8) / bandwidth;
  const jitter = (random() ** 2 * config.jitterMs) / 1000;
  const congestion = (random() ** 4 * (config.congestionMs || 0)) / 1000;
  const spike =
    random() < (config.congestionSpikeChance || 0)
      ? (random() * (config.congestionSpikeMs || 0)) / 1000
      : 0;
  const longTail =
    random() < (config.longTailDelayChance || 0)
      ? ((config.longTailDelayMinMs || 0) +
          random() *
            Math.max(0, (config.longTailDelayMaxMs || 0) - (config.longTailDelayMinMs || 0))) /
        1000
      : 0;
  const access = ((from.accessMs || 0) + (to.accessMs || 0)) / 1000;
  return access + propagation + transmit + jitter + congestion + spike + longTail;
}

function connect(nodes, a, b) {
  if (!nodes[a].peers.includes(b)) nodes[a].peers.push(b);
  if (!nodes[b].peers.includes(a)) nodes[b].peers.push(a);
}

function attackPeers(position, nodes, config, random) {
  if (!nodes.length) return [];
  const nearCount = Math.min(nodes.length, Math.max(2, Math.floor(config.neighborsNear / 2)));
  const total = Math.min(nodes.length, Math.max(4, Math.floor((config.neighborsNear + config.neighborsRandom) / 2)));
  const peers = nodes
    .map((other) => ({ id: other.id, d: distanceKm(position, other) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, nearCount)
    .map((item) => item.id);

  while (peers.length < total) {
    const id = Math.floor(random() * nodes.length);
    if (!peers.includes(id)) peers.push(id);
  }
  return peers;
}

function nodeSafePosition(city, random) {
  return {
    lat: city.lat + (random() - 0.5) * city.spread,
    lon: city.lon + (random() - 0.5) * city.spread,
  };
}
