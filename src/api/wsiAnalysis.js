// src/api/wsiAnalysis.js
// Whole-slide analysis: sample patches in a grid, analyze each with Gemini,
// aggregate into tumor%, purity, necrosis%, heterogeneity index, patch stats.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRegionImageBlob } from './index.js';
import { GEMINI_MODEL, GEMINI_MODEL_LABEL, calcGeminiCost } from './geminiApi.js';

// ── Config ────────────────────────────────────────────────────────────────────
const GRID_N         = 4;     // 4×4 = 16 patches
const PATCH_OUTPUT   = 512;   // max output pixels per side
const PATCH_MAG      = 10;    // magnification for tissue-level context
const TISSUE_MIN     = 0.15;  // skip patch if < 15% tissue pixels
const INTER_PATCH_MS = 300;   // delay between Gemini calls (rate limit safety)

// ── Prompts ───────────────────────────────────────────────────────────────────
const WSI_SYSTEM_PROMPT =
  'You are an expert computational pathologist performing whole-slide image (WSI) analysis. ' +
  'You analyze H&E stained tissue patches sampled from across a pathology slide. ' +
  'You respond ONLY with a single valid JSON object — no markdown, no prose, no code fences.';

const WSI_USER_PROMPT =
  'Analyze this H&E stained tissue patch (512×512 pixels, 10× magnification, ~0.5mm × 0.5mm).\n\n' +
  'Estimate the percentage of the visible area occupied by each tissue compartment:\n' +
  '- tumor_pct: viable neoplastic cells (pleomorphism, high N/C ratio, mitoses, invasive nests)\n' +
  '- stroma_pct: fibrous stroma, connective tissue, desmoplasia\n' +
  '- necrosis_pct: necrotic zones (ghost nuclei, karyolysis, debris — NO viable cells)\n' +
  '- other_pct: remaining (vessels, adipose, lymphocytes, normal epithelium, background glass)\n\n' +
  'All four must sum to 100.\n\n' +
  'Return ONLY this JSON with YOUR OWN values from the image:\n' +
  '{"tumor_pct":0,"stroma_pct":0,"necrosis_pct":0,"other_pct":100,' +
  '"tissue_type":"background","confidence":"high","notes":""}\n\n' +
  'tissue_type: one of "invasive_carcinoma","in_situ","stroma_only","necrosis_dominant",' +
  '"normal_tissue","mixed","background"\n' +
  'confidence: "high"|"medium"|"low"\n' +
  'Output ONLY the JSON. No markdown. No code fences.';

// ── Helpers ───────────────────────────────────────────────────────────────────
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extractJson(text) {
  let s = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }
  throw new Error(`Cannot parse Gemini WSI response: ${text.slice(0, 200)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tissue heuristic ─────────────────────────────────────────────────────────
// Returns fraction of pixels that are not background (white glass or black border).
async function tissueFraction(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const SIZE   = 64;
    let canvas, ctx;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(SIZE, SIZE);
      ctx    = canvas.getContext('2d');
    } else {
      canvas        = document.createElement('canvas');
      canvas.width  = SIZE;
      canvas.height = SIZE;
      ctx           = canvas.getContext('2d');
    }
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
    const data   = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let tissue   = 0;
    const total  = SIZE * SIZE;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const isWhite = r > 220 && g > 220 && b > 220;
      const isBlack = r <  15 && g <  15 && b <  15;
      if (!isWhite && !isBlack) tissue++;
    }
    return tissue / total;
  } catch {
    return 1; // assume tissue on error
  }
}

// ── Grid computation ─────────────────────────────────────────────────────────
export function computePatchGrid(tilesInfo, gridN = GRID_N) {
  const { sizeX, sizeY } = tilesInfo;
  const cellW = sizeX / gridN;
  const cellH = sizeY / gridN;
  const patches = [];
  for (let row = 0; row < gridN; row++) {
    for (let col = 0; col < gridN; col++) {
      // center of cell
      const cx = (col + 0.5) * cellW;
      const cy = (row + 0.5) * cellH;
      // region size in base pixels that maps to PATCH_OUTPUT at PATCH_MAG
      // Girder handles rescaling; we just clamp to cell bounds
      const w = Math.min(cellW, Math.round(PATCH_OUTPUT * ((tilesInfo.magnification || 40) / PATCH_MAG)));
      const h = Math.min(cellH, Math.round(PATCH_OUTPUT * ((tilesInfo.magnification || 40) / PATCH_MAG)));
      patches.push({
        patchIndex: row * gridN + col,
        col, row,
        x: Math.round(cx - w / 2),
        y: Math.round(cy - h / 2),
        w, h,
      });
    }
  }
  return patches;
}

// ── Per-patch Gemini call ────────────────────────────────────────────────────
async function analyzePatch(blob, apiKey) {
  const base64    = await blobToBase64(blob);
  const mediaType = blob.type || 'image/png';
  const genAI     = new GoogleGenerativeAI(apiKey);
  const model     = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: WSI_SYSTEM_PROMPT });
  const response  = await model.generateContent([
    { inlineData: { mimeType: mediaType, data: base64 } },
    WSI_USER_PROMPT,
  ]);
  const text  = response.response.text();
  const raw   = extractJson(text);
  const meta  = response.response.usageMetadata ?? {};
  return {
    result: raw,
    inputTok:  meta.promptTokenCount     ?? 0,
    outputTok: meta.candidatesTokenCount ?? 0,
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────────
function aggregatePatches(patchResults) {
  const analyzed = patchResults.filter((p) => p.status === 'analyzed');
  if (analyzed.length === 0) return null;

  const vals  = (key) => analyzed.map((p) => p[key] ?? 0);
  const mean  = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std   = (arr) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  };

  const tumorPcts   = vals('tumor_pct');
  const stromaPcts  = vals('stroma_pct');
  const necrosisPcts = vals('necrosis_pct');

  const tumorMean  = mean(tumorPcts);
  const tumorStd   = std(tumorPcts);
  const stromaMean = mean(stromaPcts);

  const purities = analyzed.map((p) => {
    const t = p.tumor_pct ?? 0, s = p.stroma_pct ?? 0;
    return (t + s) > 0 ? (t / (t + s)) * 100 : 0;
  });

  // 5-bin histogram [0-20, 20-40, 40-60, 60-80, 80-100]
  const histogram = [0, 0, 0, 0, 0];
  tumorPcts.forEach((p) => { histogram[Math.min(4, Math.floor(p / 20))]++; });

  const skipped = patchResults.filter((p) => p.status === 'skipped').length;
  const failed  = patchResults.filter((p) => p.status === 'failed').length;

  return {
    analyzed_count:       analyzed.length,
    skipped_count:        skipped,
    failed_count:         failed,
    total_patches:        patchResults.length,
    tumor_pct_mean:       +tumorMean.toFixed(1),
    tumor_pct_std:        +tumorStd.toFixed(1),
    tumor_pct_min:        +Math.min(...tumorPcts).toFixed(1),
    tumor_pct_max:        +Math.max(...tumorPcts).toFixed(1),
    tumor_pct_histogram:  histogram,
    tumor_purity:         +(mean(purities) / 100).toFixed(3),
    necrosis_pct_mean:    +mean(necrosisPcts).toFixed(1),
    stroma_pct_mean:      +stromaMean.toFixed(1),
    heterogeneity_index:  tumorMean > 0 ? +(tumorStd / tumorMean).toFixed(3) : 0,
    partial_warning:      failed > 0 ? `${failed} patch${failed > 1 ? 'es' : ''} failed` : null,
  };
}

// ── Shared patch analysis loop ────────────────────────────────────────────────
async function runPatchLoop(patches, itemId, apiKey, onProgress) {
  const patchGrid    = patches.map(() => 'pending');
  const patchResults = [];
  let totalInputTok  = 0;
  let totalOutputTok = 0;
  let analyzed       = 0;

  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    patchGrid[i] = 'analyzing';
    onProgress({ current: i + 1, total: patches.length, patchGrid: [...patchGrid] });

    let entry;
    try {
      const blob     = await getRegionImageBlob(itemId, p.x, p.y, p.w, p.h, PATCH_MAG, PATCH_OUTPUT);
      const fraction = await tissueFraction(blob);

      if (fraction < TISSUE_MIN) {
        patchGrid[i] = 'skipped';
        entry = { ...p, status: 'skipped', tissueFraction: +fraction.toFixed(3), skipReason: 'background' };
      } else {
        const { result, inputTok, outputTok } = await analyzePatch(blob, apiKey);
        totalInputTok  += inputTok;
        totalOutputTok += outputTok;
        analyzed++;
        patchGrid[i] = 'done';
        entry = {
          ...p, status: 'analyzed', tissueFraction: +fraction.toFixed(3),
          tumor_pct:    result.tumor_pct    ?? 0,
          stroma_pct:   result.stroma_pct   ?? 0,
          necrosis_pct: result.necrosis_pct ?? 0,
          other_pct:    result.other_pct    ?? 0,
          tissue_type:  result.tissue_type  ?? 'unknown',
          confidence:   result.confidence   ?? 'low',
          notes:        result.notes        ?? '',
        };
      }
    } catch (err) {
      console.error(`[WSI] Patch ${i} failed:`, err.message);
      patchGrid[i] = 'failed';
      entry = { ...p, status: 'failed', error: err.message };
    }

    patchResults.push(entry);
    onProgress({ current: i + 1, total: patches.length, patchGrid: [...patchGrid] });
    if (i < patches.length - 1) await sleep(INTER_PATCH_MS);
  }

  return { patchResults, totalInputTok, totalOutputTok, analyzed };
}

// ── Whole-slide orchestrator ──────────────────────────────────────────────────
export async function analyzeWholeSlide(itemId, tilesInfo, onProgress) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('VITE_GEMINI_API_KEY is not set. Add it to .env.local.');

  const patches = computePatchGrid(tilesInfo);
  const { patchResults, totalInputTok, totalOutputTok, analyzed } =
    await runPatchLoop(patches, itemId, apiKey, onProgress);

  const aggregate = aggregatePatches(patchResults);
  if (!aggregate || aggregate.analyzed_count < 3)
    throw new Error(`Insufficient tissue: only ${analyzed} patches had analyzable tissue.`);

  return {
    aggregate, patchResults,
    gridN: GRID_N,
    slideWidth: tilesInfo.sizeX, slideHeight: tilesInfo.sizeY,
    modelLabel: GEMINI_MODEL_LABEL,
    usage: { input_tokens: totalInputTok, output_tokens: totalOutputTok,
             cost_usd: calcGeminiCost(totalInputTok, totalOutputTok), patch_calls: analyzed },
  };
}

// ── ROI grid orchestrator ─────────────────────────────────────────────────────
const ROI_GRID_N   = 3;  // 3×3 = 9 patches for a focused ROI
const ROI_PATCH_MAG = 20; // higher magnification for ROI (more detail)

export async function analyzeRoiGrid(itemId, roi, onProgress) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('VITE_GEMINI_API_KEY is not set. Add it to .env.local.');

  const { x, y, width, height } = roi;
  const cellW = width  / ROI_GRID_N;
  const cellH = height / ROI_GRID_N;

  const patches = Array.from({ length: ROI_GRID_N * ROI_GRID_N }, (_, i) => {
    const col = i % ROI_GRID_N, row = Math.floor(i / ROI_GRID_N);
    return {
      patchIndex: i, col, row,
      x: Math.round(x + col * cellW),
      y: Math.round(y + row * cellH),
      w: Math.round(cellW),
      h: Math.round(cellH),
    };
  });

  const { patchResults, totalInputTok, totalOutputTok, analyzed } =
    await runPatchLoop(patches, itemId, apiKey, onProgress);

  const aggregate = aggregatePatches(patchResults);
  if (!aggregate || aggregate.analyzed_count < 2)
    throw new Error(`Insufficient tissue in ROI: only ${analyzed} patches had analyzable tissue.`);

  return {
    aggregate, patchResults,
    gridN: ROI_GRID_N,
    modelLabel: GEMINI_MODEL_LABEL,
    usage: { input_tokens: totalInputTok, output_tokens: totalOutputTok,
             cost_usd: calcGeminiCost(totalInputTok, totalOutputTok), patch_calls: analyzed },
  };
}
