"""Vendored PanNuke class names + overlay colours for the agent loop (GPU-free).

Mirrors CellViT's PanNuke taxonomy/colours (``cellvit.config.config``), vendored because that
package is GPU-only. ``PANNUKE_NAMES`` (id order) drives the loop stub; ``CLASS_HEX`` is the DSA
``point`` element ``lineColor`` (repo ``makePoint`` convention). Names must match the CellViT
service's ``pannuke.TYPE_NAMES``.
"""

# PanNuke ids 1..5 in order — used by the GPU-free loop stub to synthesize typed nuclei.
PANNUKE_NAMES: list[str] = ["Neoplastic", "Inflammatory", "Connective", "Dead", "Epithelial"]

# Official PanNuke overlay colours (COLOR_DICT_CELLS), name -> hex for a DSA element `lineColor`.
CLASS_HEX: dict[str, str] = {
    "Neoplastic": "#ff0000",     # 255, 0, 0
    "Inflammatory": "#22dd4d",   # 34, 221, 77
    "Connective": "#235cec",     # 35, 92, 236
    "Dead": "#feff00",           # 254, 255, 0
    "Epithelial": "#ff9f44",     # 255, 159, 68
}


__all__ = ["PANNUKE_NAMES", "CLASS_HEX"]
