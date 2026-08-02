// src/components/panels/analysis/nativeCatalog.js — the native tools, declared as data.
//
// A HistomicsTK CLI describes its form in Slicer XML and `parseXml.js` turns that into
// `{ title, description, groups: [{ label, params }] }`. The five native tools have no XML, so they
// declare **the same shape** here. That is the whole trick of Inc 6 · 02: one catalog, one form
// renderer, two producers. The alternative — a second hand-written form per tool — is what the five
// panels already are, and is what this replaces.
//
// Params therefore speak the Slicer vocabulary (`boolean`, `float`, `string-enumeration`, …) so
// `ParamField` renders them unchanged. Three shapes have no Slicer equivalent and are prefixed to
// keep the two vocabularies apart:
//
//   pa-scope     whole slide or a drawn region — the choice, not the rectangle
//   pa-region    the rectangle itself, via the shared `useRegionSelect` handle
//   pa-artifact  an upstream artifact of a given kind, picked from this slide's ready rows
//
// `submit` calls each tool's existing gateway endpoint. What is behind that endpoint is what moves:
// **nuclei is on the Celery path since 05** and its tab is gone, so this is the only place it can be
// started; the other four still run on their own service queues and keep their tabs until 06–07.
// Nothing in this file distinguishes them, which is the point — a kind moving is a change to one
// route, not to the catalog.
//
// Not listed: `patching` and `features`. They are interior DAG stages whose patch size is bound to
// the encoder chosen for the features step, and that binding lives in `PreprocessPanel`'s planner.
// Listing them as standalone entries would let a user build tiles no encoder wants. They arrive
// with the planner in 07.
import { startBiomarker } from '../../../api/biomarkerApi.js';
import { startNuclei } from '../../../api/nucleiApi.js';
import { startSegment } from '../../../api/preprocessApi.js';
import { listTasks, startPredict } from '../../../api/taskApi.js';
import { getTissueCatalog, startTissue } from '../../../api/tissueApi.js';
import { SEGMENTERS } from '../preprocessUtils.js';

/** The group name every native entry is listed under, alongside one group per docker image. */
export const NATIVE_GROUP = 'PathAssist';

const asOptions = (xs, value = 'id', label = 'label') =>
  xs.map(x => ({ value: String(x[value]), label: x[label] ?? String(x[value]) }));

// ── The two params every region-capable tool shares ──────────────────────────────────────
// Declared once because they are one decision in two fields: `pa-region` is disabled while
// `scope` is `whole`, and a tool that cannot do whole-slide simply omits the pair.
const scopeParams = (wholeHint) => ([
  {
    tag: 'pa-scope', name: 'scope', label: 'Run over',
    desc: wholeHint, defVal: 'region',
  },
  {
    tag: 'pa-region', name: 'bbox', label: 'Region',
    desc: 'Draw a rectangle on the slide. Shared with Copilot and the other panels.',
    enabledWhen: (v) => v.scope === 'region',
  },
]);

const artifactParam = (name, kind, label, desc, opts = {}) => ({
  tag: 'pa-artifact', name, label, desc, artifactKind: kind, ...opts,
});

/** The five tools, in the order a slide is usually worked through. */
export const NATIVE_TOOLS = [
  {
    id: 'segmentation',
    title: 'Tissue segmentation',
    description:
      'Find the tissue on the slide and store its contours. Every whole-slide run downstream '
      + 'needs one, so that it can skip the glass.',
    groups: [{
      label: 'Segmentation',
      params: [
        {
          tag: 'string-enumeration', name: 'segmenter', label: 'Segmenter',
          desc: 'HEST and GrandQC are learned; Otsu is a threshold and is much faster.',
          defVal: 'hest', options: asOptions(SEGMENTERS),
        },
        {
          tag: 'float', name: 'seg_conf_thresh', label: 'Confidence threshold',
          desc: 'Lower keeps more tissue.', defVal: '0.5', min: '0.1', max: '0.9', step: '0.05',
        },
        { tag: 'boolean', name: 'remove_holes', label: 'Remove holes', defVal: 'false' },
        { tag: 'boolean', name: 'remove_artifacts', label: 'Remove artifacts', defVal: 'false' },
        { tag: 'boolean', name: 'remove_penmarks', label: 'Remove pen marks', defVal: 'false' },
      ],
    }],
    submit: (itemId, v) => startSegment(itemId, {
      segmenter: v.segmenter,
      seg_conf_thresh: Number(v.seg_conf_thresh),
      remove_holes: v.remove_holes === 'true',
      remove_artifacts: v.remove_artifacts === 'true',
      remove_penmarks: v.remove_penmarks === 'true',
    }),
  },

  {
    id: 'nuclei',
    title: 'Nuclei segmentation',
    description:
      'CellViT-SAM-H per-nucleus segmentation and classification. A region takes seconds; a whole '
      + 'slide takes tens of minutes, and can be stopped from Runs below and resumed by starting '
      + 'the same run again — what a stopped build already computed is kept.',
    groups: [
      {
        label: 'Scope',
        params: scopeParams('A whole-slide run needs a tissue segmentation; a drawn region does not.'),
      },
      {
        label: 'Inputs',
        params: [artifactParam(
          'seg_hash', 'segmentation', 'Tissue segmentation',
          'Which cores hold tissue, so the GPU is not spent on glass.',
          { requiredWhen: (v) => v.scope === 'whole' },
        )],
      },
    ],
    submit: (itemId, v, { roi }) => startNuclei(itemId, {
      bbox: v.scope === 'whole' ? null : roi,
      seg_hash: v.scope === 'whole' ? (v.seg_hash || null) : null,
    }),
  },

  {
    id: 'tissue',
    title: 'Tissue map',
    description:
      'A dense per-pixel tissue class raster, mounted over the slide like a second image. '
      + 'Whole-slide runs are CPU-bound here and take a while.',
    groups: [
      { label: 'Scope', params: scopeParams('Both scopes need a tissue segmentation.') },
      {
        label: 'Inputs',
        params: [
          artifactParam('seg_hash', 'segmentation', 'Tissue segmentation',
            'Everything outside these contours is masked out.', { required: true }),
          {
            tag: 'string-enumeration', name: 'backend', label: 'Backend',
            desc: 'The deployed model. Its classes, palette and licence come from the service.',
            defVal: '',
            // Resolved when the form opens: the service is the only honest source for which
            // backends this deployment actually has (Inc 4).
            optionsFrom: async () => {
              const c = await getTissueCatalog();
              const names = Object.keys(c?.backends || {});
              return names.map(n => ({ value: n, label: n }));
            },
          },
        ],
      },
    ],
    submit: (itemId, v, { roi }) => startTissue(itemId, {
      seg_hash: v.seg_hash,
      bbox: v.scope === 'whole' ? null : roi,
      backend: v.backend || null,
    }),
  },

  {
    id: 'biomarker',
    title: 'Marker map',
    description:
      'Virtual multiplex immunofluorescence over the H&E, reduced to a phenotype per nucleus. '
      + 'Needs both the tissue contours and a nuclei run to attribute signal to cells.',
    groups: [
      { label: 'Scope', params: scopeParams('Both scopes need a segmentation and a nuclei run.') },
      {
        label: 'Inputs',
        params: [
          artifactParam('seg_hash', 'segmentation', 'Tissue segmentation',
            'Bounds the area the markers are inferred over.', { required: true }),
          artifactParam('nuclei_hash', 'nuclei', 'Nuclei',
            'The cells the marker signal is attributed to.', { required: true }),
        ],
      },
    ],
    submit: (itemId, v, { roi }) => startBiomarker(itemId, {
      seg_hash: v.seg_hash,
      nuclei_hash: v.nuclei_hash,
      bbox: v.scope === 'whole' ? null : roi,
    }),
  },

  {
    id: 'prediction',
    title: 'Downstream task',
    description:
      'Run a trained slide-level model over an existing feature index — an ABMIL head over the '
      + 'tiles the preprocess build encoded.',
    groups: [{
      label: 'Inputs',
      params: [
        artifactParam('feat_hash', 'features', 'Feature index',
          'The encoded tiles the model reads. Build one in Preprocess first.', { required: true }),
        {
          tag: 'string-enumeration', name: 'task_id', label: 'Task',
          desc: 'The trained head to apply. Each declares the encoder it was fitted on.',
          defVal: '', required: true,
          optionsFrom: async () => {
            const { tasks } = await listTasks();
            return (tasks || []).map(t => ({ value: t.id, label: t.label || t.id }));
          },
        },
      ],
    }],
    submit: (itemId, v) => startPredict(itemId, { feat_hash: v.feat_hash, task_id: v.task_id }),
  },
];

/** Every declared param of a tool, flattened — the form seeds and validates over this. */
export function toolParams(tool) {
  return (tool?.groups || []).flatMap(g => g.params);
}

/** Default values for a tool's form, keyed by param name. */
export function seedValues(tool) {
  const out = {};
  toolParams(tool).forEach(p => { out[p.name] = p.defVal ?? ''; });
  return out;
}

/** Whether `param` accepts input given the rest of the form. */
export function isEnabled(param, values) {
  return param.enabledWhen ? !!param.enabledWhen(values) : true;
}

/**
 * The first reason this form cannot be submitted, or null.
 *
 * Reported as one sentence rather than per-field marks because the native forms are short and the
 * failures are about missing *upstream work* ("no nuclei run on this slide yet"), which is a
 * sentence, not a red outline.
 *
 * A missing upstream has two quite different causes and they get two different sentences (Inc 6 ·
 * 06). "You have not picked one" is answered by opening the dropdown; "this slide has none" is
 * answered by running a different tool first, and telling someone to pick from an empty list is
 * the kind of instruction that gets read as a bug. The marker map is the entry that made this
 * worth separating — it needs both a segmentation and a nuclei run, and on a fresh slide it has
 * neither.
 */
export function firstProblem(tool, values, { roi, artifacts } = {}) {
  for (const p of toolParams(tool)) {
    if (!isEnabled(p, values)) continue;
    if (p.tag === 'pa-region' && values.scope === 'region' && !roi) {
      return 'Draw a region on the slide, or switch to the whole slide.';
    }
    const needed = p.required || (p.requiredWhen ? p.requiredWhen(values) : false);
    if (!needed || values[p.name]) continue;
    // `artifacts` undefined means the list has not loaded, which is not the same as empty — so
    // the generic sentence stands until we actually know.
    if (artifacts && !artifacts.some(a => a.kind === p.artifactKind)) {
      return `This slide has no ${p.artifactKind} yet — run it first, then come back.`;
    }
    return `${p.label} is required.`;
  }
  return null;
}
