"""Vendored PanNuke nucleus taxonomy (GPU-free).

The authoritative values live in ``cellvit.config.config.TYPE_NUCLEI_DICT_PANNUKE``, but that
package ships only in the GPU Dockerfile (imported lazily) — the base/CI env has no ``cellvit``.
So the id->name map is vendored here as a plain constant. Keep it in sync with CellViT's PanNuke
taxonomy.
"""

# id 0 = Background (never present in cells.json). ids 1..5 are the PanNuke classes.
TYPE_NAMES: dict[int, str] = {
    1: "Neoplastic",
    2: "Inflammatory",
    3: "Connective",
    4: "Dead",
    5: "Epithelial",
}


def name_for(type_id: int) -> str:
    """PanNuke class name for a nucleus ``type`` id; ``"Unknown"`` for anything out of range."""
    return TYPE_NAMES.get(int(type_id), "Unknown")


# Okabe-Ito, the same source the tissue backend's palette came from, so the two maps can be shown
# together without two unrelated colour languages on one slide. Assigned by what the reader looks
# for: Neoplastic takes vermillion (the tissue map's Tumour colour, deliberately — a nucleus called
# neoplastic and a region called tumour are the same claim at two scales), and the rest are chosen
# to stay separable from each other and from H&E's pink-and-purple underneath.
TYPE_COLORS: dict[int, str] = {
    1: "D55E00",   # Neoplastic
    2: "009E73",   # Inflammatory
    3: "0072B2",   # Connective
    4: "CC79A7",   # Dead
    5: "E69F00",   # Epithelial
}

# Palette index 0 is not a class: it means "no nucleus here". Nothing is ever written as class 0,
# so the raster's background and a nucleus can never be confused.
BACKGROUND_INDEX = 0


def color_for(type_id: int) -> str:
    """'RRGGBB' for a nucleus class id; mid-grey for one the taxonomy does not name."""
    return TYPE_COLORS.get(int(type_id), "999999")


def class_ids() -> list[int]:
    """The class ids in palette order — the order every classes/colors list is built in."""
    return sorted(TYPE_NAMES)


def palette_bytes() -> bytes:
    """A 256*3 PIL palette: index 0 black (written out as transparent), then the class colours."""
    pal = bytearray(768)
    for i in class_ids():
        pal[i * 3: i * 3 + 3] = bytes.fromhex(color_for(i))
    return bytes(pal)


__all__ = [
    "BACKGROUND_INDEX", "TYPE_COLORS", "TYPE_NAMES", "class_ids", "color_for", "name_for",
    "palette_bytes",
]
