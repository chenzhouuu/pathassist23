"""Generate the L1 golden fixture from hgmil's OWN ABMIL code + the real checkpoint.

The bag is synthesised from a fixed seed and scaled to real CONCH feature statistics (measured
below), so nothing large has to be committed while the arithmetic exercised is identical.
"""
import json
import sys
from pathlib import Path

import h5py
import numpy as np
import torch

sys.path.insert(0, "/home/chen/hgmil/lcr-mil/src")
from lcr_mil.teacher.abmil import ABMIL  # noqa: E402

FEAT_DIR = Path(
    "/home/chen/MIL-Lab/trident_processed/tcga_brca"
    "/20x_256px_0px_overlap/features_conch_v1"
)
CKPT = Path("/home/chen/data2/models/mil/brca_idc_ilc_abmil_conch_fold0.pt")
N, DIM, SEED = 48, 512, 20260723

# ── measure real CONCH feature statistics so the synthetic bag is realistically scaled
sample = sorted(FEAT_DIR.glob("*.h5"))[:3]
vals = []
for p in sample:
    with h5py.File(p, "r") as f:
        vals.append(np.asarray(f["features"][:256], dtype=np.float64))
real = np.concatenate(vals, axis=0)
mu, sd = float(real.mean()), float(real.std())
print(f"real CONCH stats over {real.shape}: mean={mu:.6f} std={sd:.6f}")

# ── the fixture bag (must match tests/test_predict.py exactly)
rng = np.random.default_rng(SEED)
bag = (rng.standard_normal((N, DIM)) * sd + mu).astype(np.float32)

# ── reference forward, using hgmil's own module
ckpt = torch.load(CKPT, map_location="cpu", weights_only=True)
sd_ = ckpt["model_state_dict"]
model = ABMIL(in_dim=512, embed_dim=256, attn_dim=128, num_classes=2, dropout=0.25)
model.load_state_dict(sd_, strict=True)
model.eval()

with torch.no_grad():
    x = torch.from_numpy(bag)
    out = model(x, return_attention=True)
    logits = out["logits"][0]
    probs = torch.softmax(logits, dim=0)
    attention = out["attention"]

    # per-patch class evidence, derived the same way predict.py does
    h = model.patch_embed(x)
    per_patch = model.classifier(h)
    pred = int(torch.argmax(probs).item())
    evidence = attention * (per_patch[:, pred] - per_patch[:, 1 - pred])

margin = float((logits[pred] - logits[1 - pred]).item())
print(f"pred={pred} probs={probs.tolist()}")
print(f"Σevidence={float(evidence.sum()):.8f}  logit_margin={margin:.8f}")

golden = {
    "_note": (
        "Generated from lcr_mil.teacher.abmil.ABMIL with the real checkpoint. "
        "Regenerate with tests/fixtures/gen_abmil_golden.py if the weights change."
    ),
    "seed": SEED, "n": N, "dim": DIM,
    "feature_mean": round(mu, 6), "feature_std": round(sd, 6),
    "weights_sha256": "dccf8dec80bb2c4a0aa607f9311ebedc162e6c42a9d2630be76e4e79012cd55b",
    "pred_index": pred,
    "probs": [float(v) for v in probs],
    "logits": [float(v) for v in logits],
    "logit_margin": margin,
    "attention": [float(v) for v in attention],
    "evidence": [float(v) for v in evidence],
}
dest = Path(sys.argv[1])
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(golden, indent=1) + "\n")
print("wrote", dest, dest.stat().st_size, "bytes")
