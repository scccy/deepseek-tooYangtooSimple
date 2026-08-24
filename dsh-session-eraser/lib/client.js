window.__ModuleLoader__.load({
	id: "dsh-session-eraser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		var DELETE_API = "/api/dsh-sesdel/delete";

		function requestDelete(sessionId) {
			return fetch(DELETE_API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId })
			}).then(function (res) {
				return res.json().catch(function () {
					throw new Error("服务响应异常 (HTTP " + res.status + ")");
				}).then(function (body) {
					if (!res.ok) throw new Error(body !== null && typeof body === "object" && typeof body.message === "string" ? body.message : "HTTP " + res.status);
					return body;
				});
			});
		}

		var CSS = [
			".sdr-clear { padding: 2px 8px; border-radius: 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8b949e); font-size: 14px; cursor: pointer; }",
			".sdr-clear:hover { color: var(--dsw-alias-label-primary, inherit); }",
			".sdr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); z-index: 1000; }",
			".sdr-panel { position: absolute; left: 12px; top: 12px; bottom: 12px; width: 344px; display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay, var(--dsw-specific-sidebar-fill, #1e1e24)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.35); overflow: hidden; }",
			".sdr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 8px; }",
			".sdr-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }",
			".sdr-hint { padding: 0 14px 8px; color: var(--dsw-alias-label-secondary, #8b949e); font-size: 12px; }",
			".sdr-hint b { color: var(--dsw-alias-state-error-primary, #e5484d); }",
			".sdr-error { margin: 0 14px 10px; border: 1px solid var(--dsw-alias-state-error-primary, #e5484d); background: rgba(229,72,77,.08); color: var(--dsw-alias-state-error-primary, #e5484d); font-size: 12px; padding: 7px 9px; border-radius: 6px; line-height: 1.45; }",
			".sdr-list { flex: 1; overflow-y: auto; }",
			".sdr-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12)); cursor: default; }",
			".sdr-row-idle:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }",
			".sdr-row-confirm { background: rgba(229,72,77,.10); }",
			".sdr-main { flex: 1; min-width: 0; }",
			".sdr-name { font-size: 13px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, inherit); }",
			".sdr-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #8b949e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
			".sdr-sub .sdr-running { color: var(--dsw-alias-state-warn-primary, #d29922); }",
			".sdr-act { flex: none; }",
			".sdr-btn { border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); color: inherit; padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }",
			".sdr-btn:disabled { opacity: .45; cursor: not-allowed; }",
			".sdr-btn-danger { border-color: var(--dsw-alias-state-error-primary, #e5484d); background: rgba(229,72,77,.12); color: var(--dsw-alias-state-error-primary, #e5484d); }",
			".sdr-head-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; white-space: nowrap; }",
			".sdr-head-btn:hover { border-color: var(--dsw-alias-border-l1, rgba(128,128,128,.5)); }",
			".sdr-head-btn:disabled { opacity: .45; cursor: not-allowed; }",
			".sdr-head-btn-danger { border-color: var(--dsw-alias-state-error-primary, #e5484d); background: rgba(229,72,77,.12); color: var(--dsw-alias-state-error-primary, #e5484d); }",
			".sdr-empty { color: var(--dsw-alias-label-secondary, #8b949e); font-size: 13px; padding: 20px 14px; }",
			".sdr-foot-btn { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8b949e); font-size: 13px; cursor: pointer; padding: 6px 8px; border-radius: 6px; }",
			".sdr-foot-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); }"
		].join("\n");

		function basenameOf(path) {
			if (typeof path !== "string") return "";
			var parts = path.split(/[\\/]+/).filter(function (part) { return part.length > 0; });
			return parts.length > 0 ? parts[parts.length - 1] : "";
		}

		function refreshSharedList() {
			if (ctxSessions === undefined) return;
			if (typeof ctxSessions.refresh === "function") {
				try {
					var p = ctxSessions.refresh();
					if (p !== null && p !== undefined && typeof p.catch === "function") p.catch(function () { /* ignore */ });
				} catch (error) { /* ignore */ }
			}
		}

		function SessionEraserDock(props) {
			var useSessions = props.useSessions;
			var sessionsState = typeof useSessions === "function" ? useSessions(function (state) { return state; }) : null;
			var currentId = sessionsState !== null && typeof sessionsState === "object" && typeof sessionsState.current === "string" ? sessionsState.current : null;
			var openState = react.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var confirmState = react.useState(null);
			var confirmId = confirmState[0];
			var setConfirmId = confirmState[1];
			var busyState = react.useState(null);
			var busyId = busyState[0];
			var setBusyId = busyState[1];
			var errorState = react.useState("");
			var error = errorState[0];
			var setError = errorState[1];
			var removedState = react.useState({});
			var removed = removedState[0];
			var setRemoved = removedState[1];

			var rows = [];
			if (sessionsState !== null && typeof sessionsState === "object") {
				var byId = sessionsState.byId === undefined ? {} : sessionsState.byId;
				var ids = Array.isArray(sessionsState.ids) ? sessionsState.ids : [];
				for (var i = 0; i < ids.length; i++) {
					var summary = byId[ids[i]];
					if (summary === undefined) continue;
					if (removed[ids[i]] === true) continue;
					if (summary.blank === true) continue;
					if (summary.origin === "subagent") continue;
					rows.push({
						id: String(ids[i]),
						title: typeof summary.displayTitle === "string" ? summary.displayTitle : String(ids[i]),
						cwd: typeof summary.cwd === "string" ? summary.cwd : "",
						running: summary.running === true
					});
				}
			}

			function performDelete(id) {
				setBusyId(id);
				setError("");
				requestDelete(id).then(function (result) {
					if (result !== null && typeof result === "object" && result.ok === true) {
						var warnings = Array.isArray(result.warnings) ? result.warnings : [];
						if (result.terminatedLive === true && warnings.length === 0) setError("已结束运行中的会话,并已删除。");
						else if (warnings.length > 0) setError("已删除,但有警告:" + warnings.join(" | "));
						else setError("");
						setRemoved(function (current) { var next = Object.assign({}, current); next[id] = true; return next; });
						if (currentId === id && ctxSessions !== undefined && typeof ctxSessions.clear === "function") {
							try { ctxSessions.clear(); } catch (error) { /* ignore */ }
						}
						// Sync the shared sidebar list: the host removed the log, but the
						// rendered list would otherwise keep the stale row until reconnect.
						refreshSharedList();
					} else {
						setError(result !== null && typeof result === "object" && typeof result.message === "string" ? result.message : "删除失败");
					}
				}, function (deleteError) {
					setError("删除失败:" + String(deleteError && deleteError.message ? deleteError.message : deleteError));
				}).finally(function () {
					setBusyId(null);
					setConfirmId(null);
				});
			}

			function onRowClick(row) {
				if (busyId !== null) return;
				if (confirmId === row.id) performDelete(row.id);
				else setConfirmId(row.id);
			}

			return react.createElement(react.Fragment, null,
				react.createElement("button", {
					className: "sdr-foot-btn",
					title: "结束并删除会话",
					onClick: function () { setError(""); setOpen(!open); }
				},
					react.createElement("span", null, "🗑"),
					react.createElement("span", null, "删除会话")
				),
				!open ? null : react.createElement("div", {
					className: "sdr-backdrop",
					onClick: function () { setOpen(false); setConfirmId(null); setError(""); }
				},
					react.createElement("div", { className: "sdr-panel", onClick: function (event) { event.stopPropagation(); } },
						react.createElement("div", { className: "sdr-head" },
							react.createElement("div", { className: "sdr-title" }, "删除会话"),
							react.createElement("button", { className: "sdr-clear", onClick: function () { setOpen(false); setConfirmId(null); setError(""); } }, "✕")
						),
						react.createElement("div", { className: "sdr-hint" },
							"点一下行把它标记,",
							react.createElement("b", null, "再点一次"),
							"结束并永久删除。列表含全部工作区,子会话与空白会话不显示。"
						),
						error.length > 0 ? react.createElement("div", { className: "sdr-error" }, error) : null,
						rows.length === 0
							? react.createElement("div", { className: "sdr-empty" }, "没有可删除的会话。")
							: react.createElement("div", { className: "sdr-list" },
								rows.map(function (row) {
									var subBits = [];
									var base = basenameOf(row.cwd);
									if (base.length > 0) subBits.push(base);
									if (row.running) subBits.push("运行中");
									return react.createElement("div", {
										key: row.id,
										className: "sdr-row" + (confirmId === row.id ? " sdr-row-confirm" : " sdr-row-idle"),
										onClick: function () { onRowClick(row); },
										title: confirmId === row.id ? "再次点击以结束并删除" : "点击标记删除"
									},
										react.createElement("div", { className: "sdr-main" },
											react.createElement("div", { className: "sdr-name" }, row.title),
											react.createElement("div", { className: "sdr-sub" },
												subBits.length === 0 ? null : subBits.map(function (bit, bi) {
													return react.createElement("span", { key: bi }, bi > 0 ? " · " : null, bit === "运行中" ? react.createElement("span", { className: "sdr-running" }, bit) : bit);
												})
											)
										),
										confirmId === row.id
											? react.createElement("span", { style: { color: "var(--dsw-alias-state-error-primary, #e5484d)", fontSize: 11, whiteSpace: "nowrap" } }, busyId === row.id ? "处理中…" : "再点一次执行")
											: null,
										react.createElement("div", { className: "sdr-act" },
											react.createElement("button", {
												className: "sdr-btn" + (confirmId === row.id ? " sdr-btn-danger" : ""),
												onClick: function (event) { event.stopPropagation(); onRowClick(row); },
												disabled: busyId !== null
											}, confirmId === row.id ? (busyId === row.id ? "处理中…" : "确认结束删除") : "删除")
										)
									);
								})
							)
					)
				)
			);
		}

		function SessionHeaderDeleteButton(props) {
			var sessionId = props !== null && typeof props === "object" && typeof props.sessionId === "string" ? props.sessionId : "";
			var confirmState = react.useState(false);
			var confirming = confirmState[0];
			var setConfirming = confirmState[1];
			var busyState = react.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			function onClick() {
				if (busy || sessionId.length === 0) return;
				if (!confirming) { setConfirming(true); return; }
				setBusy(true);
				var target = sessionId;
				requestDelete(target).then(function (result) {
					if (result !== null && typeof result === "object" && result.ok === true) {
						setConfirming(false);
						if (ctxSessions !== undefined && typeof ctxSessions.clear === "function") {
							try { ctxSessions.clear(); } catch (error) { /* ignore */ }
						}
						refreshSharedList();
					} else if (confirming) {
						setConfirming(false);
						if (typeof globalThis.alert === "function") globalThis.alert("删除失败:" + (result !== null && typeof result === "object" && typeof result.message === "string" ? result.message : "未知错误"));
					}
				}, function (deleteError) {
					if (typeof globalThis.alert === "function") globalThis.alert("删除失败:" + String(deleteError && deleteError.message ? deleteError.message : deleteError));
				}).finally(function () {
					setBusy(false);
				});
			}

			if (sessionId.length === 0) return null;
			return react.createElement("button", {
				type: "button",
				className: "sdr-head-btn" + (confirming ? " sdr-head-btn-danger" : ""),
				title: confirming ? "再次点击以结束并删除当前会话" : "删除当前会话",
				onClick: onClick,
				disabled: busy
			}, busy ? "删除中…" : (confirming ? "确认删除?" : "删除会话"));
		}

		var ctxSessions;

		exports.apply = function apply(ctx) {
			ctxSessions = ctx.get("sessions");
			var slots = ctx.get("slots");
			if (slots === undefined) return;

			// Bridge for the patched native session-row menu.
			globalThis.__SesdelBridge = { requestDelete: requestDelete };

			// Drain the pending delete queue the menu accumulated while the bridge was absent.
			try {
				var raw = globalThis.localStorage.getItem("__sesdelPending");
				if (raw !== null && raw.length > 0) {
					var pending = JSON.parse(raw);
					if (Array.isArray(pending)) {
						globalThis.localStorage.removeItem("__sesdelPending");
						for (var p = 0; p < pending.length; p++) {
							if (typeof pending[p] === "string" && pending[p].length > 0) requestDelete(pending[p]);
						}
					}
				}
			} catch (ignore) { /* ignore */ }

			// Styles.
			var styleEl = document.createElement("style");
			styleEl.dataset.plugin = "dsh-session-eraser";
			styleEl.textContent = CSS;
			document.head.appendChild(styleEl);
			ctx.effect(function () {
				return function () {
					try { styleEl.remove(); } catch (ignore) { /* ignore */ }
				};
			}, "dsh-session-eraser: styles");

			slots.inject("sidebar.footer.action", function () {
				return slots.register(
					{ name: "sidebar.footer.action", id: "session-eraser-action", order: 10, label: function () { return "删除会话"; } },
					function (props) { return react.createElement(SessionEraserDock, props); }
				);
			});

			// Plugin-native "delete current session" action in the session header,
			// registered through the official `conversation.session.header.actions`
			// slot so it survives DSH upgrades (unlike a patched row menu).
			slots.inject("conversation.session.header.actions", function () {
				return slots.register(
					{ name: "conversation.session.header.actions", id: "session-eraser-delete", order: 30, label: function () { return "删除会话"; } },
					function (props) { return react.createElement(SessionHeaderDeleteButton, props); }
				);
			});
		};

		exports.inject = ["sessions", "slots"];

		return module.exports;
	}
});