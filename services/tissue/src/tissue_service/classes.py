"""The tissue vocabulary: classes, palette and the backend catalog (Inc 4, design §4.3).

A *backend* is one trained dense segmenter. Its class list is its own — a future self-trained
decoder may predict a different set — so nothing downstream (artifact, tile server, panel) may
hardcode the five BCSS classes. Everything reads this table, and the panel reads it over
``/tissue/catalog``.

Palette index 0 is deliberately NOT a class. BCSS has no background output: the model will
confidently label glass. Index 0 is written wherever a pixel falls outside the parent
segmentation's tissue contours, which is what keeps every area fraction honest.
"""

from dataclasses import dataclass

BACKGROUND_INDEX = 0


@dataclass(frozen=True)
class Backend:
    """One dense tissue segmenter: what it predicts, at what resolution, under what licence."""

    name: str
    classes: tuple[str, ...]
    colors: tuple[str, ...]           # parallel to classes; palette index i+1
    input_mpp: float                  # the mpp the network was trained to see
    patch_in: int                     # network input side, level-0 px at input_mpp
    patch_out: int                    # network output side after the centre crop
    trained_on: str
    weights_license: str
    weights_file: str
    description: str

    def index(self, name: str) -> int:
        """Palette index for a class name (1-based); 0 for anything unknown."""
        try:
            return self.classes.index(name) + 1
        except ValueError:
            return BACKGROUND_INDEX


# Okabe-Ito derived, chosen so tumour and stroma are maximally separated and "Others" reads as
# neutral rather than as a finding.
BCSS = Backend(
    name="bcss_fcn_unet",
    classes=("Tumour", "Stroma", "Inflammatory", "Necrosis", "Others"),
    colors=("D55E00", "0072B2", "009E73", "CC79A7", "999999"),
    input_mpp=0.25,
    patch_in=1024,
    patch_out=512,
    trained_on="BCSS · breast (H&E)",
    weights_license="CC-BY-NC-4.0",
    weights_file="fcn_resnet50_unet-bcss.pth",
    description=(
        "FCN-ResNet50 encoder with a UNet decoder, trained on the Breast Cancer Semantic "
        "Segmentation (BCSS) dataset. Architecture from TIAToolbox (BSD-3); weights are "
        "CC-BY-NC-4.0, i.e. non-commercial."
    ),
)

BACKENDS: dict[str, Backend] = {BCSS.name: BCSS}
DEFAULT_BACKEND = BCSS.name


def get_backend(name: str | None) -> Backend:
    """Resolve a backend name, falling back to the default. Raises on an unknown *explicit* name."""
    if not name:
        return BACKENDS[DEFAULT_BACKEND]
    if name not in BACKENDS:
        raise KeyError(f"unknown backend {name!r}; known: {sorted(BACKENDS)}")
    return BACKENDS[name]


def palette_bytes(backend: Backend) -> bytes:
    """A 256*3 PIL palette: index 0 black (rendered transparent), then the class colours."""
    pal = bytearray(768)
    for i, hexed in enumerate(backend.colors, start=1):
        pal[i * 3: i * 3 + 3] = bytes.fromhex(hexed.lstrip("#"))
    return bytes(pal)


def catalog() -> dict:
    """Everything the panel needs to render its controls without hardcoding biology."""
    return {
        "backends": {
            b.name: {
                "classes": list(b.classes),
                "colors": {c: f"#{col}" for c, col in zip(b.classes, b.colors, strict=True)},
                "input_mpp": b.input_mpp,
                "trained_on": b.trained_on,
                "weights_license": b.weights_license,
                "description": b.description,
            }
            for b in BACKENDS.values()
        },
        "default_backend": DEFAULT_BACKEND,
    }
