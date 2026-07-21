// Pure Markdown parsers for the copilot answer: a small, safe subset (paragraphs, lists,
// fenced code, inline bold/italic/code). Rendered to React elements (never dangerouslySetInnerHTML),
// so model output can't inject markup. These tests pin the parsing; the components are thin.
import { describe, it, expect } from 'vitest';
import { parseInline, parseBlocks } from './markdown.jsx';

describe('parseInline', () => {
  it('returns a single text token for plain prose', () => {
    expect(parseInline('just words')).toEqual([{ t: 'text', v: 'just words' }]);
  });

  it('splits bold spans', () => {
    expect(parseInline('found **1,234 nuclei** here')).toEqual([
      { t: 'text', v: 'found ' },
      { t: 'b', v: '1,234 nuclei' },
      { t: 'text', v: ' here' },
    ]);
  });

  it('splits italic and inline code', () => {
    expect(parseInline('use *this* or `that`')).toEqual([
      { t: 'text', v: 'use ' },
      { t: 'i', v: 'this' },
      { t: 'text', v: ' or ' },
      { t: 'code', v: 'that' },
    ]);
  });

  it('prefers bold over italic when both could match', () => {
    expect(parseInline('**strong**')).toEqual([{ t: 'b', v: 'strong' }]);
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    const b = parseBlocks('first para\nstill first\n\nsecond para');
    expect(b).toEqual([
      { t: 'p', text: 'first para\nstill first' },
      { t: 'p', text: 'second para' },
    ]);
  });

  it('collects a bullet list', () => {
    const b = parseBlocks('- one\n- two\n- three');
    expect(b).toEqual([{ t: 'ul', items: ['one', 'two', 'three'] }]);
  });

  it('collects an ordered list', () => {
    const b = parseBlocks('1. first\n2. second');
    expect(b).toEqual([{ t: 'ol', items: ['first', 'second'] }]);
  });

  it('captures a fenced code block verbatim', () => {
    const b = parseBlocks('```\nx = 1\ny = 2\n```');
    expect(b).toEqual([{ t: 'pre', code: 'x = 1\ny = 2' }]);
  });

  it('handles a paragraph followed by a list', () => {
    const b = parseBlocks('Here is what I found:\n- a\n- b');
    expect(b).toEqual([
      { t: 'p', text: 'Here is what I found:' },
      { t: 'ul', items: ['a', 'b'] },
    ]);
  });

  it('is empty for empty input', () => {
    expect(parseBlocks('')).toEqual([]);
  });
});
