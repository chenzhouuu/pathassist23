// The native tool declarations (Inc 6 · 02). Two things are worth asserting: that the declared
// form is the one the tool's endpoint actually wants, and that the panel refuses to submit a run
// whose upstream is missing — because the failure a user hits is "no nuclei on this slide yet",
// and finding that out from a 409 after clicking Run is the shape this ticket removes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/preprocessApi.js', () => ({ startSegment: vi.fn() }));
vi.mock('../../../api/nucleiApi.js', () => ({ startNuclei: vi.fn() }));
vi.mock('../../../api/tissueApi.js', () => ({ startTissue: vi.fn(), getTissueCatalog: vi.fn() }));
vi.mock('../../../api/biomarkerApi.js', () => ({ startBiomarker: vi.fn() }));
vi.mock('../../../api/taskApi.js', () => ({ startPredict: vi.fn(), listTasks: vi.fn() }));

import { startSegment } from '../../../api/preprocessApi.js';
import { startNuclei } from '../../../api/nucleiApi.js';
import { getTissueCatalog, startTissue } from '../../../api/tissueApi.js';
import { startBiomarker } from '../../../api/biomarkerApi.js';
import { listTasks, startPredict } from '../../../api/taskApi.js';
import {
  NATIVE_TOOLS, firstProblem, isEnabled, seedValues, toolParams,
} from './nativeCatalog.js';

const ITEM = '6a6e1ca82ae96ce927e33818';   // the DEMO slide
const ROI = { x: 7000, y: 7000, width: 4096, height: 4096 };
const tool = (id) => NATIVE_TOOLS.find(t => t.id === id);

beforeEach(() => { vi.clearAllMocks(); });

describe('the catalog itself', () => {
  it('lists the five tools the five panels cover', () => {
    expect(NATIVE_TOOLS.map(t => t.id))
      .toEqual(['segmentation', 'nuclei', 'tissue', 'biomarker', 'prediction']);
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

  it('needs a segmentation for a whole-slide nuclei run only', () => {
    const t = tool('nuclei');
    expect(firstProblem(t, { scope: 'whole', seg_hash: '' }, { roi: null }))
      .toMatch(/tissue segmentation is required/i);
    // A drawn region enumerates its own tiles, so it does not.
    expect(firstProblem(t, { scope: 'region', seg_hash: '' }, { roi: ROI })).toBeNull();
  });

  it('needs both upstreams for a marker map, whatever the scope', () => {
    const t = tool('biomarker');
    expect(firstProblem(t, { scope: 'whole', seg_hash: '', nuclei_hash: 'n1' }, {}))
      .toMatch(/tissue segmentation is required/i);
    expect(firstProblem(t, { scope: 'whole', seg_hash: 's1', nuclei_hash: '' }, {}))
      .toMatch(/nuclei is required/i);
    expect(firstProblem(t, { scope: 'whole', seg_hash: 's1', nuclei_hash: 'n1' }, {})).toBeNull();
  });
});

describe('submit hands each endpoint what it already expects', () => {
  it('segmentation: strings from the form become the numbers and booleans the API takes', async () => {
    await tool('segmentation').submit(ITEM, {
      segmenter: 'grandqc', seg_conf_thresh: '0.35',
      remove_holes: 'true', remove_artifacts: 'false', remove_penmarks: 'true',
    }, {});
    expect(startSegment).toHaveBeenCalledWith(ITEM, {
      segmenter: 'grandqc', seg_conf_thresh: 0.35,
      remove_holes: true, remove_artifacts: false, remove_penmarks: true,
    });
  });

  it('nuclei: a region run sends the drawn rectangle and no seg_hash', async () => {
    await tool('nuclei').submit(ITEM, { scope: 'region', seg_hash: 's1' }, { roi: ROI });
    expect(startNuclei).toHaveBeenCalledWith(ITEM, { bbox: ROI, seg_hash: null });
  });

  it('nuclei: a whole-slide run sends the seg_hash and no rectangle', async () => {
    await tool('nuclei').submit(ITEM, { scope: 'whole', seg_hash: 's1' }, { roi: ROI });
    expect(startNuclei).toHaveBeenCalledWith(ITEM, { bbox: null, seg_hash: 's1' });
  });

  it('tissue: an unset backend is null, not the empty string the select holds', async () => {
    await tool('tissue').submit(ITEM, { scope: 'whole', seg_hash: 's1', backend: '' }, {});
    expect(startTissue).toHaveBeenCalledWith(ITEM, { seg_hash: 's1', bbox: null, backend: null });
  });

  it('biomarker: both upstream hashes travel with the scope', async () => {
    await tool('biomarker').submit(
      ITEM, { scope: 'region', seg_hash: 's1', nuclei_hash: 'n1' }, { roi: ROI },
    );
    expect(startBiomarker).toHaveBeenCalledWith(ITEM, {
      seg_hash: 's1', nuclei_hash: 'n1', bbox: ROI,
    });
  });

  it('prediction: the feature index and the head, and nothing about regions', async () => {
    await tool('prediction').submit(ITEM, { feat_hash: 'f1', task_id: 'brca-subtype' }, {});
    expect(startPredict).toHaveBeenCalledWith(ITEM, {
      feat_hash: 'f1', task_id: 'brca-subtype',
    });
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
    expect(await task.optionsFrom()).toEqual([{ value: 'brca', label: 'BRCA IDC/ILC' }]);
  });
});
