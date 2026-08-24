window.__ModuleLoader__.load({
  id: "dsh-channel-models",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var el = react.createElement;

    var DISCOVER_ROUTE = "/api/dsh-channel-models/discover";
    var CREATE_ROUTE = "/api/dsh-channel-models/create";
    var LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    var CSS = [
      ".cm-page{max-width:920px;padding:2px 0 28px;color:var(--dsw-alias-label-primary);font-size:13px}",
      ".cm-page h2{margin:0 0 14px;font-size:18px;line-height:1.3;letter-spacing:0}",
      ".cm-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;padding:14px 0;border-block:1px solid var(--dsw-alias-border-l1)}",
      ".cm-field{display:flex;flex-direction:column;gap:6px;min-width:0}.cm-wide{grid-column:1/-1}",
      ".cm-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600}",
      ".cm-input{box-sizing:border-box;width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}",
      ".cm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 0}",
      ".cm-button{min-height:34px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-weight:600;cursor:pointer}",
      ".cm-button-create{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".cm-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}.cm-button:disabled{opacity:.48;cursor:not-allowed}",
      ".cm-status{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".cm-note{padding:9px 10px;border-left:3px solid var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-1);white-space:pre-wrap;overflow-wrap:anywhere}",
      ".cm-error{border-left-color:var(--dsw-alias-state-error-primary)}",
      ".cm-list{border-top:1px solid var(--dsw-alias-border-l1)}",
      ".cm-row{display:grid;grid-template-columns:24px minmax(160px,1fr) minmax(280px,1.4fr);gap:10px;align-items:start;padding:12px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".cm-id{font-weight:600;overflow-wrap:anywhere}.cm-meta{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".cm-levels{display:flex;gap:6px;flex-wrap:wrap}.cm-level{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".cm-level-on{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}",
      "@media(max-width:720px){.cm-form{grid-template-columns:1fr}.cm-wide{grid-column:auto}.cm-row{grid-template-columns:24px minmax(0,1fr)}.cm-levels{grid-column:2}}"
    ].join("\n");

    function postJson(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      }).then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok || !payload.ok) throw new Error(payload.message || (payload.failures || []).map(function (item) { return item.baseURL + ": " + item.message; }).join("\n") || "请求失败");
          return payload;
        });
      });
    }

    function Field(props) {
      return el("label", { className: "cm-field" + (props.wide ? " cm-wide" : "") },
        el("span", { className: "cm-label" }, props.label), props.children);
    }

    function ChannelModelsPage() {
      var providerState = react.useState("internal-gateway");
      var provider = providerState[0];
      var setProvider = providerState[1];
      var nameState = react.useState("内部中转站");
      var displayName = nameState[0];
      var setDisplayName = nameState[1];
      var urlState = react.useState("");
      var baseURL = urlState[0];
      var setBaseURL = urlState[1];
      var apiState = react.useState("openai-completions");
      var api = apiState[0];
      var setApi = apiState[1];
      var keyState = react.useState("");
      var apiKey = keyState[0];
      var setApiKey = keyState[1];
      var manualState = react.useState("");
      var manualId = manualState[0];
      var setManualId = manualState[1];
      var modelState = react.useState([]);
      var models = modelState[0];
      var setModels = modelState[1];
      var busyState = react.useState("");
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noticeState = react.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      function patchModel(index, patch) {
        setModels(function (current) { return current.map(function (model, at) { return at === index ? Object.assign({}, model, patch) : model; }); });
      }

      function addModel() {
        var id = manualId.trim();
        if (!id) return;
        if (models.some(function (model) { return model.id === id; })) {
          setNotice({ error: true, text: "模型 " + id + " 已在列表中" });
          return;
        }
        setModels(function (current) { return current.concat([{ id: id, selected: true, reasoningLevels: [], vision: false }]); });
        setManualId("");
        setNotice({ error: false, text: "已添加模型 " + id + "，可调整推理等级与图片能力后创建" });
      }

      function discover() {
        setBusy("discover");
        setNotice(null);
        postJson(DISCOVER_ROUTE, { provider: provider, baseURL: baseURL, api: api, apiKey: apiKey }).then(function (result) {
          setBaseURL(result.baseURL);
          setModels(result.models.map(function (model) { return Object.assign({}, model, { selected: true }); }));
          setNotice({ error: false, text: "已从 " + result.baseURL + " 获取 " + result.models.length + " 个模型。" });
        }).catch(function (error) {
          setNotice({ error: true, text: String(error && error.message ? error.message : error) });
        }).finally(function () { setBusy(""); });
      }

      function createChannel() {
        setBusy("create");
        setNotice(null);
        var selected = models.filter(function (model) { return model.selected; });
        postJson(CREATE_ROUTE, {
          provider: provider,
          displayName: displayName,
          baseURL: baseURL,
          api: api,
          apiKey: apiKey,
          models: selected.map(function (model) {
            return {
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              reasoningLevels: model.reasoningLevels,
              vision: model.vision === true
            };
          })
        }).then(function (result) {
          var lines = result.models.map(function (model) {
            return model.id + ": " + (model.reasoningLevels.length ? model.reasoningLevels.join(", ") : "提供方默认") + (model.vision ? ", 支持图片" : "");
          });
          setApiKey("");
          setNotice({ error: false, text: "已创建渠道 " + result.provider + "。\n" + lines.join("\n") });
        }).catch(function (error) {
          setNotice({ error: true, text: String(error && error.message ? error.message : error) });
        }).finally(function () { setBusy(""); });
      }

      var rows = models.map(function (model, index) {
        var levels = Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [];
        var vision = model.vision === true;
        var controls = LEVELS.map(function (level) {
          var checked = levels.indexOf(level) >= 0;
          return el("label", { className: "cm-level" + (checked ? " cm-level-on" : ""), key: level },
            el("input", {
              type: "checkbox",
              checked: checked,
              onChange: function () {
                patchModel(index, { reasoningLevels: checked ? levels.filter(function (item) { return item !== level; }) : levels.concat(level) });
              }
            }), level);
        });
        controls.push(el("label", { className: "cm-level" + (vision ? " cm-level-on" : ""), key: "__vision" },
          el("input", {
            type: "checkbox",
            checked: vision,
            disabled: !!busy,
            onChange: function () { patchModel(index, { vision: !vision }); }
          }), "支持图片"));
        var meta = [];
        if (model.vision) meta.push("支持图片输入");
        if (model.contextWindow) meta.push("上下文 " + model.contextWindow);
        if (model.maxTokens) meta.push("输出 " + model.maxTokens);
        return el("div", { className: "cm-row", key: model.id },
          el("input", { type: "checkbox", checked: model.selected, onChange: function (event) { patchModel(index, { selected: event.target.checked }); }, "aria-label": "选择 " + model.id }),
          el("div", null, el("div", { className: "cm-id" }, model.id), meta.length ? el("div", { className: "cm-meta" }, meta.join(" · ")) : null),
          el("div", { className: "cm-levels" }, controls));
      });

      var selectedCount = models.filter(function (model) { return model.selected; }).length;
      return el("div", { className: "cm-page" },
        el("h2", null, "渠道模型"),
        el("div", { className: "cm-form" },
          el(Field, { label: "Provider ID" }, el("input", { className: "cm-input", value: provider, disabled: !!busy, onChange: function (event) { setProvider(event.target.value); } })),
          el(Field, { label: "显示名称" }, el("input", { className: "cm-input", value: displayName, disabled: !!busy, onChange: function (event) { setDisplayName(event.target.value); } })),
          el(Field, { label: "API 地址", wide: true }, el("input", { className: "cm-input", value: baseURL, disabled: !!busy, onChange: function (event) { setBaseURL(event.target.value); } })),
          el(Field, { label: "API 协议" }, el("select", { className: "cm-input", value: api, disabled: !!busy, onChange: function (event) { setApi(event.target.value); } }, el("option", { value: "openai-completions" }, "OpenAI Chat Completions"), el("option", { value: "openai-responses" }, "OpenAI Responses"), el("option", { value: "anthropic-messages" }, "Anthropic Messages"))),
          el(Field, { label: "测试 API 密钥" }, el("input", { className: "cm-input", type: "password", value: apiKey, autoComplete: "off", disabled: !!busy, onChange: function (event) { setApiKey(event.target.value); } }))
        ),
        el("div", { className: "cm-actions" },
          api === "anthropic-messages" ? el("span", { className: "cm-status" }, "Anthropic Messages 无模型列表接口,请手动添加模型") : null,
          el("button", { className: "cm-button", type: "button", disabled: !!busy || api === "anthropic-messages" || !provider.trim() || !baseURL.trim(), onClick: discover }, busy === "discover" ? "获取中…" : "获取渠道模型"),
          el("input", { className: "cm-input", value: manualId, placeholder: "手动添加模型 ID", disabled: !!busy, onChange: function (event) { setManualId(event.target.value); }, onKeyDown: function (event) { if (event.key === "Enter") addModel(); }, style: { width: 220 } }),
          el("button", { className: "cm-button", type: "button", disabled: !!busy || !manualId.trim(), onClick: addModel }, "添加模型"),
          models.length ? el("button", { className: "cm-button cm-button-create", type: "button", disabled: !!busy || selectedCount === 0, onClick: createChannel }, busy === "create" ? "创建中…" : "新增自定义渠道") : null,
          models.length ? el("span", { className: "cm-status" }, "已选择 " + selectedCount + " / " + models.length) : null
        ),
        notice ? el("div", { className: "cm-note" + (notice.error ? " cm-error" : "") }, notice.text) : null,
        models.length ? el("div", { className: "cm-list" }, rows) : null
      );
    }

    exports.apply = function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      var styleEl = document.createElement("style");
      styleEl.dataset.plugin = "dsh-channel-models";
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
      ctx.effect(function () { return function () { try { styleEl.remove(); } catch (_) {} }; }, "dsh-channel-models: styles");
      slots.inject("settings.section", function () {
        return slots.register({ name: "settings.section", id: "channel-models", order: 11, label: function () { return "渠道模型"; } }, function () { return el(ChannelModelsPage, null); });
      });
    };

    exports.inject = ["slots"];
    return module.exports;
  }
});
