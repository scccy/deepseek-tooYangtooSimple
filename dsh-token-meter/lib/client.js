window.__ModuleLoader__.load({
	id: "dsh-token-meter-scccy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var el = react.createElement;

		var API_SUMMARY = "/api/dsh-tokmeter/summary";
		var API_MONTHS = "/api/dsh-tokmeter/months";

		function postJson(url, body) {
			return fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {})
			}).then(function (res) {
				if (!res.ok) {
					throw new Error("HTTP " + res.status);
				}
				return res.json();
			});
		}

		var CSS = [
			".tm-wrap{display:flex;flex-direction:column;gap:14px;padding:2px 0 24px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:900px;}",
			".tm-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
			".tm-nav{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;}",
			".tm-nav:hover{border-color:var(--dsw-alias-border-l2);}",
			".tm-select{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;font-weight:600;}",
			".tm-unit{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px;}",
			".tm-refresh{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".tm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;}",
			".tm-empty{color:var(--dsw-alias-label-secondary);padding:24px 0;text-align:center;font-size:12px;}",
			".tm-main{display:flex;flex-direction:column;gap:14px;}",
			".tm-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px 16px;}",
			".tm-card-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;}",
			".tm-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0;}",
			".tm-tabs{margin-left:auto;display:flex;gap:4px;}",
			".tm-tab{background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);border-radius:7px;padding:3px 10px;font-size:11px;cursor:pointer;}",
			".tm-tab-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}",
			".tm-legend{display:flex;gap:14px;margin-top:10px;flex-wrap:wrap;}",
			".tm-leg{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);}",
			".tm-dot{width:9px;height:9px;border-radius:3px;display:inline-block;}",
			".tm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px;}",
			".tm-stat-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px;}",
			".tm-stat-num{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);}",
			".tm-stat-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px;font-variant-numeric:tabular-nums;}",
			".tm-day-chart{display:flex;align-items:flex-end;gap:2px;height:160px;padding-top:6px;position:relative;}",
			".tm-day{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%;min-width:0;}",
			".tm-day-stack{width:100%;max-width:16px;display:flex;flex-direction:column;justify-content:flex-end;border-radius:3px;overflow:hidden;height:calc(100% - 16px);}",
			".tm-day:hover .tm-seg{filter:brightness(1.15);}",
			".tm-seg-hit{background:var(--dsw-alias-brand-primary);}",
			".tm-seg-miss{background:var(--dsw-alias-brand-primary);opacity:.32;}",
			".tm-seg-out{background:var(--dsw-alias-state-warn-primary);opacity:.85;}",
			".tm-day-bar{width:100%;max-width:16px;border-radius:3px 3px 0 0;background:var(--dsw-alias-state-success-primary);opacity:.8;}",
			".tm-day-zerobar{width:100%;max-width:16px;height:2px;border-radius:1px;background:var(--dsw-alias-bg-layer-2);}",
			".tm-day:hover .tm-day-bar,.tm-day:hover .tm-day-zerobar{opacity:1;filter:brightness(1.2);}",
			".tm-day-label{font-size:9px;color:var(--dsw-alias-label-secondary);height:12px;line-height:12px;}",
			".tm-hour-chart{display:flex;align-items:flex-end;gap:2px;height:110px;padding-top:6px;}",
			".tm-hour{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%;min-width:0;}",
			".tm-hour-bar{width:100%;max-width:16px;border-radius:2px;background:var(--dsw-alias-state-success-primary);opacity:.75;}",
			".tm-hour:hover .tm-hour-bar{opacity:1;}",
			".tm-hour-label{font-size:9px;color:var(--dsw-alias-label-secondary);height:12px;line-height:12px;}",
			".tm-track{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px;}",
			".tm-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);opacity:.8;}",
			".tm-model-row{margin-bottom:12px;}",
			".tm-model-row:last-child{margin-bottom:0;}",
			".tm-model-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;}",
			".tm-model-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".tm-model-nums{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;}",
			".tm-heat-wrap{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;}",
			".tm-heat-board{display:flex;flex-direction:column;gap:4px;}",
			".tm-heat-weekdays{display:grid;grid-template-columns:repeat(7,22px);gap:4px;}",
			".tm-heat-wd{width:22px;font-size:10px;line-height:1;text-align:center;color:var(--dsw-alias-label-secondary);}",
			".tm-heat-grid{display:grid;grid-template-columns:repeat(7,22px);gap:4px;}",
			".tm-heat-cell{width:22px;height:22px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;font-size:9px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}",
			".tm-heat-cell.tm-heat-empty{border:1px dashed var(--dsw-alias-border-l1);background:transparent;}",
			".tm-heat-1{background:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,var(--dsw-alias-bg-layer-2));}",
			".tm-heat-2{background:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-bg-layer-2));}",
			".tm-heat-3{background:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,var(--dsw-alias-bg-layer-2));}",
			".tm-heat-4{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand);}",
			".tm-heat-legend{display:flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;}",
			".tm-heat-legend .tm-heat-cell{width:10px;height:10px;border-radius:2px;}"
		].join("\n");

		function pad(n) {
			return n < 10 ? "0" + (n | 0) : "" + n;
		}

		function fmt(n, unit) {
			var u = unit || "auto";
			if (u === "tok") return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
			if (u === "k") return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n));
			if (u === "m") return n >= 1000000 ? (n / 1000000).toFixed(2) + "M" : (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n)));
			if (u === "b") return n >= 1000000000 ? (n / 1000000000).toFixed(2) + "B" : (n >= 1000000 ? (n / 1000000).toFixed(2) + "M" : (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n))));
			if (n >= 1000000000) return (n / 1000000000).toFixed(2) + "B";
			if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
			if (n >= 10000) return (n / 1000).toFixed(1) + "K";
			return String(Math.round(n));
		}

		function pct(r) {
			return r === 0 ? "0%" : (r * 100).toFixed(1) + "%";
		}

		function MeterPage() {
			var monthsState = react.useState([]);
			var months = monthsState[0];
			var setMonths = monthsState[1];
			var monthState = react.useState(null);
			var month = monthState[0];
			var setMonth = monthState[1];
			var viewState = react.useState(null);
			var view = viewState[0];
			var setView = viewState[1];
			var errorState = react.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var loadingState = react.useState(false);
			var loading = loadingState[0];
			var setLoading = loadingState[1];
			var unitState = react.useState("auto");
			var unit = unitState[0];
			var setUnit = unitState[1];
			var dayModeState = react.useState("stack");
			var dayMode = dayModeState[0];
			var setDayMode = dayModeState[1];
			var heatModeState = react.useState("usage");
			var heatMode = heatModeState[0];
			var setHeatMode = heatModeState[1];

			react.useEffect(function () {
				var cancelled = false;
				postJson(API_MONTHS).then(function (res) {
					if (cancelled) return;
					var ms = (res && Array.isArray(res.months) ? res.months : []).slice().sort().reverse();
					setMonths(ms);
					if (ms.length > 0) setMonth(ms[0]);
				}, function (err) {
					if (!cancelled) setError("加载月份列表失败: " + String(err && err.message ? err.message : err));
				});
				return function () { cancelled = true; };
			}, []);

			react.useEffect(function () {
				if (month === null) return undefined;
				var cancelled = false;
				setLoading(true);
				postJson(API_SUMMARY, { month: month }).then(function (res) {
					if (cancelled) return;
					setView(res);
					setError(null);
				}, function (err) {
					if (!cancelled) setError(String(err && err.message ? err.message : err));
				}).finally(function () {
					if (!cancelled) setLoading(false);
				});
				return function () { cancelled = true; };
			}, [month]);

			react.useEffect(function () {
				if (month === null) return undefined;
				var timer = setInterval(function () {
					postJson(API_SUMMARY, { month: month }).then(function (res) {
						setView(res);
					}, function (err) {
						setError(String(err && err.message ? err.message : err));
					});
				}, 30000);
				return function () { clearInterval(timer); };
			}, [month]);

			function shiftMonth(delta) {
				if (month === null) return;
				var parts = /^(\d{4})-(\d{2})$/.exec(month);
				if (parts === null) return;
				var d = new Date(Number(parts[1]), Number(parts[2]) - 1 + delta, 1);
				var target = d.getFullYear() + "-" + pad(d.getMonth() + 1);
				if (months.indexOf(target) < 0) {
					var next = months.slice();
					next.push(target);
					next.sort();
					next.reverse();
					setMonths(next);
				}
				setMonth(target);
			}

			var monthOptions = months.map(function (m) {
				return el("option", { key: m, value: m }, m);
			});

			var unitOptions = [
				el("option", { key: "auto", value: "auto" }, "自动"),
				el("option", { key: "tok", value: "tok" }, "tok"),
				el("option", { key: "k", value: "k" }, "K"),
				el("option", { key: "m", value: "m" }, "M"),
				el("option", { key: "b", value: "b" }, "B")
			];

			var statCards = null;
			var dayChart = null;
			var dayLegend = null;
			var heatCells = null;
			var modelRows = null;
			var hourBars = null;

			if (view !== null && view !== undefined && typeof view === "object") {
				var total = view.total || {};
				var daily = Array.isArray(view.days) ? view.days : [];
				var dim = daily.length;
				statCards = [
					el("div", { key: "total", className: "tm-stat" },
						el("div", { className: "tm-stat-label" }, "总使用量"),
						el("div", { className: "tm-stat-num" }, fmt(total.total || 0, unit))),
					el("div", { key: "input", className: "tm-stat" },
						el("div", { className: "tm-stat-label" }, "输入 Prompt"),
						el("div", { className: "tm-stat-num" }, fmt(total.input || 0, unit)),
						(total.cacheHit || total.cacheMiss || 0) > 0
							? el("div", { className: "tm-stat-sub" }, "命中 " + fmt(total.cacheHit || 0, unit) + " · 写入 " + fmt(total.cacheMiss || 0, unit))
							: (total.input || 0) > 0 ? el("div", { className: "tm-stat-sub" }, "暂无缓存数据") : null),
					el("div", { key: "output", className: "tm-stat" },
						el("div", { className: "tm-stat-label" }, "输出 Completion"),
						el("div", { className: "tm-stat-num" }, fmt(total.output || 0, unit))),
					el("div", { key: "cache", className: "tm-stat" },
						el("div", { className: "tm-stat-label" }, "缓存命中率"),
						el("div", { className: "tm-stat-num" }, (total.cacheHit || total.cacheMiss || 0) > 0 ? pct(total.cacheRate || 0) : "—")),
					el("div", { key: "calls", className: "tm-stat" },
						el("div", { className: "tm-stat-label" }, "请求次数"),
						el("div", { className: "tm-stat-num" }, String(total.calls || 0))),
					el("div", { key: "avg", className: "tm-stat" },
						el("div", { className: "tm-stat-label" }, "日均使用"),
						el("div", { className: "tm-stat-num" }, fmt(dim > 0 ? (total.total || 0) / dim : (total.total || 0), unit)))
				];

				var maxDayVal = 1;
				for (var di = 0; di < daily.length; di++) {
					var dv = (daily[di].input || 0) + (daily[di].output || 0);
					if (dv > maxDayVal) maxDayVal = dv;
				}
				if (dayMode === "stack") {
					dayChart = daily.map(function (day) {
						var v = (day.input || 0) + (day.output || 0);
						var hit = (day.cacheHit || 0) > (day.input || 0) ? (day.input || 0) : (day.cacheHit || 0);
						var miss = Math.max(0, (day.input || 0) - hit);
						var outH = Math.max(0, day.output || 0);
						var hHit = v === 0 ? 0 : Math.max(1, Math.round(hit / maxDayVal * 100));
						var hMiss = v === 0 ? 0 : Math.max(1, Math.round(miss / maxDayVal * 100));
						var hOut = v === 0 ? 0 : Math.max(1, Math.round(outH / maxDayVal * 100));
						var dayNum = Number(day.day.slice(8, 10));
						var showLabel = dayNum === 1 || dayNum % 5 === 0 || v > 0;
						var title = day.day + "\n输入 " + fmt(day.input || 0, unit) + "(" + ((day.cacheHit || 0) > 0 ? "缓存命中 " + fmt(day.cacheHit || 0, unit) : "无缓存命中") + ")\n输出 " + fmt(day.output || 0, unit) + "\n" + (day.calls || 0) + " 次请求,命中率 " + pct(day.cacheRate || 0);
						var stack = el("div", { className: "tm-day-stack" },
							hit > 0 ? el("div", { className: "tm-seg tm-seg-hit", style: { height: hHit + "%" } }) : null,
							miss > 0 ? el("div", { className: "tm-seg tm-seg-miss", style: { height: hMiss + "%" } }) : null,
							outH > 0 ? el("div", { className: "tm-seg tm-seg-out", style: { height: hOut + "%" } }) : null);
						return el("div", { key: day.day, className: "tm-day", title: title },
							v > 0 ? stack : el("div", { className: "tm-day-zerobar" }),
							el("div", { className: "tm-day-label" }, showLabel ? String(dayNum) : ""));
					});
					dayLegend = el("div", { className: "tm-legend" },
						el("span", { className: "tm-leg" }, el("i", { className: "tm-dot tm-seg-hit" }), "缓存命中的输入"),
						el("span", { className: "tm-leg" }, el("i", { className: "tm-dot tm-seg-miss" }), "未命中输入"),
						el("span", { className: "tm-leg" }, el("i", { className: "tm-dot tm-seg-out" }), "输出"));
				} else {
					dayChart = daily.map(function (day) {
						var v = (day.input || 0) + (day.output || 0);
						var rate = v > 0 ? (day.cacheRate || 0) : 0;
						var dayNum = Number(day.day.slice(8, 10));
						var showLabel = dayNum === 1 || dayNum % 5 === 0 || v > 0;
						var title = day.day + "\n缓存命中率 " + pct(rate) + "\n命中 " + fmt(day.cacheHit || 0, unit) + " / 未命中 " + fmt(day.cacheMiss || 0, unit) + "\n" + (day.calls || 0) + " 次请求";
						return el("div", { key: day.day, className: "tm-day", title: title },
							el("div", { className: "tm-day-stack" },
								rate > 0 ? el("div", { className: "tm-day-bar", style: { height: rate * 100 + "%" } }) : el("div", { className: "tm-day-zerobar" })),
							el("div", { className: "tm-day-label" }, showLabel ? String(dayNum) : ""));
					});
					dayLegend = el("div", { className: "tm-legend" },
						el("span", { className: "tm-leg" }, el("i", { className: "tm-dot tm-day-bar" }), "当日缓存命中率"));
				}

				var models = Array.isArray(view.models) ? view.models : [];
				var maxModelVal = 1;
				for (var mi = 0; mi < models.length; mi++) {
					var mv = (models[mi].input || 0) + (models[mi].output || 0);
					if (mv > maxModelVal) maxModelVal = mv;
				}
				modelRows = models.length === 0
					? [el("div", { key: "empty", className: "tm-empty" }, "本月暂无模型用量数据")]
					: models.map(function (m2) {
						var v = (m2.input || 0) + (m2.output || 0);
						var widthPct = Math.round(v / maxModelVal * 100);
						return el("div", { key: m2.model, className: "tm-model-row" },
							el("div", { className: "tm-model-head" },
								el("span", { className: "tm-model-name", title: m2.model }, m2.model),
								el("span", { className: "tm-model-nums" },
									"入 " + fmt(m2.input || 0, unit) + " · 出 " + fmt(m2.output || 0, unit) + " · 缓存 " + pct(m2.cacheRate || 0) + " · " + (m2.calls || 0) + " 次 · " + widthPct + "%")),
							el("div", { className: "tm-track" },
								el("div", { className: "tm-fill", style: { width: widthPct + "%" } })));
					});

				var hours2 = Array.isArray(view.hours) ? view.hours : [];
				var maxHourVal = 1;
				for (var hi = 0; hi < hours2.length; hi++) {
					var hv = (hours2[hi].input || 0) + (hours2[hi].output || 0);
					if (hv > maxHourVal) maxHourVal = hv;
				}
				hourBars = hours2.map(function (h2) {
					var v = (h2.input || 0) + (h2.output || 0);
					var height = v === 0 ? 0 : Math.max(5, Math.round(v / maxHourVal * 100));
					var showLabel = h2.hour % 4 === 0;
					return el("div", { key: "h" + h2.hour, className: "tm-hour", title: h2.hour + ":00 ~ " + (h2.hour + 1) + ":00\n输入 " + fmt(h2.input || 0, unit) + " · 输出 " + fmt(h2.output || 0, unit) + " · " + (h2.calls || 0) + " 次请求" },
						el("div", { className: "tm-hour-bar", style: { height: height + "%" } }),
						el("div", { className: "tm-hour-label" }, showLabel ? String(h2.hour) + "h" : ""));
				});

				// ---- 每日用量热点图 (GitHub-contribution style, one month) ----
				var heatVal = function (d) {
					if (heatMode === "calls") return d.calls || 0;
					if (heatMode === "rate") return ((d.input || 0) + (d.output || 0)) > 0 ? (d.cacheRate || 0) : 0;
					return (d.input || 0) + (d.output || 0);
				};
				var heatName = heatMode === "calls" ? "请求次数" : (heatMode === "rate" ? "缓存命中率" : "总用量");
				var hm = /^(\d{4})-(\d{2})$/.exec(month || "");
				if (hm !== null && daily.length > 0) {
					var firstDow = new Date(Number(hm[1]), Number(hm[2]) - 1, 1).getDay();
					var off = (firstDow + 6) % 7; // 周一为列 0
					var activeVals = [];
					for (var avi = 0; avi < daily.length; avi++) {
						var av = heatVal(daily[avi]);
						if (av > 0) activeVals.push(av);
					}
					var hmax = 1;
					for (var avi2 = 0; avi2 < activeVals.length; avi2++) {
						if (activeVals[avi2] > hmax) hmax = activeVals[avi2];
					}
					var weeks = [];
					var wk = [];
					for (var p = 0; p < off + daily.length; p++) {
						if (p % 7 === 0 && p > 0) { weeks.push(wk); wk = []; }
						var di = p - off;
						if (di < 0 || di >= daily.length) {
							wk.push(null);
						} else {
							var dRow = daily[di];
							var vv = heatVal(dRow);
							var lvl = vv === 0 ? 0 : Math.min(4, 1 + Math.floor(vv / hmax * 3.99));
							var t = dRow.day +
								"\n" + heatName + " " + (heatMode === "rate" ? pct(vv) : fmt(vv, unit)) +
								"\n输入 " + fmt(dRow.input || 0, unit) + " · 输出 " + fmt(dRow.output || 0, unit) +
								"\n" + (dRow.calls || 0) + " 次请求 · 缓存率 " + pct(dRow.cacheRate || 0);
							wk.push({ level: lvl, num: di + 1, title: t });
						}
					}
					if (wk.length > 0) weeks.push(wk);
					var heatRows = weeks.map(function (w2, wi) {
						var cells = [];
						for (var c = 0; c < 7; c++) {
							var cell = w2[c];
							cells.push(cell === null || cell === undefined
								? el("div", { key: "e" + wi + "-" + c, className: "tm-heat-cell tm-heat-empty" })
								: el("div", { key: "c" + wi + "-" + c, className: "tm-heat-cell tm-heat-" + cell.level, title: cell.title }, String(cell.num)));
						}
						return el("div", { key: "w" + wi, className: "tm-heat-grid" }, cells);
					});
					var wdHeader = ["一", "二", "三", "四", "五", "六", "日"].map(function (w) {
						return el("div", { key: w, className: "tm-heat-wd" }, w);
					});
					var legendCells = [0, 1, 2, 3, 4].map(function (lv) {
						return el("i", { key: "l" + lv, className: "tm-heat-cell tm-heat-" + lv });
					});
					heatCells = el("div", { className: "tm-heat-wrap" },
						el("div", { className: "tm-heat-board" },
							el("div", { className: "tm-heat-weekdays" }, wdHeader),
							heatRows),
						el("div", { className: "tm-heat-legend" }, "少", legendCells, "多"),
						activeVals.length === 0 ? el("div", { className: "tm-empty" }, "本月暂无 " + heatName + " 数据") : null);
				}
			}

			return el("div", { className: "tm-wrap" },
				el("div", { className: "tm-header" },
					el("button", { className: "tm-nav", onClick: function () { shiftMonth(-1); }, title: "上一月" }, "◀"),
					el("select", {
						className: "tm-select",
						value: month === null ? "" : month,
						onChange: function (event) { setMonth(event.target.value); }
					}, monthOptions),
					el("button", { className: "tm-nav", onClick: function () { shiftMonth(1); }, title: "下一月" }, "▶"),
					el("span", { className: "tm-refresh" }, error !== null ? "加载出错" : (loading ? "加载中…" : "每 30 秒自动刷新")),
					el("span", { className: "tm-unit" }, "单位",
						el("select", { className: "tm-select", value: unit, onChange: function (event) { setUnit(event.target.value); } }, unitOptions))),
				error !== null ? el("div", { className: "tm-error" }, error) : null,
				view === null ? el("div", { className: "tm-empty" }, error === null ? "正在加载…" : null) : null,
				view !== null ? el("div", { className: "tm-main" },
					el("div", { className: "tm-card" },
						el("div", { className: "tm-card-title" }, "月度总览"),
						el("div", { className: "tm-stats" }, statCards)),
					el("div", { className: "tm-card" },
						el("div", { className: "tm-card-head" },
							el("div", { className: "tm-card-title" }, "每日使用量"),
							el("div", { className: "tm-tabs" },
								el("button", { className: "tm-tab" + (dayMode === "stack" ? " tm-tab-on" : ""), onClick: function () { setDayMode("stack"); } }, "用量堆叠"),
								el("button", { className: "tm-tab" + (dayMode === "rate" ? " tm-tab-on" : ""), onClick: function () { setDayMode("rate"); } }, "缓存命中率"))),
						el("div", { className: "tm-day-chart" }, dayChart),
						dayLegend),
					el("div", { className: "tm-card" },
						el("div", { className: "tm-card-head" },
							el("div", { className: "tm-card-title" }, "每日用量热点图"),
							el("div", { className: "tm-tabs" },
								el("button", { className: "tm-tab" + (heatMode === "usage" ? " tm-tab-on" : ""), onClick: function () { setHeatMode("usage"); } }, "用量"),
								el("button", { className: "tm-tab" + (heatMode === "calls" ? " tm-tab-on" : ""), onClick: function () { setHeatMode("calls"); } }, "次数"),
								el("button", { className: "tm-tab" + (heatMode === "rate" ? " tm-tab-on" : ""), onClick: function () { setHeatMode("rate"); } }, "缓存率"))),
						heatCells),
					el("div", { className: "tm-card" },
						el("div", { className: "tm-card-title" }, "按模型分布"),
						el("div", { className: "tm-models" }, modelRows)),
					el("div", { className: "tm-card" },
						el("div", { className: "tm-card-title" }, "按小时时段分布"),
						el("div", { className: "tm-hour-chart" }, hourBars)))
					: null);
		}

		exports.apply = function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === undefined) return;

			var styleEl = document.createElement("style");
			styleEl.dataset.plugin = "dsh-token-meter-scccy";
			styleEl.textContent = CSS;
			document.head.appendChild(styleEl);
			ctx.effect(function () {
				return function () {
					try { styleEl.remove(); } catch (ignore) { /* ignore */ }
				};
			}, "dsh-token-meter-scccy: styles");

			slots.inject("settings.section", function () {
				return slots.register(
					{ name: "settings.section", id: "token-meter-scccy", order: 12, label: function () { return "Token 用量"; } },
					function (props) { return el(MeterPage, null); }
				);
			});
		};

		exports.inject = ["slots"];

		return module.exports;
	}
});