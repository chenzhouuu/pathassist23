"""ResNet50-UNet — the architecture behind TIAToolbox's ``fcn_resnet50_unet-bcss`` checkpoint.

Re-implemented from the TIAToolbox reference (``tiatoolbox/models/architecture/unet.py``,
BSD-3-Clause, © TIA Centre, University of Warwick) rather than depending on the package: the
weights are one 120-line network, and installing tiatoolbox would drag openslide-python, shapely,
scikit-image, zarr and its own ``WSIReader`` into the image for a slide reader we already have.
Same pattern as ``biomarker/_arch.py`` for GigaTIME-Flash.

torch/torchvision are imported at module top **on purpose** — this module is imported lazily
(only from ``model.load_backend``, only on the GPU image), so the base GPU-free env never touches
it. Do not import this from any base-path code.

**Verified bit-exact against the reference.** With
``UNetModel(num_input_channels=3, num_output_channels=5, encoder="resnet50",
decoder_block=[3, 3], skip_type="add")`` and the same checkpoint, this module and TIAToolbox agree
to ``max|Δ| = 0.0`` with 100 % argmax agreement at both 512 px and 1024 px inputs. That check lives
in ``tests/test_arch_reference.py`` and is skipped when tiatoolbox is not installed — it is a
development gate, not a runtime dependency.

**Every structural choice below is forced by the checkpoint, not guessed:**

- ``skip_type = "add"``. ``uplist.0``'s input BatchNorm has **1024** channels. The upsampled
  ``conv1x1`` output (1024) *concatenated* with ``layer3`` (1024) would be 2048; *added*, it is
  1024. Every level agrees (512+512, 256+256, 64+64).
- Decoder convolutions are **same**-padded. An additive skip requires exact spatial agreement
  between the decoder feature and the encoder feature, which valid convolutions would break.
- ``conv1x1`` and the decoder convolutions are **bias-free** (only ``.weight`` present);
  ``clf`` has a bias.
- Block order is pre-activation ``BN → ReLU → Conv → BN → ReLU → Conv``: parameters live at
  indices 0/2/3/5 with 1/4 parameter-free.

Input contract: a float tensor already scaled to **[0, 1]** — see ``infer.NORMALISE``.
"""

import torch
from torch import nn
from torch.nn import functional as F  # noqa: N812
from torchvision.models import resnet50

# The decoder's per-level output channels, read straight off the checkpoint.
_UP_CHANNELS = ((1024, 512), (512, 256), (256, 64), (64, 64))


class UpSample2x(nn.Module):
    """Nearest-neighbour 2x upsample expressed as an outer product with a ones(2,2) matrix.

    Implemented this way (rather than as ``F.interpolate``) because the checkpoint carries the
    matrix as a buffer, ``upsample2x.unpool_mat``, and a strict load must find it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.register_buffer("unpool_mat", torch.ones(2, 2, dtype=torch.float32))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        n, c, h, w = x.shape
        mat = self.unpool_mat.to(x.dtype)
        out = x.reshape(n, c, h, w, 1, 1) * mat.reshape(1, 1, 1, 1, 2, 2)
        out = out.permute(0, 1, 2, 4, 3, 5)          # N C H 2 W 2
        return out.reshape(n, c, h * 2, w * 2)


def _up_block(in_ch: int, out_ch: int) -> nn.Sequential:
    """Pre-activation decoder block. Indices must stay 0/1/2/3/4/5 to match the checkpoint."""
    return nn.Sequential(
        nn.BatchNorm2d(in_ch),                                   # 0
        nn.ReLU(inplace=True),                                   # 1
        nn.Conv2d(in_ch, out_ch, 3, padding=1, bias=False),      # 2
        nn.BatchNorm2d(out_ch),                                  # 3
        nn.ReLU(inplace=True),                                   # 4
        nn.Conv2d(out_ch, out_ch, 3, padding=1, bias=False),     # 5
    )


class UNetModel(nn.Module):
    """ResNet50 encoder + additive-skip UNet decoder → per-class probabilities."""

    def __init__(self, num_output_channels: int = 5) -> None:
        super().__init__()
        # Kept whole (including the unused `fc`) so a strict load finds every `backbone.*` key.
        self.backbone = resnet50(weights=None)
        self.conv1x1 = nn.Conv2d(2048, 1024, 1, bias=False)
        self.uplist = nn.ModuleList([_up_block(i, o) for i, o in _UP_CHANNELS])
        self.upsample2x = UpSample2x()
        self.clf = nn.Conv2d(_UP_CHANNELS[-1][1], num_output_channels, 1, bias=True)

    def encode(self, x: torch.Tensor) -> list[torch.Tensor]:
        """The five encoder feature maps: stem /2, layer1 /4, layer2 /8, layer3 /16, layer4 /32."""
        b = self.backbone
        x = b.relu(b.bn1(b.conv1(x)))
        stem = x                                  # 64 @ /2
        x = b.maxpool(x)
        c1 = b.layer1(x)                          # 256 @ /4
        c2 = b.layer2(c1)                         # 512 @ /8
        c3 = b.layer3(c2)                         # 1024 @ /16
        c4 = b.layer4(c3)                         # 2048 @ /32
        return [stem, c1, c2, c3, c4]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """``x`` float NCHW in [0, 1] → softmax probabilities NCHW at the input's resolution."""
        stem, c1, c2, c3, c4 = self.encode(x)
        d = self.conv1x1(c4)
        for block, skip in zip(self.uplist, (c3, c2, c1, stem), strict=True):
            d = block(self.upsample2x(d) + skip)
        logits = self.clf(d)                                      # /2
        prob = torch.softmax(logits, dim=1)
        return F.interpolate(prob, scale_factor=2, mode="bilinear", align_corners=False)


def build(num_output_channels: int = 5) -> UNetModel:
    return UNetModel(num_output_channels=num_output_channels)
