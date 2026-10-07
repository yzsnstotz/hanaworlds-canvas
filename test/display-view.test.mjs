import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObjectsHistoryView } from '../src/display-view.mjs';
import { displayFixture } from '../src/display-fixture.mjs';

test('sample UI labels its origin and renders the requested data with read-only controls', () => {
  const html = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: displayFixture, sample: true }));
  for (const text of ['示例数据', '不来自当前世界', '林边小屋', '石头小径', '8 × 6 × 8 格', '批量区域', '逐格', '影响 384 格', '已提交', '已撤回']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/<button/g) ?? []).length, 2, 'only sample switch and read refresh controls');
  assert.ok(!html.includes('撤回</button>') && !html.includes('提交</button>'));
});

test('old history discloses missing metadata and unbound worlds explain why they are empty', () => {
  const old = structuredClone(displayFixture); old.history[0].committedAt = null; old.history[0].mode = null; old.history[0].affectedCells = null;
  const html = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: old, sample: false }));
  for (const text of ['未记录时间','方式未记录','影响格数未记录']) assert.ok(html.includes(text));
  const empty = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: { state: 'NO_WORLD', objects: [], history: [] }, sample: false }));
  assert.ok(empty.includes('当前会话还没有绑定世界'));
});
