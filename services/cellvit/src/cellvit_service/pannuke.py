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


__all__ = ["TYPE_NAMES", "name_for"]
