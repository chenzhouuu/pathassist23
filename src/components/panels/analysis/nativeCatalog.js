// src/components/panels/analysis/nativeCatalog.js — the native tools, declared as data.
//
// A HistomicsTK CLI describes its form in Slicer XML and `parseXml.js` turns that into
// `{ title, description, groups: [{ label, params }] }`. The native tools have no XML, so they
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
// `submit` calls each tool's existing gateway endpoint. What is behind that endpoint is what moved:
// every kind is a Girder job on one Celery queue now (05 → 07), and every panel that used to start
// one is gone, so this is the only place any of them can be started.
//
// **Still not listed: `patching` and `features`.** They are interior stages of a build, and their
// patch size is bound to the encoder chosen for the features step (Fork B) — listing them
// separately would let a user cut tiles no encoder wants. They are steps of the `preprocess` entry
// below, planned and sequenced server-side (`agent/gateway/plan.py`), which is what 07 replaced the
// panel's auto-advance loop with.
import { startBiomarker } from '../../../api/biomarkerApi.js';
import { startNuclei } from '../../../api/nucleiApi.js';
import { startBuild, startSegment } from '../../../api/preprocessApi.js';
import { listTasks, startPredict } from '../../../api/taskApi.js';
import { getTissueCatalog, startTissue } from '../../../api/tissueApi.js';
import { describeSpec } from '../../workspace/prediction.js';
import { ENCODERS, MAGS, OVERLAPS, SEGMENTERS, recommendedMag, recommendedPatchSize } from './encoders.js';

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

/** Every native tool, in the order a slide is usually worked through. */
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
    submit: (itemId, v, { mode } = {}) => startSegment(itemId, {
      segmenter: v.segmenter,
      seg_conf_thresh: Number(v.seg_conf_thresh),
      remove_holes: v.remove_holes === 'true',
      remove_artifacts: v.remove_artifacts === 'true',
      remove_penmarks: v.remove_penmarks === 'true',
    }, mode),
  },

  {
    id: 'preprocess',
    title: 'Feature index',
    description:
      'Encode the slide into per-tile feature vectors — segment the tissue, cut it into tiles at '
      + 'the encoder\'s trained resolution, then encode them. One submission; whatever this slide '
      + 'already has is skipped, so a second encoder over the same tiles costs one step, not three.',
    groups: [
      {
        label: 'Build target',
        params: [
          {
            tag: 'string-enumeration', name: 'encoder', label: 'Encoder',
            desc: 'The vectors everything downstream reads. Its trained resolution decides how '
              + 'the slide is tiled, which is why the tiling stage is not a tool of its own.',
            defVal: 'conch_v1_text',
            options: ENCODERS.map(e => ({
              value: e.id, label: e.label,
              note: `${e.patch_size} px at ${e.mag}× · ${e.dim}-d`
                + (e.text ? ' · text-aligned, so Copilot can search this index in words'
                          : ' · vision tower, what the MIL tasks are trained on'),
            })),
          },
        ],
      },
      {
        label: 'Segmentation',
        params: [
          {
            tag: 'string-enumeration', name: 'segmenter', label: 'Segmenter',
            desc: 'Reused if this slide already has one with these settings.',
            defVal: 'hest', options: asOptions(SEGMENTERS),
          },
          {
            tag: 'float', name: 'seg_conf_thresh', label: 'Confidence threshold',
            desc: 'Lower keeps more tissue.', defVal: '0.5', min: '0.1', max: '0.9', step: '0.05',
          },
        ],
      },
      {
        label: 'Tiling',
        params: [
          // Shown, not hidden, and pre-set from the encoder — the geometry is what a feature index
          // means, and a build whose tiling nobody can see is one nobody can compare against a
          // task's declared spec.
          {
            tag: 'string-enumeration', name: 'mag', label: 'Magnification',
            desc: 'Follows the encoder unless you change it.', defVal: '20',
            options: MAGS.map(m => ({ value: String(m), label: `${m}×` })),
          },
          {
            tag: 'string-enumeration', name: 'patch_size', label: 'Tile size',
            desc: 'Pixels, at the magnification above.', defVal: '512',
            options: [256, 384, 512, 1024].map(v => ({ value: String(v), label: `${v} px` })),
          },
          {
            tag: 'string-enumeration', name: 'overlap', label: 'Overlap',
            desc: 'Absolute pixels between neighbouring tiles.', defVal: '0',
            options: OVERLAPS.map(v => ({ value: String(v), label: v ? `${v} px` : 'None' })),
          },
        ],
      },
    ],
    // The encoder binds the tiling (Fork B): picking one re-seeds mag and tile size, and anything
    // typed afterwards stands. Without this the form's two halves can disagree silently, and the
    // build that comes out is tiles at a resolution the encoder was never trained on.
    onChange: (name, value) => (name !== 'encoder' ? null : {
      encoder: value,
      mag: String(recommendedMag(value)),
      patch_size: String(recommendedPatchSize(value)),
    }),
    submit: (itemId, v, { mode } = {}) => startBuild(itemId, {
      encoder: v.encoder,
      segmenter: v.segmenter,
      seg_conf_thresh: Number(v.seg_conf_thresh),
      mag: Number(v.mag),
      patch_size: Number(v.patch_size),
      overlap: Number(v.overlap),
    }, mode),
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
    submit: (itemId, v, { roi, mode } = {}) => startNuclei(itemId, {
      bbox: v.scope === 'whole' ? null : roi,
      seg_hash: v.scope === 'whole' ? (v.seg_hash || null) : null,
    }, mode),
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
            'Optional. Everything outside these contours is masked out; one is planned for you '
            + 'if this slide has none.'),
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
    submit: (itemId, v, { roi, mode } = {}) => startTissue(itemId, {
      seg_hash: v.seg_hash || null,
      bbox: v.scope === 'whole' ? null : roi,
      backend: v.backend || null,
    }, mode),
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
            'Optional. Bounds the area the markers are inferred over.'),
          artifactParam('nuclei_hash', 'nuclei', 'Nuclei',
            'Optional. The cells the marker signal is attributed to.'),
        ],
      },
    ],
    submit: (itemId, v, { roi, mode } = {}) => startBiomarker(itemId, {
      seg_hash: v.seg_hash || null,
      nuclei_hash: v.nuclei_hash || null,
      bbox: v.scope === 'whole' ? null : roi,
    }, mode),
  },

  {
    id: 'prediction',
    title: 'Downstream task',
    description:
      'Run a trained slide-level model over this slide — an ABMIL head over encoded tiles. '
      + 'The task declares the build its weights were fitted on; if this slide has no matching '
      + 'feature index, the whole chain is queued in one go and the call comes out at the end.',
    groups: [{
      label: 'Inputs',
      params: [
        {
          tag: 'string-enumeration', name: 'task_id', label: 'Task',
          desc: 'The trained head to apply.',
          defVal: '', required: true,
          // Each option carries the model card the Task panel used to draw: what it was fitted on,
          // how it scored, and what it is not for. That is a fact about the selected head rather
          // than about the field, which is what `note` on an option is (Inc 6 · 07).
          optionsFrom: async () => {
            const { tasks } = await listTasks();
            return (tasks || []).map(t => ({
              value: t.id, label: t.label || t.id, note: taskNote(t),
            }));
          },
        },
        // Optional, and that is the point: leaving it empty is "use whatever matches, and build
        // one if nothing does". Naming an index is for the case where a slide has several and the
        // choice is deliberate.
        artifactParam('feat_hash', 'features', 'Feature index',
          'Optional. Left empty, the index matching the task is found — or built.'),
      ],
    }],
    submit: (itemId, v, { mode } = {}) => startPredict(itemId, {
      feat_hash: v.feat_hash || null, task_id: v.task_id,
    }, mode),
  },
];

/** The model card, as one option's note: what it eats, what it was fitted on, what it is not. */
export function taskNote(task) {
  const m = task?.metrics || {};
  const metric = (label, v) => (Number.isFinite(v) ? `${label} ${v.toFixed(3)}` : null);
  return [
    task?.feature_spec ? `Needs ${describeSpec(task.feature_spec)}` : null,
    (task?.classes || []).length ? `Classes ${task.classes.join(' · ')}` : null,
    task?.cohort ? `Trained on ${task.cohort}` : null,
    [metric('AUC', m.test_auc), metric('Acc', m.test_acc), metric('F1', m.test_f1)]
      .filter(Boolean).join(' · ') || null,
    task?.caveat || null,
  ].filter(Boolean).join('\n');
}

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
 * one thing they can be missing is short too.
 *
 * **Missing upstreams are no longer among them (Inc 6 · 08).** Until 07 this said things like
 * *"this slide has no nuclei yet — run it first, then come back"*: a true sentence about a piece
 * of work the machine could do, which made the user the scheduler. The server plans them now, and
 * what the form shows instead is what it is *about* to do — see `describePlan`. What is left here
 * is the two things a plan cannot supply: a rectangle nobody drew, and a choice only the user can
 * make (which task).
 */
export function firstProblem(tool, values, { roi } = {}) {
  for (const p of toolParams(tool)) {
    if (!isEnabled(p, values)) continue;
    if (p.tag === 'pa-region' && values.scope === 'region' && !roi) {
      return 'Draw a region on the slide, or switch to the whole slide.';
    }
    // `pa-artifact` params are never required: an unnamed upstream is planned, not demanded.
    if (p.tag === 'pa-artifact' || !p.required || values[p.name]) continue;
    return `${p.label} is required.`;
  }
  return null;
}

/**
 * What a submission is about to cost, as the server planned it.
 *
 * `plan` is a `mode=plan` reply — `{status, steps, plan}` — computed by the same function that
 * will run the submission, so the sentence and the run cannot disagree. That is the whole reason
 * this is a server round-trip rather than a fourth client-side dependency table.
 *
 * The queue-slot count is stated out loud because at `concurrency=1` it is a wait the user is
 * agreeing to on everyone else's behalf as well as their own.
 */
export function describePlan(plan) {
  if (!plan) return null;
  if (plan.status === 'ready') {
    return { built: true, steps: [], headline: 'Already built — nothing to run.' };
  }
  const steps = plan.steps || [];
  const n = steps.length;
  if (!n) return null;
  return {
    built: false,
    steps,
    headline: n === 1
      ? '1 step · 1 queue slot'
      : `${n} steps · ${n} queue slots, one after another`,
    // Named rather than counted: "2 upstreams" is a number, and which two is the answer.
    upstreams: steps.slice(0, -1).map(s => s.title),
  };
}
