// Markdown split into blocks for a streaming answer: the blocks together are the whole answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdownBlocks, renderMarkdown } from '../webview/core/dom';

const SAMPLE = [
  '# Plan',
  '',
  'Some **bold** text and `code`, with a [link][docs].',
  '',
  '- one',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const x = 1;',
  '',
  'const y = 2;',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> quoted',
  '',
  '<b>raw html</b>',
  '',
  '[docs]: https://example.com/docs',
  '',
  'Last line',
].join('\n');

describe('markdown blocks', () => {
  it('joined, the blocks are the whole text rendered at once, at every length', () => {
    for (let end = 1; end <= SAMPLE.length; end++) {
      const text = SAMPLE.slice(0, end);
      const blocks = markdownBlocks(text);
      if (!blocks) continue;
      assert.equal(blocks.map((b) => b.html()).join(''), renderMarkdown(text), `at ${end} characters`);
    }
    assert.ok(markdownBlocks(SAMPLE)!.length > 8);
  });

  it('keeps raw HTML escaped in each block', () => {
    const html = markdownBlocks('<script>alert(1)</script>\n\ntext')!.map((b) => b.html()).join('');
    assert.doesNotMatch(html, /<script>/);
  });
});
