// Markdown split into blocks for a streaming answer: the blocks together are the whole answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { marked } from 'marked';
import { markdownBlocks, renderFinishedMarkdown, renderMarkdown } from '../webview/core/dom';

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

describe('finished Markdown', () => {
  it('is rendered once and kept, within a size budget', () => {
    let parsed = 0;
    marked.use({
      hooks: {
        preprocess: (text: string) => {
          parsed++;
          return text;
        },
      },
    });
    const answer = 'A finished **answer** with `code`.';
    const html = renderFinishedMarkdown(answer);
    assert.equal(html, renderMarkdown(answer));
    parsed = 0;
    assert.equal(renderFinishedMarkdown(answer), html);
    assert.equal(parsed, 0, 'drawn again without rendering it again');
    // Many other answers later, the oldest ones make way.
    for (let i = 0; i < 400; i++) renderFinishedMarkdown(`${'x'.repeat(10_000)} ${i}`);
    parsed = 0;
    renderFinishedMarkdown(answer);
    assert.equal(parsed, 1, 'rendered again once it made way');
    // A very long text is not kept at all.
    const huge = 'y'.repeat(600_000);
    renderFinishedMarkdown(huge);
    parsed = 0;
    renderFinishedMarkdown(huge);
    assert.equal(parsed, 1);
  });
});
