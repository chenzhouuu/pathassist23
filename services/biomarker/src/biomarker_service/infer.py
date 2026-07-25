"""mIF inference seam: one tile of H&E → a ``[23, h, w]`` marker-presence-probability map [0,1].

Dispatch on the service mode (config): ``"real"`` runs GigaTIME-Flash (torch, imported lazily so
the base env stays GPU-free); ``"stub"`` returns a deterministic dev field so the whole phenotype
path is browser-E2E-able with no GPU. The caller (pipeline.py) drives this **tile by tile** and
pools each tile's cells immediately, so the full ROI raster is never materialised (review S2).
"""

import numpy as np

# ImageNet normalisation (the Flash reference), applied to rgb/255 before the ViT.
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# GigaTIME-Flash runs on 256×256 windows; a tile is split into windows and re-tiled.
WINDOW = 256
# Tile side fed per read/inference step (the reference feeds native 512 tiles). Also the memory
# unit: one tile's mIF (23×512×512 f32 ≈ 24 MB), never the whole ROI.
TILE = 512

NUM_CLASSES = 23


def window_padding(h: int, w: int, window: int = WINDOW) -> tuple[int, int]:
    """Right/bottom pad (ph, pw) that grows ``h×w`` to a whole number of ``window`` tiles (C1).

    Pure (no torch) so the 256-multiple invariant is unit-tested in the GPU-free env, where
    predict_tile itself can't run."""
    return (window - h % window) % window, (window - w % window) % window


def normalize_rgb(rgb: np.ndarray) -> np.ndarray:
    """(H,W,3) uint8 → (3,H,W) float32, rgb/255 then ImageNet MEAN/STD (the Flash contract)."""
    x = rgb.astype(np.float32) / 255.0
    return np.ascontiguousarray(np.transpose((x - _MEAN) / _STD, (2, 0, 1)))


# Windows are inferred with an overlap and feathered together (Inc 3b). Butt-jointed 256 windows
# leave a visible grid in the marker map: a ViT window has no context past its own edge, so two
# neighbouring windows disagree along their shared seam, and at 40x that seam repeats every 256 px
# across the whole slide. Overlapping by OVERLAP and cross-fading over that band makes the join
# continuous. Cost is (256/(256-OVERLAP))^2 ≈ 1.8x windows — paid once, at build time.
OVERLAP = 64


def _feather(window: int, overlap: int, device, torch):
    """A separable 2-D weight that ramps 0→1 across ``overlap`` at each edge, flat in the middle."""
    ramp = torch.ones(window, device=device)
    if overlap > 0:
        edge = torch.linspace(1.0 / (overlap + 1), 1.0 - 1.0 / (overlap + 1), overlap,
                              device=device)
        ramp[:overlap] = edge
        ramp[window - overlap:] = edge.flip(0)
    return (ramp[:, None] * ramp[None, :])[None, None]


def predict_tile(rgb_tile: np.ndarray, model) -> np.ndarray:
    """Real GigaTIME-Flash forward over one tile → ``[23, h, w]`` sigmoid probs. Lazy torch.

    GigaTIME-Flash only accepts 256×256 windows (its ViT patch grid and decoder output are fixed
    at 256), so a tile is padded up to a whole number of 256 windows, inferred window-by-window,
    then cropped back. Without the pad, a user ROI whose side isn't a multiple of 256 produces a
    partial edge window and the forward raises (review C1).

    Windows OVERLAP and are feathered together, because butt-jointed windows print a 256-px grid
    across the map (see OVERLAP)."""
    import torch  # lazy: only the real (trident) image has torch
    from torch.nn.functional import pad as _pad

    device = next(model.parameters()).device
    t = torch.from_numpy(normalize_rgb(rgb_tile)).unsqueeze(0).to(device)
    _, _, h, w = t.shape
    ph, pw = window_padding(h, w)
    if ph or pw:
        t = _pad(t, (0, pw, 0, ph), mode="replicate")  # extend right/bottom to a 256 multiple
    _, _, hp, wp = t.shape

    stride = WINDOW - OVERLAP
    weight = _feather(WINDOW, OVERLAP, device, torch)
    acc = torch.zeros(1, NUM_CLASSES, hp, wp, device=device)
    wsum = torch.zeros(1, 1, hp, wp, device=device)
    # Start positions cover the padded tile and always include the last full window, so the right
    # and bottom edges get a whole window rather than a partial one.
    ys = sorted({*range(0, max(hp - WINDOW, 0) + 1, stride), max(hp - WINDOW, 0)})
    xs = sorted({*range(0, max(wp - WINDOW, 0) + 1, stride), max(wp - WINDOW, 0)})
    with torch.no_grad():
        for y in ys:
            for x in xs:
                win = t[:, :, y:y + WINDOW, x:x + WINDOW].contiguous()
                acc[:, :, y:y + WINDOW, x:x + WINDOW] += model(win) * weight
                wsum[:, :, y:y + WINDOW, x:x + WINDOW] += weight
    logits = acc / wsum.clamp_min(1e-6)
    return torch.sigmoid(logits[:, :, :h, :w]).squeeze(0).cpu().numpy()


def stub_tile(rgb_tile: np.ndarray) -> np.ndarray:
    """Deterministic dev-stub mIF (no GPU): channel-distinct, spatially-varying probs in [0,1].

    Not a scientific prediction — a plumbing field so the tool → fusion → overlay path is
    browser-E2E-able and produces a *mix* of phenotypes to look at. Derived only from the tile's
    own pixels, so it is deterministic and reproducible.
    """
    h, w = rgb_tile.shape[:2]
    rgb = rgb_tile.astype(np.float32) / 255.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    out = np.empty((NUM_CLASSES, h, w), dtype=np.float32)
    for i in range(NUM_CLASSES):
        # a per-channel linear mix of the RGB planes + a channel phase, squashed to [0,1]
        field = (0.6 * r + 0.3 * g + 0.1 * b) * (i + 1) + 0.13 * i
        out[i] = 0.5 + 0.5 * np.sin(field * (1.0 + 0.05 * i))
    return out


def tile_fn(mode: str, model):
    """Pick the per-tile predictor for the current mode (``model`` used only on the real path)."""
    if mode == "real":
        return lambda rgb: predict_tile(rgb, model)
    return stub_tile
