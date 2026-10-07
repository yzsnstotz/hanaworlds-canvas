import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
const SELECTED_KEY = 'hanaworlds.canvas.undo-web.selected.v1';
const reasons = {
  NOTHING_TO_UNDO: '这笔改动当前已撤回，没有可撤回的内容。',
  NOTHING_TO_REDO: '这笔改动目前没有被撤回，不需要重做。',
  REGION_REDO_NOT_IN_PROTOCOL: '批量区域改动没有「重做」操作，撤回后无法恢复。',
  REGION_UNDO_HAS_NO_REDO: '批量区域改动没有「重做」操作；为保证撤回后能恢复，这里不提供撤回。',
  WORLD_CHANGED_SINCE: '这笔改动之后，世界里又有了别的改动；Canvas 只对最近一次改动撤回或重做，避免覆盖后来的内容。',
  TRANSACTION_PENDING: '还有一笔事务正在处理，请稍后点击「刷新」。',
  REDO_CONFLICT: '这些格子已被别的改动修改，Canvas 拒绝覆盖；没有写入任何内容。',
  UNDO_CONFLICT: '这些格子已被别的改动修改，Canvas 拒绝覆盖；没有写入任何内容。',
  READBACK_MISMATCH: '这些格子已被别的改动修改，Canvas 拒绝覆盖；没有写入任何内容。',
  STALE_REVISION: '记录已经变化，请点击「刷新」后再试。',
  RECOVERY_PENDING: 'Canvas 正在恢复这笔事务，暂时不能确认结果；请稍后刷新。',
  OTHER_OBJECTS_AFFECTED: '撤回会影响别的对象，Canvas 拒绝执行；没有写入任何内容。',
  OBJECT_NOT_FOUND: '找不到这笔改动，请刷新。',
};
const reasonText = code => reasons[code] ?? 'Canvas 拒绝了这次操作；没有写入任何内容。';
const timeLabel = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录时间';
const cellLabel = name => name === 'air' ? '空' : name;
async function request(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok && !value.error) throw new Error('无法读取记录');
  return value;
}
function App() {
  const [view, setView] = useState(null);
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem(SELECTED_KEY); } catch { return null; } });
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const load = () => {
    setPending(true); setError(null);
    return request('/api/undo').then(value => {
      if (value.source !== 'ISOLATED_DURABLE_FIXTURE') throw new Error(value.error ?? '示例来源无法确认');
      setView(value);
    }).catch(failure => setError(failure.message)).finally(() => setPending(false));
  };
  useEffect(() => { load(); }, []);
  const entries = view?.entries ?? [];
  const entry = entries.find(row => row.objectRef === selected) ?? null;
  const choose = objectRef => { setSelected(objectRef); setResult(null); try { localStorage.setItem(SELECTED_KEY, objectRef); } catch {} };
  const act = action => {
    setPending(true); setResult(null); setError(null);
    request(`/api/undo/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectRef: entry.objectRef }) })
      .then(value => {
        if (value.view) setView(value.view);
        setResult(value.error ? { ok: false, action, code: value.error.code ?? value.error } :
          { ok: true, action, status: value.status, transactionId: value.transactionId });
      }).catch(failure => setError(failure.message)).finally(() => setPending(false));
  };
  return <div className="canvas-web-shell">
    <aside className="canvas-web-nav"><a className="canvas-web-brand" href="/objects"><span className="canvas-web-mark">▦</span><span>HanaWorlds<small>CANVAS</small></span></a>
      <div className="canvas-web-nav-caption">世界档案</div>
      <a href="/objects" className="canvas-web-nav-item">对象与历史 <span>↗</span></a>
      <a href="/undo" className="canvas-web-nav-item" aria-current="page">撤回与重做 <span>↺</span></a>
      <p className="canvas-web-nav-note">每一次改动，<br/>都可以收回或重来。</p><span className="canvas-web-readonly">只作用于隔离示例世界</span></aside>
    <main><div className="canvas-web-topline"><span>HanaWorlds / Canvas</span><span className="canvas-web-mode">示例记录 · 隔离环境</span></div>
      <section className="hw-canvas-display" aria-label="撤回与重做（Canvas）">
        <header className="hw-canvas-header"><div><div className="hw-canvas-eyebrow">CANVAS · 历史操作</div><h1>撤回与重做</h1>
          <p>选一笔改动，撤回它，或把撤回的改动重做回来。每一步都经 Canvas 事务完成并读回。</p></div>
          <div className="hw-canvas-actions"><button type="button" onClick={load} disabled={pending}>{pending ? '正在处理…' : '刷新'}</button></div></header>
        <div className="hw-canvas-fixture undo-fixture" role="status"><strong>示例数据 · 隔离环境</strong>
          <span>这些改动来自隔离示例世界，由 Canvas 真实事务提交；撤回和重做同样走 Canvas 事务，只改动这个示例世界，不连接、也不会写入真实世界。</span></div>
        {error && <p role="alert" className="hw-canvas-error">读取失败：{error}</p>}
        {!view && pending && <p role="status">正在读取 Canvas 的历史…</p>}
        {view && <div className="hw-canvas-grid">
          <section className="hw-canvas-card" aria-labelledby="undo-list-title">
            <div className="hw-canvas-sectionhead"><h2 id="undo-list-title">示例改动</h2><span>{entries.length} 笔</span></div>
            <ul className="undo-entries">{entries.map(row => <li key={row.objectRef}>
              <button type="button" className={row.objectRef === entry?.objectRef ? 'undo-entry selected' : 'undo-entry'}
                aria-pressed={row.objectRef === entry?.objectRef} onClick={() => choose(row.objectRef)}>
                <strong>{row.label}</strong>
                <span>{row.mode === 'REGION' ? '批量区域' : '逐格'} · 影响 {row.affectedCells ?? row.cells.length} 格</span>
                <span className={row.state === 'UNDONE' ? 'hw-canvas-status undone' : 'hw-canvas-status'}>{row.state === 'UNDONE' ? '已撤回' : '已提交'}</span>
                {!row.undo.available && !row.redo.available && <span className="undo-locked">不可操作</span>}
              </button></li>)}</ul>
          </section>
          <section className="hw-canvas-card" aria-labelledby="undo-detail-title">
            {!entry ? <p className="hw-canvas-muted" id="undo-detail-title">请先在左侧选择一笔改动。</p> : <>
              <div className="hw-canvas-sectionhead"><h2 id="undo-detail-title">{entry.label}</h2>
                <span className={entry.state === 'UNDONE' ? 'hw-canvas-status undone' : 'hw-canvas-status'}>{entry.state === 'UNDONE' ? '已撤回' : '已提交'}</span></div>
              <p className="undo-meta">{timeLabel(entry.committedAt)} · {entry.mode === 'REGION' ? '批量区域' : '逐格'} · 当前占用 {entry.footprintCells} 格</p>
              <div className="undo-buttons">
                <button type="button" onClick={() => act('undo')} disabled={pending || !entry.undo.available}>撤回</button>
                <button type="button" onClick={() => act('redo')} disabled={pending || !entry.redo.available}>重做</button>
              </div>
              {!entry.undo.available && <p className="undo-why">不能撤回：{reasonText(entry.undo.reason)}</p>}
              {!entry.redo.available && <p className="undo-why">不能重做：{reasonText(entry.redo.reason)}</p>}
              {result && <p role="status" className={result.ok ? 'undo-result ok' : 'undo-result failed'}>
                {result.ok ? `${result.action === 'undo' ? '已撤回' : '已重做'}：Canvas 事务已验证，格子已读回。` :
                  `${result.action === 'undo' ? '撤回' : '重做'}没有执行：${reasonText(result.code)}（${result.code}）`}</p>}
              <h3>对应格子（读回）</h3>
              <table className="undo-cells"><thead><tr><th>位置</th><th>当前内容</th></tr></thead>
                <tbody>{entry.cells.map(cell => <tr key={cell.position.join(',')}><td>({cell.position.join(', ')})</td>
                  <td className={cell.nodeName === 'air' ? 'undo-empty' : ''}>{cellLabel(cell.nodeName)}</td></tr>)}</tbody></table>
              <h3>这笔改动的历史</h3>
              <ol className="undo-moves">{entry.moves.map((move, index) => <li key={move.transactionId}>
                {index === 0 ? '提交' : move.status === 'UNDONE' ? '撤回' : '重做'} · {timeLabel(move.committedAt)}</li>)}</ol>
            </>}
          </section></div>}
        <footer>撤回与重做只作用于上面的隔离示例世界；真实世界不受影响。</footer>
      </section>
    </main></div>;
}
createRoot(document.getElementById('root')).render(<App />);
