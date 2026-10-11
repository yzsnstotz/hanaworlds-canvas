// src/display-view.mjs
import React from "react";
var h = React.createElement;
var positions = (value) => value.join(", ");
var emptyReasons = {
  NO_SESSION: "\u8FD8\u6CA1\u6709\u9009\u62E9\u4F1A\u8BDD\u3002\u9009\u62E9\u4E00\u4E2A\u5DF2\u8FDE\u63A5\u4E16\u754C\u7684\u4F1A\u8BDD\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u5B83\u7684\u5BF9\u8C61\u4E0E\u5386\u53F2\u3002",
  NO_WORLD: "\u5F53\u524D\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u4E16\u754C\u3002\u8BF7\u5148\u5728\u4E16\u754C\u9762\u677F\u8FDE\u63A5\u5E76\u9009\u62E9\u4E16\u754C\u3002",
  EMPTY: "\u5F53\u524D\u4E16\u754C\u8FD8\u6CA1\u6709 Canvas \u5DF2\u63D0\u4EA4\u7684\u5BF9\u8C61\u3002\u5B8C\u6210\u4E00\u6B21\u5EFA\u9020\u540E\uFF0C\u5BF9\u8C61\u4E0E\u5386\u53F2\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002"
};
var undoReasons = {
  NOTHING_TO_UNDO: "\u8FD9\u7B14\u5DF2\u64A4\u56DE\u3002",
  WORLD_CHANGED_SINCE: "\u4E4B\u540E\u4E16\u754C\u53C8\u6709\u65B0\u6539\u52A8\uFF1BCanvas \u53EA\u64A4\u56DE\u4E16\u754C\u6700\u8FD1\u4E00\u6B21\u6539\u52A8\u3002",
  TRANSACTION_PENDING: "\u6709\u4E00\u7B14\u6539\u52A8\u4ECD\u5728\u5904\u7406\u4E2D\uFF0C\u5B8C\u6210\u540E\u624D\u80FD\u64A4\u56DE\u3002",
  REGION_SCOPE_EVIDENCE_UNAVAILABLE: "\u8FD9\u6761\u533A\u57DF\u5386\u53F2\u7F3A\u5C11\u53EF\u4FE1\u786E\u8BA4\u8303\u56F4\uFF0C\u6682\u4E0D\u80FD\u64A4\u56DE\u3002",
  REGION_UNDO_HAS_NO_REDO: "\u6279\u91CF\u533A\u57DF\u6539\u52A8\u5728\u8FD9\u91CC\u4E0D\u63D0\u4F9B\u64A4\u56DE\u3002",
  HISTORY_MOVED: "\u8FD9\u7B14\u5DF2\u4E0D\u662F\u8BE5\u5BF9\u8C61\u7684\u6700\u8FD1\u6539\u52A8\uFF0C\u8BF7\u5237\u65B0\u540E\u518D\u770B\u3002",
  OBJECT_NOT_FOUND: "Canvas \u627E\u4E0D\u5230\u8FD9\u4E2A\u5BF9\u8C61\u3002",
  NO_WORLD: "\u5F53\u524D\u4F1A\u8BDD\u6CA1\u6709\u7ED1\u5B9A\u4E16\u754C\u3002",
  UNDO_CONFLICT: "\u8FD9\u7B14\u5DF2\u4E0D\u662F\u6700\u8FD1\u6539\u52A8\uFF0C\u672A\u64A4\u56DE\u3002",
  STALE_REVISION: "\u4E16\u754C\u6216\u5BF9\u8C61\u5DF2\u53D8\u5316\uFF0C\u672A\u64A4\u56DE\u3002\u8BF7\u5237\u65B0\u540E\u518D\u770B\u3002",
  READBACK_MISMATCH: "\u4E16\u754C\u91CC\u7684\u65B9\u5757\u4E0E\u8FD9\u7B14\u63D0\u4EA4\u540E\u7684\u72B6\u6001\u4E0D\u4E00\u81F4\uFF0C\u672A\u64A4\u56DE\u3002",
  ROLLED_BACK: "\u64A4\u56DE\u6CA1\u6709\u901A\u8FC7\u6821\u9A8C\uFF0C\u5DF2\u6574\u7B14\u56DE\u6EDA\uFF0C\u4E16\u754C\u4FDD\u6301\u539F\u6837\u3002",
  RECOVERY_PENDING: "\u64A4\u56DE\u7ED3\u679C\u672A\u77E5\uFF0CCanvas \u5DF2\u8BB0\u4E3A\u5F85\u6062\u590D\u3002\u8BF7\u4E0D\u8981\u91CD\u590D\u70B9\u51FB\u3002",
  CAPABILITY_UNAVAILABLE: "\u9700\u8981\u7684\u4E16\u754C\u73B0\u5728\u4E0D\u53EF\u7528\uFF08\u672A\u542F\u52A8\u3001\u8FDE\u4E0D\u4E0A\u6216\u7F3A\u5C11\u6240\u9700\u80FD\u529B\uFF09\uFF0C\u672A\u64A4\u56DE\u3002"
};
var undoReasonLabel = (code) => undoReasons[code] ?? `\u672A\u64A4\u56DE\uFF08${code}\uFF09`;
var undoFailureLabel = (code, worldRef = null) => worldRef ? `${undoReasonLabel(code)} \u9700\u8981\u7684\u4E16\u754C\uFF1A${worldRef}` : undoReasonLabel(code);
var redoReasons = {
  NOTHING_TO_REDO: "\u6CA1\u6709\u53EF\u91CD\u505A\u7684\u6539\u52A8\u3002",
  REGION_REDO_NOT_IN_PROTOCOL: "\u6279\u91CF\u533A\u57DF\u6539\u52A8\u4E0D\u63D0\u4F9B\u91CD\u505A\u3002",
  WORLD_CHANGED_SINCE: "\u4E4B\u540E\u4E16\u754C\u53C8\u6709\u65B0\u6539\u52A8\uFF0C\u4E0D\u80FD\u91CD\u505A\u8FD9\u7B14\u3002",
  TRANSACTION_PENDING: "\u6709\u4E00\u7B14\u6539\u52A8\u4ECD\u5728\u5904\u7406\u4E2D\uFF0C\u5B8C\u6210\u540E\u624D\u80FD\u91CD\u505A\u3002",
  HISTORY_MOVED: "\u8FD9\u7B14\u5DF2\u4E0D\u662F\u5F53\u524D\u53EF\u91CD\u505A\u7684\u6539\u52A8\uFF0C\u8BF7\u5237\u65B0\u540E\u518D\u770B\u3002",
  REDO_CONFLICT: "\u4E16\u754C\u91CC\u7684\u65B9\u5757\u5DF2\u53D8\u5316\uFF0C\u672A\u91CD\u505A\u3002",
  REDO_UNAVAILABLE: "\u8FD9\u7B14\u6539\u52A8\u73B0\u5728\u4E0D\u80FD\u91CD\u505A\u3002",
  ROLLED_BACK: "\u91CD\u505A\u6CA1\u6709\u901A\u8FC7\u6821\u9A8C\uFF0C\u5DF2\u6574\u7B14\u56DE\u6EDA\u3002",
  RECOVERY_PENDING: "\u91CD\u505A\u7ED3\u679C\u672A\u77E5\uFF0CCanvas \u5DF2\u8BB0\u4E3A\u5F85\u6062\u590D\u3002\u8BF7\u4E0D\u8981\u91CD\u590D\u70B9\u51FB\u3002"
};
var redoFailureLabel = (code, worldRef = null) => {
  const label = redoReasons[code] ?? `\u672A\u91CD\u505A\uFF08${code}\uFF09`;
  return worldRef ? `${label} \u9700\u8981\u7684\u4E16\u754C\uFF1A${worldRef}` : label;
};
var readFailureLabel = (failure) => {
  const cause = failure?.details?.storageFailure;
  return cause ? `Canvas \u5B58\u50A8\u521D\u59CB\u5316\u5931\u8D25\uFF08${cause.code}\uFF09\uFF1A${cause.message}` : failure?.details?.reason ?? failure?.code ?? failure?.message ?? String(failure);
};
function timeLabel(value) {
  if (value === null) return "\u672A\u8BB0\u5F55\u65F6\u95F4";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function ObjectsHistoryView({ view, refresh, pending = false, error = null, liveError = null, emptyReason, footer = "\u8FD9\u91CC\u4EC5\u4F9B\u67E5\u770B\u3002\u5EFA\u9020\u6216\u64A4\u56DE\u8BF7\u4F7F\u7528\u5BF9\u5E94\u9762\u677F\u3002", actions = null, undo = null, redo = null }) {
  const objects = view?.objects ?? [];
  const history = view?.history ?? [];
  const steps = actions && (undo || redo) ? new Map(actions.objects.map((object) => [object.objectRef, object.undo])) : null;
  const redoSteps = actions && redo ? new Map(actions.objects.map((object) => [object.objectRef, object.redo])) : null;
  const undoButtons = (entry) => {
    const step = steps?.get(entry.objectRef);
    if (!undo || !step?.available || step.historyTransactionId !== entry.transactionId) return null;
    if (undo.confirming === entry.transactionId) return h(
      "div",
      { className: "hw-canvas-undo" },
      h("span", null, `\u64A4\u56DE\u8FD9\u7B14\uFF1ACanvas \u4F1A\u628A\u8FD9 ${entry.affectedCells ?? "\u82E5\u5E72"} \u683C\u6062\u590D\u5230\u63D0\u4EA4\u524D\u3002`),
      h("button", { type: "button", className: "hw-canvas-danger", disabled: undo.busy, onClick: () => undo.confirm(entry) }, undo.busy ? "\u6B63\u5728\u64A4\u56DE\u2026" : "\u786E\u8BA4\u64A4\u56DE"),
      h("button", { type: "button", disabled: undo.busy, onClick: undo.cancel }, "\u53D6\u6D88")
    );
    return h(
      "div",
      { className: "hw-canvas-undo" },
      h("button", { type: "button", disabled: undo.busy || pending, onClick: () => undo.request(entry) }, "\u64A4\u56DE\u8FD9\u7B14")
    );
  };
  const redoButtons = (entry) => {
    const step = redoSteps?.get(entry.objectRef);
    if (!step?.available || step.historyTransactionId !== entry.transactionId) return null;
    if (redo.confirming === entry.transactionId) return h(
      "div",
      { className: "hw-canvas-undo" },
      h("span", null, `\u91CD\u505A\u8FD9\u7B14\uFF1ACanvas \u4F1A\u91CD\u65B0\u5E94\u7528\u8FD9 ${entry.affectedCells ?? "\u82E5\u5E72"} \u683C\u7684\u6539\u52A8\u3002`),
      h("button", { type: "button", disabled: redo.busy, onClick: () => redo.confirm(entry) }, redo.busy ? "\u6B63\u5728\u91CD\u505A\u2026" : "\u786E\u8BA4\u91CD\u505A"),
      h("button", { type: "button", disabled: redo.busy, onClick: redo.cancel }, "\u53D6\u6D88")
    );
    return h(
      "div",
      { className: "hw-canvas-undo" },
      h("button", { type: "button", disabled: redo.busy || pending, onClick: () => redo.request(entry) }, "\u91CD\u505A\u8FD9\u7B14")
    );
  };
  return h(
    "section",
    { className: "hw-canvas-display", "aria-label": "\u5BF9\u8C61\u4E0E\u5386\u53F2\uFF08Canvas\uFF09" },
    h(
      "header",
      { className: "hw-canvas-header" },
      h(
        "div",
        null,
        h("div", { className: "hw-canvas-eyebrow" }, "CANVAS \xB7 \u4E16\u754C\u8BB0\u5F55"),
        h("h1", null, "\u5BF9\u8C61\u4E0E\u5386\u53F2"),
        h("p", null, "\u770B\u770B\u4E16\u754C\u91CC\u7684\u4F5C\u54C1\uFF0C\u4EE5\u53CA\u6BCF\u4E00\u6B21\u5DF2\u63D0\u4EA4\u7684\u6539\u52A8\u3002")
      ),
      h(
        "div",
        { className: "hw-canvas-actions" },
        h("button", { type: "button", onClick: refresh, disabled: pending }, pending ? "\u6B63\u5728\u8BFB\u53D6\u2026" : "\u5237\u65B0")
      )
    ),
    h("div", { className: "hw-canvas-source" }, steps ? "\u5F53\u524D\u4E16\u754C \xB7 \u53EF\u64A4\u56DE\u6216\u91CD\u505A\u6700\u8FD1\u6539\u52A8" : "\u5F53\u524D\u4E16\u754C \xB7 \u53EA\u8BFB"),
    steps && undo?.message && h("p", { role: "status", className: "hw-canvas-done" }, undo.message),
    steps && undo?.error && h("p", { role: "alert", className: "hw-canvas-error" }, "\u64A4\u56DE\u5931\u8D25\uFF1A", undo.error),
    redo?.message && h("p", { role: "status", className: "hw-canvas-done" }, redo.message),
    redo?.error && h("p", { role: "alert", className: "hw-canvas-error" }, "\u91CD\u505A\u5931\u8D25\uFF1A", redo.error),
    error && h("p", { role: "alert", className: "hw-canvas-error" }, "\u8BFB\u53D6\u5931\u8D25\uFF1A", error),
    liveError && h(
      "p",
      { role: "alert", className: "hw-canvas-error" },
      `\u81EA\u52A8\u66F4\u65B0\u5DF2\u4E2D\u65AD\uFF08${liveError}\uFF09\uFF1A\u65B0\u7684\u5EFA\u9020\u6216\u64A4\u56DE\u4E0D\u4F1A\u81EA\u52A8\u51FA\u73B0\uFF0C\u8BF7\u70B9\u300C\u5237\u65B0\u300D\u8BFB\u53D6\u6700\u65B0\u8BB0\u5F55\u3002`
    ),
    pending && !view && h("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6 Canvas \u7684\u5BF9\u8C61\u4E0E\u5386\u53F2\u2026"),
    view && view.state !== "READY" && h(
      "div",
      { className: "hw-canvas-empty", role: "status" },
      h("strong", null, "\u8FD9\u91CC\u8FD8\u6CA1\u6709\u8BB0\u5F55"),
      h("p", null, emptyReason ?? emptyReasons[view.state])
    ),
    h(
      "div",
      { className: "hw-canvas-grid" },
      h(
        "section",
        { className: "hw-canvas-card", "aria-labelledby": "hw-canvas-objects-title" },
        h("div", { className: "hw-canvas-sectionhead" }, h("h2", { id: "hw-canvas-objects-title" }, "\u4E16\u754C\u91CC\u7684\u5BF9\u8C61"), h("span", null, `${objects.length} \u4E2A\u5BF9\u8C61`)),
        objects.length === 0 ? h("p", { className: "hw-canvas-muted" }, "\u6682\u65E0\u5BF9\u8C61\u3002") : h("ul", { className: "hw-canvas-objects" }, objects.map((object, index) => h(
          "li",
          { key: object.objectRef },
          h("h3", null, object.name ?? `\u672A\u547D\u540D\u5BF9\u8C61 ${index + 1}`),
          h(
            "dl",
            null,
            h("dt", null, "\u4F4D\u7F6E"),
            h("dd", null, object.bounds ? `(${positions(object.bounds.min)})` : "\u5F53\u524D\u65E0\u5360\u5730\uFF08\u5DF2\u64A4\u56DE\uFF09"),
            h("dt", null, "\u5360\u5730\u5927\u5C0F"),
            h("dd", null, object.bounds ? `${object.bounds.size.join(" \xD7 ")} \u683C` : "0 \u683C"),
            h("dt", null, "\u5B9E\u9645\u5360\u7528"),
            h("dd", null, `${object.occupiedCells} \u683C`),
            steps?.get(object.objectRef) && !steps.get(object.objectRef).available && [
              h("dt", { key: "undo-t" }, "\u64A4\u56DE"),
              h("dd", { key: "undo-d" }, undoReasonLabel(steps.get(object.objectRef).reason))
            ],
            redoSteps?.get(object.objectRef) && !redoSteps.get(object.objectRef).available && [
              h("dt", { key: "redo-t" }, "\u91CD\u505A"),
              h("dd", { key: "redo-d" }, redoFailureLabel(redoSteps.get(object.objectRef).reason))
            ]
          )
        )))
      ),
      h(
        "section",
        { className: "hw-canvas-card", "aria-labelledby": "hw-canvas-history-title" },
        h("div", { className: "hw-canvas-sectionhead" }, h("h2", { id: "hw-canvas-history-title" }, "\u6539\u52A8\u65F6\u95F4\u7EBF"), h("span", null, `${history.length} \u7B14\u8BB0\u5F55`)),
        history.length === 0 ? h("p", { className: "hw-canvas-muted" }, "\u6682\u65E0\u5386\u53F2\u3002\u53EA\u6709\u5B8C\u6210\u63D0\u4EA4\u7684\u6539\u52A8\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002") : h("ol", { className: "hw-canvas-timeline" }, history.map((entry) => h(
          "li",
          { key: entry.transactionId },
          h(
            "div",
            { className: "hw-canvas-historyhead" },
            h("h3", null, entry.objectName ?? "\u672A\u547D\u540D\u5BF9\u8C61"),
            h("span", { className: entry.status === "UNDONE" ? "hw-canvas-status undone" : "hw-canvas-status" }, entry.status === "UNDONE" ? "\u5DF2\u64A4\u56DE" : "\u5DF2\u63D0\u4EA4")
          ),
          h("time", entry.committedAt ? { dateTime: entry.committedAt } : {}, timeLabel(entry.committedAt)),
          h(
            "p",
            null,
            entry.mode === "REGION" ? "\u6279\u91CF\u533A\u57DF" : entry.mode === "CELL" ? "\u9010\u683C" : "\u65B9\u5F0F\u672A\u8BB0\u5F55",
            " \xB7 ",
            entry.affectedCells === null ? "\u5F71\u54CD\u683C\u6570\u672A\u8BB0\u5F55" : `\u5F71\u54CD ${entry.affectedCells} \u683C`
          ),
          (entry.committedAt === null || entry.mode === null || entry.affectedCells === null) && h("small", { className: "hw-canvas-muted" }, "\u8FD9\u7B14\u65E7\u8BB0\u5F55\u6CA1\u6709\u4FDD\u5B58\u5B8C\u6574\u5C55\u793A\u4FE1\u606F\u3002"),
          undoButtons(entry),
          redoButtons(entry)
        )))
      )
    ),
    h("footer", null, steps ? "\u64A4\u56DE\u548C\u91CD\u505A\u7531 Canvas \u6821\u9A8C\u5F53\u524D\u4E16\u754C\u540E\u6574\u7B14\u6267\u884C\uFF1B\u6821\u9A8C\u4E0D\u8FC7\u6574\u7B14\u56DE\u6EDA\u3002" : footer)
  );
}
export {
  ObjectsHistoryView,
  readFailureLabel,
  redoFailureLabel,
  undoFailureLabel,
  undoReasonLabel
};
