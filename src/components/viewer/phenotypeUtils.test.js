import { describe, it, expect } from 'vitest';

import {
  phenotypeCounts, flagCounts, legendLabel, cellTooltip, nearestCell,
} from './phenotypeUtils.js';
import { colorForPhenotype, presentPhenotypes, PHENOTYPE_ORDER } from './phenotypeColors.js';

const PHENO = {
  points: [[10, 10], [20, 20], [30, 30]],
  classes: ['Tumour', 'Tumour', 'Cytotoxic T'],
  cells: [
    { x: 10, y: 10, phenotype: 'Tumour', flags: [], markers: { CK: 0.91 } },
    { x: 20, y: 20, phenotype: 'Tumour', flags: [], markers: { CK: 0.82 } },
    { x: 30, y: 30, phenotype: 'Cytotoxic T', flags: ['Proliferating', 'PD-1+'],
      markers: { CD8: 0.9, CD3: 0.7, Ki67: 0.6 } },
  ],
};

describe('phenotypeUtils', () => {
  it('counts lineages from classes', () => {
    expect(phenotypeCounts(PHENO)).toEqual({ Tumour: 2, 'Cytotoxic T': 1 });
    expect(phenotypeCounts(null)).toEqual({});
  });

  it('tallies functional flags across cells', () => {
    expect(flagCounts(PHENO)).toEqual({ Proliferating: 1, 'PD-1+': 1 });
  });

  it('formats a legend label with its count', () => {
    expect(legendLabel('Tumour', phenotypeCounts(PHENO))).toBe('2 Tumour');
  });

  it('builds a tooltip with lineage, flags and top markers (2dp, region-relative)', () => {
    const t = cellTooltip(PHENO.cells[2]);
    expect(t).toContain('Cytotoxic T');
    expect(t).toContain('Proliferating, PD-1+');
    expect(t).toContain('CD8 0.90');       // sorted desc, two decimals
    expect(cellTooltip(null)).toBe('');
  });

  it('finds the nearest cell within the hit radius', () => {
    const project = (i) => ({ x: PHENO.points[i][0], y: PHENO.points[i][1] });
    expect(nearestCell(PHENO.points, project, 21, 19)).toBe(1);   // near [20,20]
    expect(nearestCell(PHENO.points, project, 200, 200)).toBe(-1); // nothing within radius
  });
});

describe('phenotypeColors', () => {
  it('maps a lineage to a stable colour, Other → default', () => {
    expect(colorForPhenotype('Tumour')).toContain('220, 38, 38');
    expect(colorForPhenotype('Other')).toBe(colorForPhenotype('nonsense'));
  });

  it('lists present phenotypes in canonical order', () => {
    expect(presentPhenotypes(PHENO)).toEqual(['Tumour', 'Cytotoxic T']);
    expect(PHENOTYPE_ORDER[0]).toBe('Tumour');
  });
});
