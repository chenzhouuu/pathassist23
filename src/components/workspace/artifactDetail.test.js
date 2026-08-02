// What an opened artifact row says (Inc 6 · 04).
//
// The meta below is the shape the cellvit service really stores — read back off disk, which is the
// point of the module: reload the page and the same counts come back.
import { describe, expect, it } from 'vitest';
import { detailFor, hasDetail, layerBinding, metaIsRow } from './artifactDetail.js';

const META = {
  summary: {
    n_nuclei: 15180,
    area_mm2: 19.28425585508351,
    counts_by_class: {
      Connective: 10955, Neoplastic: 3836, Inflammatory: 168, Epithelial: 221,
    },
  },
  coverage: { n_tiles: 72 },
  classes: ['Neoplastic', 'Inflammatory', 'Connective', 'Dead', 'Epithelial'],
  colors: {
    Neoplastic: '#e94560', Inflammatory: '#4da6ff', Connective: '#4caf82',
    Dead: '#888888', Epithelial: '#f5a623',
  },
  layers: { classes: { levels: 5, level_offset: 2 }, instances: { levels: 5, level_offset: 2 } },
};

const detail = (over = {}, layer = {}) => detailFor('nuclei', { ...META, ...over }, layer);

describe('which kinds have moved across', () => {
  it('is the three drawable raster kinds, after 06', () => {
    // Added as entries in the same table, not as a second copy of the module — which is why the
    // panel that renders them never learns what `heFade` or `display.gamma` mean.
    expect(hasDetail('nuclei')).toBe(true);
    expect(hasDetail('tissue')).toBe(true);
    expect(hasDetail('biomarker')).toBe(true);
  });

  it('never has detail for a kind with nothing to draw', () => {
    expect(hasDetail('features')).toBe(false);
    expect(detailFor('features', META, {})).toBeNull();
  });
});

describe('the numbers the artifact stores', () => {
  it('leads with coverage, because it is what the counts are an account of', () => {
    expect(detail().stats[0]).toEqual({
      key: 'covered', label: 'Covered', value: '72 tiles · 19.28 mm²',
    });
  });

  it('reports the total and the area it was measured over', () => {
    const byKey = Object.fromEntries(detail().stats.map(s => [s.key, s.value]));
    expect(byKey.total).toBe('15,180');
    expect(byKey.area).toBe('19.28 mm²');
    // Not "Nuclei" — the row this opens under is already called that.
    expect(detail().stats.find(s => s.key === 'total').label).toBe('Total');
  });

  it('says nothing about a number the artifact does not carry', () => {
    // A slide with no mpp has no area. An omitted row is a fact; "0 mm²" would not be one.
    const stats = detail({ summary: { ...META.summary, area_mm2: undefined } }).stats;
    expect(stats.find(s => s.key === 'area')).toBeUndefined();
    expect(stats.find(s => s.key === 'total')).toBeTruthy();
  });

  it('has no coverage row for an artifact that recorded none', () => {
    expect(detail({ coverage: undefined }).stats.find(s => s.key === 'covered')).toBeUndefined();
  });
});

describe('one row per class', () => {
  it('is in PanNuke order with counts and fractions', () => {
    const segs = detail().segments;
    expect(segs.map(s => s.label)).toEqual(
      ['Neoplastic', 'Inflammatory', 'Connective', 'Epithelial']);
    const conn = segs.find(s => s.label === 'Connective');
    expect(conn.count).toBe(10955);
    expect(conn.fraction).toBeCloseTo(10955 / 15180);
  });

  it('omits a class the run found none of', () => {
    // `Dead` is in the palette and in the class list, and the region had none. A zero row would be
    // a claim about biology that a region-scale count cannot support.
    expect(detail().segments.find(s => s.label === 'Dead')).toBeUndefined();
  });

  it('takes its colour off the artifact, so a swatch cannot drift from the mask', () => {
    expect(detail().segments.find(s => s.label === 'Neoplastic').colorHex).toBe('#e94560');
  });

  it('falls back to grey for a class the palette predates', () => {
    const segs = detail({ colors: { Neoplastic: '#e94560' } }).segments;
    expect(segs.find(s => s.label === 'Connective').colorHex).toBe('#888888');
  });

  it('reads a hidden class as not visible, and still counts it', () => {
    const segs = detail({}, { hidden: { Connective: true } }).segments;
    const conn = segs.find(s => s.label === 'Connective');
    expect(conn.visible).toBe(false);
    expect(conn.count).toBe(10955);
  });

  it('has no rows at all before anything has been counted', () => {
    expect(detail({ summary: { n_nuclei: 0, counts_by_class: {} } }).segments).toEqual([]);
  });
});

describe('the controls the layer is drawn with', () => {
  it('offers both views once the per-cell raster exists', () => {
    expect(detail().config.modes.map(m => m.value)).toEqual(['classes', 'instances']);
  });

  it('offers no view switch for an artifact built before the per-cell plane', () => {
    const cfg = detail({ layers: { classes: { levels: 5 } } }).config;
    expect(cfg.modes).toEqual([]);
    expect(cfg.drawn).toBe(true);
  });

  it('is not drawable while a build has polygons but no raster', () => {
    expect(detail({ layers: {} }).config.drawn).toBe(false);
  });

  it('carries the stored opacity and mode, and the defaults when nobody has set them', () => {
    expect(detail().config.opacity).toBe(0.65);
    expect(detail().config.mode).toBe('classes');
    expect(detail({}, { opacity: 0.2, render: 'instances' }).config.opacity).toBe(0.2);
  });

  it('explains the instance view only while it is showing', () => {
    expect(detail().config.note).toBeNull();
    expect(detail({}, { render: 'instances' }).config.note).toMatch(/colour per cell/);
  });
});

describe('an eye on a class row', () => {
  it('patches the store rather than replacing it', () => {
    const { toggleSegment } = layerBinding('nuclei');
    const patch = toggleSegment({ hidden: { Dead: true } }, 'Connective');
    expect(patch).toEqual({ hidden: { Dead: true, Connective: true } });
  });

  it('turns a hidden class back on', () => {
    const { toggleSegment } = layerBinding('nuclei');
    expect(toggleSegment({ hidden: { Connective: true } }, 'Connective'))
      .toEqual({ hidden: { Connective: false } });
  });

  it('names the store slice the layer lives in, not a local copy', () => {
    expect(layerBinding('nuclei')).toMatchObject({
      layerKey: 'nucleiLayerParams', setterKey: 'setNucleiLayerParams',
    });
    expect(layerBinding('features')).toBeNull();
  });
});

// ── tissue (Inc 6 · 06) ─────────────────────────────────────────────────────────────
//
// The meta below is what the tissue service really stores: hard and soft fractions, a TSR, a
// palette, and a coverage record that says how much of the slide the numbers describe.

const TISSUE_META = {
  backend: 'bcss_fcn_unet',
  classes: ['Tumour', 'Stroma', 'Inflammatory', 'Necrosis', 'Others'],
  colors: { Tumour: '#D55E00', Stroma: '#0072B2', Inflammatory: '#009E73',
            Necrosis: '#CC79A7', Others: '#999999' },
  coverage: { n_tiles: 43 },
  layers: { classes: { levels: 4, level_offset: 2 }, probs: { levels: 4, level_offset: 2 } },
  summary: {
    covered_mm2: 11.28, tsr: 0.4212,
    fraction: { Tumour: 0.5, Stroma: 0.3, Inflammatory: 0.15, Others: 0.05 },
    fraction_soft: { Tumour: 0.46, Stroma: 0.3, Inflammatory: 0.15, Others: 0.09 },
    pixels: { Tumour: 500, Stroma: 300, Inflammatory: 150, Others: 50 },
  },
};

const tissue = (over = {}, layer = {}) => detailFor('tissue', { ...TISSUE_META, ...over }, layer);

describe('a tissue map, opened', () => {
  it('says what area the fractions under it are fractions of', () => {
    // A composition over 3 % of a slide and one over all of it are not the same claim, so the
    // coverage is the first line and the numbers sit underneath it.
    expect(tissue().stats).toEqual([
      { key: 'covered', label: 'Covered', value: '43 tiles · 11.28 mm²' },
      { key: 'tsr', label: 'TSR', value: '0.421' },
    ]);
  });

  it('reports TSR as a number, never as a category', () => {
    expect(tissue({ summary: { ...TISSUE_META.summary, tsr: undefined } }).stats)
      .not.toContainEqual(expect.objectContaining({ key: 'tsr' }));
  });

  it('keeps the class order fixed so the legend does not reshuffle as coverage grows', () => {
    expect(tissue().segments.map((s) => s.key))
      .toEqual(['Tumour', 'Stroma', 'Inflammatory', 'Others']);   // Necrosis: no fraction, no row
  });

  it('carries the soft fraction only where it says something the hard one does not', () => {
    const [tumour, stroma] = tissue().segments;
    expect(tumour.note).toBe('soft 46.0%');       // 0.50 hard vs 0.46 soft — real uncertainty
    expect(stroma.note).toBe(null);               // identical to three places: nothing to add
  });

  it('takes its swatches from the artifact so a colour cannot drift from the picture', () => {
    expect(tissue().segments[0].colorHex).toBe('#D55E00');
  });

  it('offers the three looks, the confidence ramp and the H&E fade', () => {
    const { config } = tissue();
    expect(config.modes.map((m) => m.value)).toEqual(['classes', 'probs', 'outline']);
    expect(config.toggles.map((t) => t.key)).toEqual(['conf']);
    expect(config.sliders.map((s) => s.key)).toEqual(['confFloor', 'heFade']);
  });

  it('drops the confidence controls in a mode that has no confidence to ramp', () => {
    const { config } = tissue({}, { render: 'probs' });
    expect(config.toggles).toEqual([]);
    expect(config.sliders.map((s) => s.key)).toEqual(['heFade']);
  });

  it('hides the faintest slider when alpha is not following confidence at all', () => {
    expect(tissue({}, { conf: false }).config.sliders.map((s) => s.key)).toEqual(['heFade']);
  });

  it('offers the composition as a file, carrying the area it was measured over', () => {
    const [csv] = tissue().config.actions;
    expect(csv.key).toBe('csv');
    expect(csv.download.text.split('\n')[0])
      .toBe('class,pixels,fraction,fraction_soft,covered_mm2,core_tiles,backend');
    expect(csv.download.text).toContain('11.28,43,bcss_fcn_unet');
  });

  it('offers no export before there is anything to export', () => {
    expect(tissue({ coverage: null }).config.actions).toEqual([]);
  });

  it('offers controls exactly when the viewer has something to point them at', () => {
    // The service writes its meta only after the pyramid, so meta existing is a raster existing —
    // and `ArtifactLayers` mounts on the same test.
    expect(tissue().config.drawn).toBe(true);
    expect(detailFor('tissue', null, {}).config.drawn).toBe(false);
  });

  it('hides a class from the picture, and turns it back on', () => {
    const { toggleSegment, patch } = layerBinding('tissue');
    expect(toggleSegment({ hidden: {} }, 'Others')).toEqual({ hidden: { Others: true } });
    expect(patch({}, 'mode', 'outline')).toEqual({ render: 'outline' });
    expect(patch({}, 'heFade', 0.4)).toEqual({ heFade: 0.4 });
  });

  it("has no editable colours — a class's colour is the artifact's", () => {
    expect(layerBinding('tissue').recolourSegment).toBeNull();
  });
});

// ── biomarker (Inc 6 · 06) ──────────────────────────────────────────────────────────

const CATALOG = {
  presets: {
    Lineage: [{ marker: 'CK', color: '00ffff' }, { marker: 'CD3', color: 'ff0000' }],
    Immune: [{ marker: 'CD8', color: '8000ff' }],
  },
  markers: ['CK', 'CD3', 'CD8', 'FOXP3'],
  equivalents: { Transgelin: 'SM22α — near-equivalent of α-SMA' },
  phenotype_colors: { Tumour: '#e94560', 'Cytotoxic T': '#4da6ff' },
  dapi_color: '808080',
};

const BIO_META = {
  coverage: { core: 2048, n_tiles: 4 },
  slide: { mpp: 0.25 },
  thresholds: { CK: 0.42, CD3: null },
  summary: { n_cells: 222412, counts_by_phenotype: { Tumour: 900, 'Cytotoxic T': 120 } },
  layers: { markers: { levels: 4, level_offset: 2 }, pheno: { levels: 6, level_offset: 0 } },
};

const bio = (layer = {}) => detailFor('biomarker', BIO_META, layer, CATALOG);

describe('a marker map, opened', () => {
  it('says how much was analysed and how many cells it found', () => {
    expect(bio().stats).toEqual([
      { key: 'covered', label: 'Covered', value: '4 tiles · 1.05 mm²' },
      { key: 'cells', label: 'Cells', value: '222,412' },
    ]);
  });

  it('lists the channels being composited when it is showing markers', () => {
    // The mode decides what the segment list is a list *of* — the two pictures are mutually
    // exclusive (Inc 3b · D8), so there is one list, not two.
    expect(bio().segments.map((s) => s.key)).toEqual(['CK', 'CD3']);   // the Lineage preset
    expect(bio().segments[0].colorHex).toBe('#00ffff');
  });

  it('says which markers had no separable positive population on this slide', () => {
    // A null threshold is "not measurable here", which is a different statement from "all
    // negative" — and the channel is still viewable, so it stays in the list.
    expect(bio().segments.map((s) => s.note))
      .toEqual([null, 'no separable positive population']);
  });

  it('lists the lineages instead once it is showing phenotypes', () => {
    const { segments } = bio({ mode: 'pheno' });
    expect(segments.map((s) => s.key)).toEqual(['Tumour', 'Cytotoxic T']);
    expect(segments[0]).toMatchObject({ count: 900, colorHex: '#e94560' });
    expect(segments[1].fraction).toBeCloseTo(120 / 1020, 5);
  });

  it('offers the panel preset and the display transfer function in markers mode only', () => {
    const markers = bio().config;
    expect(markers.choices.map((c) => c.key)).toEqual(['preset', 'addMarker']);
    expect(markers.toggles.map((t) => t.key)).toEqual(['dapiOn']);
    expect(markers.sliders.map((s) => s.key))
      .toEqual(['dapiW', 'display.lo', 'display.hi', 'display.gamma', 'heFade']);

    const pheno = bio({ mode: 'pheno' }).config;
    expect(pheno.choices).toEqual([]);
    expect(pheno.sliders.map((s) => s.key)).toEqual(['heFade']);
  });

  it('only offers markers this deployment has and this composite does not', () => {
    const [, add] = bio().config.choices;
    expect(add.options.map((o) => o.value)).toEqual(['', 'CD8', 'FOXP3']);
  });

  it('has no opacity — the composite is tuned by its transfer function, not by an alpha', () => {
    expect(bio().config.opacity).toBeNull();
  });

  it('says on the row itself that the numbers are predictions', () => {
    // The panel that used to carry this sentence is gone, and a positivity that reads as a stain
    // is the one misreading this feature cannot afford.
    expect(bio().config.note).toContain('not a stain');
  });

  it('replaces the whole channel set when a preset is picked', () => {
    // The colours in a preset were chosen to be separable *together*, so half of one carried
    // across is how a composite becomes illegible.
    const { patch } = layerBinding('biomarker');
    expect(patch({ mode: 'markers' }, 'preset', 'Immune', CATALOG)).toEqual({
      preset: 'Immune',
      channels: [{ marker: 'CD8', color: '#8000ff', enabled: true }],
    });
  });

  it('appends an added marker rather than replacing anything', () => {
    const { patch } = layerBinding('biomarker');
    const layer = { mode: 'markers', channels: [{ marker: 'CK', color: '#00ffff', enabled: true }] };
    expect(patch(layer, 'addMarker', 'CD8', CATALOG).channels.map((c) => c.marker))
      .toEqual(['CK', 'CD8']);
    // …and adding one it already has, or nothing at all, is not a change
    expect(patch(layer, 'addMarker', 'CK', CATALOG)).toBeNull();
    expect(patch(layer, 'addMarker', '', CATALOG)).toBeNull();
  });

  it('writes a display slider back into the nested transfer function', () => {
    const { patch } = layerBinding('biomarker');
    const out = patch({ mode: 'markers', display: { lo: 0.15, hi: 0.95, gamma: 0.8 } },
                      'display.gamma', 1.4);
    expect(out).toEqual({ display: { lo: 0.15, hi: 0.95, gamma: 1.4 } });
  });

  it('hides a channel in one mode and a lineage in the other, from the same eye', () => {
    const { toggleSegment } = layerBinding('biomarker');
    const channels = [{ marker: 'CK', color: '#00ffff', enabled: true }];
    expect(toggleSegment({ mode: 'markers', channels }, 'CK').channels[0].enabled).toBe(false);
    expect(toggleSegment({ mode: 'pheno', hidden: {} }, 'Tumour'))
      .toEqual({ hidden: { Tumour: true } });
  });

  it("lets a channel be recoloured, but only where a colour is the user's choice", () => {
    const { recolourSegment } = layerBinding('biomarker');
    const layer = { mode: 'markers', channels: [{ marker: 'CK', color: '#00ffff' }] };
    expect(recolourSegment(layer, 'CK', '#ff00ff').channels[0].color).toBe('#ff00ff');
    // A phenotype's colour is the artifact's own — the swatch has to stay a reliable key.
    expect(recolourSegment({ mode: 'pheno' }, 'Tumour', '#fff')).toBeNull();
  });

  it("resolves the preset's channels so the row and the picture read the same list", () => {
    // `channels: null` in the store means "whatever this preset says". Resolved from the same
    // catalog `ArtifactLayers` resolves it from, or a swatch could disagree with the composite.
    expect(detailFor('biomarker', BIO_META, { channels: null }, CATALOG).segments)
      .toHaveLength(2);
    expect(detailFor('biomarker', BIO_META, { channels: null }, null).segments).toEqual([]);
  });
});

// ── prediction (Inc 6 · 07) ──────────────────────────────────────────────────

describe('a prediction row, opened', () => {
  const PRED = {
    kind: 'prediction', art_hash: 'pr1', parent_hash: 'f1', status: 'ready',
    params: { task_id: 'brca_idc_ilc' },
    result: {
      classes: ['IDC', 'ILC'], probs: [0.93, 0.07], pred_index: 0, pred_label: 'IDC',
      n_patches: 2731, elapsed_ms: 118, model_ver: 'abmil-conch-brca-fold0-v1',
    },
  };
  const detail = (layer = {}) => detailFor('prediction', PRED, layer);

  it('leads with the call and its confidence', () => {
    expect(detail().stats).toEqual([
      { key: 'call', label: 'Call', value: 'IDC' },
      { key: 'confidence', label: 'Confidence', value: '0.93' },
    ]);
  });

  it('keeps the classes in the model order and colours the winner as the ramp does', () => {
    const segs = detail().segments;
    expect(segs.map((s) => s.label)).toEqual(['IDC', 'ILC']);
    expect(segs[0].colorHex).toBe('#b4282f');   // the red pole
    expect(segs[1].colorHex).toBe('#3a4ca0');   // the blue one
  });

  it('locks the class rows, because they are two poles of one quantity', () => {
    // Hiding one would leave a map of half a comparison; the eye has nothing to mean here.
    expect(detail().segments.every((s) => s.locked)).toBe(true);
  });

  it('offers an opacity only in overlay, where there is something to blend into', () => {
    expect(detail({ view: 'overlay' }).config.opacity).toBe(0.55);
    expect(detail({ view: 'split' }).config.opacity).toBeNull();
  });

  it('states the provenance and what the two poles mean, next to the picture', () => {
    const note = detail().config.note;
    expect(note).toContain('2,731 patches');
    expect(note).toContain('Blue supports ILC, red supports IDC');
  });

  it('turns the mode buttons into the layer field the viewer reads', () => {
    expect(layerBinding('prediction').patch({}, 'mode', 'split')).toEqual({ view: 'split' });
  });

  it('withholds the eye handler entirely', () => {
    expect(layerBinding('prediction').toggleSegment).toBeNull();
  });

  it('has nothing to say for a row whose run left no result', () => {
    const empty = detailFor('prediction', { ...PRED, result: null }, {});
    expect(empty.stats).toEqual([]);
    expect(empty.config.drawn).toBe(false);
  });

  it('reads the row itself rather than a meta document', () => {
    expect(metaIsRow('prediction')).toBe(true);
    expect(metaIsRow('tissue')).toBe(false);
  });
});

it('names its mode row for what the modes are, not for a palette it does not have', () => {
  // "Colour by" is right for a class map and wrong here: overlay vs side-by-side is *where* the
  // evidence is drawn.
  const pred = { kind: 'prediction', result: { classes: ['IDC'], probs: [1], pred_label: 'IDC' } };
  expect(detailFor('prediction', pred, {}).config.modeLabel).toBe('Show as');
  expect(detailFor('nuclei', null, {}).config.modeLabel).toBeUndefined();
});
