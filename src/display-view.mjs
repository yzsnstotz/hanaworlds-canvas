import React from 'react';
const h = React.createElement;
const positions = value => value.join(', ');
const emptyReasons = {
  NO_SESSION: '还没有选择会话。选择一个已连接世界的会话后，这里会显示它的对象与历史。',
  NO_WORLD: '当前会话还没有绑定世界。请先在世界面板连接并选择世界。',
  EMPTY: '当前世界还没有 Canvas 已提交的对象。完成一次建造后，对象与历史会出现在这里。',
};
// Canvas's named reasons for not offering, or not completing, an Undo.
const undoReasons = {
  NOTHING_TO_UNDO: '这笔已撤回。',
  WORLD_CHANGED_SINCE: '之后世界又有新改动；Canvas 只撤回世界最近一次改动。',
  TRANSACTION_PENDING: '有一笔改动仍在处理中，完成后才能撤回。',
  REGION_UNDO_HAS_NO_REDO: '批量区域改动在这里不提供撤回。',
  HISTORY_MOVED: '这笔已不是该对象的最近改动，请刷新后再看。',
  OBJECT_NOT_FOUND: 'Canvas 找不到这个对象。',
  NO_WORLD: '当前会话没有绑定世界。',
  UNDO_CONFLICT: '这笔已不是最近改动，未撤回。',
  STALE_REVISION: '世界或对象已变化，未撤回。请刷新后再看。',
  READBACK_MISMATCH: '世界里的方块与这笔提交后的状态不一致，未撤回。',
  ROLLED_BACK: '撤回没有通过校验，已整笔回滚，世界保持原样。',
  RECOVERY_PENDING: '撤回结果未知，Canvas 已记为待恢复。请不要重复点击。',
};
export const undoReasonLabel = code => undoReasons[code] ?? `未撤回（${code}）`;
function timeLabel(value) {
  if (value === null) return '未记录时间';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
export function ObjectsHistoryView({ view, sample, toggleSample, refresh, pending = false, error = null, emptyReason, allowSampleRefresh = false, sampleDescription = '这些对象与时间线仅用于展示，不来自当前世界，也不会写入世界。', footer = '这里仅供查看。建造或撤回请使用对应面板。', actions = null, undo = null }) {
  const objects = view?.objects ?? [];
  const history = view?.history ?? [];
  // Undo controls appear only when the caller supplies Canvas's published actions (App panel, live data).
  const steps = !sample && actions && undo ? new Map(actions.objects.map(object => [object.objectRef, object.undo])) : null;
  const undoButtons = entry => {
    const step = steps?.get(entry.objectRef);
    if (!step?.available || step.historyTransactionId !== entry.transactionId) return null;
    if (undo.confirming === entry.transactionId) return h('div', { className: 'hw-canvas-undo' },
      h('span', null, `撤回这笔：Canvas 会把这 ${entry.affectedCells ?? '若干'} 格恢复到提交前。`),
      h('button', { type: 'button', className: 'hw-canvas-danger', disabled: undo.busy, onClick: () => undo.confirm(entry) }, undo.busy ? '正在撤回…' : '确认撤回'),
      h('button', { type: 'button', disabled: undo.busy, onClick: undo.cancel }, '取消'));
    return h('div', { className: 'hw-canvas-undo' },
      h('button', { type: 'button', disabled: undo.busy || pending, onClick: () => undo.request(entry) }, '撤回这笔'));
  };
  return h('section', { className: 'hw-canvas-display', 'aria-label': '对象与历史（Canvas）' },
    h('header', { className: 'hw-canvas-header' },
      h('div', null, h('div', { className: 'hw-canvas-eyebrow' }, 'CANVAS · 世界记录'),
        h('h1', null, '对象与历史'), h('p', null, '看看世界里的作品，以及每一次已提交的改动。')),
      h('div', { className: 'hw-canvas-actions' },
        h('button', { type: 'button', role: 'switch', 'aria-checked': sample,
          className: sample ? 'hw-canvas-example active' : 'hw-canvas-example', onClick: toggleSample },
        sample ? '关闭示例数据' : '查看示例数据'),
        h('button', { type: 'button', onClick: refresh, disabled: sample && !allowSampleRefresh || pending }, pending ? '正在读取…' : '刷新'))),
    sample && h('div', { className: 'hw-canvas-fixture', role: 'status' },
      h('strong', null, '示例数据'), h('span', null, sampleDescription)),
    !sample && h('div', { className: 'hw-canvas-source' }, steps ? '当前世界 · 可撤回每个对象的最近一笔' : '当前世界 · 只读'),
    steps && undo?.message && h('p', { role: 'status', className: 'hw-canvas-done' }, undo.message),
    steps && undo?.error && h('p', { role: 'alert', className: 'hw-canvas-error' }, '撤回失败：', undo.error),
    error && h('p', { role: 'alert', className: 'hw-canvas-error' }, '读取失败：', error),
    pending && !view && h('p', { role: 'status' }, '正在读取 Canvas 的对象与历史…'),
    view && view.state !== 'READY' && h('div', { className: 'hw-canvas-empty', role: 'status' },
      h('strong', null, '这里还没有记录'), h('p', null, emptyReason ?? emptyReasons[view.state])),
    h('div', { className: 'hw-canvas-grid' },
      h('section', { className: 'hw-canvas-card', 'aria-labelledby': 'hw-canvas-objects-title' },
        h('div', { className: 'hw-canvas-sectionhead' }, h('h2', { id: 'hw-canvas-objects-title' }, '世界里的对象'), h('span', null, `${objects.length} 个对象`)),
        objects.length === 0 ? h('p', { className: 'hw-canvas-muted' }, '暂无对象。') :
          h('ul', { className: 'hw-canvas-objects' }, objects.map((object, index) =>
            h('li', { key: object.objectRef }, h('h3', null, object.name ?? `未命名对象 ${index + 1}`),
              h('dl', null, h('dt', null, '位置'), h('dd', null, object.bounds ? `(${positions(object.bounds.min)})` : '当前无占地（已撤回）'),
                h('dt', null, '占地大小'), h('dd', null, object.bounds ? `${object.bounds.size.join(' × ')} 格` : '0 格'),
                h('dt', null, '实际占用'), h('dd', null, `${object.occupiedCells} 格`),
                steps?.get(object.objectRef) && !steps.get(object.objectRef).available && [
                  h('dt', { key: 'undo-t' }, '撤回'), h('dd', { key: 'undo-d' }, undoReasonLabel(steps.get(object.objectRef).reason))]))))),
      h('section', { className: 'hw-canvas-card', 'aria-labelledby': 'hw-canvas-history-title' },
        h('div', { className: 'hw-canvas-sectionhead' }, h('h2', { id: 'hw-canvas-history-title' }, '改动时间线'), h('span', null, `${history.length} 笔记录`)),
        history.length === 0 ? h('p', { className: 'hw-canvas-muted' }, '暂无历史。只有完成提交的改动会出现在这里。') :
          h('ol', { className: 'hw-canvas-timeline' }, history.map(entry =>
            h('li', { key: entry.transactionId },
              h('div', { className: 'hw-canvas-historyhead' }, h('h3', null, entry.objectName ?? '未命名对象'),
                h('span', { className: entry.status === 'UNDONE' ? 'hw-canvas-status undone' : 'hw-canvas-status' }, entry.status === 'UNDONE' ? '已撤回' : '已提交')),
              h('time', entry.committedAt ? { dateTime: entry.committedAt } : {}, timeLabel(entry.committedAt)),
              h('p', null, entry.mode === 'REGION' ? '批量区域' : entry.mode === 'CELL' ? '逐格' : '方式未记录',
                ' · ', entry.affectedCells === null ? '影响格数未记录' : `影响 ${entry.affectedCells} 格`),
              (entry.committedAt === null || entry.mode === null || entry.affectedCells === null) &&
                h('small', { className: 'hw-canvas-muted' }, '这笔旧记录没有保存完整展示信息。'),
              undoButtons(entry)))))),
    h('footer', null, steps ? '撤回由 Canvas 校验当前世界后整笔执行；校验不过整笔回滚，不会只撤一部分。' : footer));
}
