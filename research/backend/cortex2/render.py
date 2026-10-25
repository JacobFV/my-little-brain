"""Matplotlib renders of a job: the image the vision model critiques and the UI shows as provenance."""
from __future__ import annotations

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from . import inverse as inv, neural as nm  # noqa: E402

INK, MUTED, ACCENT, WARM, GOOD = "#3b3f46", "#9aa0a6", "#6f8fd6", "#e09a5b", "#4fa88f"


def _landscape_grid(values: np.ndarray) -> np.ndarray:
    """256 states → 16x16: rows (P, c2) levels, columns (c1, tau) levels."""
    lv = nm.bits_to_levels(nm.all_bits())
    grid = np.full((16, 16), np.nan)
    for k, (p, c2, c1, tau) in enumerate(lv):
        grid[p * 4 + c2, c1 * 4 + tau] = values[k]
    return grid


def job_figure(exp: dict, job: dict) -> bytes:
    ev = job["evaluation"]
    target = inv.Target(exp["target"]["source"], np.asarray(exp["target"]["features"]),
                        np.asarray(exp["target"]["weights"]), exp["target"]["label"],
                        truth_bits=nm.bitstring_to_bits(exp["target"]["truth_bitstring"]) if exp["target"].get("truth_bitstring") else None)
    best = ev["best"]["bitstring"]
    fig = plt.figure(figsize=(12, 7.2), dpi=110)
    gs = fig.add_gridspec(2, 3, height_ratios=[1, 1.05], hspace=0.42, wspace=0.28)
    fig.suptitle(f"{job['provider']} · {job.get('approximation')} · best validated {best} "
                 f"(loss {ev['best_nonlinear_loss']:.3f}; min {ev['min_possible_loss']:.3f})", color=INK, fontsize=11)

    ax = fig.add_subplot(gs[0, :2])
    obs = np.asarray(exp["observed_trace"]["samples"])
    fs_obs = exp["observed_trace"]["fs"]
    t_obs = np.arange(len(obs)) / fs_obs
    sim = inv.simulated_trace(best, seconds=min(4.0, t_obs[-1] if len(t_obs) else 2.0))
    t_sim = np.arange(len(sim)) / nm.SIM_FS
    ax.plot(t_obs, obs, color=INK, lw=0.9, label="observed (z-scored)")
    ax.plot(t_sim, sim - 4, color=ACCENT, lw=0.9, label=f"model {best} (offset)")
    if target.truth_bits is not None and nm.bits_to_bitstring(target.truth_bits) != best:
        tr = inv.simulated_trace(nm.bits_to_bitstring(target.truth_bits), seconds=len(sim) / nm.SIM_FS)
        ax.plot(t_sim[:len(tr)], tr[:len(t_sim)] - 8, color=GOOD, lw=0.8, label="hidden truth (offset)")
    ax.set_xlabel("s"); ax.set_yticks([]); ax.legend(loc="upper left", bbox_to_anchor=(1.0, 1.0), fontsize=7, frameon=False)
    ax.set_title("waveform: observed vs simulated", fontsize=9, color=MUTED)

    ax = fig.add_subplot(gs[0, 2])
    table = nm.forward_table().features
    x = np.arange(nm.N_FEATURES)
    ax.bar(x - 0.2, target.features, 0.4, color=INK, label="observed")
    ax.bar(x + 0.2, table[nm.grid_index(nm.bitstring_to_bits(best))], 0.4, color=ACCENT, label="best model")
    ax.set_xticks(x, [n.replace("rel_logpow_", "").replace("Hz", "") for n in nm.FEATURE_NAMES], rotation=70, fontsize=6)
    ax.set_title("features (log rel. band power, amplitude)", fontsize=9, color=MUTED); ax.legend(fontsize=7, frameon=False)

    ax = fig.add_subplot(gs[1, 0])
    cands = sorted(ev["candidates"], key=lambda c: -c["samples"])[:16]
    colors = [GOOD if c["consistent"] else (ACCENT if c.get("validated") else MUTED) for c in cands]
    ax.barh(range(len(cands))[::-1], [c["probability"] for c in cands], color=colors)
    ax.set_yticks(range(len(cands))[::-1], [f"{c['bitstring']}  L={c['nonlinear_loss']:.2f}" for c in cands], fontsize=6, family="monospace")
    ax.set_title(f"top sampled states (green = consistent, blue = validated)", fontsize=9, color=MUTED)

    losses = inv.nonlinear_losses(target)
    ax = fig.add_subplot(gs[1, 1])
    im = ax.imshow(_landscape_grid(np.log10(losses + 1e-3)), cmap="magma_r")
    ax.set_title("nonlinear loss landscape (log10)", fontsize=9, color=MUTED)
    ax.set_xlabel("c1 level × τ level"); ax.set_ylabel("P level × c2 level")
    fig.colorbar(im, ax=ax, fraction=0.046)
    probs = np.zeros(nm.N_STATES)
    for s, n in job["counts"].items():
        probs[nm.grid_index(nm.bitstring_to_bits(s))] = n / ev["shots"]
    ax2 = fig.add_subplot(gs[1, 2])
    im2 = ax2.imshow(_landscape_grid(probs), cmap="Blues")
    lv = nm.bits_to_levels(nm.bitstring_to_bits(best))[0]
    ax2.scatter([lv[2] * 4 + lv[3]], [lv[0] * 4 + lv[1]], s=60, facecolors="none", edgecolors=WARM, label="best")
    if target.truth_bits is not None:
        tl = nm.bits_to_levels(target.truth_bits)[0]
        ax2.scatter([tl[2] * 4 + tl[3]], [tl[0] * 4 + tl[1]], marker="x", color=GOOD, label="truth")
    ax2.legend(fontsize=7, frameon=False, loc="lower right")
    ax2.set_title(f"sample distribution · P(consistent) {ev['p_consistent']:.3f} vs {ev['uniform_p_consistent']:.3f} uniform",
                  fontsize=8, color=MUTED)
    fig.colorbar(im2, ax=ax2, fraction=0.046)
    tr = job.get("transpiled") or {}
    if tr:
        fig.text(0.01, 0.005, f"physical gates {tr.get('gates')} (budget {tr.get('budget')}), 2q gates {tr.get('two_qubit_gates')}, "
                 f"2q depth {tr.get('two_qubit_depth')}, target {tr.get('backend')}", fontsize=8, color=MUTED)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def agent_figure(exp: dict, job: dict, observed: dict[str, float]) -> bytes:
    """Search-side figure for the design agent: only hypotheses that were actually forward-simulated.

    Unlike `job_figure` (the evaluator view for humans) it shows no loss landscape, no global minimum and
    no hidden truth, so the agent cannot steer its search with oracle information.
    """
    ev = job["evaluation"]
    best_known = min(observed, key=observed.get) if observed else ev["best"]["bitstring"]
    fig = plt.figure(figsize=(12, 6.6), dpi=100)
    gs = fig.add_gridspec(2, 3, height_ratios=[1, 1.05], hspace=0.45, wspace=0.3)
    fig.suptitle(f"{job['provider']} · {job.get('approximation')} · job best validated {ev['best']['bitstring']} "
                 f"(loss {ev['best_nonlinear_loss']:.3f}) · experiment best {best_known} "
                 f"({observed.get(best_known, float('nan')):.3f})", color=INK, fontsize=10)

    ax = fig.add_subplot(gs[0, :2])
    obs = np.asarray(exp["observed_trace"]["samples"])
    t_obs = np.arange(len(obs)) / exp["observed_trace"]["fs"]
    sim = inv.simulated_trace(best_known, seconds=min(4.0, t_obs[-1] if len(t_obs) else 2.0))
    ax.plot(t_obs, obs, color=INK, lw=0.9, label="observed (z-scored)")
    ax.plot(np.arange(len(sim)) / nm.SIM_FS, sim - 4, color=ACCENT, lw=0.9, label=f"best validated {best_known} (offset)")
    ax.set_yticks([]); ax.set_xlabel("s")
    ax.legend(loc="upper left", bbox_to_anchor=(1.0, 1.0), fontsize=7, frameon=False)
    ax.set_title("waveform: observed vs best validated hypothesis", fontsize=9, color=MUTED)

    ax = fig.add_subplot(gs[0, 2])
    x = np.arange(nm.N_FEATURES)
    ax.bar(x - 0.2, exp["target"]["features"], 0.4, color=INK, label="observed")
    ax.bar(x + 0.2, nm.forward_table().features[nm.grid_index(nm.bitstring_to_bits(best_known))], 0.4,
           color=ACCENT, label="best validated")
    ax.set_xticks(x, [n.replace("rel_logpow_", "").replace("Hz", "") for n in nm.FEATURE_NAMES], rotation=70, fontsize=6)
    ax.legend(fontsize=7, frameon=False)
    ax.set_title("features", fontsize=9, color=MUTED)

    ax = fig.add_subplot(gs[1, 0])
    cands = sorted(ev["candidates"], key=lambda c: -c["samples"])[:16]
    labels = [f"{c['bitstring']}  " + (f"L={observed[c['bitstring']]:.2f}" if c["bitstring"] in observed else "unsimulated")
              for c in cands]
    ax.barh(range(len(cands))[::-1], [c["probability"] for c in cands],
            color=[ACCENT if c["bitstring"] in observed else MUTED for c in cands])
    ax.set_yticks(range(len(cands))[::-1], labels, fontsize=6, family="monospace")
    ax.set_title("most-sampled states (blue = forward-simulated)", fontsize=9, color=MUTED)

    ax = fig.add_subplot(gs[1, 1:])
    new = {c["bitstring"] for c in ev.get("validated", [])}
    items = list(observed.items())
    ax.scatter(range(len(items)), [np.log10(v + 1e-3) for _, v in items],
               c=[WARM if s in new else ACCENT for s, _ in items], s=14)
    ax.set_xlabel("forward simulation # (validation order)")
    ax.set_ylabel("log10 loss")
    ax.set_title(f"every hypothesis simulated so far ({len(items)}/256; orange = this job)", fontsize=9, color=MUTED)
    tr = job.get("transpiled") or {}
    if tr:
        fig.text(0.01, 0.005, f"physical gates {tr.get('gates')} (budget {tr.get('budget')}), 2q gates {tr.get('two_qubit_gates')}, "
                 f"2q depth {tr.get('two_qubit_depth')}, target {tr.get('backend')}", fontsize=8, color=MUTED)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def spectrogram_grid(src: dict, channels: list[str] | None = None, max_channels: int = 23) -> bytes:
    """Stacked per-channel log spectrograms (1–45 Hz) with annotated events; what Gemini 'sees' in triage."""
    from scipy.signal import spectrogram

    names = src["names"]
    idx = [names.index(c) for c in channels if c in names] if channels else list(range(len(names)))
    idx = idx[:max_channels]
    fs = src["fs"]
    n = len(idx)
    fig, axes = plt.subplots(n, 1, figsize=(12, 0.62 * n + 1.2), dpi=100, sharex=True, squeeze=False)
    nper = int(min(fs * 2, src["data"].shape[1]))
    for row, i in enumerate(idx):
        ax = axes[row, 0]
        f, t, S = spectrogram(src["data"][i], fs=fs, nperseg=nper, noverlap=int(nper * 0.75))
        keep = (f >= 1) & (f <= 45)
        ax.pcolormesh(src["start"] + t, f[keep], 10 * np.log10(S[keep] + 1e-12), shading="auto", cmap="magma")
        ax.set_ylabel(names[i], rotation=0, ha="right", va="center", fontsize=7)
        ax.set_yticks([4, 8, 13, 30])
        ax.tick_params(labelsize=5)
        for e in src.get("events", []):
            if e["end"] > src["start"] and e["start"] < src["end"]:
                ax.axvline(max(e["start"], src["start"]), color="#7ee0c3", lw=1)
                ax.axvline(min(e["end"], src["end"]), color="#7ee0c3", lw=1, ls="--")
    axes[-1, 0].set_xlabel("time (s)  ·  y: frequency (Hz, ticks at 4/8/13/30)  ·  green: annotated seizure", fontsize=8)
    fig.suptitle(f"{src['label']} · {src['start']:.0f}–{src['end']:.0f} s · per-channel spectrograms (log power)", fontsize=10, color=INK)
    fig.tight_layout(rect=(0, 0, 1, 0.98))
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()
