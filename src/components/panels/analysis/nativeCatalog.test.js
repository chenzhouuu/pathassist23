// The native tool declarations (Inc 6 · 02). Two things are worth asserting: that the declared
// form is the one the tool's endpoint actually wants, and that the panel refuses to submit a run
// whose upstream is missing — because the failure a user hits is "no nuclei on this slide yet",
// and finding that out from a 409 after clicking Run is the shape this ticket removes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/preprocessApi.js', () => ({ startSegment: vi.fn(), startBuild: vi.fn() }));
vi.mock('../../../api/nucleiApi.js', () => ({ startNuclei: vi.fn() }));
vi.mock('../../../api/tissueApi.js', () => ({ startTissue: vi.fn(), getTissueCatalog: vi.fn() }));
vi.mock('../../../api/biomarkerApi.js', () => ({ startBiomarker: vi.fn() }));
vi.mock('../../../api/taskApi.js', () => ({ startPredict: vi.fn(), listTasks: vi.fn() }));

import { startBuild, startSegment } from '../../../api/preprocessApi.js';
import { startNuclei } from '../../../api/nucleiApi.js';
import { getTissueCatalog, startTissue } from '../../../api/tissueApi.js';
import { startBiomarker } from '../../../api/biomarkerApi.js';
import { listTasks, startPredict } from '../../../api/taskApi.js';
import {
  NATIVE_TOOLS, describePlan, firstProblem, isEnabled, seedValues, taskNote, toolParams,
} from './nativeCatalog.js';

const ITEM = '6a6e1ca82ae96ce927e33818';   // the DEMO slide
const ROI = { x: 7000, y: 7000, width: 4096, height: 4096 };
const tool = (id) => NATIVE_TOOLS.find(t => t.id === id);

beforeEach(() => { vi.clearAllMocks(); });

describe('the catalog itself', () => {
  it('lists every native tool, in the order a slide is worked through', () => {
    // Six, not five: the feature-index build joined in 07 as one entry with an encoder target,
    // rather than as the three DAG stages it runs (`patching` and `features` are still not here).
    expect(NATIVE_TOOLS.map(t => t.id))
      .toEqual(['segmentation', 'preprocess', 'nuclei', 'tissue', 'biomarker', 'prediction']);
  });

  it('gives every param a name, a label and a tag the renderer knows', () => {
    const known = new Set([
      'pa-scope', 'pa-region', 'pa-artifact',
      'boolean', 'float', 'integer', 'string-enumeration',
    ]);
    for (const t of NATIVE_TOOLS) {
      for (const p of toolParams(t)) {
        expect(p.name, `${t.id} param has no name`).toBeTruthy();
        expect(p.label, `${t.id}.${p.name} has no label`).toBeTruthy();
        expect(known, `${t.id}.${p.name} uses tag ${p.tag}`).toContain(p.tag);
      }
    }
  });

  it('seeds a form from the declared defaults', () => {
    expect(seedValues(tool('segmentation'))).toEqual({
      segmenter: 'hest', seg_conf_thresh: '0.5',
      remove_holes: 'false', remove_artifacts: 'false', remove_penmarks: 'false',
    });
  });
});

describe('scope and region are one decision in two fields', () => {
  it('disables the region picker once the run is whole-slide', () => {
    const bbox = toolParams(tool('nuclei')).find(p => p.tag === 'pa-region');
    expect(isEnabled(bbox, { scope: 'region' })).toBe(true);
    expect(isEnabled(bbox, { scope: 'whole' })).toBe(false);
  });

  it('asks for a rectangle before a region run, and not before a whole-slide one', () => {
    const t = tool('nuclei');
    expect(firstProblem(t, { scope: 'region' }, { roi: null }))
      .toMatch(/draw a region/i);
    expect(firstProblem(t, { scope: 'region' }, { roi: ROI })).toBeNull();
    expect(firstProblem(t, { scope: 'whole', seg_hash: 's1' }, { roi: null })).toBeNull();
  });

  it('asks for nothing an upstream could supply (Inc 6 · 08)', () => {
    // Until 07 this refused a whole-slide nuclei run with no segmentation, and a marker map with
    // neither upstream, in sentences telling the user to go and run something else first. Both
    // were true, and both were work the machine could do — the planner does it now.
    expect(firstProblem(tool('nuclei'), { scope: 'whole', seg_hash: '' }, {})).toBeNull();
    expect(firstProblem(tool('biomarker'), { scope: 'whole', seg_hash: '', nuclei_hash: '' }, {}))
      .toBeNull();
  });

  it('still asks for the two things a plan cannot supply', () => {
    // A rectangle nobody drew, and a choice only the user can make.
    expect(firstProblem(tool('nuclei'), { scope: 'region' }, { roi: null }))
      .toMatch(/draw a region/i);
    expect(firstProblem(tool('prediction'), { task_id: '' }, {})).toMatch(/task is required/i);
  });
});

describe('what a submission is about to cost', () => {
  it('names the upstreams and counts the queue slots out loud', () => {
    // At `concurrency=1` this is a wait the user agrees to on everyone else's behalf too.
    const view = describePlan({ status: 'planned', steps: [
      { kind: 'segmentation', title: 'Tissue segmentation' },
      { kind: 'nuclei', title: 'Nuclei segmentation' },
      { kind: 'biomarker', title: 'Marker map' },
    ] });
    expect(view.headline).toBe('3 steps · 3 queue slots, one after another');
    expect(view.upstreams).toEqual(['Tissue segmentation', 'Nuclei segmentation']);
  });

  it('says one slot in the singular', () => {
    expect(describePlan({ status: 'planned', steps: [{ kind: 'tissue', title: 'Tissue map' }] })
      .headline).toBe('1 step · 1 queue slot');
  });

  it('says so when there is nothing to run at all', () => {
    const view = describePlan({ status: 'ready', steps: [] });
    expect(view.built).toBe(true);
    expect(view.headline).toMatch(/already built/i);
  });

  it('is null before the server has answered', () => {
    expect(describePlan(null)).toBeNull();
  });
});

describe('submit hands each endpoint what it already expects', () => {
  it('segmentation: strings from the form become the numbers and booleans the API takes', async () => {
    await tool('segmentation').submit(ITEM, {
      segmenter: 'grandqc', seg_conf_thresh: '0.35',
      remove_holes: 'true', remove_artifacts: 'false', remove_penmarks: 'true',
    }, {});
    expect(startSegment.mock.calls[0].slice(0, 2)).toEqual([ITEM, {
      segmenter: 'grandqc', seg_conf_thresh: 0.35,
      remove_holes: true, remove_artifacts: false, remove_penmarks: true,
    }]);
  });

  it('nuclei: a region run sends the drawn rectangle and no seg_hash', async () => {
    await tool('nuclei').submit(ITEM, { scope: 'region', seg_hash: 's1' }, { roi: ROI });
    expect(startNuclei.mock.calls[0].slice(0, 2)).toEqual([ITEM, { bbox: ROI, seg_hash: null }]);
  });

  it('nuclei: a whole-slide run sends the seg_hash and no rectangle', async () => {
    await tool('nuclei').submit(ITEM, { scope: 'whole', seg_hash: 's1' }, { roi: ROI });
    expect(startNuclei.mock.calls[0].slice(0, 2)).toEqual([ITEM, { bbox: null, seg_hash: 's1' }]);
  });

  it('tissue: an unset backend is null, not the empty string the select holds', async () => {
    await tool('tissue').submit(ITEM, { scope: 'whole', seg_hash: 's1', backend: '' }, {});
    expect(startTissue.mock.calls[0].slice(0, 2)).toEqual([ITEM, { seg_hash: 's1', bbox: null, backend: null }]);
  });

  it('biomarker: both upstream hashes travel with the scope', async () => {
    await tool('biomarker').submit(
      ITEM, { scope: 'region', seg_hash: 's1', nuclei_hash: 'n1' }, { roi: ROI },
    );
    expect(startBiomarker.mock.calls[0].slice(0, 2)).toEqual([ITEM, {
      seg_hash: 's1', nuclei_hash: 'n1', bbox: ROI,
    }]);
  });

  it('prediction: the feature index and the head, and nothing about regions', async () => {
    await tool('prediction').submit(ITEM, { feat_hash: 'f1', task_id: 'brca-subtype' }, {});
    expect(startPredict.mock.calls[0].slice(0, 2)).toEqual([ITEM, {
      feat_hash: 'f1', task_id: 'brca-subtype',
    }]);
  });
});

describe('options only the service can answer', () => {
  it('reads the deployed tissue backends rather than hard-coding them', async () => {
    getTissueCatalog.mockResolvedValue({ backends: { bcss: {}, other: {} } });
    const backend = toolParams(tool('tissue')).find(p => p.name === 'backend');
    expect(await backend.optionsFrom()).toEqual([
      { value: 'bcss', label: 'bcss' }, { value: 'other', label: 'other' },
    ]);
  });

  it('unwraps the task catalog, which is an object and not a list', async () => {
    listTasks.mockResolvedValue({ tasks: [{ id: 'brca', label: 'BRCA IDC/ILC' }], available: true });
    const task = toolParams(tool('prediction')).find(p => p.name === 'task_id');
    expect(await task.optionsFrom()).toEqual([
      { value: 'brca', label: 'BRCA IDC/ILC', note: '' },
    ]);
  });
});

// ── The feature-index build (Inc 6 · 07) ─────────────────────────────────────

describe('the feature index is one entry with an encoder target', () => {
  const build = () => tool('preprocess');

  it('does not offer tiling or encoding as tools of their own', () => {
    // Cutting tiles at a size no encoder was trained on is minutes of GPU nobody can use, which is
    // why the geometry is bound to the encoder instead of being a fourth entry in this list.
    expect(NATIVE_TOOLS.map(t => t.id)).not.toContain('patching');
    expect(NATIVE_TOOLS.map(t => t.id)).not.toContain('features');
  });

  it('opens on the text-aligned encoder at its trained geometry', () => {
    const v = seedValues(build());
    expect(v.encoder).toBe('conch_v1_text');
    expect(v.patch_size).toBe('512');
    expect(v.mag).toBe('20');
  });

  it('re-seeds the tiling when the encoder changes (Fork B)', () => {
    const next = build().onChange('encoder', 'uni_v2');
    expect(next).toMatchObject({ encoder: 'uni_v2', patch_size: '256', mag: '20' });
  });

  it('leaves every other field alone', () => {
    expect(build().onChange('segmenter', 'otsu')).toBeNull();
  });

  it('submits one build, with the numbers as numbers', () => {
    build().submit(ITEM, { ...seedValues(build()), segmenter: 'otsu', seg_conf_thresh: '0.4' });
    expect(startBuild.mock.calls[0].slice(0, 2)).toEqual([ITEM, {
      encoder: 'conch_v1_text', segmenter: 'otsu', seg_conf_thresh: 0.4,
      mag: 20, patch_size: 512, overlap: 0,
    }]);
  });

  it('says what each encoder is for, on the option itself', () => {
    const enc = toolParams(build()).find(p => p.name === 'encoder');
    expect(enc.options.find(o => o.value === 'conch_v1_text').note).toContain('text-aligned');
    expect(enc.options.find(o => o.value === 'uni_v2').note).toContain('256 px at 20×');
  });
});

describe('the downstream task', () => {
  it('needs a task and nothing else', () => {
    const values = seedValues(tool('prediction'));
    expect(firstProblem(tool('prediction'), values, { artifacts: [] }))
      .toBe('Task is required.');
    expect(firstProblem(tool('prediction'), { ...values, task_id: 'brca' }, { artifacts: [] }))
      .toBeNull();
  });

  it('submits without a feature index, which is what makes it one submission', () => {
    // The server finds the index matching the task's spec, or plans the build. A slide with
    // nothing on it reaches a call in one click.
    tool('prediction').submit(ITEM, { task_id: 'brca', feat_hash: '' });
    expect(startPredict.mock.calls[0].slice(0, 2)).toEqual([ITEM, { task_id: 'brca', feat_hash: null }]);
  });

  it('sends a named index when one was chosen deliberately', () => {
    tool('prediction').submit(ITEM, { task_id: 'brca', feat_hash: 'f1' });
    expect(startPredict.mock.calls[0].slice(0, 2)).toEqual([ITEM, { task_id: 'brca', feat_hash: 'f1' }]);
  });

  it('carries the model card on the option — what it eats, its scores, and its caveat', () => {
    const note = taskNote({
      id: 'brca', label: 'BRCA IDC vs ILC', classes: ['IDC', 'ILC'],
      cohort: 'TCGA-BRCA — 942 cases', caveat: 'Research use only.',
      feature_spec: { encoder: 'conch_v1', mag: 20, patch_size: 512, overlap: 0 },
      metrics: { test_auc: 0.9421, test_acc: 0.881 },
    });
    expect(note).toContain('Needs CONCH V1 · 512 px · 20×');
    expect(note).toContain('Trained on TCGA-BRCA — 942 cases');
    expect(note).toContain('AUC 0.942');
    expect(note).toContain('Research use only.');
  });

  it('says nothing it was not told — a task with no card gets no note', () => {
    expect(taskNote({ id: 'x' })).toBe('');
  });
});
