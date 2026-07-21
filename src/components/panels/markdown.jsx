// markdown.jsx — a small, safe Markdown subset for the copilot's answer: paragraphs, bullet
// and ordered lists, fenced code, and inline bold / italic / code. Parsed to tokens (pure,
// testable) and rendered as React elements — never dangerouslySetInnerHTML — so model output
// cannot inject markup. Not a full CommonMark implementation; just what answers actually use.
import React from 'react';

// Inline: split a line into text / bold / italic / code tokens. Non-nested; bold (**…**) is
// matched before italic (*…*) so it wins when both could apply.
export function parseInline(text) {
  const tokens = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ t: 'text', v: text.slice(last, m.index) });
    const s = m[0];
    if (s.startsWith('`')) tokens.push({ t: 'code', v: s.slice(1, -1) });
    else if (s.startsWith('**')) tokens.push({ t: 'b', v: s.slice(2, -2) });
    else tokens.push({ t: 'i', v: s.slice(1, -1) });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ t: 'text', v: text.slice(last) });
  return tokens;
}

const UL = /^\s*[-*]\s+/;
const OL = /^\s*\d+\.\s+/;
const FENCE = /^\s*```/;

// Block: group lines into paragraphs, lists, and fenced code blocks.
export function parseBlocks(text) {
  const lines = (text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1; // skip the closing fence
      blocks.push({ t: 'pre', code: code.join('\n') });
    } else if (UL.test(line)) {
      const items = [];
      while (i < lines.length && UL.test(lines[i])) { items.push(lines[i].replace(UL, '')); i += 1; }
      blocks.push({ t: 'ul', items });
    } else if (OL.test(line)) {
      const items = [];
      while (i < lines.length && OL.test(lines[i])) { items.push(lines[i].replace(OL, '')); i += 1; }
      blocks.push({ t: 'ol', items });
    } else if (line.trim() === '') {
      i += 1;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== ''
        && !FENCE.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) {
        para.push(lines[i]); i += 1;
      }
      blocks.push({ t: 'p', text: para.join('\n') });
    }
  }
  return blocks;
}

function Inline({ text }) {
  return parseInline(text).map((tok, i) => {
    if (tok.t === 'b') return <strong key={i}>{tok.v}</strong>;
    if (tok.t === 'i') return <em key={i}>{tok.v}</em>;
    if (tok.t === 'code') return <code key={i} className="cp-md-code">{tok.v}</code>;
    return <React.Fragment key={i}>{tok.v}</React.Fragment>;
  });
}

// Render a Markdown subset as React elements. Safe by construction (React escapes text).
export function Markdown({ text }) {
  return parseBlocks(text).map((b, i) => {
    if (b.t === 'pre') return <pre key={i} className="cp-md-pre">{b.code}</pre>;
    if (b.t === 'ul') {
      return <ul key={i} className="cp-md-ul">{b.items.map((it, j) => (
        <li key={j}><Inline text={it} /></li>))}</ul>;
    }
    if (b.t === 'ol') {
      return <ol key={i} className="cp-md-ol">{b.items.map((it, j) => (
        <li key={j}><Inline text={it} /></li>))}</ol>;
    }
    return <p key={i} className="cp-md-p"><Inline text={b.text} /></p>;
  });
}
