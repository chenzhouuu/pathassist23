// src/api/pathChatApi.js
// AskPA — multi-turn vision chat for pathology case consultation.
// Claude: requires VITE_ANTHROPIC_API_KEY in .env.local.
// MedGemma: requires VITE_GEMINI_API_KEY in .env.local.
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Model config ──────────────────────────────────────────────────────────────
export const CHAT_MODELS = {
  'claude-sonnet-4-6': { label: 'Sonnet',   maxTokens: 2048, provider: 'anthropic' },
  'claude-opus-4-6':   { label: 'Opus',     maxTokens: 2048, provider: 'anthropic' },
  'medgemma-4b-it':    { label: 'MedGemma', maxTokens: 2048, provider: 'google' },
};

const PRICE = {
  'claude-sonnet-4-6': { in: 3.00  / 1_000_000, out: 15.00 / 1_000_000 },
  'claude-opus-4-6':   { in: 15.00 / 1_000_000, out: 75.00 / 1_000_000 },
  'medgemma-4b-it':    { in: 0,                  out: 0 },                // free via AI Studio
};

export function calcChatCost(modelId, inputTok, outputTok) {
  const p = PRICE[modelId] || PRICE['claude-sonnet-4-6'];
  return inputTok * p.in + outputTok * p.out;
}

// ── System prompt ─────────────────────────────────────────────────────────────
export function buildSystemPrompt(activeItem, tilesInfo) {
  const slideName = activeItem?.name || 'Unknown slide';
  const dimStr = tilesInfo
    ? `${tilesInfo.sizeX} × ${tilesInfo.sizeY} px`
    : 'dimensions unknown';
  const magStr = tilesInfo?.magnification
    ? ` · ${tilesInfo.magnification}× native magnification`
    : '';

  return [
    'You are AskPA, an AI pathology copilot embedded in PathAssist — a digital slide viewer used by pathologists.',
    '',
    'Your role: help the pathologist consult on cases, reason about morphological findings, provide differential diagnoses,',
    'explain staining patterns, assist with cell counting estimates, and draft structured pathology reports.',
    '',
    'Current slide context:',
    `- Slide: ${slideName}`,
    `- Dimensions: ${dimStr}${magStr}`,
    '',
    'When a message includes an image, it is a JPEG screenshot of the pathologist\'s current viewport.',
    'The zoom level is noted in each message as "[Zoom: XX×]".',
    '',
    'Guidelines:',
    '- Think step by step before giving conclusions',
    '- Use standard pathology terminology (H&E, IHC, DAB, hematoxylin, mitotic figures, nuclear pleomorphism, etc.)',
    '- Distinguish definitive findings from differential possibilities',
    '- If image quality or field of view is insufficient to answer, say so explicitly — do not guess',
    '- Do not fabricate cell counts or percentages unless asked to estimate; always label estimates as estimates',
    '- When asked to generate a report, use standard structured format: Clinical History, Gross Description, Microscopic Description, Diagnosis, Comment',
  ].join('\n');
}

// ── Viewport capture ──────────────────────────────────────────────────────────
export function captureViewport(maxPx = 800) {
  const canvas = document.querySelector('#osd-viewer canvas');
  if (!canvas) return null;
  try {
    const scale = Math.min(1, maxPx / canvas.width);
    const out = document.createElement('canvas');
    out.width  = Math.round(canvas.width  * scale);
    out.height = Math.round(canvas.height * scale);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL('image/jpeg', 0.82);
    return dataUrl.split(',')[1];
  } catch {
    return null;
  }
}

// ── Context suffix ────────────────────────────────────────────────────────────
export function buildContextSuffix(zoom, roiSelectResult) {
  const parts = [`Zoom: ${zoom || '—'}`];
  if (roiSelectResult) {
    const { x, y, width, height } = roiSelectResult;
    parts.push(`Active ROI: (${Math.round(x)}, ${Math.round(y)}) ${Math.round(width)}×${Math.round(height)} px`);
  } else {
    parts.push('ROI: none');
  }
  return `\n\n[${parts.join(' | ')}]`;
}

// ── Compute zoom string from OSD viewer ───────────────────────────────────────
export function computeZoomString(viewer, tilesInfo) {
  if (!viewer?.viewport) return '—';
  try {
    const vpZoom    = viewer.viewport.getZoom(true);
    const imgZoom1x = viewer.viewport.imageToViewportZoom(1);
    if (imgZoom1x && imgZoom1x > 0) {
      const imageZoom = vpZoom / imgZoom1x;
      const maxMag    = tilesInfo?.magnification || 40;
      const mag       = imageZoom * maxMag;
      return (mag < 1 ? mag.toFixed(2) : mag.toFixed(1)) + '×';
    }
  } catch { /* viewer not ready */ }
  return '—';
}

// ── API serializer ────────────────────────────────────────────────────────────
export function serializeMessages(messages) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

// ── MedGemma chat (Google AI) ─────────────────────────────────────────────────
// Converts Anthropic-format messages to Google parts format for multi-turn chat.
function toGoogleParts(contentBlocks) {
  return contentBlocks.map((block) => {
    if (block.type === 'text') return { text: block.text };
    if (block.type === 'image') return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    return { text: '' };
  });
}

async function sendMedGemmaChat(systemPrompt, messages) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('VITE_GEMINI_API_KEY is not set. Add it to .env.local and restart the dev server.');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'medgemma-4b-it',
    systemInstruction: systemPrompt,
  });

  // All but the last message go into history; last message is sent via sendMessage
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toGoogleParts(m.content),
  }));

  const lastMsg = messages[messages.length - 1];
  const lastParts = toGoogleParts(lastMsg.content);

  const chat = model.startChat({ history });
  const response = await chat.sendMessage(lastParts);

  const text      = response.response.text();
  const meta      = response.response.usageMetadata ?? {};
  const inputTok  = meta.promptTokenCount     ?? 0;
  const outputTok = meta.candidatesTokenCount ?? 0;
  return {
    text,
    usage: { input_tokens: inputTok, output_tokens: outputTok, cost_usd: 0 },
  };
}

// ── Core chat call (routes by provider) ──────────────────────────────────────
export async function sendPathChat(modelId, systemPrompt, messages) {
  const cfg = CHAT_MODELS[modelId] || CHAT_MODELS['claude-sonnet-4-6'];

  if (cfg.provider === 'google') {
    return sendMedGemmaChat(systemPrompt, messages);
  }

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('VITE_ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.');
  }
  const anthropic = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const res = await anthropic.messages.create({
    model:      modelId,
    max_tokens: cfg.maxTokens,
    system:     systemPrompt,
    messages,
  });

  const text      = res.content?.[0]?.text ?? '';
  const inputTok  = res.usage?.input_tokens  ?? 0;
  const outputTok = res.usage?.output_tokens ?? 0;
  return {
    text,
    usage: {
      input_tokens:  inputTok,
      output_tokens: outputTok,
      cost_usd:      calcChatCost(modelId, inputTok, outputTok),
    },
  };
}

// ── Report generation ─────────────────────────────────────────────────────────
export async function generateReport(modelId, systemPrompt, messages) {
  const reportRequest = {
    role: 'user',
    content: [{
      type: 'text',
      text: 'Based on our consultation above, please generate a structured pathology report. ' +
            'Use the following standard sections:\n\n' +
            '**CLINICAL HISTORY**\n' +
            '**GROSS DESCRIPTION**\n' +
            '**MICROSCOPIC DESCRIPTION**\n' +
            '**DIAGNOSIS**\n' +
            '**COMMENT**\n\n' +
            'Fill in each section based on what we discussed. ' +
            'If information for a section is unavailable from our discussion, write "Not provided." ' +
            'Format as clean Markdown. Be concise and use standard pathology language.',
    }],
  };

  const allMessages = [...serializeMessages(messages), reportRequest];
  const { text, usage } = await sendPathChat(modelId, systemPrompt, allMessages);
  return { report: text, usage };
}
