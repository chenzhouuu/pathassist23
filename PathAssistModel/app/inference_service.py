from __future__ import annotations

import gc
import logging
from pathlib import Path
from typing import Dict, Optional

from .config import Settings
from .utils import ensure_dir, resolve_first_file


logger = logging.getLogger(__name__)


class InferenceService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _segmentor(self):
        from tiatoolbox.models.engine.nucleus_instance_segmentor import NucleusInstanceSegmentor

        try:
            return NucleusInstanceSegmentor(
                model=self.settings.model_name,
                batch_size=self.settings.batch_size,
                num_loader_workers=self.settings.num_loader_workers,
                num_postproc_workers=self.settings.num_postproc_workers,
                device=self.settings.gpu_device,
                verbose=True,
            )
        except TypeError:
            return NucleusInstanceSegmentor(
                pretrained_model=self.settings.model_name,
                batch_size=self.settings.batch_size,
                num_loader_workers=self.settings.num_loader_workers,
                num_postproc_workers=self.settings.num_postproc_workers,
                auto_generate_mask=False,
                verbose=True,
            )

    def _run_new_api(self, segmentor, slide_path: Path, output_dir: Path) -> Optional[Path]:
        if not hasattr(segmentor, "run"):
            return None
        try:
            segmentor.run(
                images=[str(slide_path)],
                masks=None,
                patch_mode=False,
                save_dir=str(output_dir),
                output_type="json",
                auto_get_mask=False,
                num_workers=max(self.settings.num_loader_workers, 1),
                overwrite=True,
                device=self.settings.gpu_device,
                verbose=True,
            )
        except TypeError:
            return None
        return resolve_first_file(output_dir.rglob("*"), suffixes=[".json", ".dat"])

    def _run_legacy_api(self, segmentor, slide_path: Path, output_dir: Path) -> Path:
        segmentor.predict(
            [str(slide_path)],
            masks=None,
            save_dir=str(output_dir),
            mode="wsi",
            device=self.settings.gpu_device,
            crash_on_exception=True,
        )
        output_path = resolve_first_file(output_dir.rglob("*"), suffixes=[".dat", ".json"])
        if not output_path:
            raise RuntimeError(f"No HoVer-Net output produced under {output_dir}")
        return output_path

    def run_hovernet(self, slide_path: Path, output_dir: Path) -> Dict:
        ensure_dir(output_dir)
        segmentor = self._segmentor()
        output_path = self._run_new_api(segmentor, slide_path, output_dir)
        if output_path is None:
            output_path = self._run_legacy_api(segmentor, slide_path, output_dir)
        gc.collect()
        return {
            "slide_path": str(slide_path),
            "output_path": str(output_path),
            "model_name": self.settings.model_name,
        }
