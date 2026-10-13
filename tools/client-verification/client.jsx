import { verificationClientContribution } from './remote.mjs';

export const name = 'hanaworlds-canvas-client-verification';
export const inject = ['remote', 'slots', 'layout', 'sessions'];
const entryName = 'hanaworldsCanvasVerification';
const fail = (code, message, details) => Object.assign(new Error(`${code}: ${message}`), { code, details });
const text = node => (node?.innerText ?? node?.textContent ?? '').trim();
const visible = node => !!node?.isConnected && !node.hidden && node.getClientRects().length > 0;
const label = option => typeof option === 'function' ? option() : option;
const encode = value => JSON.stringify(value, (_key, item) => item instanceof Error
  ? { name: item.name, code: item.code, message: item.message, details: item.details } : item, 2);

function observation(ctx, config) {
  const pending = new Map(), controller = new AbortController();
  const completedOkSessions = new Map();
  const budget = config.waitMs ?? 30000;
  if (!Number.isFinite(budget) || budget <= 0) throw fail('CANVAS_VERIFY_BUDGET_INVALID', 'waitMs must be positive');
  let disposed = false, queue = Promise.resolve();
  const root = document.createElement('details');
  root.dataset.canvasVerificationTool = 'canvas-client-verification/v1';
  root.setAttribute('aria-label', 'Canvas 实际客户端验证工具');
  root.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:10000;max-width:min(600px,90vw);max-height:65vh;overflow:auto;background:var(--bg-primary,#fff);color:var(--text-primary,#222);padding:12px;border:1px solid #888;border-radius:8px';
  const summary = document.createElement('summary'); summary.textContent = 'Canvas 客户端验证'; root.append(summary);
  const buttons = document.createElement('div'); buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
  const output = document.createElement('pre'); output.setAttribute('aria-live', 'polite');
  root.append(buttons, output);
  const log = [];
  const record = (stage, value) => { log.push({ stage, value }); output.textContent = encode(log); };
  const checkActive = () => { if (disposed) throw fail('CANVAS_VERIFICATION_DISPOSED', 'The observation tool was disposed'); };
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(budget)]);
  async function remote(method, ...args) {
    checkActive();
    const response = await ctx.remote.hanaworldsCanvasVerification[method](...args, signal());
    checkActive();
    if (!response.ok) throw Object.assign(new Error(response.error?.message ?? 'Observer Remote failed'), response.error);
    return response.value;
  }
  async function cancelCase(caseId) {
    // Keep the mounted official Remote available during disposal. This signal
    // is independent of the cancelled UI observation, and never retries a
    // business call or changes its actual receiver.
    const response = await ctx.remote.hanaworldsCanvasVerification.invoke(caseId,
      JSON.stringify({ phase: 'cancel' }), AbortSignal.timeout(budget));
    if (!response.ok) throw Object.assign(new Error(response.error?.message ?? 'Observer cleanup failed'), response.error);
  }
  async function inspectActualClient() {
    const inspection = await remote('inspect');
    const source = inspection.clientSource;
    const modules = ctx.get('modules'), loader = ctx.get('loader');
    if (!source || modules?.version !== 'client' || loader?.internal !== modules)
      throw fail('CANVAS_CLIENT_MODULE_SOURCE_UNPROVEN', 'Actual Client module system and official Loader must share the Host-attested source');
    if (window.__ModuleLoader__?.mode !== 'live') throw fail('CANVAS_CLIENT_MODULE_LOADER_NOT_LIVE', 'Official module registration facade is not live');
    const packageName = 'hanaworlds-canvas';
    const rows = modules.manifest.modules.filter(row => row.id === packageName);
    if (rows.length !== 1 || modules.manifest.rev !== source.graphRef)
      throw fail('CANVAS_CLIENT_GRAPH_MISMATCH', 'Actual parsed Client graph does not match the current Host graph');
    const row = rows[0], expected = source.graphRow;
    for (const key of ['id', 'url', 'rev']) {
      if (row[key] !== expected?.[key]) throw fail('CANVAS_CLIENT_GRAPH_ROW_MISMATCH', 'Actual Canvas module row differs from the Host graph', { field: key });
    }
    for (const key of ['inject', 'external']) {
      if (JSON.stringify(row[key]) !== JSON.stringify(expected?.[key] ?? []))
        throw fail('CANVAS_CLIENT_GRAPH_EDGES_MISMATCH', 'Actual Canvas graph dependencies differ from the Host graph', { field: key });
    }
    if (source.packageRoot !== inspection.packageRoot || source.artifactPath !== `${inspection.packageRoot}/lib/client.js`
      || source.artifactSHA256 !== inspection.artifacts?.['lib/client.js'])
      throw fail('CANVAS_CLIENT_INSTALLED_ARTIFACT_MISMATCH', 'Host graph source must identify the same installed Canvas client bytes');
    const record = modules.loadCache.get(packageName);
    if (!record || record.id !== packageName || !record.exports)
      throw fail('CANVAS_CLIENT_MODULE_RECORD_MISSING', 'Official Client loadCache has no actual materialized Canvas exports');
    const active = [...loader.entries()].filter(entry => entry.options.name === packageName && !entry.disabled && entry.fiber?.state === 2);
    if (active.length !== 1) throw fail('CANVAS_CLIENT_LOADER_ENTRY_NOT_ACTIVE', 'Expected one actual ACTIVE official Canvas client entry', { count: active.length });
    const entry = active[0], executable = ctx.registry.resolve(loader.unwrapExports(record.exports));
    if (entry.moduleNamespace !== record.exports || !executable || entry.fiber.runtime?.callback !== executable)
      throw fail('CANVAS_CLIENT_RUNTIME_IDENTITY_MISMATCH', 'Actual active Loader entry is not the materialized Canvas module callback');
    const page = new URL(document.baseURI), bundle = new URL(row.url, page);
    const sameOrigin = url => url.protocol === page.protocol && url.host === page.host && !url.username && !url.password;
    if (!sameOrigin(bundle)) throw fail('CANVAS_CLIENT_BUNDLE_ORIGIN_MISMATCH', 'Actual graph bundle must be served by this product origin');
    const response = await fetch(bundle.href, { signal: signal() });
    if (!response.ok || (response.url && !sameOrigin(new URL(response.url))))
      throw fail('CANVAS_CLIENT_BUNDLE_FETCH_FAILED', 'Actual product graph bundle fetch failed', { status: response.status });
    if (!globalThis.crypto?.subtle) throw fail('CANVAS_CLIENT_BUNDLE_DIGEST_UNAVAILABLE', 'Actual renderer cannot hash its fetched graph bundle');
    const bytes = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== source.bundleSHA256) throw fail('CANVAS_CLIENT_BUNDLE_BYTES_MISMATCH', 'Product-served Client bundle does not match the Host graph artifact', { observedSHA256: digest });
    // These identities and hashes are observations of actual objects/bytes;
    // no synthetic root/fiber/registration references are allocated here.
    return { ...inspection, client: {
      modulesVersion: modules.version, graphRef: modules.manifest.rev,
      graphRow: { id: row.id, url: row.url, rev: row.rev, inject: row.inject, external: row.external },
      materializedModuleId: record.id, loaderEntryId: entry.id, fiberUid: entry.fiber.uid,
      fiberState: entry.fiber.state, moduleNamespaceMatches: entry.moduleNamespace === record.exports,
      callbackMatches: entry.fiber.runtime.callback === executable,
      loaderUsesModules: loader.internal === modules, bundleSHA256: digest,
    } };
  }
  function waitFor(read, code, message) {
    checkActive();
    return new Promise((resolve, reject) => {
      let observer, timer, finished = false;
      const cleanup = () => { observer?.disconnect(); clearTimeout(timer); controller.signal.removeEventListener('abort', abort); };
      const done = (error, value) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(value); };
      const abort = () => done(fail('CANVAS_VERIFICATION_DISPOSED', 'Observation was cancelled'));
      const inspect = () => { try { const value = read(); if (value) done(null, value); } catch (error) { done(error); } };
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => done(fail(code, message)), budget);
      controller.signal.addEventListener('abort', abort, { once: true }); inspect();
    });
  }
  const entries = slot => ctx.slots.entriesOfSlot(slot);
  function panelInfo() {
    const main = entries('main');
    const candidates = entries('sidebar.panellist').map(entry => ({
      id: entry.options.id, label: label(entry.options.label),
    })).filter(entry => /Canvas/i.test(entry.label ?? '') && main.some(m => m.options.key === entry.id));
    if (candidates.length !== 1) throw fail('CANVAS_LIVE_PANEL_AMBIGUOUS', 'Expected exactly one live Canvas sidebar/main pair', { candidates });
    return { mainKey: candidates[0].id, sidebarTarget: candidates[0].id, label: candidates[0].label };
  }
  const selected = () => ctx.layout.panelInfo.getSnapshot().activePanelId;
  const canvasPanel = () => [...document.querySelectorAll('.hw-canvas-display')].find(visible);
  const actualButton = (scope, match) => [...scope.querySelectorAll('button,[role="button"]')]
    .filter(visible).filter(node => !root.contains(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true')
    .filter(node => typeof match === 'string' ? (node.getAttribute('aria-label') ?? text(node)) === match : match.test(node.getAttribute('aria-label') ?? text(node)));
  function uniqueButton(scope, match, code) {
    const found = actualButton(scope, match);
    if (found.length !== 1) throw fail(code, 'Expected one enabled actual product control', { matching: String(match), found: found.length });
    return found[0];
  }
  function snapshot(extra = {}) {
    const panels = [...document.querySelectorAll('.hw-canvas-display')].filter(visible);
    return { canvasPanels: panels.length, text: panels.map(text).join(' '), ...extra };
  }
  async function useSession(preparation) {
    const sessionRef = preparation.actualSessionRef ?? preparation.sessionRef;
    if (typeof sessionRef !== 'string' || !sessionRef) throw fail('CANVAS_UI_SESSION_NOT_SUPPLIED', 'Host must identify the actual selected/bound Session');
    const current = () => Object.values(ctx.sessions.list.getSnapshot().byId).find(x => (x.retainedBy.mainView ?? 0) > 0)?.id;
    if (current() !== sessionRef) {
      const navigation = ctx.get('uiWorkspace');
      if (!ctx.sessions.list.getSnapshot().byId[sessionRef])
        throw fail('CANVAS_UI_SESSION_NOT_CATALOGUED', 'Host Session is absent from the actual Client catalog', { sessionRef });
      if (typeof navigation?.openSession !== 'function') throw fail('CANVAS_UI_SESSION_NAVIGATION_MISSING', 'Official uiWorkspace.openSession is unavailable');
      navigation.openSession(sessionRef);
      // This is a public source observation, not a fabricated retention count.
      await new Promise((resolve, reject) => {
        let release, timer;
        const abort = () => finish(fail('CANVAS_VERIFICATION_DISPOSED', 'Session selection cancelled'));
        const finish = error => { release?.(); clearTimeout(timer); controller.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const inspect = () => { if (current() === sessionRef) finish(); };
        release = ctx.sessions.list.subscribe(inspect);
        timer = setTimeout(() => finish(fail('CANVAS_UI_SESSION_SELECTION_FAILED', 'Official Session navigation did not retain the requested main view', { sessionRef })), budget);
        controller.signal.addEventListener('abort', abort, { once: true }); inspect();
      });
    }
    if (current() !== sessionRef) throw fail('CANVAS_UI_SESSION_MISMATCH', 'Actual main view changed during observation');
  }
  async function navigate(actions, clickSidebar = false) {
    const info = panelInfo();
    if (clickSidebar) {
      const button = uniqueButton(document, info.label, 'CANVAS_SIDEBAR_CONTROL_MISSING');
      button.click(); actions.push({ kind: 'sidebar', label: info.label, panelId: info.mainKey });
      if (selected() !== info.mainKey) throw fail('CANVAS_SIDEBAR_TARGET_MISMATCH', 'Sidebar did not select its live registered main panel');
    }
    ctx.layout.selectPanel(info.mainKey);
    await waitFor(() => selected() === info.mainKey && canvasPanel(), 'CANVAS_PRODUCT_PANEL_MISSING', 'Actual Canvas main panel did not render');
    return { mainKey: info.mainKey, sidebarTarget: info.sidebarTarget, selectedPanelId: selected() };
  }
  function historyRow(panel, action, preparation) {
    if (!panel) return null;
    const title = action === 'undo' ? '撤回' : '重做';
    const rows = [...panel.querySelectorAll('.hw-canvas-timeline > li')];
    const targetId = preparation.historyTransactionId ?? preparation.transactionId;
    const history = preparation.view?.history ?? preparation.redoView?.history ?? preparation.undoView?.history;
    let row;
    if (targetId && history) {
      const index = history.findIndex(item => item.transactionId === targetId);
      if (index < 0) throw fail('CANVAS_UI_HISTORY_TARGET_MISSING', 'Actual target receipt is absent from the independently observed history');
      row = rows[index];
      if (!row || !text(row).includes(history[index].objectName ?? '未命名对象')) return null;
    } else {
      const eligible = rows.filter(node => actualButton(node, `${title}这笔`).length === 1);
      if (eligible.length > 1) throw fail('CANVAS_UI_HISTORY_TARGET_AMBIGUOUS', 'Host must identify the actual history row', { count: eligible.length });
      if (eligible.length === 0) return null;
      row = eligible[0];
    }
    return actualButton(row, `${title}这笔`).length === 1 ? row : null;
  }
  async function historyAction(action, actions, preparation) {
    const title = action === 'undo' ? '撤回' : '重做';
    const row = await waitFor(() => historyRow(canvasPanel(), action, preparation),
      'CANVAS_HISTORY_ACTION_CONTROL_MISSING', 'Actual independently observed history row has no enabled action control');
    uniqueButton(row, `${title}这笔`, 'CANVAS_HISTORY_ACTION_CONTROL_MISSING').click();
    const confirm = await waitFor(() => actualButton(row, `确认${title}`)[0], 'CANVAS_HISTORY_CONFIRM_CONTROL_MISSING', 'Actual history confirmation is absent');
    confirm.click(); actions.push({ kind: action, label: text(confirm) });
    await waitFor(() => {
      const actual = canvasPanel();
      const error = actual?.querySelector('.hw-canvas-error');
      if (error && visible(error)) throw fail('CANVAS_PRODUCT_HISTORY_FAILED', text(error));
      const status = row.querySelector('.hw-canvas-status');
      return actual && status && text(status) === (action === 'undo' ? '已撤回' : '已提交')
        && [...actual.querySelectorAll('.hw-canvas-done')].find(node => visible(node) && text(node).includes(`已${title}`));
    }, 'CANVAS_HISTORY_ACTION_WAIT', 'Actual Canvas action did not complete');
  }
  async function managerPanel(actions) {
    const candidates = entries('sidebar.panellist').map(entry => ({ id: entry.options.id, label: label(entry.options.label) }))
      .filter(entry => /插件|plugins?|扩展|extensions?/i.test(entry.label ?? '') && entries('main').some(x => x.options.key === entry.id));
    if (candidates.length !== 1) throw fail('CANVAS_NORMAL_MANAGER_PANEL_MISSING', 'Cannot discover one normal plugin-manager panel in the live registry', { candidates });
    uniqueButton(document, candidates[0].label, 'CANVAS_MANAGER_SIDEBAR_CONTROL_MISSING').click();
    ctx.layout.selectPanel(candidates[0].id);
    actions.push({ kind: 'manager', label: candidates[0].label, panelId: candidates[0].id });
    return waitFor(() => {
      // Ascend from an actual exact package label to its own actionable card.
      const labels = [...document.querySelectorAll('h1,h2,h3,h4,span,p,code')].filter(node => !root.contains(node) && visible(node) && text(node) === 'hanaworlds-canvas');
      for (const item of labels) {
        for (let card = item.parentElement; card && card !== document.body; card = card.parentElement) {
          if (actualButton(card, /卸载|uninstall|配置|configure|设置|settings/i).length > 0) return card;
        }
      }
    }, 'CANVAS_MANAGER_PACKAGE_CARD_MISSING', 'Actual installed Canvas card with normal controls is absent');
  }
  async function configure(preparation, actions) {
    const requested = preparation.requestedSettings;
    if (!requested || typeof requested !== 'object') throw fail('CANVAS_UI_CONFIGURATION_NOT_SUPPLIED', 'Host did not supply actual requested placement settings');
    const card = await managerPanel(actions);
    const open = uniqueButton(card, /配置|configure|设置|settings/i, 'CANVAS_NORMAL_CONFIGURATION_CONTROL_MISSING');
    open.click(); actions.push({ kind: 'configuration', label: text(open) });
    const form = await waitFor(() => [...document.querySelectorAll('form,[role="dialog"]')].find(node => visible(node) && !root.contains(node)
      && node.querySelector('input,textarea,select')), 'CANVAS_NORMAL_CONFIGURATION_FORM_MISSING', 'Normal configuration form did not appear');
    for (const [key, value] of Object.entries(requested)) {
      const fields = [...form.querySelectorAll('input,textarea,select')].filter(node => visible(node) &&
        (node.name === key || node.getAttribute('aria-label') === key || [...(node.labels ?? [])].some(x => text(x) === key)));
      if (fields.length !== 1) throw fail('CANVAS_NORMAL_CONFIGURATION_FIELD_MISSING', 'Placement setting has no unique actual editable field', { key });
      const field = fields[0];
      if (field.disabled || field.readOnly) throw fail('CANVAS_NORMAL_CONFIGURATION_FIELD_DISABLED', key);
      const property = field.type === 'checkbox' ? 'checked' : 'value';
      const next = property === 'checked' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), property)?.set;
      if (!setter) throw fail('CANVAS_NORMAL_CONFIGURATION_FIELD_UNSUPPORTED', key);
      setter.call(field, next); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
      actions.push({ kind: 'setting', label: key });
    }
    const save = uniqueButton(form, /^(保存|保存配置|应用|Save|Apply)$/i, 'CANVAS_NORMAL_CONFIGURATION_SAVE_MISSING');
    save.click(); actions.push({ kind: 'save', label: text(save) });
    await waitFor(() => !visible(form), 'CANVAS_NORMAL_CONFIGURATION_SAVE_WAIT', 'Normal configuration save did not close the form');
    const freshCard = await managerPanel(actions);
    const reload = uniqueButton(freshCard, /^(重新加载|重载|Reload)$/i, 'CANVAS_NORMAL_CONFIGURATION_RELOAD_MISSING');
    reload.click(); actions.push({ kind: 'reload', label: text(reload) });
  }
  async function unload(actions, info) {
    const card = await managerPanel(actions);
    const uninstall = uniqueButton(card, /^(卸载|Uninstall)$/i, 'CANVAS_NORMAL_UNINSTALL_CONTROL_MISSING');
    uninstall.click(); actions.push({ kind: 'uninstall', label: text(uninstall) });
    const prompt = await waitFor(() => {
      if (!entries('main').some(x => x.options.key === info.mainKey)) return { unloaded: true };
      const dialog = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
        .find(node => visible(node) && !root.contains(node) && /Canvas|hanaworlds-canvas/i.test(text(node)));
      return dialog && { dialog };
    },
    'CANVAS_NORMAL_UNINSTALL_CONFIRM_MISSING', 'Normal manager uninstall confirmation is absent');
    if (prompt.dialog) {
      const confirm = uniqueButton(prompt.dialog, /^(确认卸载|卸载|确认|Uninstall|Confirm)$/i, 'CANVAS_NORMAL_UNINSTALL_CONFIRM_MISSING');
      confirm.click(); actions.push({ kind: 'confirm-uninstall', label: text(confirm) });
    }
    await waitFor(() => !entries('main').some(x => x.options.key === info.mainKey)
      && !entries('sidebar.panellist').some(x => x.options.id === info.sidebarTarget)
      && document.querySelectorAll('.hw-canvas-display').length === 0,
    'CANVAS_NORMAL_UNINSTALL_WAIT', 'Normal manager did not clear actual Canvas UI registrations');
    let oldTargetAccepted = false;
    try { ctx.layout.selectPanel(info.mainKey); oldTargetAccepted = true; } catch { /* public layout rejects the removed live key */ }
    return { mainEntryPresent: entries('main').some(x => x.options.key === info.mainKey),
      sidebarEntryPresent: entries('sidebar.panellist').some(x => x.options.id === info.sidebarTarget),
      remoteNamespacePresent: !!ctx.get('remote.hanaworldsCanvasDisplay'), oldTargetAccepted };
  }
  async function runUi(caseId) {
    const actions = [];
    let preparation = await remote('invoke', caseId, 'prepare'); record('prepare', preparation);
    await useSession(preparation);
    let dom = await navigate(actions, true);
    if (caseId === 'ui/undo-redo') {
      await historyAction('undo', actions, preparation);
      const afterUndo = await remote('invoke', caseId, 'after-undo'); record('after-undo', afterUndo);
      await historyAction('redo', actions, { ...preparation, ...afterUndo });
      record('after-redo', await remote('invoke', caseId, 'after-redo'));
    } else if (caseId === 'ui/configuration-reload') {
      await configure(preparation, actions);
      record('after-reload', await remote('invoke', caseId, 'after-reload'));
      dom = await navigate(actions);
    } else if (caseId === 'ui/unload') {
      dom = { ...dom, ...await unload(actions, dom) };
      record('after-unload', await remote('invoke', caseId, 'after-unload'));
    } else if (caseId === 'ui/region') {
      await historyAction('undo', actions, preparation);
      record('after-region-undo', await remote('invoke', caseId, 'after-region-undo'));
    } else if (caseId === 'ui/visible-error') {
      // Host establishes the actual unavailable/stale input; only the panel's
      // existing public action/refresh may expose it in the product DOM.
      if (preparation.action === 'undo' || preparation.action === 'redo') {
        const title = preparation.action === 'undo' ? '撤回' : '重做';
        const row = await waitFor(() => historyRow(canvasPanel(), preparation.action, preparation),
          'CANVAS_ERROR_ACTION_CONTROL_MISSING', 'Actual error scenario has no enabled product history action; unavailable actions have no button');
        uniqueButton(row, `${title}这笔`, 'CANVAS_ERROR_ACTION_CONTROL_MISSING').click();
        const confirm = await waitFor(() => actualButton(row, `确认${title}`)[0], 'CANVAS_ERROR_CONFIRM_CONTROL_MISSING', 'Actual error action confirmation is absent');
        confirm.click(); actions.push({ kind: preparation.action, label: text(confirm) });
      } else if (preparation.action === 'refresh') {
        const refresh = await waitFor(() => canvasPanel() && actualButton(canvasPanel(), '刷新')[0],
          'CANVAS_ERROR_REFRESH_CONTROL_MISSING', 'Actual product refresh control is unavailable');
        refresh.click();
        actions.push({ kind: 'refresh', label: '刷新' });
      } else throw fail('CANVAS_ACTUAL_ERROR_SCENARIO_NOT_SUPPLIED', 'Host must supply a real available product action and public error scenario');
      await waitFor(() => {
        const error = canvasPanel()?.querySelector('.hw-canvas-error');
        return error && visible(error) && (!preparation.publicError?.code || text(error).includes(preparation.publicError.code));
      }, 'CANVAS_PUBLIC_ERROR_NOT_VISIBLE', 'Actual product panel did not display the public error');
    } else if (caseId === 'ui/populated-history') {
      await waitFor(() => preparation.view?.objects?.length > 0 && preparation.view?.history?.length > 0
        && preparation.view.objects.every(item => item.name === null || text(canvasPanel()).includes(item.name)),
      'CANVAS_POPULATED_HISTORY_NOT_VISIBLE', 'Actual object/history names did not reach the product panel');
    }
    const observed = snapshot(dom);
    record('product-dom', observed);
    return remote('invoke', caseId, JSON.stringify({ phase: 'finish', dom: observed, actions }));
  }
  async function runLocal(caseId, mode) {
    const actions = [];
    const prepareMode = { phase: 'local-prepare', mode };
    if (caseId === 'local/panelId') prepareMode.dom = snapshot(await navigate(actions, true));
    const preparation = await remote('invoke', caseId, JSON.stringify(prepareMode));
    record('local-prepare', preparation);
    const request = preparation.request;
    if (!request || typeof request !== 'object') throw fail('CANVAS_LOCAL_REQUEST_NOT_SUPPLIED', 'Host did not provide the actual bound local request');
    let response;
    if (caseId === 'local/panelId') {
      // Reconfigure the existing official Loader-managed module through its
      // normal UI. Never call a fetched factory against a second Context.
      await configure({ requestedSettings: request }, actions);
      if (mode === 'ok') {
        const dom = await navigate(actions, true);
        if (dom.mainKey !== request.panelId) throw fail('CANVAS_CLIENT_PANEL_CONFIGURATION_NOT_APPLIED', 'Normal Loader reload did not apply the requested panelId');
        response = { main: { key: dom.mainKey }, sidebar: { id: dom.sidebarTarget }, selectedPanelId: dom.selectedPanelId };
      } else {
        await navigate(actions);
        const errorPanel = await waitFor(() => {
          const panel = canvasPanel();
          return panel && text(panel).includes('INVALID_CANVAS_PANEL_ID') && panel;
        }, 'CANVAS_CLIENT_PANEL_REFUSAL_NOT_VISIBLE', 'Actual client did not expose its panelId refusal');
        const fields = [...errorPanel.querySelectorAll('dt')];
        const value = title => text(fields.find(node => text(node) === title)?.nextElementSibling);
        response = { code: value('故障'), stage: value('阶段'), visible: visible(errorPanel), message: value('详情') };
      }
    } else {
      const method = caseId.slice('local/display.'.length);
      const allowed = method === 'read' || method === 'actions' || method === 'changes'
        ? ['sessionRef'] : ['sessionRef', 'objectRef', 'historyTransactionId'];
      const unexpected = Object.keys(request).filter(key => !allowed.includes(key));
      if (unexpected.length) {
        // The public positional Remote can only express its declared fields.
        // Admission negative cases therefore use the SAME existing Connection
        // carrier and Gateway endpoint, preserving the full invalid args. This
        // creates neither a transport nor a receiver and changes no descriptor.
        const connection = ctx.get('connection');
        if (typeof connection?.rpc?.call !== 'function') throw fail('CANVAS_OFFICIAL_CONNECTION_RPC_MISSING', 'The current official Connection carrier is unavailable');
        const endpoint = `hanaworldsCanvasDisplay/${method}`;
        const result = await connection.rpc.call('/api', endpoint, { args: request }, signal());
        response = result.ok ? result.value : result.error;
        actions.push({ kind: 'official-carrier-admission', label: endpoint });
        record('actual-connection-carrier', { channel: '/api', endpoint, request, response });
      } else {
      let display;
      try {
        display = ctx.inject(['remote.hanaworldsCanvasDisplay'], async child => {
          const service = child.remote.hanaworldsCanvasDisplay;
          if (typeof service?.[method] !== 'function') throw fail('CANVAS_DISPLAY_REMOTE_METHOD_MISSING', method);
          if (method === 'changes') {
            const handle = service.changes(request.sessionRef, signal());
            try {
              const first = handle[Symbol.asyncIterator]().next();
              await remote('invoke', caseId, JSON.stringify({ phase: 'after-subscribe', mode }));
              const received = await first;
              if (received.done) throw fail('CANVAS_DISPLAY_CHANGES_ENDED', 'Actual stream ended before its first durable notice');
              response = received.value;
            } finally { await handle.dispose(); }
          } else {
            const result = await service[method](...allowed.map(key => request[key]));
            // RemoteError is an Error instance; message is non-enumerable and
            // its local marker is not part of the public wire error DTO.
            response = result.ok ? result.value : {
              code: result.error.code, message: result.error.message, details: result.error.details,
            };
          }
        });
        await display;
      } finally { await display?.dispose(); }
      }
    }
    record('local-client-response', response);
    return remote('invoke', caseId, JSON.stringify({ phase: 'local-finish', mode, request, response, dom: snapshot(), actions }));
  }
  async function prepareCaseSession(caseId, mode) {
    let sessionRef;
    if (mode === 'replay') {
      sessionRef = completedOkSessions.get(caseId);
      if (!sessionRef) throw fail('CANVAS_REPLAY_SESSION_NOT_OBSERVED', 'Execute this event success before replaying its actual Session', { caseId });
    } else {
      if (typeof ctx.sessions.create !== 'function') throw fail('CANVAS_OFFICIAL_SESSION_CREATE_MISSING', 'The installed official Sessions create API is unavailable');
      sessionRef = await ctx.sessions.create();
      if (typeof sessionRef !== 'string' || !sessionRef) throw fail('CANVAS_OFFICIAL_SESSION_CREATE_INVALID', 'Official Sessions did not return its actual catalogued identity');
    }
    await useSession({ actualSessionRef: sessionRef });
    record('actual-case-session', { caseId, mode, sessionRef });
    record('case-prepare', await remote('invoke', caseId, JSON.stringify({ phase: 'case-prepare', sessionRef, mode })));
    return sessionRef;
  }
  const entry = {
    profileVersion: 'canvas-client-verification/v1',
    inspect: inspectActualClient,
    result(caseId, mode) {
      checkActive();
      const result = pending.get(JSON.stringify([caseId, mode]));
      return result ?? Promise.reject(fail('CANVAS_CASE_NOT_STARTED', 'Click the actual case button before reading its result', { caseId, mode }));
    },
  };
  if (window[entryName]) throw fail('CANVAS_VERIFICATION_ENTRY_ALREADY_PRESENT', 'An independently loaded observer is already active');
  for (const { id, mode } of __CANVAS_VERIFICATION_CASES__) {
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.canvasVerificationCase = id; button.dataset.canvasVerificationMode = mode;
    button.textContent = `${id} / ${mode}`;
    button.onclick = () => {
      const key = JSON.stringify([id, mode]);
      // Cache the actual execution Promise synchronously; result() never
      // starts work, fabricates a response, or returns an old expected DTO.
      const task = queue.then(async () => {
        checkActive(); record('invoke', { caseId: id, mode });
        try {
          const sessionRef = await prepareCaseSession(id, mode);
          const value = id.startsWith('ui/') ? await runUi(id)
            : id === 'local/panelId' || id.startsWith('local/display.') ? await runLocal(id, mode)
            : await remote('invoke', id, mode);
          if (mode === 'ok') completedOkSessions.set(id, sessionRef);
          return value;
        } catch (error) {
          try { await cancelCase(id); }
          catch (cleanupError) { throw Object.assign(new AggregateError([error,cleanupError], 'Canvas observation failed and its capture could not be released'), { observationCleanupFailed: true }); }
          throw error;
        }
      });
      pending.set(key, task); queue = task.catch(() => {});
      task.then(value => record('result', value), error => record('failure', error));
    };
    buttons.append(button);
  }
  window[entryName] = entry; document.body.append(root);
  let disposal;
  return () => {
    if (disposal) return disposal;
    disposed = true; controller.abort();
    for (const button of buttons.children) button.onclick = null;
    root.remove();
    if (window[entryName] === entry) delete window[entryName];
    disposal = (async () => {
      const results = await Promise.allSettled([...pending.values()]);
      // Successful event cases retain their real Session only for replay.
      // Dispose that retained scope via the normal Canvas cleanup route too.
      const releases = await Promise.allSettled([...completedOkSessions.keys()]
        .filter(id => id.startsWith('event/')).map(cancelCase));
      pending.clear(); completedOkSessions.clear();
      const failures = [...results.filter(row => row.status === 'rejected' && row.reason?.observationCleanupFailed),
        ...releases.filter(row => row.status === 'rejected')].map(row => row.reason);
      if (failures.length) throw new AggregateError(failures, 'Canvas observation disposal could not release its actual captures/scopes');
    })();
    return disposal;
  };
}

export async function apply(ctx, config = {}) {
  if (!window.__ModuleLoader__) throw fail('CANVAS_OFFICIAL_CLIENT_LOADER_MISSING', 'Observation tool requires the official product ModuleLoader');
  let disposeRemote, observer, cleanup;
  const dispose = async () => {
    const failures = [];
    for (const release of [() => cleanup?.(), () => observer?.dispose(), () => disposeRemote?.()]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Canvas client observation tool cleanup failed');
  };
  try {
    disposeRemote = await ctx.remote.$mount(verificationClientContribution);
    observer = ctx.inject(['remote.hanaworldsCanvasVerification', 'slots', 'layout', 'sessions'], child => {
      child.effect(() => { cleanup = observation(child, config); return cleanup; });
    });
    await observer;
    return dispose;
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Canvas observer initialization and cleanup failed'); }
    throw error;
  }
}
