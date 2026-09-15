// Desktop settings client bundle renderer.
//
// The "设置 → 通用" rows (版本 / 更新 / 通知管控 / 诊断与修复) ship as a tiny
// client module written into the active profile's node_modules at boot. It used
// to be a 400-line template string inside sidecar.mjs; keeping it as a plain
// module makes it editable without fighting backtick indentation.
// Keep the generated output byte-identical across moves (ABOUT_BUNDLE_REVISION).
export function renderAboutClient(versionJson) {
  const ABOUT_PACKAGE = '@dsh-desktop/desktop-about';
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(ABOUT_PACKAGE)},
  factory: (require) => {
    let react = require("react");
    var module = { exports: {} };
    var exports = module.exports;
    var VERSION = ${versionJson};
    var inject = ["slots"];
    var rowStyle = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 0",
      borderBottom: "1px solid var(--dsw-alias-border-l2)"
    };
    var titleStyle = {
      color: "var(--dsw-alias-label-primary)",
      fontSize: "14px",
      lineHeight: "22px"
    };
    var valueStyle = {
      color: "var(--dsw-alias-label-secondary)",
      fontVariantNumeric: "tabular-nums",
      fontSize: "14px",
      lineHeight: "22px"
    };
    var textWrapStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minWidth: 0,
      paddingRight: "16px"
    };
    var hintStyle = {
      color: "var(--dsw-alias-label-secondary)",
      fontSize: "12px",
      lineHeight: "18px",
      whiteSpace: "pre-wrap"
    };
    var buttonBaseStyle = {
      flexShrink: 0,
      marginLeft: "16px",
      padding: "5px 14px",
      borderRadius: "8px",
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-2)",
      color: "var(--dsw-alias-label-primary)",
      fontSize: "13px",
      lineHeight: "20px"
    };
    function buttonStyle(busy) {
      return Object.assign({}, buttonBaseStyle, {
        cursor: busy ? "progress" : "pointer",
        opacity: busy ? 0.55 : 1
      });
    }
    function invokeNative(cmd, args) {
      var api = window.__TAURI__;
      if (api === undefined || api.core === undefined || typeof api.core.invoke !== "function") {
        return Promise.reject(new Error("desktop bridge unavailable"));
      }
      return api.core.invoke(cmd, args || {});
    }
    function listenNative(event, handler) {
      var api = window.__TAURI__;
      if (api !== undefined && api.event !== undefined && typeof api.event.listen === "function") {
        return api.event.listen(event, handler);
      }
      return Promise.resolve(function () {});
    }
    function VersionRow() {
      return react.createElement("div", { style: rowStyle },
        react.createElement("div", { style: titleStyle }, "桌面版版本 / Desktop version"),
        react.createElement("div", { style: valueStyle }, "v" + VERSION)
      );
    }
    function DshUpdateRow() {
      var infoState = react.useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var checkingState = react.useState(false);
      var checking = checkingState[0];
      var setChecking = checkingState[1];
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var tailState = react.useState([]);
      var tail = tailState[0];
      var setTail = tailState[1];
      var statusState = react.useState("");
      var status = statusState[0];
      var setStatus = statusState[1];

      function refresh(force) {
        if (checking) return;
        setChecking(true);
        invokeNative("shell_check_update", { force: force === true }).then(function (result) {
          setInfo(result && typeof result === "object" ? result : {});
        }, function (error) {
          setInfo({ error: error && error.message ? error.message : String(error) });
        }).finally(function () {
          setChecking(false);
        });
      }
      react.useEffect(function () {
        refresh(false);
      }, []);

      react.useEffect(function () {
        var unlisten = null;
        var active = true;
        listenNative("dsh:update-progress", function (event) {
          if (!active) return;
          var payload = event && event.payload ? event.payload : {};
          if (payload.phase === "done") {
            setBusy(false);
            setStatus(payload.line ? String(payload.line) : "更新完成");
          } else if (payload.phase === "error") {
            setBusy(false);
            setStatus("失败：" + (payload.line ? String(payload.line) : "未知错误"));
          } else {
            setBusy(true);
            if (payload.line) {
              var line = String(payload.line);
              setTail(function (prev) {
                var next = prev.concat([line]);
                if (next.length > 4) next = next.slice(next.length - 4);
                return next;
              });
            }
          }
        }).then(function (fn) {
          unlisten = fn;
          if (!active && typeof fn === "function") fn();
        });
        return function () {
          active = false;
          if (unlisten && typeof unlisten === "function") unlisten();
        };
      }, []);

      function onUpdate() {
        if (busy) return;
        setBusy(true);
        setStatus("");
        setTail([]);
        invokeNative("shell_dsh_update").then(function () {
          // progress arrives via dsh:update-progress; the host then restarts.
        }, function (error) {
          setBusy(false);
          setStatus("失败：" + (error && error.message ? error.message : String(error)));
        });
      }

      var localLabel = info && info.localVersion ? "v" + info.localVersion : (checking ? "检测中…" : "未读取");
      var latestLabel = info && info.latestVersion ? "v" + info.latestVersion : "—";
      var versionStatus = "";
      if (info && info.error) {
        versionStatus = String(info.error);
      } else if (info && info.updateAvailable) {
        versionStatus = "发现新版本，可更新";
      } else if (info && info.localVersion && info.latestVersion) {
        versionStatus = "已是最新";
      }
      var versionLine = "本地 " + localLabel;
      if (info && info.latestVersion) {
        versionLine = versionLine + " · 仓库 " + latestLabel;
      }
      if (versionStatus) {
        versionLine = versionLine + " · " + versionStatus;
      }

      var actionLine = status;
      if (!actionLine && tail.length > 0) {
        actionLine = tail.join(" · ");
      }

      var buttonsStyle = {
        flexShrink: 0,
        marginLeft: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        alignItems: "stretch"
      };
      return react.createElement("div", { style: Object.assign({}, rowStyle, { alignItems: "flex-start" }) },
        react.createElement("div", { style: textWrapStyle },
          react.createElement("div", { style: titleStyle }, "dsh 版本与更新 / DSH version & update"),
          react.createElement("div", { style: hintStyle }, versionLine),
          actionLine ? react.createElement("div", { style: hintStyle }, actionLine) : null
        ),
        react.createElement("div", { style: buttonsStyle },
          react.createElement("button", {
            style: buttonStyle(busy),
            disabled: busy,
            onClick: onUpdate
          }, busy ? "更新中…" : "更新 dsh"),
          react.createElement("button", {
            style: buttonStyle(checking),
            disabled: checking,
            onClick: function () { refresh(true); }
          }, checking ? "检测中…" : "检测更新")
        )
      );
    }
    function DiagnosticsRepairRow() {
      var dataState = react.useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var expandedState = react.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var copyState = react.useState("复制");
      var copy = copyState[0];
      var setCopy = copyState[1];
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var messageState = react.useState("");
      var message = messageState[0];
      var setMessage = messageState[1];
      function refresh() {
        invokeNative("shell_diagnostics").then(function (raw) {
          try {
            setData(typeof raw === "string" ? JSON.parse(raw) : raw);
          } catch (e) {
            setData({ error: String(e) });
          }
        }, function (error) {
          setData({ error: error && error.message ? error.message : String(error) });
        });
      }
      react.useEffect(function () { refresh(); }, []);
      function summary() {
        if (!data) return "读取中…";
        var parts = ["主机就绪：" + (data.ready === true ? "是" : data.ready === false ? "否" : "未知")];
        if (data.stage) parts.push("阶段：" + data.stage);
        if (data.error) parts.push("错误：" + data.error);
        return parts.join(" · ");
      }
      function startRestart() {
        if (busy) return;
        setBusy(true);
        setMessage("正在请求热重启…");
        invokeNative("shell_hot_restart").then(function () {
          setMessage("主机正在重启，页面将在准备好后自动重载。");
        }, function (error) {
          setBusy(false);
          setMessage("热重启失败：" + (error && error.message ? error.message : String(error)));
        });
      }
      function startReset() {
        if (busy) return;
        if (!window.confirm("重置会重建桌面站点资源（www）并重启本机主机；不会删除会话、插件或设置。继续？")) return;
        setBusy(true);
        setMessage("正在重置…");
        invokeNative("shell_reset_runtime").then(function () {
          setMessage("重置完成，主机正在重启，页面将在准备好后自动重载。");
        }, function (error) {
          setBusy(false);
          setMessage("重置失败：" + (error && error.message ? error.message : String(error)));
        });
      }
      function detailText() {
        return JSON.stringify(data, null, 2);
      }
      function onCopy() {
        var text = detailText();
        var p = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error("clipboard unavailable"));
        p.then(function () {
          setCopy("已复制");
          setTimeout(function () { setCopy("复制"); }, 1600);
        }, function () { setCopy("复制失败"); });
      }
      var preStyle = {
        width: "100%", maxHeight: "240px", overflow: "auto", margin: "0",
        padding: "10px", border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "8px", background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-secondary)", fontSize: "12px",
        lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-all"
      };
      var dangerBorder = { borderColor: "var(--dsw-alias-border-danger, #c96a6a)" };
      var hint = message.length > 0 ? message : summary();
      return react.createElement("div", { style: Object.assign({}, rowStyle, { alignItems: "flex-start", flexDirection: "column" }) },
        react.createElement("div", { style: { display: "flex", width: "100%", alignItems: "flex-start", justifyContent: "space-between" } },
          react.createElement("div", { style: textWrapStyle },
            react.createElement("div", { style: titleStyle }, "诊断与修复 / Diagnostics & repair"),
            react.createElement("div", { style: hintStyle }, hint)
          ),
          react.createElement("div", { style: { display: "flex", flexShrink: 0, marginLeft: "16px", gap: "8px" } },
            react.createElement("button", { style: buttonStyle(false), onClick: function () { setExpanded(!expanded); } }, expanded ? "收起" : "详情"),
            react.createElement("button", { style: buttonStyle(busy), disabled: busy, onClick: startRestart }, "热重启"),
            react.createElement("button", { style: Object.assign({}, buttonStyle(busy), dangerBorder), disabled: busy, onClick: startReset }, "重置并修复")
          )
        ),
        expanded ? react.createElement("pre", { style: preStyle }, detailText()) : null,
        expanded ? react.createElement("div", { style: { display: "flex", marginTop: "8px", gap: "8px" } },
          react.createElement("button", { style: buttonStyle(false), onClick: refresh }, "刷新"),
          react.createElement("button", { style: buttonStyle(false), onClick: onCopy }, copy)
        ) : null
      );
    }

    function NotificationsRow() {
      var prefsState = react.useState(null);
      var prefs = prefsState[0];
      var setPrefs = prefsState[1];
      function load() {
        invokeNative("shell_get_notify_prefs").then(function (raw) {
          try {
            setPrefs(typeof raw === "string" ? JSON.parse(raw) : raw);
          } catch (e) {
            setPrefs(null);
          }
        }, function () { setPrefs(null); });
      }
      react.useEffect(function () { load(); }, []);
      function onToggle(key, value) {
        if (prefs === null || prefs === undefined) return;
        var next = Object.assign({}, prefs);
        next[key] = value;
        setPrefs(next);
        invokeNative("shell_set_notify_prefs", { prefs: JSON.stringify(next) }).catch(function () { load(); });
      }
      var items = [
        ["turn_end", "完成对话", "用户发起的对话回复已就绪时"],
        ["turn_failure", "会话失败", "对话回复出错或超限时"],
        ["approval", "需要审批", "工具请求执行权限时"],
        ["error", "会话错误", "会话运行出错时"],
        ["plugin", "插件批准", "动态插件请求批准时"]
      ];
      function toggleStyle(on, muted) {
        return {
          flexShrink: 0,
          minWidth: "44px",
          padding: "2px 10px",
          borderRadius: "999px",
          border: "1px solid " + (on ? "var(--dsw-alias-accent, #4f7cff)" : "var(--dsw-alias-border-l2)"),
          background: on ? "var(--dsw-alias-accent, #4f7cff)" : "transparent",
          color: on ? "#f4f6ff" : "var(--dsw-alias-label-secondary)",
          fontSize: "12px",
          lineHeight: "18px",
          cursor: muted ? "default" : "pointer",
          opacity: muted ? 0.45 : 1
        };
      }
      var subRowStyle = {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", minHeight: "30px", gap: "8px"
      };
      var subTextStyle = {
        display: "flex", flexDirection: "column", minWidth: 0, paddingRight: "16px"
      };
      var subLabelStyle = {
        color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px"
      };
      var subHintStyle = {
        color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px"
      };
      var ready = !(prefs === null || prefs === undefined);
      var globalOn = ready && prefs.enabled === true;
      return react.createElement("div", { style: Object.assign({}, rowStyle, { alignItems: "flex-start", flexDirection: "column" }) },
        react.createElement("div", { style: { display: "flex", width: "100%", alignItems: "flex-start", justifyContent: "space-between" } },
          react.createElement("div", { style: textWrapStyle },
            react.createElement("div", { style: titleStyle }, "通知管控 / Notifications"),
            react.createElement("div", { style: hintStyle }, "选择哪些事项弹出系统通知，关闭总开关则全部静默")
          )
        ),
        react.createElement("div", { style: subRowStyle },
          react.createElement("div", { style: subTextStyle },
            react.createElement("div", { style: subLabelStyle }, "通知总开关"),
            react.createElement("div", { style: subHintStyle }, "关闭后所有系统通知都不会弹出")
          ),
          react.createElement("button", { style: toggleStyle(globalOn, false), onClick: function () { onToggle("enabled", !globalOn); } }, globalOn ? "开" : "关")
        ),
        (ready ? items : []).map(function (item) {
          var key = item[0];
          var label = item[1];
          var subHint = item[2];
          var on = prefs[key] === true;
          return react.createElement("div", { key: key, style: Object.assign({}, subRowStyle, { paddingLeft: "16px" }) },
            react.createElement("div", { style: subTextStyle },
              react.createElement("div", { style: subLabelStyle }, label),
              react.createElement("div", { style: subHintStyle }, subHint)
            ),
            react.createElement("button", {
              style: toggleStyle(on, !globalOn),
              disabled: !globalOn,
              onClick: function () { onToggle(key, !on); }
            }, on ? "开" : "关")
          );
        })
      );
    }
    function apply(ctx) {
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-version",
        order: 900
      }, VersionRow));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-dsh-update",
        order: 910
      }, DshUpdateRow));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-notifications",
        order: 930
      }, NotificationsRow));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-repair",
        order: 950
      }, DiagnosticsRepairRow));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.name = ${JSON.stringify(ABOUT_PACKAGE)};
    return module.exports;
  }
});
`;
}
