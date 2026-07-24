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


def normalize_rgb(rgb: np.ndarray) -> np.ndarray:
    """(H,W,3) uint8 → (3,H,W) float32, rgb/255 then ImageNet MEAN/STD (the Flash contract)."""
    x = rgb.astype(np.float32) / 255.0
    return np.ascontiguousarray(np.transpose((x - _MEAN) / _STD, (2, 0, 1)))


def predict_tile(rgb_tile: np.ndarray, model) -> np.ndarray:
    """Real GigaTIME-Flash forward over one tile → ``[23, h, w]`` sigmoid probs. Lazy torch."""
    import torch  # lazy: only the real (trident) image has torch

    device = next(model.parameters()).device
    t = torch.from_numpy(normalize_rgb(rgb_tile)).unsqueeze(0).to(device)
    _, _, h, w = t.shape
    logits = torch.zeros(1, NUM_CLASSES, h, w, device=device)
    with torch.no_grad():
        for y in range(0, h, WINDOW):
            for x in range(0, w, WINDOW):
                win = t[:, :, y:y + WINDOW, x:x + WINDOW].contiguous()
                logits[:, :, y:y + WINDOW, x:x + WINDOW] = model(win)
    return torch.sigmoid(logits).squeeze(0).cpu().numpy()


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
