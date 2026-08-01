// src/components/viewer/ArtifactLayers.jsx — the one owner of the artifact overlays (Inc 5 · 03a/b).
//
// Why this exists: these layers used to be mounted by the panels that tune them, and each removed
// its layer on unmount — while the right panel unmounts a panel every time you switch tabs. An eye
// in the Workspace could not survive that, because clicking it means leaving the panel's tab. So
// the layers moved to where the viewer's canvas overlays already live: mounted for as long as a
// slide is open, reading what to draw from the store.
//
// It renders nothing. It is a set of effects with a mount point — the same shape as TissueOverlay
// and PhenotypeOverlay beside it.
//
// What it reads:
//   visibleArtifacts    { [art_hash]: { kind } }  — the Workspace's eye, the only writer
//   tissueLayerParams   the Tissue panel's controls, in the store because the layer outlives it
//   markerLayerParams   the same, for the Markers panel
//
// Four pictures, one per drawable kind, each in its own layer slot so they stack (Inc 4 D4):
//   tissue        a class/probability pyramid, under everything
//   nuclei        the nucleus mask, above the tissue it subdivides
//   biomarker     the marker composite or the phenotype map — one or the other, never both (D8)
//   segmentation  the tissue outline, a canvas rather than a pyramid. TissueOverlay paints it;
//                 what this owns is fetching the contours once and caching them by hash.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { getTissueMeta, tileAjaxHeaders, tileUrl } from '../../api/tissueApi.js';
import { getBiomarkerMeta, getCatalog } from '../../api/biomarkerApi.js';
import { getNucleiMeta, tileUrl as nucleiTileUrl } from '../../api/nucleiApi.js';
import { getSegmentationContours } from '../../api/preprocessApi.js';
import {
  LAYER_FOR_RENDER, classesOf, layerLevels, layerSignature, levelOffsetFor, tileParams,
  withTissueDefaults,
} from '../panels/tissueUtils.js';
import {
  layerSignature as markerSignature, phenotypeLegend, presetChannels,
  tileParams as markerTileParams, withMarkerDefaults,
} from '../panels/markerUtils.js';
import {
  classesOf as nucleiClassesOf, layerLevels as nucleiLevels,
  layerSignature as nucleiSignature, levelOffsetFor as nucleiOffsetFor,
  tileParams as nucleiTileParams, withNucleiDefaults,
} from '../panels/nucleiUtils.js';
import { clearMarkerLayers, setMarkersBase, syncMarkerLayer } from './markerLayers.js';
import { buildTileSource, removeLayer, setBasePreference, syncLayer } from './overlayLayers.js';

/** The artifact kinds this component can put on the viewer. The Workspace offers an eye for these. */
export const SWITCHABLE_KINDS = ['tissue', 'nuclei', 'biomarker', 'segmentation'];

const LAYER_FOR_MODE = { markers: 'markers', pheno: 'pheno' };

// How often a still-building artifact's coverage is re-read. Slower than the panels' 2.5 s poll:
// a core tile of nuclei is tens of seconds of GPU, so there is nothing new to see any sooner, and
// each change re-requests the visible tiles.
const BUILD_REFRESH_MS = 5000;

/** The hash of the visible artifact of `kind`, or null. One layer slot per kind (see the store). */
export function visibleHashOf(visibleArtifacts, kind) {
  const hit = Object.entries(visibleArtifacts || {}).find(([, v]) => v?.kind === kind);
  return hit ? hit[0] : null;
}

/**
 * Fetch an artifact's meta while it is the visible one, and forget it when it is not.
 *
 * `refreshMs` re-reads it on a timer, for a build that is still being written: the artifact's
 * coverage grows core by core, and the meta route reads coverage fresh off disk, so this is how a
 * running build's picture catches up without anyone pressing anything.
 */
function useArtifactMeta(fetcher, itemId, hash, refreshMs = 0) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    if (!itemId || !hash) { setMeta(null); return undefined; }
    let live = true;
    const read = () => fetcher(itemId, hash)
      .then((m) => { if (live) setMeta(m); })
      .catch(() => { if (live) setMeta(null); });   // a build with nothing to draw yet
    read();
    if (!refreshMs) return () => { live = false; };
    const t = setInterval(read, refreshMs);
    return () => { live = false; clearInterval(t); };
    // `fetcher` is a module function, stable by construction.
  }, [itemId, hash, refreshMs]);   // eslint-disable-line react-hooks/exhaustive-deps
  return meta;
}

// ── tissue ───────────────────────────────────────────────────────────────────────────

function TissueTileLayer({ viewer, itemId, hash }) {
  const stored = useStore((s) => s.tissueLayerParams);
  const meta = useArtifactMeta(getTissueMeta, itemId, hash);
  const mountedSig = useRef(null);

  const p = useMemo(() => withTissueDefaults(stored), [stored]);
  const classes = useMemo(() => classesOf(meta, null, null), [meta]);
  const shown = useMemo(() => classes.filter((c) => !p.hidden[c]), [classes, p.hidden]);

  const layer = LAYER_FOR_RENDER[p.render];
  const params = useMemo(() => tileParams(p.render, {
    show: shown, opacity: 1, conf: p.conf, confFloor: p.confFloor, classes,
  }), [p.render, shown, p.conf, p.confFloor, classes]);

  const visible = !!hash && !!meta;
  const signature = visible ? layerSignature(p.render, hash, params) : 'none';

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
      tileUrlFor: (level, x, y) => tileUrl(itemId, hash, layer, level, x, y, params),
    });
    mountedSig.current = syncLayer(viewer, {
      key: 'tissue', signature, mounted: mountedSig.current, tileSource,
      // Layer opacity, not a tile parameter: dragging the slider must not refetch a single tile.
      opacity: p.opacity, ajaxHeaders: tileAjaxHeaders(),
    });
    setBasePreference(viewer, 'tissue', p.heFade >= 1 ? null : { opacity: p.heFade });
  }, [viewer, visible, signature, itemId, hash, layer, meta, params, p.opacity, p.heFade]);

  useEffect(() => () => {
    if (!viewer) return;
    removeLayer(viewer, 'tissue');
    setBasePreference(viewer, 'tissue', null);
  }, [viewer]);

  return null;
}

// ── nuclei ───────────────────────────────────────────────────────────────────────────

function NucleiTileLayer({ viewer, itemId, hash }) {
  const stored = useStore((s) => s.nucleiLayerParams);
  // A whole-slide run fills in core by core over minutes or hours. While it does, re-read the
  // artifact's coverage so the mask catches up on its own; once it stops, stop asking.
  const building = useStore((s) => !!s.artifactRuns[hash]);
  const meta = useArtifactMeta(getNucleiMeta, itemId, hash, building ? BUILD_REFRESH_MS : 0);
  const mountedSig = useRef(null);

  const p = useMemo(() => withNucleiDefaults(stored), [stored]);
  const classes = useMemo(() => nucleiClassesOf(meta), [meta]);
  const shown = useMemo(() => classes.filter((c) => !p.hidden[c]), [classes, p.hidden]);

  // Coverage is in the tile URL, so growing coverage is a different picture and OSD fetches it.
  // Unchanged coverage means an unchanged URL, so a poll that found nothing new costs nothing.
  const rev = meta?.coverage?.n_tiles;
  const params = useMemo(
    () => nucleiTileParams({ show: shown, opacity: 1, classes, rev }),
    [shown, classes, rev],
  );

  // A build that has run but not yet drawn reports no levels. Mounting then would ask for tiles
  // that do not exist and leave an empty layer on the viewer, so the eye simply shows nothing
  // until there is something to show.
  const levels = nucleiLevels(meta);
  const visible = !!hash && !!meta && levels > 0;
  const signature = visible ? nucleiSignature(hash, params) : 'none';

  useEffect(() => {
    if (!viewer) return;
    if (!visible) {
      removeLayer(viewer, 'nuclei');
      mountedSig.current = 'none';
      return;
    }
    const tileSource = buildTileSource({
      slideWidth: meta?.slide?.width,
      slideHeight: meta?.slide?.height,
      levelOffset: nucleiOffsetFor(meta),
      levels,
      tileUrlFor: (level, x, y) => nucleiTileUrl(itemId, hash, 'classes', level, x, y, params),
    });
    mountedSig.current = syncLayer(viewer, {
      key: 'nuclei', signature, mounted: mountedSig.current, tileSource,
      // Layer opacity, not a tile parameter: dragging the slider must not refetch a single tile.
      opacity: p.opacity, ajaxHeaders: tileAjaxHeaders(),
    });
  }, [viewer, visible, signature, itemId, hash, meta, params, levels, p.opacity]);

  useEffect(() => () => { if (viewer) removeLayer(viewer, 'nuclei'); }, [viewer]);

  return null;
}

// ── biomarker ────────────────────────────────────────────────────────────────────────

function MarkerTileLayer({ viewer, itemId, hash }) {
  const stored = useStore((s) => s.markerLayerParams);
  const meta = useArtifactMeta(getBiomarkerMeta, itemId, hash);
  const [catalog, setCatalog] = useState(null);
  const mountedSig = useRef(null);

  // The marker vocabulary and palette come from the service, so a layer switched on from the
  // Workspace is drawn with the deployed model's channels even if the Markers panel never opened.
  useEffect(() => {
    if (!hash) return undefined;
    let live = true;
    getCatalog().then((c) => { if (live) setCatalog(c); }).catch(() => {});
    return () => { live = false; };
  }, [hash]);

  const p = useMemo(() => withMarkerDefaults(stored), [stored]);
  const channels = useMemo(
    () => p.channels || presetChannels(catalog, p.preset),
    [p.channels, catalog, p.preset],
  );
  const legend = useMemo(() => phenotypeLegend(meta), [meta]);
  const allShown = legend.every((l) => !p.hidden[l.name]);
  const shownLineages = useMemo(
    () => legend.map((l) => l.name).filter((n) => !p.hidden[n]),
    [legend, p.hidden],
  );

  const params = useMemo(() => markerTileParams(p.mode, {
    channels,
    display: p.display,
    dapi: p.dapiOn ? (catalog?.dapi_color || '808080') : null,
    dapiWeight: p.dapiW,
    show: allShown ? null : shownLineages,
  }), [p.mode, channels, p.display, p.dapiOn, p.dapiW, catalog, allShown, shownLineages]);

  const visible = !!hash && !!meta;
  const signature = markerSignature(p.mode, visible ? hash : null, params);

  useEffect(() => {
    if (!viewer) return;
    mountedSig.current = syncMarkerLayer(viewer, {
      signature, mounted: mountedSig.current,
      itemId, artHash: visible ? hash : null,
      layer: visible ? LAYER_FOR_MODE[p.mode] : null,
      meta, params,
    });
    // "Remove the H&E background" is the base layer's opacity, not a black rectangle. Declared as
    // a preference, because the tissue map may be switched on underneath it (Inc 4 D4).
    setMarkersBase(viewer, visible ? { opacity: p.heFade, backdrop: '#000' } : null);
  }, [viewer, signature, itemId, hash, visible, p.mode, meta, params, p.heFade]);

  useEffect(() => () => { clearMarkerLayers(viewer); }, [viewer]);

  return null;
}

// ── segmentation ─────────────────────────────────────────────────────────────────────

function SegmentationContours({ itemId, hash }) {
  const cached = useStore((s) => s.tissueContours[hash]);
  const cacheTissueContours = useStore((s) => s.cacheTissueContours);

  // Fetched once per artifact and kept, so switching the outline back on costs nothing. The
  // painting is TissueOverlay's, which reads the same cache and the same visibility map.
  useEffect(() => {
    if (!itemId || !hash || cached) return undefined;
    let live = true;
    getSegmentationContours(itemId, hash)
      .then((gj) => { if (live) cacheTissueContours(hash, gj); })
      .catch(() => {});
    return () => { live = false; };
  }, [itemId, hash, cached, cacheTissueContours]);

  return null;
}

// ── the owner ────────────────────────────────────────────────────────────────────────

export default function ArtifactLayers() {
  const viewer = useStore((s) => s.viewer);
  const activeItem = useStore((s) => s.activeItem);
  const visibleArtifacts = useStore((s) => s.visibleArtifacts);
  const itemId = activeItem?._id || null;

  return (
    <>
      <TissueTileLayer viewer={viewer} itemId={itemId}
                       hash={visibleHashOf(visibleArtifacts, 'tissue')} />
      <NucleiTileLayer viewer={viewer} itemId={itemId}
                       hash={visibleHashOf(visibleArtifacts, 'nuclei')} />
      <MarkerTileLayer viewer={viewer} itemId={itemId}
                       hash={visibleHashOf(visibleArtifacts, 'biomarker')} />
      <SegmentationContours itemId={itemId}
                            hash={visibleHashOf(visibleArtifacts, 'segmentation')} />
    </>
  );
}
