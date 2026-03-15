// src/api/claudeApi.js
// Claude 3.5 Sonnet vision analysis for Ki67 IHC pathology images.
// Runs entirely in the browser — requires VITE_ANTHROPIC_API_KEY in .env.local.
import Anthropic from '@anthropic-ai/sdk';

// ── Model config ──────────────────────────────────────────────────────────────
export const AI_MODEL        = 'claude-sonnet-4-6';
export const AI_MODEL_LABEL  = 'Claude Sonnet 4.6';

// Pricing (USD per token) — update if Anthropic changes rates
const PRICE_INPUT_PER_TOK  = 3.00  / 1_000_000; // $3.00 / MTok
const PRICE_OUTPUT_PER_TOK = 15.00 / 1_000_000; // $15.00 / MTok

// ── Prompts ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT =
  'You are an expert computational pathologist specializing in Ki67 ' +
  'immunohistochemistry (IHC) quantification. ' +
  'You respond ONLY with a single valid JSON object — no markdown, no prose, no code fences.';

const USER_PROMPT =
  'Analyze this Ki67 IHC stained histology image.\n\n' +
  'Staining rules:\n' +
  '- Brown (DAB) nuclei = Ki67-POSITIVE (proliferating)\n' +
  '- Blue (hematoxylin) nuclei = Ki67-NEGATIVE (resting)\n\n' +
  'Return EXACTLY this JSON object (replace the placeholder values with real numbers/strings):\n' +
  '{"ki67_percentage":82.5,"positive_count":412,"negative_count":89,"total_count":501,' +
  '"stain_quality":"good","proliferation_activity":"high",' +
  '"interpretation":"High Ki67 proliferation index consistent with aggressive neoplasm.",' +
  '"confidence":"high","notes":""}\n\n' +
  'Rules for each field:\n' +
  '- ki67_percentage: number 0-100 (positive_count/total_count*100)\n' +
  '- positive_count: integer >= 0\n' +
  '- negative_count: integer >= 0\n' +
  '- total_count: positive_count + negative_count\n' +
  '- stain_quality: exactly one of "good", "fair", "poor"\n' +
  '- proliferation_activity: exactly one of "low" (<15%), "intermediate" (15-30%), "high" (>30%)\n' +
  '- interpretation: 1-2 sentence clinical summary\n' +
  '- confidence: exactly one of "high", "medium", "low"\n' +
  '- notes: caveats or empty string\n\n' +
  'Output ONLY the JSON object. No other text.';

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
  throw new Error(`Cannot parse model response as JSON: ${text.slice(0, 300)}`);
}

function normalizeResult(raw) {
  const n = { ...raw };

  if (n.ki67_percentage == null)
    n.ki67_percentage = n.ki67Index ?? n.ki67_index ?? n.proliferationIndex ??
      n.proliferation_index ?? n.ki67 ?? n.percentage ?? n.index ?? null;
  if (typeof n.ki67_percentage === 'string') n.ki67_percentage = parseFloat(n.ki67_percentage);

  if (n.positive_count == null)
    n.positive_count = n.positiveCells ?? n.positive_cells ?? n.positiveCount ??
      n.brownNuclei ?? n.brown_nuclei ?? null;

  if (n.negative_count == null)
    n.negative_count = n.negativeCells ?? n.negative_cells ?? n.negativeCount ??
      n.blueNuclei ?? n.blue_nuclei ?? null;

  if (n.total_count == null)
    n.total_count = n.totalCells ?? n.total_cells ?? n.totalCount ?? n.totalNuclei ??
      (n.positive_count != null && n.negative_count != null
        ? n.positive_count + n.negative_count : null);

  if (!n.stain_quality)
    n.stain_quality = n.stainingQuality ?? n.staining_quality ?? n.quality ?? null;

  if (!n.proliferation_activity) {
    n.proliferation_activity = n.proliferationActivity ?? n.proliferationLevel ??
      n.proliferation_level ?? n.activity ?? null;
    if (!n.proliferation_activity && n.ki67_percentage != null) {
      const p = n.ki67_percentage;
      n.proliferation_activity = p > 30 ? 'high' : p > 15 ? 'intermediate' : 'low';
    }
  }

  if (!n.confidence)     n.confidence     = n.confidenceLevel ?? n.confidence_level ?? null;
  if (!n.interpretation) n.interpretation = n.summary ?? n.clinical_summary ?? null;
  if (!n.notes)          n.notes          = n.caveats ?? n.comments ?? null;

  return n;
}

// ── Exported cost calculator (also used by AIPanel) ───────────────────────────
export function calcCost(inputTok, outputTok) {
  return inputTok * PRICE_INPUT_PER_TOK + outputTok * PRICE_OUTPUT_PER_TOK;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Analyse a Ki67 IHC image region using Claude 3.5 Sonnet.
 * @param {Blob} imageBlob  PNG blob from Girder tiles/region
 * @returns {Promise<{ result: object, usage: { input_tokens, output_tokens, cost_usd } }>}
 */
export async function analyzeKi67WithOpus(imageBlob) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(
    'VITE_ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.'
  );

  const base64    = await blobToBase64(imageBlob);
  const mediaType = imageBlob.type || 'image/png';

  const anthropic = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const message = await anthropic.messages.create({
    model:      AI_MODEL,
    max_tokens: 512,
    system:     SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text',  text: USER_PROMPT },
      ],
    }],
  });

  const text   = message.content?.[0]?.text ?? '';
  const raw    = extractJson(text);
  const result = normalizeResult(raw);

  const inputTok  = message.usage?.input_tokens  ?? 0;
  const outputTok = message.usage?.output_tokens ?? 0;
  const usage = {
    input_tokens:  inputTok,
    output_tokens: outputTok,
    cost_usd:      calcCost(inputTok, outputTok),
  };

  return { result, usage };
}
