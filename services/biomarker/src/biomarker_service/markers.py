"""GigaTIME-Flash channel vocabulary + the transparent phenotype gate table (design §5, O1).

The per-cell vector is the source of truth (a mean marker-**presence probability** [0,1] pooled
from the sigmoid mIF — NOT an intensity, review B1). The phenotype is a pure function of which
markers a cell is positive for, positivity being region-relative (per-ROI adaptive threshold).

Lineage is assigned by **first matching rule** (priority order resolves multi-positive cells);
functional flags are independent and additive. This is a documented, adjustable v1 — the whole
gate is data here, not a trained classifier.
"""

from collections.abc import Callable

# Model output channel order (GigaTIME db_test.common_channel_list / the Flash notebook).
CHANNEL_NAMES: list[str] = [
    "DAPI", "TRITC", "Cy5", "PD-1", "CD14", "CD4", "T-bet", "CD34", "CD68",
    "CD16", "CD11c", "CD138", "CD20", "CD3", "CD8", "PD-L1", "CK", "Ki67",
    "Tryptase", "Actin-D", "Caspase3-D", "PHH3-B", "Transgelin",
]
CHANNEL_INDEX: dict[str, int] = {name: i for i, name in enumerate(CHANNEL_NAMES)}

# DAPI is a nuclear reference (used for QC that a centroid sits on a real nucleus); TRITC/Cy5 are
# background channels the authors exclude from analysis. Neither drives phenotype gating.
DAPI_CHANNEL = "DAPI"
BACKGROUND_CHANNELS: frozenset[str] = frozenset({"TRITC", "Cy5"})

# The ~20 usable markers — everything that can gate a phenotype.
MARKER_CHANNELS: list[str] = [
    c for c in CHANNEL_NAMES if c != DAPI_CHANNEL and c not in BACKGROUND_CHANNELS
]

# Lineage rules, evaluated top-to-bottom; the first whose predicate holds over the cell's set of
# positive markers wins. Tumour (CK) is exclusive-first; immune lineages follow; CD3 gates the T
# split. `pos` is the set of region-relative-positive marker names for one cell.
LINEAGE_RULES: list[tuple[str, Callable[[frozenset[str]], bool]]] = [
    ("Tumour", lambda p: "CK" in p),
    ("Endothelial", lambda p: "CD34" in p and "CK" not in p),
    ("Plasma cell", lambda p: "CD138" in p),
    ("B cell", lambda p: "CD20" in p),
    ("Cytotoxic T", lambda p: "CD3" in p and "CD8" in p),
    ("Helper T", lambda p: "CD3" in p and "CD4" in p),
    ("T cell", lambda p: "CD3" in p),
    ("Myeloid", lambda p: bool(p & {"CD68", "CD11c", "CD14", "CD16"})),
    ("Mast cell", lambda p: "Tryptase" in p),
]
DEFAULT_LINEAGE = "Other"

# Names in the order the overlay legend should present them (lineages first, then Other).
PHENOTYPE_ORDER: list[str] = [name for name, _ in LINEAGE_RULES] + [DEFAULT_LINEAGE]

# Functional flags — independent of lineage, additive per cell.
FUNCTIONAL_FLAGS: list[tuple[str, Callable[[frozenset[str]], bool]]] = [
    ("Proliferating", lambda p: "Ki67" in p or "PHH3-B" in p),
    ("Apoptotic", lambda p: "Caspase3-D" in p),
    ("PD-1+", lambda p: "PD-1" in p),
    ("PD-L1+", lambda p: "PD-L1" in p),
    ("T-bet+", lambda p: "T-bet" in p),
]
