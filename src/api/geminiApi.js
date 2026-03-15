// src/api/geminiApi.js
// Gemini 2.0 Flash vision analysis for Ki67 IHC pathology images.
// Runs entirely in the browser — requires VITE_GOOGLE_AI_API_KEY in .env.local.
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Model config ──────────────────────────────────────────────────────────────
export const GEMINI_MODEL       = 'gemini-2.5-flash-lite';
export const GEMINI_MODEL_LABEL = 'Gemini 2.5 Flash Lite';

// Pricing (USD per token) — Gemini 1.5 Pro (≤128K context)
const PRICE_INPUT_PER_TOK  = 1.25 / 1_000_000; // $1.25 / MTok
const PRICE_OUTPUT_PER_TOK = 5.00 / 1_000_000; // $5.00 / MTok

// ── Prompts ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT =
  'You are an expert computational pathologist specializing in Ki67 ' +
  'immunohistochemistry (IHC) quantification. ' +
  'You respond ONLY with a single valid JSON object — no markdown, no prose, no code fences.';

const USER_PROMPT =
  'Analyze this Ki67 IHC histology image. Count the brown (DAB, Ki67-positive) and blue (hematoxylin, Ki67-negative) nuclei.\n\n' +
  'Respond with ONLY a JSON object using these exact keys:\n' +
  '{\n' +
  '  "ki67_percentage": <number 0-100, positive/total*100>,\n' +
  '  "positive_count": <integer, brown nuclei>,\n' +
  '  "negative_count": <integer, blue nuclei>,\n' +
  '  "total_count": <positive + negative>,\n' +
  '  "stain_quality": <"good"|"fair"|"poor">,\n' +
  '  "proliferation_activity": <"low" if <15%, "intermediate" if 15-30%, "high" if >30%>,\n' +
  '  "interpretation": <1-2 sentence clinical summary>,\n' +
  '  "confidence": <"high"|"medium"|"low">,\n' +
  '  "notes": <caveats or empty string>\n' +
  '}\n\n' +
  'Use YOUR OWN counts from the image. Output ONLY the JSON. No markdown, no code fences.';

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
  throw new Error(`Cannot parse Gemini response as JSON: ${text.slice(0, 300)}`);
}

export function calcGeminiCost(inputTok, outputTok) {
  return inputTok * PRICE_INPUT_PER_TOK + outputTok * PRICE_OUTPUT_PER_TOK;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Analyse a Ki67 IHC image region using Gemini 2.0 Flash.
 * @param {Blob} imageBlob  PNG blob from Girder tiles/region
 * @returns {Promise<{ result: object, usage: { input_tokens, output_tokens, cost_usd } }>}
 */
export async function analyzeKi67WithGemini(imageBlob) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error(
    'VITE_GEMINI_API_KEY is not set. Add it to .env.local and restart the dev server.'
  );

  const base64    = await blobToBase64(imageBlob);
  const mediaType = imageBlob.type || 'image/png';

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: SYSTEM_PROMPT,
  });

  let response;
  try {
    response = await model.generateContent([
      { inlineData: { mimeType: mediaType, data: base64 } },
      USER_PROMPT,
    ]);
  } catch (err) {
    console.error('[Gemini] generateContent failed:', err?.message);
    throw err;
  }

  const text      = response.response.text();
  const result    = extractJson(text);
  const meta      = response.response.usageMetadata ?? {};
  const inputTok  = meta.promptTokenCount     ?? 0;
  const outputTok = meta.candidatesTokenCount ?? 0;

  const usage = {
    input_tokens:  inputTok,
    output_tokens: outputTok,
    cost_usd:      calcGeminiCost(inputTok, outputTok),
  };

  return { result, usage };
}
