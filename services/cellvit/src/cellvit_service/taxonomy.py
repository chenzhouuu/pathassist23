"""The nucleus taxonomies this service can label an outline with (Inc 7, §4).

Six of them, and the difference between the first and the rest is *when* it is computed, not what
it is. PanNuke comes out of the CellViT decoder alongside the instance masks — one of its three
heads, asserted present by ``check_network_output``, so it costs nothing and cannot be switched
off. The other five are CellViT++ classifier heads: a two-layer MLP over the per-nucleus 1280-d
token, run later, from disk, relabelling outlines that already exist.

That is why they all live in one table. A taxonomy is a naming of the same shapes; nothing here
knows how the naming was produced.

**Stored ids are 1-based, always.** Palette index 0 means "no nucleus here" (Inc 5), which is what
keeps the raster's background and a class from ever being confused. PanNuke's model already emits
1..5; the five heads emit 0-based ids, so ``model_offset`` is 1 for them and 0 for PanNuke. That
shift exists here and nowhere else — everything downstream sees stored ids.

Names are vendored rather than read from the checkpoints, for two reasons. The GPU-free base image
has no ``cellvit`` package, as ``pannuke.py`` already had to work around; and the two NuCLS
checkpoints carry no ``data.label_map`` at all (only ``classification_level``), which is why
``nuclei_taxonomy="nucls_super"`` raises ``KeyError`` inside cellvit 1.0.9. Upstream's own names
for those two are in ``cellvit/training/datasets/nucls.py``.
"""

from dataclasses import dataclass

# Palette index 0 is not a class: it means "no nucleus here". Nothing is ever stored as 0, so the
# raster's background and a nucleus can never be confused.
BACKGROUND_INDEX = 0

# ── the colour language ─────────────────────────────────────────────────────────────
#
# Okabe-Ito, the same source the tissue backend's palette came from, so the two maps can be shown
# together without two unrelated colour languages on one slide.
#
# Assigned by *semantic family*, not per taxonomy: a nucleus called `Neoplastic` by PanNuke,
# `tumor_any` by NuCLS and `Tumor Cell` by OCELOT is the same claim under three names, and it keeps
# vermillion in all three — the colour the tissue map already uses for Tumour, so a nucleus and a
# region agree at two scales. Switching taxonomy then changes the *subdivision* of the picture
# rather than its colours, which is the only way the two can be compared by eye.
TUMOUR = "D55E00"      # vermillion — also the tissue map's Tumour
IMMUNE = "009E73"      # bluish green — lymphocytes, TILs, "inflammatory"
STROMA = "0072B2"      # blue — fibroblasts, connective, "stromal"
EPITHELIUM = "E69F00"  # orange
MITOTIC = "F0E442"     # yellow — a mitotic figure, whatever the taxonomy calls it
MACROPHAGE = "56B4E9"  # sky blue
APOPTOTIC = "CC79A7"   # reddish purple — dead nuclei, and plasma cells where there are no dead
OTHER = "999999"       # mid grey — a class that names the absence of a name


@dataclass(frozen=True)
class Taxonomy:
    """One naming of a nucleus, and everything needed to store, count and draw it.

    ``names`` is keyed by **stored** id (1-based) and holds the upstream spelling — the string a
    count is filed under and a hidden-class toggle keys on, so a nicer label can never break
    either. ``display`` is what a reader sees.
    """

    id: str
    label: str
    organ: str
    #: Checkpoint filename under `$CELLVIT_CACHE/classifier/sam-h/`; None for PanNuke, which is
    #: not a head — segmentation produces it.
    checkpoint: str | None
    #: stored id -> the upstream class name
    names: dict[int, str]
    #: stored id -> what a reader is shown
    display: dict[int, str]
    #: stored id -> 'RRGGBB'
    colors: dict[int, str]
    #: stored_id = model_id + model_offset
    model_offset: int

    @property
    def class_ids(self) -> list[int]:
        """The stored ids in palette order — the order every classes/colors list is built in."""
        return sorted(self.names)

    @property
    def n_classes(self) -> int:
        return len(self.names)

    def name(self, stored_id: int) -> str:
        """Upstream name for a stored id; ``"Unknown"`` for one this taxonomy does not name."""
        return self.names.get(int(stored_id), "Unknown")

    def color(self, stored_id: int) -> str:
        """'RRGGBB' for a stored id; mid-grey for one this taxonomy does not name."""
        return self.colors.get(int(stored_id), OTHER)

    def palette_bytes(self) -> bytes:
        """A 256*3 PIL palette: index 0 black (written out as transparent), then the classes."""
        pal = bytearray(768)
        for i in self.class_ids:
            pal[i * 3: i * 3 + 3] = bytes.fromhex(self.color(i))
        return bytes(pal)

    def as_dict(self) -> dict:
        """The form `meta.json` and `/nuclei/catalog` both carry.

        Names and colours travel with the artifact rather than living in the frontend, so a
        recolour can never drift from the map it is describing.
        """
        return {
            "id": self.id,
            "label": self.label,
            "organ": self.organ,
            "classes": [self.names[i] for i in self.class_ids],
            "display": {self.names[i]: self.display[i] for i in self.class_ids},
            "colors": {self.names[i]: f"#{self.color(i)}" for i in self.class_ids},
            "class_ids": {str(i): self.names[i] for i in self.class_ids},
        }


def _taxonomy(
    tax_id: str, label: str, organ: str, checkpoint: str | None,
    rows: list[tuple[str, str, str]], *, model_offset: int,
) -> Taxonomy:
    """Build one from `(upstream name, display name, colour)` in stored-id order from 1."""
    names, display, colors = {}, {}, {}
    for i, (name, shown, colour) in enumerate(rows, start=1):
        names[i], display[i], colors[i] = name, shown, colour
    return Taxonomy(
        id=tax_id, label=label, organ=organ, checkpoint=checkpoint,
        names=names, display=display, colors=colors, model_offset=model_offset,
    )


#: The taxonomy every artifact has, because segmentation produces it.
DEFAULT = "pannuke"

TAXONOMIES: dict[str, Taxonomy] = {
    # Not a head: the CellViT decoder's own type map. model_offset 0 — it already emits 1..5 with
    # 0 meaning background, which is where this module's 1-based convention came from.
    "pannuke": _taxonomy(
        "pannuke", "PanNuke", "pan-organ (19 tissues)", None,
        [
            ("Neoplastic", "Neoplastic", TUMOUR),
            ("Inflammatory", "Inflammatory", IMMUNE),
            ("Connective", "Connective", STROMA),
            ("Dead", "Dead", APOPTOTIC),
            ("Epithelial", "Epithelial", EPITHELIUM),
        ],
        model_offset=0,
    ),
    # NuCLS: TCGA breast carcinoma, 18 institutions, 220k+ annotated nuclei. Names verbatim from
    # upstream's `cellvit/training/datasets/nucls.py`, which is the only place they exist — the
    # checkpoints carry `classification_level` and no label map.
    "nucls_super": _taxonomy(
        "nucls_super", "NuCLS super", "breast (TCGA-BRCA)", "nucls_super.pth",
        [
            ("tumor_any", "Tumour (any)", TUMOUR),
            ("nonTIL_stromal", "Stromal (non-TIL)", STROMA),
            ("sTIL", "sTIL", IMMUNE),
            ("other_nucleus", "Other", OTHER),
        ],
        model_offset=1,
    ),
    "nucls_main": _taxonomy(
        "nucls_main", "NuCLS main", "breast (TCGA-BRCA)", "nucls_main.pth",
        [
            ("tumor_nonMitotic", "Tumour (non-mitotic)", TUMOUR),
            ("tumor_mitotic", "Tumour (mitotic)", MITOTIC),
            ("nonTILnonMQ_stromal", "Stromal (non-TIL, non-macrophage)", STROMA),
            ("macrophage", "Macrophage", MACROPHAGE),
            ("lymphocyte", "Lymphocyte", IMMUNE),
            # Reddish purple is free here: this taxonomy has no "dead" class, and a plasma cell
            # needs to stay distinguishable from the lymphocyte beside it.
            ("plasma_cell", "Plasma cell", APOPTOTIC),
            ("other_nucleus", "Other", OTHER),
        ],
        model_offset=1,
    ),
    # PanopTILs: breast tumour microenvironment. Its checkpoint is the one head that *does* carry
    # `data.label_map`; these names are that map.
    "panoptils": _taxonomy(
        "panoptils", "PanopTILs", "breast", "panoptils.pth",
        [
            ("Other Cells", "Other cells", OTHER),
            ("Epithelial Cells", "Epithelial cells", EPITHELIUM),
            ("Stromal Cells", "Stromal cells", STROMA),
            ("TILs", "TILs", IMMUNE),
        ],
        model_offset=1,
    ),
    "midog": _taxonomy(
        "midog", "MIDOG", "pan-organ (mitosis)", "midog.pth",
        [
            ("Mitotic", "Mitotic", MITOTIC),
            ("Non-Mitotic", "Non-mitotic", OTHER),
        ],
        model_offset=1,
    ),
    "ocelot": _taxonomy(
        "ocelot", "OCELOT", "multi-organ", "ocelot.pth",
        [
            ("Other Cell", "Other cell", OTHER),
            ("Tumor Cell", "Tumour cell", TUMOUR),
        ],
        model_offset=1,
    ),
}

#: Every taxonomy id, PanNuke first — the order a catalog and a dropdown are built in.
TAXONOMY_IDS: list[str] = [DEFAULT, *(k for k in TAXONOMIES if k != DEFAULT)]

#: The five that need a checkpoint. Deliberately not Lizard or CoNSeP: both are colorectal, both
#: are in the same `classifier.zip`, and neither is offered (D5). Adding one is a row above.
HEAD_IDS: list[str] = [k for k, t in TAXONOMIES.items() if t.checkpoint]


class UnknownTaxonomy(KeyError):
    """Raised for a taxonomy id this service does not have. Callers turn it into a 400."""


def get(tax_id: str | None) -> Taxonomy:
    """The taxonomy for an id, defaulting to PanNuke when none is named."""
    key = (tax_id or DEFAULT).strip()
    try:
        return TAXONOMIES[key]
    except KeyError as exc:
        raise UnknownTaxonomy(
            f"unknown taxonomy {key!r}; this service has {', '.join(TAXONOMY_IDS)}"
        ) from exc


def name_for(stored_id: int, tax_id: str | None = None) -> str:
    return get(tax_id).name(stored_id)


def color_for(stored_id: int, tax_id: str | None = None) -> str:
    return get(tax_id).color(stored_id)


def class_ids(tax_id: str | None = None) -> list[int]:
    return get(tax_id).class_ids


def palette_bytes(tax_id: str | None = None) -> bytes:
    return get(tax_id).palette_bytes()


__all__ = [
    "BACKGROUND_INDEX", "DEFAULT", "HEAD_IDS", "TAXONOMIES", "TAXONOMY_IDS", "Taxonomy",
    "UnknownTaxonomy", "class_ids", "color_for", "get", "name_for", "palette_bytes",
]
