import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ObjectsHistoryView } from './display-view.mjs';
import { displayFixture } from './display-fixture.mjs';
const SAMPLE_KEY = 'hanaworlds.canvas.objects-web.sample.v1';
const SESSION_KEY = 'hanaworlds.canvas.objects-web.session.v1';
async function get(path) {
  const response = await fetch(path);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '无法读取记录');
  return value;
}
function App() {
  const [sample, setSample] = useState(() => localStorage.getItem(SAMPLE_KEY) === 'true');
  const [session, setSession] = useState(() => localStorage.getItem(SESSION_KEY) ?? '');
  const [sessions, setSessions] = useState([]);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (sample) return;
    let active = true;
    setView(null); setError(null); setPending(true);
    Promise.all([get('/api/sessions'), get(`/api/objects${session ? '?session=' + encodeURIComponent(session) : ''}`)])
      .then(([list, result]) => { if (active) { setSessions(list); setView(result); } },
        failure => { if (active) setError(failure.message); })
      .finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [sample, session, revision]);
  const emptyReason = view?.state === 'NO_SESSION' ?
    (sessions.length ? '还没有选择会话。请选择上方会话，查看它的世界记录。' : '当前还没有连接世界的会话，所以没有真实对象与历史。你可以先查看示例数据，了解完整的记录样子。') :
    view?.state === 'NO_WORLD' ? '这个会话尚未连接世界，所以没有可显示的记录。' : undefined;
  return <div className="canvas-web-shell">
    <aside className="canvas-web-nav"><a className="canvas-web-brand" href="/objects"><span className="canvas-web-mark">▦</span><span>HanaWorlds<small>CANVAS</small></span></a>
      <div className="canvas-web-nav-caption">世界档案</div><a href="/objects" className="canvas-web-nav-item" aria-current="page">对象与历史 <span>↗</span></a>
      <p className="canvas-web-nav-note">每一件作品，<br/>都有留下的痕迹。</p><span className="canvas-web-readonly">仅供查看</span></aside>
    <main><div className="canvas-web-topline"><span>HanaWorlds / Canvas</span><span className="canvas-web-mode">{sample ? '正在查看示例' : '真实记录'}</span></div>
      <div className="canvas-web-session"><label htmlFor="canvas-session">当前会话</label><select id="canvas-session" value={session} disabled={sample || !sessions.length}
        onChange={event => { localStorage.setItem(SESSION_KEY, event.target.value); setSession(event.target.value); }}>
        <option value="">{sessions.length ? '请选择会话' : '尚无连接世界的会话'}</option>{sessions.map(id => <option key={id} value={id}>{id}</option>)}
      </select></div>
      <ObjectsHistoryView view={sample ? displayFixture : view} sample={sample} pending={!sample && pending} error={sample ? null : error}
        emptyReason={emptyReason} footer="这个页面只供查看；不会建造、修改或撤回世界中的内容。"
        toggleSample={() => { localStorage.setItem(SAMPLE_KEY, String(!sample)); setSample(!sample); }} refresh={() => setRevision(x => x + 1)} />
    </main></div>;
}
createRoot(document.getElementById('root')).render(<App />);
