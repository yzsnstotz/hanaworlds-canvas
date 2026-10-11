import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObjectsHistoryView } from '../src/display-view.mjs';
import { displayFixture } from './fixtures/display-fixture.mjs';

test('view renders the data it is given with read-only controls and no sample switch', () => {
  const html = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: displayFixture }));
  for (const text of ['林边小屋', '石头小径', '8 × 6 × 8 格', '批量区域', '逐格', '影响 384 格', '已提交', '已撤回']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/<button/g) ?? []).length, 1, 'only the read refresh control');
  assert.ok(!html.includes('示例数据'), 'no sample data switch or banner in the view');
  assert.ok(!html.includes('撤回</button>') && !html.includes('提交</button>'));
});

test('old history discloses missing metadata and unbound worlds explain why they are empty', () => {
  const old = structuredClone(displayFixture); old.history[0].committedAt = null; old.history[0].mode = null; old.history[0].affectedCells = null;
  const html = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: old }));
  for (const text of ['未记录时间','方式未记录','影响格数未记录']) assert.ok(html.includes(text));
  const empty = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: { state: 'NO_WORLD', objects: [], history: [] } }));
  assert.ok(empty.includes('当前会话还没有绑定世界'));
});

test('the App panel and its bundle carry no display-fixture sample switch', async () => {
  for (const file of ['../src/client.jsx', '../src/display-view.mjs', '../lib/client.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const banned of ['display-fixture', 'displayFixture', 'SAMPLE_KEY', '查看示例数据', '示例数据', 'example-house'])
      assert.ok(!source.includes(banned), `${file} must not contain ${banned}`);
  }
});

test('a broken change feed is shown with its cause and keeps the manual refresh', () => {
  const html = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: displayFixture, liveError: 'CARRIER_LOST' }));
  assert.ok(html.includes('自动更新已中断（CARRIER_LOST）'));
  assert.ok(html.includes('刷新'));
  const live = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view: displayFixture }));
  assert.ok(!live.includes('自动更新已中断'));
});


test('view offers redo on the published origin only and shows redo confirmation', () => {
  const view = { ...displayFixture, history: [{ ...displayFixture.history[0], transactionId: 'origin', objectRef: 'object', status: 'UNDONE' }] };
  const actions = { objects: [{ objectRef: 'object', undo: { available: false, reason: 'NOTHING_TO_UNDO' },
    redo: { available: true, reason: null, historyTransactionId: 'origin' } }] };
  const redo = { confirming: null, busy: false, request() {}, cancel() {}, confirm() {} };
  const render = props => renderToStaticMarkup(React.createElement(ObjectsHistoryView, { view, actions, redo, ...props }));
  assert.match(render({}), /重做这笔/);
  assert.match(render({ redo: { ...redo, confirming: 'origin' } }), /确认重做/);
  assert.doesNotMatch(render({ actions: { objects: [{ ...actions.objects[0], redo: { available: true, historyTransactionId: 'other' } }] } }), /重做这笔/);
});

test('startup cause reaches the visible read failure label', async () => {
  const { readFailureLabel } = await import('../src/display-view.mjs');
  const error = readFailureLabel({ code: 'canvas/storage-unavailable', details: {
    storageFailure: { code: 'EACCES', message: 'fixture storage permission denied' } } });
  const html = renderToStaticMarkup(React.createElement(ObjectsHistoryView, { error }));
  assert.match(html, /EACCES/);
  assert.match(html, /fixture storage permission denied/);
});
