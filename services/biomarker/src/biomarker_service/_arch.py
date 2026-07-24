"""GigaTIME-Flash architecture — a faithful port of prov-gigatime/GigaTIME's Flash notebook
(`scripts/gigatime_flash_tcga_wsi_inference.ipynb`): a DINOv2-small ViT with LoRA adapters and a
conv decoder → 23-channel logits (sigmoid applied by the caller in infer.predict_tile).

torch + timm are imported at module top **on purpose** — this module is imported lazily
(only from model.load_flash, only on the real/trident image), so the base GPU-free env never
touches it. Do not import this from any base-path code.
"""

import torch
from timm.layers import SwiGLUPacked
from timm.models.vision_transformer import _create_vision_transformer
from torch import nn


class LoraConfig:
    def __init__(self, r=8, lora_alpha=16, lora_dropout=0.1, target_modules=None):
        self.r = r
        self.lora_alpha = lora_alpha
        self.lora_dropout = lora_dropout
        self.target_modules = target_modules or []


class LoRALinear(nn.Module):
    def __init__(self, base_layer, config):
        super().__init__()
        self.base_layer = base_layer
        self.scaling = {"default": config.lora_alpha / config.r}
        self.lora_dropout = nn.ModuleDict({"default": nn.Dropout(config.lora_dropout)})
        self.lora_A = nn.ModuleDict(
            {"default": nn.Linear(base_layer.in_features, config.r, bias=False)}
        )
        self.lora_B = nn.ModuleDict(
            {"default": nn.Linear(config.r, base_layer.out_features, bias=False)}
        )

    @property
    def weight(self):
        return self.base_layer.weight

    @property
    def bias(self):
        return self.base_layer.bias

    def forward(self, x):
        result = self.base_layer(x)
        update = self.lora_B["default"](self.lora_A["default"](self.lora_dropout["default"](x)))
        return result + update * self.scaling["default"]


class BaseModelWrapper(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model


class PeftFallbackModel(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.base_model = BaseModelWrapper(model)

    def __getattr__(self, name):
        try:
            return super().__getattr__(name)
        except AttributeError:
            return getattr(self.base_model.model, name)

    def forward(self, *a, **k):
        return self.base_model.model(*a, **k)


def apply_lora(module, config):
    for cname, child in list(module.named_children()):
        if cname in config.target_modules and isinstance(child, nn.Linear):
            setattr(module, cname, LoRALinear(child, config))
        else:
            apply_lora(child, config)


def make_vit_small_patch16_dinov2():
    args = dict(
        patch_size=16, embed_dim=384, depth=12, num_heads=6, init_values=1e-5,
        mlp_ratio=2.66667 * 2, mlp_layer=SwiGLUPacked, act_layer=nn.SiLU, img_size=224,
    )
    return _create_vision_transformer("vit_small_patch14_dinov2", pretrained=False, **args)


class GigaTIMEFlash(nn.Module):
    def __init__(self, num_classes=23):
        super().__init__()
        vit = make_vit_small_patch16_dinov2()
        apply_lora(vit, LoraConfig(r=8, lora_alpha=16, lora_dropout=0.1,
                                   target_modules=["qkv", "proj"]))
        self.encoder = PeftFallbackModel(vit)
        self.num_classes = num_classes
        self.decoder4 = self._dec(384, 192)
        self.decoder3 = self._dec(192, 96)
        self.decoder2 = self._dec(96, 48)
        self.decoder1 = self._dec(48, 24)
        self.skip1 = self._skip(384, 48, 3)
        self.skip2 = self._skip(384, 96, 2)
        self.skip3 = self._skip(384, 192, 1)
        self.final_conv = nn.Conv2d(24, num_classes, kernel_size=1)
        self.encoder.patch_embed.img_size = (256, 256)
        self.encoder.patch_embed.grid_size = (16, 16)
        self.encoder.patch_embed.num_patches = 256

    @staticmethod
    def _dec(ci, co):
        return nn.Sequential(
            nn.Conv2d(ci, co, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(co, co, 3, padding=1), nn.ReLU(inplace=True),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=True),
        )

    @staticmethod
    def _skip(ci, co, times):
        layers = []
        for _ in range(times):
            layers.append(nn.ConvTranspose2d(ci, co, 2, stride=2))
            ci = co
        return nn.Sequential(*layers)

    @staticmethod
    def _t2p(x):
        b, n, c = x.shape
        g = int(n ** 0.5)
        return x.permute(0, 2, 1).contiguous().view(b, c, g, g)

    @staticmethod
    def _resize_pos(pe, ng):
        cls, grid = pe[:, :1], pe[:, 1:]
        o = int(grid.shape[1] ** 0.5)
        grid = grid.reshape(1, o, o, -1).permute(0, 3, 1, 2)
        grid = nn.functional.interpolate(grid, size=ng, mode="bicubic", align_corners=False)
        grid = grid.permute(0, 2, 3, 1).reshape(1, ng[0] * ng[1], -1)
        return torch.cat((cls, grid), dim=1)

    def forward(self, x):
        outs = []
        x = self.encoder.patch_embed(x)
        _, n, _ = x.shape
        g = int(n ** 0.5)
        x = x + self._resize_pos(self.encoder.pos_embed, (g, g))[:, 1:]
        x = self.encoder.patch_drop(x)
        x = self.encoder.norm_pre(x)
        for i, blk in enumerate(self.encoder.blocks):
            x = blk(x)
            if i in {3, 5, 8, 11}:
                outs.append(x)
        x = self.decoder4(self._t2p(outs[3]))
        x = self.decoder3(x + self.skip3(self._t2p(outs[2])))
        x = self.decoder2(x + self.skip2(self._t2p(outs[1])))
        x = self.decoder1(x + self.skip1(self._t2p(outs[0])))
        x = self.final_conv(x)
        if x.shape[-1] != 256:
            x = nn.functional.interpolate(x, size=(256, 256), mode="bilinear", align_corners=True)
        return x


def build_flash(num_classes=23) -> GigaTIMEFlash:
    return GigaTIMEFlash(num_classes=num_classes)
