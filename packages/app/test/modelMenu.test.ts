import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionModelView } from '../src/protocol';
import { contextRing, effortLabel, modelButtonHtml, modelMenuHtml } from '../webview/features/modelMenu';

const view = (patch: Partial<SessionModelView> = {}): SessionModelView => ({
  provider: 'claude-code',
  model: 'opus',
  effort: 'max',
  efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'high',
  profiles: [],
  profile: '',
  differs: true,
  ...patch,
});

const models = [
  { id: 'default', label: 'CLI default', family: 'Latest (aliases)' },
  { id: 'opus', label: 'Opus (latest)', family: 'Latest (aliases)', note: 'recommended' },
];

describe('the model menu', () => {
  it('names the model and the effort on its button', () => {
    const html = modelButtonHtml('Claude Code · Opus (latest)', view(), false, false);
    assert.match(html, /data-action="model-menu"/);
    assert.match(html, /Claude Code · Opus \(latest\) · max/);
    assert.doesNotMatch(modelButtonHtml('Claude Code', view({ effort: '' }), false, false), / · <\/span>|· $/);
  });

  it('lists the models and the effort levels, the choice checked', () => {
    const html = modelMenuHtml({ view: view(), models, agent: false, running: false });
    assert.match(html, /aria-checked="true" data-action="session-model" data-model="opus"/);
    assert.match(html, /aria-checked="false" data-action="session-model" data-model="default"/);
    assert.match(html, /aria-checked="true" data-action="session-effort" data-effort="max"/);
    // '' is the CLI's own default.
    assert.match(html, /data-effort=""[^>]*>CLI default</);
    assert.doesNotMatch(html, /Profile/);
    assert.doesNotMatch(html, /next message/);
  });

  it('has no effort row for a provider without levels, and the agent sets its model', () => {
    const html = modelMenuHtml({ view: view({ provider: 'agent:codex', model: '', effort: '', efforts: [] }), models: [], agent: true, running: false });
    assert.doesNotMatch(html, /session-effort/);
    assert.doesNotMatch(html, /session-model"/);
    assert.match(html, /Set in the agent/);
  });

  it('offers the Claude Code profiles only when there are some', () => {
    const html = modelMenuHtml({
      view: view({ profiles: [{ id: '', name: 'Default profile' }, { id: 'work', name: 'Work <b>' }], profile: 'work' }),
      models,
      agent: false,
      running: false,
    });
    assert.match(html, /aria-checked="true" data-action="session-profile" data-profile="work"/);
    assert.match(html, /Work &lt;b&gt;/);
  });

  it('says a change waits for the next message while a request runs', () => {
    assert.match(modelMenuHtml({ view: view(), models, agent: false, running: true }), /Applies from your next message\./);
  });

  it('offers "Use as default" only when the choice differs from the settings', () => {
    assert.match(modelMenuHtml({ view: view({ differs: false }), models, agent: false, running: false }), /data-action="session-model-default" disabled/);
    assert.doesNotMatch(modelMenuHtml({ view: view(), models, agent: false, running: false }), /data-action="session-model-default" disabled/);
  });

  it('keeps a model the list does not know, escaped', () => {
    const html = modelMenuHtml({ view: view({ provider: 'claude', model: 'claude-new"x' }), models: [], agent: false, running: false });
    assert.match(html, /data-model="claude-new&quot;x"/);
  });

  it('calls the provider default by its name', () => {
    assert.equal(effortLabel('gemini', ''), 'Default');
    assert.equal(effortLabel('claude-code', ''), 'CLI default');
    assert.equal(effortLabel('claude', 'xhigh'), 'xhigh');
  });
});

describe('the context gauge', () => {
  const count = (n: number) => `${Math.round(n / 1000)}k`;

  it('is hidden while the provider has not reported the window', () => {
    assert.equal(contextRing(undefined, count), undefined);
    assert.equal(contextRing({ used: 10, size: 0 }, count), undefined);
  });

  it('fills as far as the context is used and says so in its title', () => {
    const ring = contextRing({ used: 50_000, size: 200_000 }, count)!;
    assert.match(ring.title, /Context: 25% full \(50k of 200k tokens\)/);
    // A quarter of the circumference (2 * pi * 6).
    assert.match(ring.html, /stroke-dasharray="9\.42 37\.70"/);
    assert.doesNotMatch(ring.html, /ring (high|full)/);
  });

  it('warns when the context is nearly full, and never draws past full', () => {
    assert.match(contextRing({ used: 150_000, size: 200_000 }, count)!.html, /class="ring high"/);
    const over = contextRing({ used: 300_000, size: 200_000 }, count)!;
    assert.match(over.html, /class="ring full"/);
    assert.match(over.title, /100% full/);
  });
});

describe('the model menu for an agent CLI', () => {
  const advertised = [
    { id: 'model', name: 'Model', category: 'model' as const, currentValue: 'pro', options: [{ value: 'fast', name: 'Fast' }, { value: 'pro', name: 'Pro <1>' }] },
    { id: 'think', name: 'Thinking', category: 'thought_level' as const, currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ];
  const agentView = (agentOptions?: typeof advertised) => view({ provider: 'agent:antigravity', model: '', effort: '', efforts: [], agentOptions });

  it('lists the model and thought level the agent advertised, the current ones checked', () => {
    const html = modelMenuHtml({ view: agentView(advertised), models: [], agent: true, running: false });
    assert.match(html, /aria-checked="true" data-action="session-option" data-option="model" data-value="pro"/);
    assert.match(html, /aria-checked="false" data-action="session-option" data-option="think" data-value="high"/);
    assert.match(html, /Pro &lt;1&gt;/);
    assert.doesNotMatch(html, /Set in the agent/);
    assert.match(modelButtonHtml('Antigravity CLI', agentView(advertised), false, false), /Antigravity CLI · Pro &lt;1&gt; · Low/);
  });

  it('says "Set in the agent" while the agent advertised nothing', () => {
    const html = modelMenuHtml({ view: agentView([]), models: [], agent: true, running: false });
    assert.match(html, /Set in the agent/);
    assert.doesNotMatch(html, /session-option/);
  });
});
