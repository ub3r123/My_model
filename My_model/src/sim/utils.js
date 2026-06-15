export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function pickWeighted(items, weightOf, random) {
  const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
  if (total <= 0) return items[Math.floor(random() * items.length)];

  let r = random() * total;
  for (const item of items) {
    r -= Math.max(0, weightOf(item));
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

export function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

export function shortId(id) {
  if (!id) return "-";
  return id.length > 8 ? `${id.slice(0, 8)}` : id;
}

export function pct(value) {
  return `${Math.round(value * 100)}%`;
}

export function stableHashNumber(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
