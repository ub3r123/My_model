import json
import math
import re
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


BG = "#ffffff"
GRID = "#d9dee3"
TEXT = "#1f2933"
MUTED = "#52606d"
RED = "#d64545"
BLUE = "#2563eb"
GREEN = "#2f9e62"
ORANGE = "#d97706"
PURPLE = "#7c3aed"
AVG = "#111827"

# Расчетная PoS-линия использует тот же поток транзакций, что и DAG.
# Предел блока выражен через Ethereum gas limit: 60 млн gas / 21 тыс. gas.
POS_BLOCK_INTERVAL_SLOTS = 4
ETHEREUM_BLOCK_GAS_LIMIT = 60_000_000
ETHEREUM_SIMPLE_TX_GAS = 21_000
MODEL_TX_BYTES = 1_100
POS_BLOCK_HEADER_BYTES = 600


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: render_charts.py <export_dir> <stamp>")

    export_dir = Path(sys.argv[1])
    stamp = sanitize_name(sys.argv[2])
    payload = json.load(sys.stdin)
    samples = payload.get("samples") or []
    export_dir.mkdir(parents=True, exist_ok=True)

    files = []
    files.append(
        save_origin_rejection_chart(
            export_dir,
            stamp,
            "origin-rejected-by-slot",
            "Отброшенные обычные транзакции по слотам",
            finalized_slot_samples(samples),
        )
    )
    files.append(
        save_memory_comparison_chart(
            export_dir,
            stamp,
            "memory",
            samples,
        )
    )
    files.append(
        save_conflict_acceptance_chart(
            export_dir,
            stamp,
            "conflicts-accepted-by-slot",
            "Принятые конфликтные транзакции по слотам",
            finalized_slot_samples(samples),
        )
    )

    print(json.dumps({"files": files}, ensure_ascii=False))


def finalized_slot_samples(samples):
    by_slot = {}
    for sample in samples:
        slot = sample.get("finalizedProcessedGlobalSlot")
        if slot is None:
            continue
        by_slot[int(slot)] = sample
    return [sample for _, sample in sorted(by_slot.items(), key=lambda item: item[0])]


def save_bar_chart(export_dir, stamp, name, title, samples, label_of, value_of, y_title, color, y_max=None):
    labels = [label_of(sample) for sample in samples]
    values = [value_of(sample) for sample in samples]
    fig, ax = make_axes(title, y_title)
    ax.bar(range(len(values)), values, color=with_alpha(color, 0.72), edgecolor=color, linewidth=1.6)
    configure_x_ticks(ax, labels)
    configure_y_axis(ax, values, y_max)
    return save_figure(fig, export_dir, stamp, name)


def save_origin_rejection_chart(export_dir, stamp, name, title, samples):
    labels = [sample.get("finalizedLabel") or label_for_sample(sample) for sample in samples]
    values = [ordinary_rejected_pct(sample) for sample in samples]
    fig, ax = make_axes(title, "% отброшено")
    ax.bar(
        range(len(values)),
        values,
        color=with_alpha(RED, 0.68),
        edgecolor=RED,
        linewidth=1.4,
        label="отброшенные обычные транзакции",
    )
    draw_epoch_average_lines(ax, samples, values)
    configure_x_ticks(ax, labels)
    configure_y_axis(ax, values, minimum_top=10)
    ax.legend(frameon=False, labelcolor=MUTED, fontsize=11)
    return save_figure(fig, export_dir, stamp, name)


def save_conflict_acceptance_chart(export_dir, stamp, name, title, samples):
    labels = [sample.get("finalizedLabel") or label_for_sample(sample) for sample in samples]
    values = [conflict_accepted_pct(sample) for sample in samples]
    fig, ax = make_axes(title, "% принято")
    ax.bar(
        range(len(values)),
        values,
        color=with_alpha(ORANGE, 0.68),
        edgecolor=ORANGE,
        linewidth=1.4,
        label="принятые конфликтные транзакции",
    )
    draw_epoch_average_lines(ax, samples, values)
    configure_x_ticks(ax, labels)
    configure_y_axis(ax, values, y_max=110)
    ax.legend(frameon=False, labelcolor=MUTED, fontsize=11)
    return save_figure(fig, export_dir, stamp, name)


def save_memory_comparison_chart(export_dir, stamp, name, samples):
    points = unique_slot_samples(samples)
    labels = [f"слот {global_slot(sample)}" for sample in points]
    model_memory = [number(sample.get("memoryMb")) for sample in points]
    unfolded_memory = [number(sample.get("memoryWithoutRotationMb")) for sample in points]
    pos_memory = pos_blockchain_memory(points)
    node_id = points[-1].get("observedNodeId") if points else "?"

    fig, ax = make_axes(f"Сравнение использования памяти: узел {node_id}", "МБ")
    x = range(len(points))
    ax.plot(x, model_memory, color=BLUE, linewidth=2.6, label="DAG со сворачиванием")
    ax.plot(x, unfolded_memory, color=PURPLE, linewidth=2.6, label="DAG без сворачивания (расчет)")
    ax.plot(x, pos_memory, color=GREEN, linewidth=2.6, label="PoS-блокчейн (расчет)")
    configure_x_ticks(ax, labels)
    configure_y_axis(ax, model_memory + unfolded_memory + pos_memory)
    ax.legend(frameon=False, labelcolor=MUTED, fontsize=11)
    return save_figure(fig, export_dir, stamp, name)


def save_line_chart(export_dir, stamp, name, title, samples, label_of, value_of, y_title, color, y_max=None):
    labels = [label_of(sample) for sample in samples]
    values = [value_of(sample) for sample in samples]
    fig, ax = make_axes(title, y_title)
    ax.plot(range(len(values)), values, color=color, linewidth=2.6)
    configure_x_ticks(ax, labels)
    configure_y_axis(ax, values, y_max)
    return save_figure(fig, export_dir, stamp, name)


def make_axes(title, y_title):
    fig, ax = plt.subplots(figsize=(12, 7.2), dpi=100)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    ax.set_title(title, color=TEXT, fontsize=22, fontweight="bold", pad=22)
    ax.set_xlabel("слот", color=MUTED, fontsize=13, labelpad=12)
    ax.set_ylabel(y_title, color=MUTED, fontsize=13, labelpad=12)
    ax.grid(True, color=GRID, alpha=0.85, linewidth=1)
    ax.set_axisbelow(True)
    ax.tick_params(colors=MUTED, labelsize=11)
    for spine in ax.spines.values():
        spine.set_color("#cbd5df")
    return fig, ax


def configure_x_ticks(ax, labels):
    if not labels:
        ax.set_xticks([])
        return
    max_ticks = 12
    step = max(1, math.ceil(len(labels) / max_ticks))
    ticks = list(range(0, len(labels), step))
    ax.set_xticks(ticks)
    ax.set_xticklabels([labels[index] for index in ticks], rotation=0, ha="center")
    ax.set_xlim(-0.8, max(0.8, len(labels) - 0.2))


def configure_y_axis(ax, values, y_max=None, minimum_top=1):
    ax.set_ylim(bottom=0)
    if y_max is not None:
        ax.set_ylim(0, y_max)
        return
    max_value = max(values) if values else 1
    ax.set_ylim(0, max(minimum_top, max_value * 1.18))


def draw_epoch_average_lines(ax, samples, values):
    first_label = True
    start = 0
    while start < len(samples):
        epoch = samples[start].get("finalizedProcessedEpoch", samples[start].get("epoch", 0))
        end = start
        while end + 1 < len(samples):
            next_epoch = samples[end + 1].get("finalizedProcessedEpoch", samples[end + 1].get("epoch", 0))
            if next_epoch != epoch:
                break
            end += 1
        epoch_values = values[start : end + 1]
        if epoch_values:
            avg = sum(epoch_values) / len(epoch_values)
            ax.hlines(
                avg,
                start - 0.42,
                end + 0.42,
                colors=AVG,
                linestyles="dashed",
                linewidth=1.8,
                label="среднее за эпоху" if first_label else None,
            )
            ax.text(
                end + 0.45,
                avg,
                f"{avg:.1f}%",
                color=AVG,
                fontsize=9,
                va="center",
            )
            first_label = False
        start = end + 1


def save_figure(fig, export_dir, stamp, safe_name):
    name = f"{stamp}-{sanitize_name(safe_name)}.png"
    path = export_dir / name
    fig.tight_layout(pad=2.0)
    fig.savefig(path, facecolor=BG)
    plt.close(fig)
    return {"name": name, "url": f"/exports/{name}"}


def label_for_sample(sample):
    epoch = sample.get("finalizedProcessedEpoch", sample.get("epoch", 0))
    slot = sample.get("finalizedProcessedSlot", sample.get("slot", 0))
    return f"E{epoch}/S{slot}"


def ordinary_rejected_pct(sample):
    total = number(sample.get("ordinaryFinalizedTotal"))
    if total <= 0:
        return 0.0
    return number(sample.get("ordinaryFinalizedRejected")) / total * 100


def conflict_accepted_pct(sample):
    total = number(sample.get("conflictFinalizedTotal"))
    if total <= 0:
        return 0.0
    return number(sample.get("conflictFinalizedAccepted")) / total * 100


def unique_slot_samples(samples):
    by_slot = {}
    for sample in samples:
        by_slot[global_slot(sample)] = sample
    return [sample for _, sample in sorted(by_slot.items(), key=lambda item: item[0])]


def global_slot(sample):
    return int(number(sample.get("globalSlot", sample.get("slot", 0))))


def pos_blockchain_memory(samples):
    if not samples:
        return []

    max_transactions_per_block = ETHEREUM_BLOCK_GAS_LIMIT // ETHEREUM_SIMPLE_TX_GAS
    accepted_queue = 0
    stored_bytes = POS_BLOCK_HEADER_BYTES
    result = []
    previous_accepted = 0
    start_slot = global_slot(samples[0])

    for index, sample in enumerate(samples):
        current_accepted = int(number(sample.get("observedNodeAcceptedTx")))
        accepted_queue += max(0, current_accepted - previous_accepted)
        previous_accepted = current_accepted

        elapsed_slots = global_slot(sample) - start_slot
        block_due = index > 0 and elapsed_slots > 0 and elapsed_slots % POS_BLOCK_INTERVAL_SLOTS == 0
        if block_due:
            included = min(accepted_queue, max_transactions_per_block)
            stored_bytes += POS_BLOCK_HEADER_BYTES + included * MODEL_TX_BYTES
            accepted_queue -= included

        mempool_bytes = int(number(sample.get("observedNodePendingTx"))) * MODEL_TX_BYTES
        result.append((stored_bytes + mempool_bytes) / (1024 * 1024))
    return result


def number(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return 0.0


def with_alpha(hex_color, alpha):
    clean = hex_color.lstrip("#")
    r = int(clean[0:2], 16) / 255
    g = int(clean[2:4], 16) / 255
    b = int(clean[4:6], 16) / 255
    return (r, g, b, alpha)


def sanitize_name(value):
    safe = re.sub(r"[^a-zA-Z0-9-]+", "-", str(value).lower()).strip("-")
    return safe or "chart"


if __name__ == "__main__":
    main()
