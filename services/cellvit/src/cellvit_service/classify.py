"""Step 2: name the outlines an artifact already has, with a classifier head (Inc 7 §6).

No GPU, no encoder, no ray, no slide. Everything this reads is on disk: the per-nucleus tokens
step 1 kept, and the instance raster step 1 drew. What it produces is one taxonomy's sidecar —
its labels, its coverage, its counts and its pictures.

The loop is deliberately the same shape as `nuclei.run_region`'s, because the properties it needs
are the same three Inc 4 and Inc 5 settled on and there is no reason to arrive at them twice:

    a tally is written in the same file, and therefore the same write, as the tile list it describes
    a stop happens at a core boundary, never inside one
    a resume skips what is covered, so re-running a finished taxonomy costs a read

What is *not* the same is the cost. A core is one matmul over a few hundred embeddings, so this is
seconds where segmentation was minutes — which is the whole reason the two are separate steps.
"""

import logging
from pathlib import Path

from .artifacts import (
    Coverage,
    cells_path,
    label_dir,
    labels_path,
    meta_path,
    read_cell_arrays,
    read_json,
    read_tokens,
    tokens_path,
    write_labels,
)
from .heads import load_head
from .nuclei import SlideInfo, refresh_meta, write_label_summary
from .pyramid import levels_for
from .raster import draw_one_class_core, rasterise_labels, scale_for
from .taxonomy import get as get_taxonomy

logger = logging.getLogger(__name__)


class NotClassifiable(RuntimeError):
    """The artifact cannot be classified: no meta, no coverage, or no tokens.

    A 404 or a 409 on the request path, never a 500.
    """


def run_classify(
    *,
    root: Path,
    art: str,
    taxonomy: str,
    report=None,
    should_stop=None,
) -> dict:
    """Label every core this artifact has outlines for, with `taxonomy`. Returns its summary.

    The slide's geometry comes from the artifact's own `meta.json` rather than from Girder: step 1
    already asked and wrote the answer down, and a naming that had to re-authenticate against a
    slide to relabel bytes on disk would be a dependency with nothing behind it.
    """
    tax = get_taxonomy(taxonomy)
    meta = read_json(meta_path(root))
    if not meta:
        raise NotClassifiable(
            "this artifact has no meta.json — there is nothing here to name yet"
        )
    slide = SlideInfo(
        width=int(meta["slide"]["width"]),
        height=int(meta["slide"]["height"]),
        mpp=meta["slide"].get("mpp"),
    )
    offset = int(meta.get("level_offset", 0))
    s = scale_for(offset)
    n_levels = levels_for(-(-slide.width // s), -(-slide.height // s))

    cov = Coverage.load(root)
    if not cov.done:
        raise NotClassifiable("this artifact covers no cores — segment something first")

    lab_root = label_dir(root, tax.id)
    lab = Coverage.load(lab_root)
    todo = lab.missing(sorted(cov.done))
    total = len(todo)

    # Loaded before the loop and before anything is written: a missing checkpoint should refuse the
    # run, not leave half a taxonomy on disk. It also means the Zenodo fetch (D6) happens once.
    head = load_head(tax.id)

    counts = dict((lab.totals or {}).get("counts_by_class") or {})
    n_nuclei = int((lab.totals or {}).get("n_nuclei", 0))
    computed: list[tuple[int, int]] = []
    stopped = False

    for i, (tx, ty) in enumerate(todo):
        if should_stop is not None and should_stop():
            stopped = True
            break

        cells = read_cell_arrays(cells_path(root, tx, ty))
        if cells is None:
            # Coverage says this core was computed but its vectors are gone. Skipping it silently
            # would give the taxonomy a coverage it cannot account for, so it stays uncovered and
            # the run says how many were like this.
            logger.warning("core (%d,%d) is in coverage but has no cells file", tx, ty)
            continue
        n = int(cells["inst"].shape[0])
        tokens = read_tokens(tokens_path(root, tx, ty))
        if tokens is None:
            raise NotClassifiable(
                f"core ({tx},{ty}) has {n} outlines and no tokens — this artifact was segmented "
                f"without them and cannot be classified. Segment the slide again."
            )
        if tokens.shape[0] != n:
            raise NotClassifiable(
                f"core ({tx},{ty}) has {n} outlines but {tokens.shape[0]} tokens — labelling it "
                f"would name each nucleus from a neighbour's embedding"
            )

        cls, prob = head(tokens)
        write_labels(labels_path(root, tax.id, tx, ty), cls=cls, prob=prob)

        n_nuclei += n
        for c in cls.tolist():
            name = tax.name(c)
            counts[name] = counts.get(name, 0) + 1

        # The tallies and the tile list they describe, one atomic write, at the boundary a stop is
        # allowed to happen at.
        lab.add(tx, ty)
        lab.totals = {"n_nuclei": n_nuclei, "counts_by_class": counts}
        lab.save(lab_root)
        computed.append((tx, ty))

        # A lookup over the instance raster already on disk — no polygon is filled here (§5).
        draw_one_class_core(root, tx, ty, s=s, n_levels=n_levels, taxonomy=tax.id)

        if report is not None:
            report("classify", (i + 1) / total if total else 1.0, i + 1, total or None)

    if report is not None:
        report("raster", 0.98)
    rasterise_labels(root, cov=lab, offset=offset, width=slide.width, height=slide.height,
                     taxonomy=tax.id, computed=computed)

    # meta.json lists what the artifact can be shown as, so a new taxonomy has to appear in it
    # before the viewer can offer it.
    refresh_meta(root)

    summary = write_label_summary(root, tax.id, lab, slide.mpp)
    summary["taxonomy"] = tax.id
    summary["stopped"] = stopped
    summary["remaining"] = max(0, len(lab.missing(sorted(cov.done))))
    summary["art_hash"] = art
    logger.info("classified %d core(s) as %s: %s",
                len(computed), tax.id, summary["counts_by_class"])
    return summary


__all__ = ["NotClassifiable", "run_classify"]
