import React, { useEffect, useState } from 'react';
import { ObjectsHistoryView, undoReasonLabel } from './display-view.mjs';
import { displayFixture } from './display-fixture.mjs';
import { displayClientContribution } from './display-remote.mjs';

const PANEL_ID = 'hanaworlds-canvas-objects-history';
const SAMPLE_KEY = 'hanaworlds.canvas.objects-history.sample.v1';
const css = `
.hw-canvas-display{box-sizing:border-box;height:100%;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,48px) + 24px) 32px 32px;padding-left:max(32px,var(--dsh-frame-leading-clearance,0px));color:var(--text-primary,#24352e);background:var(--bg-primary,#f4f7f3);font-family:inherit}
.hw-canvas-header{display:flex;gap:24px;justify-content:space-between;align-items:flex-start;max-width:1180px;margin:0 auto 24px}.hw-canvas-eyebrow{font-size:11px;font-weight:700;letter-spacing:.15em;color:#518467}.hw-canvas-header h1{font-size:30px;letter-spacing:-.04em;line-height:1.2;margin:10px 0}.hw-canvas-header p{font-size:14px;color:var(--text-secondary,#6a776f);margin:0;line-height:1.7}.hw-canvas-actions{display:flex;gap:8px;flex-wrap:wrap;padding-top:24px}.hw-canvas-display button{border:1px solid #c2cec6;background:var(--bg-secondary,#fff);color:inherit;cursor:pointer;font:inherit;font-size:13px;border-radius:8px;padding:9px 12px}.hw-canvas-display button:hover{border-color:#518467}.hw-canvas-display button:focus-visible{outline:2px solid #357952;outline-offset:3px}.hw-canvas-display button:disabled{opacity:.5;cursor:default}.hw-canvas-display button.active{background:#e8ae38;color:#302109;border-color:#ae780b}
.hw-canvas-fixture{display:flex;flex-wrap:wrap;gap:12px;background:#fff0c6;border:1px solid #d4a038;border-radius:12px;padding:16px 20px;margin:0 auto 24px;max-width:1180px;color:#664500;font-size:14px}.hw-canvas-fixture strong{font-weight:800}.hw-canvas-source{max-width:1180px;margin:0 auto 16px;font-size:12px;color:#518467}.hw-canvas-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:24px;max-width:1180px;margin:auto}.hw-canvas-card{min-width:0;background:var(--bg-secondary,#fff);border:1px solid #dce5de;border-radius:14px;padding:24px}.hw-canvas-sectionhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.hw-canvas-sectionhead h2{font-size:18px;margin:0}.hw-canvas-sectionhead span{font-size:12px;color:var(--text-secondary,#748278);white-space:nowrap}.hw-canvas-display h3{font-size:15px;font-weight:600;margin:0 0 12px}.hw-canvas-objects,.hw-canvas-timeline{list-style:none;padding:0;margin:0}.hw-canvas-objects li{padding:20px 0;border-top:1px solid #e5ebe6}.hw-canvas-objects li:first-child{padding-top:0;border-top:0}.hw-canvas-display dl{display:grid;grid-template-columns:80px 1fr;gap:10px;font-size:13px;margin:0}.hw-canvas-display dt{color:var(--text-secondary,#748278)}.hw-canvas-display dd{margin:0;font-variant-numeric:tabular-nums}.hw-canvas-timeline li{position:relative;padding:0 0 24px 24px;border-left:1px solid #d8e2db}.hw-canvas-timeline li:last-child{padding-bottom:0}.hw-canvas-timeline li:before{content:'';position:absolute;width:8px;height:8px;top:4px;left:-4.5px;background:#518467;border-radius:50%}.hw-canvas-historyhead{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}.hw-canvas-status{background:#e7f1e9;color:#3f7652;padding:3px 8px;border-radius:5px;font-size:11px;white-space:nowrap}.hw-canvas-status.undone{background:#eceeed;color:#64726a}.hw-canvas-display time{font-size:12px;color:var(--text-secondary,#748278);font-variant-numeric:tabular-nums}.hw-canvas-timeline p{font-size:13px;margin:8px 0}.hw-canvas-muted{color:var(--text-secondary,#748278);font-size:13px;line-height:1.7}.hw-canvas-display footer{max-width:1180px;margin:22px auto 0;font-size:12px;color:var(--text-secondary,#748278)}.hw-canvas-empty{max-width:1180px;margin:0 auto 24px;padding:20px;border:1px dashed #becfc2;border-radius:12px;font-size:14px;line-height:1.7}.hw-canvas-empty p{margin:6px 0 0;color:var(--text-secondary,#748278)}.hw-canvas-error{color:#a94732;margin:0 auto 20px;max-width:1180px;font-size:14px}.hw-canvas-done{color:#3f7652;margin:0 auto 20px;max-width:1180px;font-size:14px}.hw-canvas-undo{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;font-size:13px}.hw-canvas-display button.hw-canvas-danger{background:#a94732;border-color:#a94732;color:#fff}
@media(max-width:760px){.hw-canvas-display{padding-right:20px;padding-left:max(20px,var(--dsh-frame-leading-clearance,0px))}.hw-canvas-header{flex-direction:column;gap:8px}.hw-canvas-actions{padding-top:0}.hw-canvas-grid{grid-template-columns:1fr}.hw-canvas-card{padding:20px}}
`;

const failureCode = failure => failure?.details?.reason ?? failure?.code ?? failure?.message ?? String(failure);
export function ObjectsHistoryPanel({ sessionRef, read, readActions, undo }) {
  const [sample, setSample] = useState(() => window.localStorage.getItem(SAMPLE_KEY) === 'true');
  const [view, setView] = useState(null);
  const [actions, setActions] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState({ message: null, error: null });
  useEffect(() => {
    if (sample) return;
    let active = true;
    setView(null); setActions(null); setError(null); setConfirming(null); setPending(true);
    Promise.all([read(sessionRef), readActions ? readActions(sessionRef) : null]).then(([value, published]) => {
      if (active) { setView(value); setActions(published); }
    }, failure => {
      if (active) setError(failureCode(failure));
    }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [sample, sessionRef, revision, read, readActions]);
  useEffect(() => { setOutcome({ message: null, error: null }); }, [sessionRef, sample]);
  const undoControls = undo && {
    confirming, busy, message: outcome.message, error: outcome.error,
    request: entry => { setOutcome({ message: null, error: null }); setConfirming(entry.transactionId); },
    cancel: () => setConfirming(null),
    confirm: entry => {
      setBusy(true);
      undo(sessionRef, entry.objectRef, entry.transactionId).then(result => {
        setView(result.view);
        setOutcome({ message: `已撤回「${entry.objectName ?? '未命名对象'}」这笔改动；Canvas 已校验并读回世界。`, error: null });
      }, failure => setOutcome({ message: null, error: undoReasonLabel(failureCode(failure)) }))
        .finally(() => { setBusy(false); setConfirming(null); setRevision(value => value + 1); });
    },
  };
  return <ObjectsHistoryView view={sample ? displayFixture : view} sample={sample}
    pending={!sample && pending} error={sample ? null : error}
    actions={sample ? null : actions} undo={undoControls}
    toggleSample={() => { window.localStorage.setItem(SAMPLE_KEY, String(!sample)); setSample(!sample); }}
    refresh={() => setRevision(value => value + 1)} />;
}
function CanvasIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 5h16v14H4zM4 10h16M10 5v14M13 14h4M13 17h3" /></svg>;
}
export const name = PANEL_ID;
export const inject = ['slots', 'layout', 'sessions', 'remote'];
// The mounted namespace is the traced child Service `remote.hanaworldsCanvasDisplay`; the panel
// runs inside a fiber that injects it, as the public DSH Client Remote contract requires.
function registerPanel(ctx) {
  const remote = method => async (...args) => {
    const result = await ctx.remote.hanaworldsCanvasDisplay[method](...args);
    if (!result.ok) throw result.error;
    return result.value;
  };
  const read = remote('read'), readActions = remote('actions'), undo = remote('undo');
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css;
    style.dataset.hanaworldsCanvas = 'objects-history'; document.head.append(style);
    return () => style.remove();
  });
  function CanvasPanel({ useSessions }) {
    const sessionRef = useSessions(state => Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id ?? null);
    return <ObjectsHistoryPanel sessionRef={sessionRef} read={read} readActions={readActions} undo={undo} />;
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, CanvasPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist',
    id: PANEL_ID, order: 45, label: () => '对象与历史（Canvas）' }, CanvasIcon));
}
export async function apply(ctx) {
  const disposeRemote = await ctx.remote.$mount(displayClientContribution);
  const panel = ctx.inject(['remote.hanaworldsCanvasDisplay', 'slots', 'sessions'], registerPanel);
  try { await panel; } catch (error) { await panel.dispose(); await disposeRemote(); throw error; }
  return async () => { await panel.dispose(); await disposeRemote(); };
}
