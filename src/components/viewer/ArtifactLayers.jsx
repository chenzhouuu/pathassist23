// src/components/viewer/ArtifactLayers.jsx — the one owner of the artifact tile layers (Inc 5 · 03a).
//
// Why this exists: the tissue map's pyramid used to be mounted by TissuePanel, which removed it on
// unmount — and the right panel unmounts a panel every time you switch tabs. An eye in the
// Workspace could not survive that, because clicking it means leaving the Tissue tab. So the layer
// moves to where the viewer's canvas overlays already live: mounted for as long as a slide is open,
// reading what to draw from the store.
//
// It renders nothing. It is an effect with a mount point — the same shape as TissueOverlay and
// PhenotypeOverlay beside it, only the pictures here are tile pyramids rather than canvases.
//
// What it reads:
//   visibleArtifacts    { [art_hash]: { kind } }  — the Workspace's eye, the only writer
//   tissueLayerParams   the Tissue panel's render controls, held in the store for the same reason
//
// 03a handles `tissue`. The markers/phenotype pyramids and the segmentation outline come across in
// 03b; until then their kinds are absent from SWITCHABLE_KINDS, so no eye is offered for them and
// nothing in the UI is inert.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { getTissueMeta, tileAjaxHeaders, tileUrl } from '../../api/tissueApi.js';
import {
  LAYER_FOR_RENDER, classesOf, layerLevels, layerSignature, levelOffsetFor, tileParams,
  withTissueDefaults,
} from '../panels/tissueUtils.js';
import { buildTileSource, removeLayer, setBasePreference, syncLayer } from './overlayLayers.js';

/** The artifact kinds this component can put on the viewer. The Workspace offers an eye for these. */
export const SWITCHABLE_KINDS = ['tissue'];

/** The hash of the visible artifact of `kind`, or null. One layer slot per kind (see the store). */
export function visibleHashOf(visibleArtifacts, kind) {
  const hit = Object.entries(visibleArtifacts || {}).find(([, v]) => v?.kind === kind);
  return hit ? hit[0] : null;
}

export default function ArtifactLayers() {
  const viewer = useStore((s) => s.viewer);
  const activeItem = useStore((s) => s.activeItem);
  const visibleArtifacts = useStore((s) => s.visibleArtifacts);
  const tissueLayerParams = useStore((s) => s.tissueLayerParams);
  const itemId = activeItem?._id || null;

  const tissueHash = visibleHashOf(visibleArtifacts, 'tissue');
  const [meta, setMeta] = useState(null);
  const mountedSig = useRef(null);

  // The artifact's own meta carries slide dimensions, level offsets and the class palette, so the
  // layer is never drawn against numbers that came from somewhere other than the map itself.
  useEffect(() => {
    if (!itemId || !tissueHash) { setMeta(null); return undefined; }
    let live = true;
    getTissueMeta(itemId, tissueHash)
      .then((m) => { if (live) setMeta(m); })
      .catch(() => { if (live) setMeta(null); });   // a build with nothing to draw yet
    return () => { live = false; };
  }, [itemId, tissueHash]);

  const p = useMemo(() => withTissueDefaults(tissueLayerParams), [tissueLayerParams]);
  const classes = useMemo(() => classesOf(meta, null, null), [meta]);
  const shown = useMemo(() => classes.filter((c) => !p.hidden[c]), [classes, p.hidden]);

  const layer = LAYER_FOR_RENDER[p.render];
  const params = useMemo(() => tileParams(p.render, {
    show: shown, opacity: 1, conf: p.conf, confFloor: p.confFloor, classes,
  }), [p.render, shown, p.conf, p.confFloor, classes]);

  const visible = !!tissueHash && !!meta;
  const signature = visible ? layerSignature(p.render, tissueHash, params) : 'none';

  useEffect(() => {
    if (!viewer) return;
    if (!visible) {
      removeLayer(viewer, 'tissue');
      mountedSig.current = 'none';
      setBasePreference(viewer, 'tissue', null);
      return;
    }
    const tileSource = buildTileSource({
      slideWidth: meta?.slide?.width,
      slideHeight: meta?.slide?.height,
      levelOffset: levelOffsetFor(meta, layer),
      levels: layerLevels(meta, layer),
      tileUrlFor: (level, x, y) => tileUrl(itemId, tissueHash, layer, level, x, y, params),
    });
    mountedSig.current = syncLayer(viewer, {
      key: 'tissue', signature, mounted: mountedSig.current, tileSource,
      // Layer opacity, not a tile parameter: dragging the slider must not refetch a single tile.
      opacity: p.opacity, ajaxHeaders: tileAjaxHeaders(),
    });
    setBasePreference(viewer, 'tissue', p.heFade >= 1 ? null : { opacity: p.heFade });
  }, [viewer, visible, signature, itemId, tissueHash, layer, meta, params, p.opacity, p.heFade]);

  // Closing the slide must not leave a map stranded on the next one.
  useEffect(() => () => {
    if (!viewer) return;
    removeLayer(viewer, 'tissue');
    setBasePreference(viewer, 'tissue', null);
  }, [viewer]);

  return null;
}
