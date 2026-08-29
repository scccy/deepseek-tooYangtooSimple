// PlaceGame VIP 收菜客户端 v2.4 —— 前端控制（无构建，走 window.__TAURI__）
const invoke = (cmd, args = {}) => {
  const api = window.__TAURI__ && window.__TAURI__.core;
  if (!api) return Promise.reject(new Error("Tauri 桥接不可用"));
  return api.invoke(cmd, args);
};
const $ = (id) => document.getElementById(id);
let accounts = [];
let statusCache = null;
let runsCache = [];
let setCache = new Map(); // 地图套装进度（get_set_progress）
let wbSessionFilter = ""; // 世界boss 查看场次筛选（""=当前场次；"10"/"16"/"20"=今日该窗口）
const selected = new Set(); // 账号页批量选择

// 北京日期（与后端 run_key 同口径）
function beijingToday() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

// HTML 转义：所有插入 innerHTML 的服务端文本（昵称/物品/装备/公会名/日志详情等）
// 必须经过这里——否则恶意昵称/物品名可注入 DOM（存储型 XSS），并借 __TAURI__ 调用任意后端命令
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 节流 toast：后台轮询类错误最多每 ms 秒报一次，避免 3s 一轮刷屏
const toastThrottleMap = {};
function toastThrottle(key, msg, ms = 30000) {
  const now = Date.now();
  if (toastThrottleMap[key] && now - toastThrottleMap[key] < ms) return;
  toastThrottleMap[key] = now;
  toast(msg, "error");
}

// 自绘确认弹窗（window.confirm 在 Tauri webview 中被静默拦截返回 false，全部改走这里）
let confirmResolve = null;
function confirmModal(msg) {
  return new Promise((resolve) => {
    $("confirm-modal").style.display = "flex";
    $("confirm-text").textContent = msg;
    confirmResolve = resolve;
  });
}
function closeConfirm(val) {
  $("confirm-modal").style.display = "none";
  if (confirmResolve) { confirmResolve(val); confirmResolve = null; }
}

// ---------------- Toast ----------------
function toast(msg, type = "info") {
  const box = $("toast-container");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------------- Hash 路由 ----------------
let current = "dashboard";
function route() {
  const h = (location.hash || "#dashboard").replace("#", "");
  current = ["dashboard", "accounts", "guild", "worldboss", "equipment", "decompose", "logs", "settings"].includes(h) ? h : "dashboard";
  document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
  const page = $("page-" + current);
  if (page) page.style.display = "block";
  document.querySelectorAll("#sidebar a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === current);
  });
  if (current === "dashboard") loadTabSettings("dashboard");
  if (current === "accounts") loadTabSettings("accounts");
  if (current === "settings") loadSettings();
  if (current === "guild") { refreshGuild(); loadTabSettings("guild"); }
  if (current === "worldboss") { refreshWorldBoss(); loadSoloBosses(); loadTabSettings("worldboss"); }
  if (current === "equipment") { loadEquip(); loadReforge(); loadTabSettings("equipment"); }
  if (current === "decompose") { loadDecomposeTiers(); loadTabSettings("decompose"); }
  if (current === "logs") refreshRuns(true);
}
window.addEventListener("hashchange", route);

// ---------------- 日志状态分析（账号今日状态/错误共用） ----------------
function runAnalysis() {
  const today = beijingToday();
  const collectDone = new Set();
  const donateDone = new Set();
  const failedAcc = new Set();
  let mainCollect = null, mainApprove = null, mainDividend = null, mainGrowth = null;
  for (const r of runsCache) {
    if (r.status === "failed") failedAcc.add(r.account_id);
    if (!r.run_key.includes(today)) continue;
    if (r.status !== "ok") continue;
    if (r.task === "collect" && r.run_key.startsWith("daily:")) collectDone.add(r.account_id);
    if (r.task === "donate") donateDone.add(r.account_id);
  }
  return { collectDone, donateDone, failedAcc, mainCollect, mainApprove, mainDividend, mainGrowth };
}

// ---------------- 总览 ----------------
async function refreshDashboard(st) {
  $("s-mains").textContent = st.accounts.filter((a) => a.role === "main").length;
  $("s-alts").textContent = st.accounts.filter((a) => a.role === "alt").length;
  $("s-joined").textContent = st.accounts.filter((a) => a.role === "alt" && a.phase === "joined").length;
  renderBrackets(); // 战力/收益评分分布（收菜时缓存，纯本地聚合）

  // 大号状态卡 + 今日完成度
  const ana = runAnalysis();
  const mains = st.accounts.filter((a) => a.role === "main");
  const mainId = mains.length ? mains[0].id : null;
  $("ms-collect").innerHTML = mainId && ana.collectDone.has(mainId)
    ? '<span class="status-ok">✓ 今日已收</span>' : '<span style="color:var(--c-warn)">⏳ 待收菜</span>';
  $("ms-next").textContent = "挂机由服务器自动累积，点「一键收菜」手动领取";
  $("ms-guild").textContent = st.main_guild_id ? "入会一次性完成，每日只分红" : "未建会";
  const growthOn = st.opts && st.opts.growth_enabled;
  $("ms-growth").textContent = growthOn ? "已开启" : "未开启（设置页可开）";

  renderDailyStats(); // 完整今日任务完成度（签到/活跃/首领/街机/副职业/入会/捐献…）

  let latest = "", tickTime = "";
  try {
    const j = st.latest ? JSON.parse(st.latest) : null;
    latest = j ? j.items.join("\n") : "（暂无输出）";
    if (j && j.tick) tickTime = new Date(j.tick).toLocaleTimeString();
  } catch { latest = st.latest || ""; }
  $("latest").textContent = latest || "（暂无输出）";
  $("latest-time").textContent = tickTime;
}

// 战力/收益评分分布直方图（数据 = 收菜时缓存的 alt_power / alt_revenue）
async function renderBrackets() {
  try {
    const s = await invoke("get_bracket_stats");
    const total = s.total || 1;
    const fmt = (n) => n >= 10000 ? (n / 10000).toFixed(1) + "w" : String(n);
    const bar = (b) => {
      const pct = Math.round((b.count / total) * 100);
      return `<div class="prog-row"><span>${fmt(b.min)}${b.max > 0 ? " - " + fmt(b.max) : "+"}</span>
        <span>${b.count} 号</span><div class="prog-bar"><i class="${b.count ? "" : "empty"}" style="width:${pct}%"></i></div></div>`;
    };
    $("power-brackets").innerHTML = (s.power || []).map(bar).join("")
      || `<span class="hint">暂无战力数据（跑一轮「一键收菜」后更新）</span>`;
    $("revenue-brackets").innerHTML = (s.revenue || []).map((b) => {
      const pct = Math.round((b.count / total) * 100);
      return `<div class="prog-row"><span>${b.min} - ${b.min + 200} 分</span>
        <span>${b.count} 号</span><div class="prog-bar"><i class="${b.count ? "" : "empty"}" style="width:${pct}%"></i></div></div>`;
    }).join("") || `<span class="hint">暂无收益评分数据（${s.n_power || 0} 号）</span>`;
  } catch (e) { toastThrottle("brackets", "战力分布读取失败：" + e, 60000); }
}

// 今日任务完成度：由后端 get_daily_stats 本地聚合（签到/活跃/首领/街机/副职业/捐献）
// 注：练级+入会+装备捐仓均为条件触发的一次性/按需动作，非每日任务，故不在每日列表
// （账号页「批量入会」可手动入会；公会页「装备捐献一轮」按评分门槛条件捐仓）
async function renderDailyStats() {
  try {
    const s = await invoke("get_daily_stats");
    const rows = [
      ["collect", "每日收菜", s.collect, s.total],
      ["sign_in", "每日签到", s.sign_in, s.total],
      ["daily_claim", "每日活跃宝箱", s.daily_claim, s.total],
      ["boss_solo", "个人/地图首领", s.boss_solo, s.total],
      ["world", "世界首领", s.boss_world, s.total],
      ["arcade", "街机免费轮", s.arcade, s.total],
      ["prof", "副职业循环", s.prof, s.total],
      ["donate", "材料捐献", s.donate, s.alts],
      ["lottery", "大乐透", s.lottery, s.total],
    ];
    $("daily-progress").innerHTML = rows.map(([key, label, ok, total]) => {
      const pct = total ? Math.round((ok / total) * 100) : 0;
      const full = total && ok >= total;
      const pending = Math.max(0, (total || 0) - ok);
      const cont = pending > 0
        ? `<button class="tiny" data-btask="${key}" data-btask-pending="1" data-pending-n="${pending}" title="继续：只执行今日尚未完成的 ${pending} 个账号">⏭ 继续</button>`
        : "";
      return `<div class="prog-row"><span>${label}</span>
        <span class="${ok === 0 ? "dim" : ""} ${full ? "status-ok" : ""}">${ok}/${total}</span>
        <button class="tiny" data-btask="${key}" title="立即批量执行（全部账号）">▶</button>${cont}</div>
        <div class="prog-bar"><i class="${full ? "full" : ""}" style="width:${pct}%"></i></div>`;
    }).join("") || "<p class='hint'>暂无数据</p>";
    document.querySelectorAll("#daily-progress [data-btask]").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        const t = b.dataset.btask;
        const onlyPending = b.hasAttribute("data-btask-pending");
        const pendingN = parseInt(b.dataset.pendingN || "0", 10);
        try {
          const out = await invoke("run_task_batch", { task: t, only_pending: onlyPending });
          const ok = (out || []).filter((x) => x.r && !String(x.r).startsWith("失败")).length;
          const err = (out || []).filter((x) => x.r && String(x.r).startsWith("失败")).length;
          const skip = onlyPending && pendingN > 0 ? `，跳过 ${pendingN} 个已完成` : "";
          toast(`${onlyPending ? "补收" : "批量执行"}「${t}」：成功 ${ok} 号${err ? `，失败 ${err}` : ""}${skip}`, err ? "error" : "ok");
        } catch (e) {
          toast(String(e), "error");
        }
        b.disabled = false;
        refresh();
      };
    });
  } catch (e) { toastThrottle("dailystats", "今日完成度读取失败：" + e, 60000); }
}

// ---------------- 分解模板（按地图 9 档） ----------------
let dtData = null;
async function loadDecomposeTiers() {
  try {
    dtData = await invoke("get_decompose_tiers");
  } catch (e) {
    dtData = null;
    toast("读取分解模板失败：" + e, "error");
  }
  renderDecomposeTiers();
}
function renderDecomposeTiers() {
  const tb = $("dt-tbody");
  if (!tb) return;
  tb.innerHTML = (dtData || []).map((t, i) => `<tr>
      <td><b>${t.label}</b><span class="hint"> ${t.min_level}级起 · ${t.map_key}</span></td>
      <td><select id="dt-q-${i}">${QUALITIES.map(([k, n]) => `<option value="${k}" ${t.max_quality === k ? "selected" : ""}>${n}</option>`).join("")}</select></td>
      <td><input id="dt-s-${i}" type="number" min="0" value="${t.keep_score_above}" /></td>
      <td style="text-align:center"><input id="dt-r-${i}" type="checkbox" ${t.keep_rare_affixes ? "checked" : ""} /></td>
      <td><input id="dt-l-${i}" type="number" min="1" value="${t.max_level}" /></td>
    </tr>`).join("") || "<tr><td colspan=5 class='empty'>暂无模板（点保存生成默认 9 档）</td></tr>";
}
async function saveDecomposeTiers() {
  const arr = (dtData || []).map((t, i) => ({
    ...t,
    max_quality: $("dt-q-" + i).value,
    keep_score_above: Number($("dt-s-" + i).value) || 0,
    keep_rare_affixes: $("dt-r-" + i).checked,
    max_level: Number($("dt-l-" + i).value) || 999,
  }));
  try {
    await invoke("save_decompose_tiers", { tiers: arr });
    toast("分解模板已保存", "ok");
    refresh();
  } catch (e) {
    toast("保存失败：" + e, "error");
  }
}

// ---------------- 账号 ----------------
function phaseLabel(p) { const m = { "": "未初始化", init: "练级中", ready: "待入会", joined: "已入会" }; return m[p] || p || "-"; }

async function refreshAccounts() {
  try {
    accounts = await invoke("list_accounts");
    try {
      const sp = await invoke("get_set_progress");
      setCache = new Map((sp || []).map((x) => [x.account_id, x]));
    } catch (e) { toastThrottle("setprogress", "套装进度读取失败：" + e, 60000); }
    if (current === "accounts") renderAccounts();
  } catch (e) { toastThrottle("accounts", "读取账号失败：" + e, 30000); }
}

function renderAccounts() {
  const q = ($("acc-search")?.value || "").trim().toLowerCase();
  const pf = $("acc-phase-filter")?.value || "";
  const errOnly = $("acc-err-only")?.checked || false;
  const sel = $("acc-phase-filter");
  if (sel && sel.options.length <= 1) {
    ["", "init", "ready", "joined"].forEach((p) => {
      const o = document.createElement("option");
      o.value = p; o.textContent = p ? phaseLabel(p) : "全部阶段";
      sel.appendChild(o);
    });
  }
  const ana = runAnalysis();
  const tb = $("acc-table").querySelector("tbody");
  const rows = accounts
    .filter((a) => !q || String(a.id).includes(q) || (a.nickname || "").toLowerCase().includes(q) || a.username.toLowerCase().includes(q))
    .filter((a) => !pf || a.phase === pf)
    .filter((a) => !errOnly || ana.failedAcc.has(a.id));
  tb.innerHTML = rows
    .map((a) => {
      const lv = a.level && a.level !== "" && a.level !== "0" ? `Lv.${a.level}` : (a.role === "main" ? "-" : "Lv.1");
      const isTrial = a.username.startsWith("guest_");
      const typeTag = isTrial ? '<span class="tag">试玩</span>' : '<span class="tag ok">正式</span>';
      const promoteBtn = isTrial && a.role !== "main" ? `<button data-act="promote" data-id="${a.id}">转正</button>` : "";
      const errCls = ana.failedAcc.has(a.id) ? ' class="row-err"' : "";
      const collectMark = ana.collectDone.has(a.id) ? '<span class="status-ok">✓</span>' : "—";
      const donateMark = ana.donateDone.has(a.id) ? '<span class="status-ok">✓</span>' : "—";
      const setInfo = setCache.get(a.id);
      const setMark = setInfo && setInfo.n > 0
        ? (() => {
            const q = setInfo.quality === "white" ? "普通" : setInfo.quality === "green" ? "优秀" : setInfo.quality === "blue" ? "精良" : setInfo.quality === "purple" ? "稀有" : setInfo.quality === "orange" ? "史诗" : setInfo.quality === "red" ? "传说" : "神话";
            return `<span class="status-ok" title="${esc(setInfo.map_name)} 套装（${q}·${esc(setInfo.rareness)}）">${esc(setInfo.map_name)} ${setInfo.n}/${setInfo.total}</span>`;
          })()
        : "—";
      return `<tr${errCls}>
        <td><input type="checkbox" class="acc-check" data-id="${a.id}" ${selected.has(a.id) ? "checked" : ""} /></td>
        <td>${a.id}</td>
        <td>${a.role === "main" ? "👑 大号" : "小号"}</td>
        <td>${esc(a.nickname || a.username)} ${typeTag}</td>
        <td>${esc(a.job)}</td>
        <td>${lv}</td>
        <td>${a.role === "main" ? "—" : phaseLabel(a.phase)}</td>
        <td>${collectMark}</td>
        <td>${donateMark}</td>
        <td>${setMark}</td>
        <td>${a.enabled ? "✅" : "⛔"}</td>
        <td class="row-actions">
          <button data-act="collect" data-id="${a.id}">收菜</button>
          <button data-act="direct" data-id="${a.id}">🚀 直登网页</button>
          ${promoteBtn}
          <button data-act="toggle" data-id="${a.id}" data-on="${a.enabled ? 0 : 1}">${a.enabled ? "停用" : "启用"}</button>
          <button data-act="del" data-id="${a.id}">删除</button>
        </td>
      </tr>`;
    })
    .join("") || "<tr><td colspan=12 class='empty'>无匹配账号</td></tr>";
  // 勾选
  tb.querySelectorAll(".acc-check").forEach((c) => {
    c.onchange = () => {
      const id = Number(c.dataset.id);
      c.checked ? selected.add(id) : selected.delete(id);
      renderBatchBar();
    };
  });
  tb.querySelectorAll("button[data-act]").forEach((b) => {
    b.onclick = async () => {
      const id = Number(b.dataset.id);
      b.disabled = true; // 防连点并发（收菜/直登等）
      try {
        if (b.dataset.act === "toggle") await invoke("set_enabled", { id, enabled: b.dataset.on === "1" });
        else if (b.dataset.act === "del") { if (await confirmModal("确认删除账号 " + id + "？此操作不可恢复。")) await invoke("remove_account", { id }); }
        else if (b.dataset.act === "collect") {
          b.textContent = "收菜中…";
          const r = await invoke("run_collect", { accountId: id, withDaily: true });
          toast("收菜 #" + id + "：" + r, "ok");
        }
        else if (b.dataset.act === "direct") {
          try {
            await invoke("open_web_direct", { accountId: id });
            toast("已在游戏网页自动登录（免复制密码）", "ok");
          } catch (e) {
            // 直登失败兜底：打开默认浏览器 + 弹出凭证复制窗口
            toast("自动登录失败，已转到浏览器并弹出凭证：" + e, "error");
            const r = await invoke("open_web_login", { accountId: id });
            $("cred-user").value = r.username;
            $("cred-pass").value = r.password;
            $("cred-modal").style.display = "flex";
          }
        }
        else if (b.dataset.act === "promote") {
          const uname = prompt("新账号名（留空自动生成）", "");
          const pw = prompt("新密码（留空自动生成，建议≥6位）", "");
          const r = await invoke("promote_guest", { accountId: id, username: uname || "", password: pw || "" });
          await copyToClipboard(`账号：${r.username}\n密码：${r.password}`);
          toast(`已转正为正式账户：${r.username}（密码已复制）`, "ok");
        }
        refresh();
      } catch (e) { toast(String(e), "error"); refresh(); }
      finally { b.disabled = false; }
    };
  });
  renderBatchBar();
}

function renderBatchBar() {
  const bar = $("batch-bar");
  bar.classList.toggle("show", selected.size > 0);
  $("batch-count").textContent = `已选 ${selected.size} 个`;
}

async function batchOp(op) {
  const ids = [...selected];
  if (!ids.length) return;
  if (op === "del" && !(await confirmModal(`确认删除 ${ids.length} 个账号？此操作不可恢复。`))) return;
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      if (op === "enable") await invoke("set_enabled", { id, enabled: true });
      else if (op === "disable") await invoke("set_enabled", { id, enabled: false });
      else if (op === "del") { await invoke("remove_account", { id }); selected.delete(id); }
      else if (op === "collect") await invoke("run_collect", { accountId: id, withDaily: true });
      ok++;
    } catch (e) { fail++; }
  }
  toast(`批量${{ enable: "启用", disable: "停用", del: "删除", collect: "收菜" }[op]}：成功 ${ok}${fail ? `，失败 ${fail}` : ""}`, fail ? "error" : "ok");
  refresh();
}

// ---------------- 公会 ----------------
async function refreshGuild() {
  if (current !== "guild") return;
  try {
    const info = await invoke("get_guild_info");
    const g = info.guild || {};
    const el = $("guild-info");
    if (info.joined) {
      const apps = (g.applications || []).length;
      el.innerHTML = `公会：<b>${esc(g.name || "?")}</b> · ID ${g.guildId} · Lv.${g.level} · 成员 ${g.memberCount}/${g.memberLimit} · 资金 ${g.fundGold}<br>
      免审核${g.requiresApproval ? "关" : "开"} · 装备仓库 ${g.equipmentStorageLimit || 80}格 · 入库最低品质 ${esc(g.equipmentDonationMinQuality || "purple")} · <b>待审批申请 ${apps} 个</b>`;
      $("btn-approve-all").textContent = apps > 0 ? `✅ 批量审批入会（${apps}）` : "✅ 批量审批入会";
      document.getElementById("wb-note") && ($("wb-note").textContent = "");
      $("btn-create-guild").style.display = "none";
      document.querySelector(".guild-create-form").style.display = "none";
    } else {
      el.textContent = "主号尚未加入公会——游戏内已建的会自动识别（点刷新），或点上方「创建公会」。";
      $("btn-create-guild").style.display = "";
      document.querySelector(".guild-create-form").style.display = "grid";
    }
    const dm = info.donate_materials || { ok: 0, total: 0 };
    const de = info.donate_equip || { ok: 0, total: 0 };
    $("donate-mat-ok").textContent = dm.ok;
    $("donate-mat-total").textContent = dm.total;
    $("donate-eq-ok").textContent = de.ok;
    $("donate-eq-total").textContent = de.total;
    renderRequests(g.materialRequests || []);
    const sup = g.supplies || [];
    const selKey = $("req-key");
    if (sup.length) {
      selKey.innerHTML = '<option value="">请选择物资…</option>' + sup
        .map((s) => `<option value="${esc(s.itemKey)}" ${s.unlocked ? "" : "disabled"}>${esc(s.name)}${s.unlocked ? "" : "（未解锁 Lv." + s.unlockGuildLevel + "）"}</option>`)
        .join("");
    } else {
      selKey.innerHTML = '<option value="">暂无已解锁补给（公会等级提升后出现）</option>';
    }
    const inv = await invoke("get_alt_inventories");
    renderInv(inv || []);
  } catch (e) {
    $("guild-info").textContent = "读取失败：" + e;
  }
}

function renderRequests(reqs) {
  const tb = $("req-table").querySelector("tbody");
  tb.innerHTML = reqs
    .map((r) => {
      const id = r.id || r.requestId || "";
      const key = r.itemKey || r.item_key || r.name || "?";
      const amount = r.amount ?? "";
      const status = r.status || r.transformStatus || "";
      const ful = id ? `<button data-fulfill="${esc(id)}" data-key="${esc(key)}">补充</button>` : "-";
      return `<tr><td>${esc(key)}</td><td>${esc(String(amount))}</td><td>${esc(status)}</td><td>${ful}</td></tr>`;
    })
    .join("") || "<tr><td colspan=4 class='empty'>暂无需求</td></tr>";
  tb.querySelectorAll("button[data-fulfill]").forEach((b) => {
    b.onclick = async () => {
      const amt = prompt(`补充物资 "${b.dataset.key}" 数量（消耗公会资金）`, "10");
      if (!amt) return;
      try {
        await invoke("fulfill_request", { requestId: b.dataset.fulfill, amount: parseInt(amt, 10) });
        toast("已补充", "ok");
        refreshGuild();
      } catch (e) {
        toast(String(e), "error");
      }
    };
  });
}

function renderInv(list) {
  const agg = {};
  const TYPE_CN = { material: "材料", skill_book: "技能书", consumable: "消耗品", special: "特殊物品", equipment: "装备" };
  for (const r of list) {
    if (r.bind_status !== "unbound") continue;
    const k = r.item_key;
    agg[k] = agg[k] || { key: k, name: r.item_name || k, type: r.item_type, amount: 0, users: new Set() };
    agg[k].amount += r.amount;
    agg[k].users.add(r.username || "?");
  }
  const tb = $("inv-table").querySelector("tbody");
  tb.innerHTML = Object.values(agg)
    .map((v) => `<tr><td>${v.users.size} 个小号</td><td><b>${esc(v.name)}</b> <span class="inv-key">${esc(v.key)}</span></td><td>${esc(TYPE_CN[v.type] || v.type)}</td><td>${v.amount}</td><td>未绑定</td></tr>`)
    .join("") || "<tr><td colspan=5 class='empty'>暂无未绑定材料快照（每次收菜后自动写入）</td></tr>";
}

// ---------------- 世界boss ----------------
async function refreshWorldBoss() {
  if (current !== "worldboss") return;
  try {
    const s = await invoke("get_world_boss_stats", { session: wbSessionFilter || null });
    const win = s.window_active;
    $("wb-window").textContent = win ? "● 场次进行中" : "○ 场次外待机";
    $("wb-window").className = "badge" + (win ? " on" : "");
    $("wb-session").textContent = `查看场次：${s.session || "-"}`;
    // 场次筛选 = 查看筛选（选某场次看它的参与结果；自动参与场次在设置页控制，默认全开）
    const sel = $("wb-session-filter");
    if (sel) {
      sel.value = wbSessionFilter;
      if (!sel._bound) {
        sel._bound = true;
        sel.onchange = () => {
          wbSessionFilter = sel.value;
          refreshWorldBoss();
        };
      }
    }
    const note = win
      ? "场次进行中：全员（含大号）自动参与；统计来自本地参与记录。点「立即参与一轮」可手动补一轮。"
      : "当前不在开放时段（10-11 / 16-17 / 20-21 北京时）。开放时后台自动参与（含大号），本页刷新可见进度。";
    $("wb-note").textContent = note;
    const tb = $("wb-table").querySelector("tbody");
    tb.innerHTML = (s.bosses || []).map((b) => {
      const status = b.status === "active" ? '<span class="status-ok">进行中</span>' : `<span class="dim">${esc(b.status || "未开放")}</span>`;
      const eligible = b.eligible ?? 0;        // 等级达标账号数（含大号）
      const canP = Math.max(0, eligible - (b.participated ?? 0)); // 未参与人数（互补口径）
      const part = b.participated ?? 0;        // 已参与人数（含大号）
      const left = b.left_times ?? 0;          // 剩余可参与次数
      const doneT = b.done_times ?? 0;         // 已参与总次数
      const total = b.total || 0;
      const pct = eligible ? Math.round((part / eligible) * 100) : 0;
      const done = eligible > 0 && part >= eligible;
      return `<tr>
        <td><b>${esc(b.name)}</b> <span class="inv-key">${esc(b.key)}</span></td>
        <td>Lv.${b.requiredLevel} <span class="dim">达标${eligible}/${total}</span></td>
        <td>${status}</td>
        <td><b>${canP}</b> <span class="dim">人未参与</span></td>
        <td><b>${part}</b> <span class="dim">/ ${eligible} 人（含大号）</span></td>
        <td><b>${left}</b> <span class="dim">次</span><br><span class="dim">已用 ${doneT} 次</span></td>
        <td class="prog-cell">
          <div class="prog-bar"><i class="${done ? "full" : ""}" style="width:${pct}%"></i></div>
          <span class="dim">${pct}% 已参与/达标</span>
        </td>
      </tr>`;
    }).join("") || "<tr><td colspan=8 class='empty'>暂无数据</td></tr>";
  } catch (e) {
    toast("世界boss 统计加载失败：" + e, "error");
  }
}

// ---------------- 个人/地图首领统计（Boss统计页，与世界boss同页） ----------------
async function loadSoloBosses() {
  if (current !== "worldboss") return;
  const tb = $("solo-table");
  if (!tb) return;
  try {
    const s = await invoke("get_solo_boss_stats");
    $("solo-day").textContent = `统计日：${s.day || "-"}`;
    const typeLabel = (t) => (t === "personal" ? "个人" : "地图");
    tb.querySelector("tbody").innerHTML = (s.bosses || []).map((b) => {
      const freeTxt = b.free > 0 ? `剩余 ${b.free} 次` : `今日已用完`;
      return `<tr>
        <td><b>${esc(b.name)}</b> <span class="inv-key">${esc(b.key)}</span></td>
        <td>${typeLabel(b.type)}</td>
        <td>${esc(b.map || "-")}</td>
        <td>${b.requiredPower || "-"}</td>
        <td>${b.diff_count} 档</td>
        <td>${esc(b.highest_diff || "-")}</td>
        <td><b>${b.kills}</b> <span class="dim">击杀</span></td>
        <td>${b.accounts} 号</td>
        <td class="dim">${freeTxt}</td>
      </tr>`;
    }).join("") || "<tr><td colspan=9 class='empty'>暂无数据（首领列表来自主号样本；今天还没打过就全 0）</td></tr>";
  } catch (e) {
    toast("个人/地图首领统计加载失败：" + e, "error");
  }
}

// ---------------- 装备洗练（独立 tab，对官网洗练界面） ----------------
let reforgeCache = null;   // 后端 get_reforge_state 返回
let rfSelectedSlot = null; // 当前选中部位
let rfLocked = new Set();  // 选中装备上要锁定的词条 key
let rfBusy = false;        // 连续洗练中

const RF_QUALITY_COLOR = {
  white: "q-white", green: "q-green", blue: "q-blue", purple: "q-purple",
  orange: "q-orange", red: "q-red", gold: "q-gold",
};
const RF_STAT_LABEL = {
  hp: "生命", attack: "攻击", magicAttack: "魔攻", summonAttack: "召唤",
  defense: "防御", magicDefense: "魔防", hit: "命中", dodge: "闪避",
  crit: "暴击", critDamage: "爆伤", attackSpeed: "攻速", luck: "幸运",
  expBonus: "经验", goldBonus: "金币", dropBonus: "爆率", rareDropBonus: "极品掉率",
  bossDropBonus: "首领掉落", lifesteal: "吸血", bossDamage: "首领伤害", idleEfficiency: "挂机效率",
};
const rfStatLabel = (k) => RF_STAT_LABEL[k] || k;
const rfSlotLabel = (s) => (reforgeCache?.slotCatalog || []).find(([k]) => k === s)?.[1] || s;
const rfEquipOf = (slot) => (reforgeCache?.equipment || []).find((e) => e.slot === slot && e.status === "equipped") || null;
const rfCurrent = () => (rfSelectedSlot ? rfEquipOf(rfSelectedSlot) : null);

async function loadReforge() {
  try {
    reforgeCache = await invoke("get_reforge_state");
    $("rf-empty").style.display = (reforgeCache.equipment || []).length ? "none" : "";
    $("rf-gold").textContent = reforgeCache.gold ?? "-";
    $("rf-rare").textContent = reforgeCache.rareCoin ?? "-";
    renderReforgeSlots();
    renderReforgeDetail();
  } catch (e) {
    $("rf-hint").textContent = "读取失败：" + e;
    toast("读取装备失败：" + e, "error");
  }
}

function renderReforgeSlots() {
  const wrap = $("rf-slots");
  const cat = reforgeCache?.slotCatalog || [];
  wrap.innerHTML = cat
    .map(([slot, label]) => {
      const eq = rfEquipOf(slot);
      const sel = rfSelectedSlot === slot ? " sel" : "";
      if (!eq) return `<div class="rf-slot empty${sel}" data-slot="${esc(slot)}"><b>${esc(label)}</b><span class="rf-slot-sub">空</span></div>`;
      const qc = RF_QUALITY_COLOR[eq.quality] || "q-white";
      return `<div class="rf-slot${sel}" data-slot="${esc(slot)}">
        <b>${esc(label)}</b>
        <span class="rf-slot-name ${qc}">${esc(eq.name || "（未命名）")}</span>
        <span class="rf-slot-sub">+${eq.enhanceLevel} · Lv.${eq.level}${eq.locked ? " · 🔒" : ""}</span>
      </div>`;
    })
    .join("");
  wrap.querySelectorAll(".rf-slot").forEach((el) => {
    el.onclick = () => {
      rfSelectedSlot = el.dataset.slot;
      rfLocked = new Set(); // 换装备重置锁定选择
      renderReforgeSlots();
      renderReforgeDetail();
    };
  });
}

function renderReforgeDetail() {
  const box = $("rf-detail");
  const eq = rfCurrent();
  if (!eq) {
    box.innerHTML = `<div class="empty">${rfSelectedSlot ? "该部位暂无已穿戴装备" : "← 点选左侧一件装备开始洗练"}</div>`;
    return;
  }
  const qc = RF_QUALITY_COLOR[eq.quality] || "q-white";
  const affixRows = (eq.affixes || [])
    .map((a) => {
      const on = rfLocked.has(a.key);
      const val = a.value === null || a.value === undefined ? "" : ` <b>${esc(String(a.value))}</b>`;
      return `<label class="rf-affix${on ? " on" : ""}">
        <input type="checkbox" data-affix="${esc(a.key)}" ${on ? "checked" : ""} />
        <span class="rf-affix-name">${esc(rfStatLabel(a.key))}</span>${val}
        <span class="rf-affix-lock">${on ? "🔒" : ""}</span>
      </label>`;
    })
    .join("") || '<div class="empty">该装备暂无洗练词条</div>';
  const statOpts = (reforgeCache?.statCatalog || [])
    .map(([k, n]) => `<option value="${esc(k)}">${esc(n)}（${esc(k)}）</option>`)
    .join("");
  box.innerHTML = `
    <div class="rf-head">
      <span class="rf-name ${qc}">${esc(eq.name || "（未命名）")}</span>
      <span class="badge">${esc(rfSlotLabel(eq.slot))}</span>
      <span class="badge">+${eq.enhanceLevel}</span>
      <span class="badge">Lv.${eq.level}</span>
      <span class="badge">评分 ${eq.score}</span>
      <span class="badge">${eq.bindStatus === "unbound" ? "未绑定" : "已绑定"}</span>
      <button id="rf-toggle-lock">${eq.locked ? "🔓 解锁装备" : "🔒 锁定装备"}</button>
    </div>
    <div class="rf-sub">当前洗练词条（勾选 = 洗练时锁定保留）</div>
    <div class="rf-affixes">${affixRows}</div>
    <div class="rf-controls">
      <label class="rf-target">目标词条保底
        <select id="rf-target">${statOpts}</select>
      </label>
      <button id="btn-rf-preview">🔍 预览</button>
      <button id="btn-rf-once" class="primary">⚒️ 洗练一次</button>
      <button id="btn-rf-auto">🔁 连续洗至目标</button>
      <button id="btn-rf-stop" class="danger" style="display:none">⏹ 停止</button>
    </div>
    <pre id="rf-result" class="rf-result"></pre>`;

  // 目标词条默认：已锁定词条之外，优先暴击类
  const target = $("rf-target");
  const prefer = ["crit", "critDamage", "bossDamage", "attack"].find((k) => !rfLocked.has(k));
  if (prefer) target.value = prefer;

  box.querySelectorAll("input[data-affix]").forEach((c) => {
    c.onchange = () => {
      c.checked ? rfLocked.add(c.dataset.affix) : rfLocked.delete(c.dataset.affix);
      renderReforgeDetail();
    };
  });
  $("rf-toggle-lock").onclick = async () => {
    try {
      await invoke("equipment_toggle_lock", { equipmentId: eq.id });
      toast(eq.locked ? "已解锁装备" : "已锁定装备", "ok");
      await loadReforge();
    } catch (e) { toast(String(e), "error"); }
  };
  $("btn-rf-preview").onclick = () => rfDo("preview");
  $("btn-rf-once").onclick = () => rfDo("once");
  $("btn-rf-auto").onclick = rfAuto;
  $("btn-rf-stop").onclick = () => { rfBusy = false; };
}

// 提取 preview/exec 返回里的可读摘要（字段未实测，多候选 + 兜底 JSON）
function rfSummarize(v) {
  const d = (v && (v.data !== undefined ? v.data : v)) || {};
  let cost = null;
  for (const k of ["goldCost", "cost", "costGold", "gold", "price"]) {
    if (typeof d[k] === "number") { cost = d[k]; break; }
  }
  let lines = [];
  if (cost !== null) lines.push(`预计消耗金币：${cost}`);
  // 尝试列出结果词条
  const cand = d.affixes || d.reforgeStats || d.result || d.newStats;
  if (Array.isArray(cand) && cand.length) {
    const txt = cand.map((s) => (typeof s === "string" ? rfStatLabel(s) : rfStatLabel(s.key || s.stat || "?") + (s.value !== undefined ? " " + s.value : ""))).join("、");
    lines.push("词条：" + txt);
  }
  lines.push("", JSON.stringify(d, null, 2));
  return lines.join("\n");
}

async function rfDo(mode) {
  const eq = rfCurrent();
  if (!eq) return;
  const target = $("rf-target").value;
  const lockedStats = [...rfLocked];
  const cmd = mode === "preview" ? "reforge_preview" : "reforge_exec";
  const btn = mode === "preview" ? $("btn-rf-preview") : $("btn-rf-once");
  try {
    btn.disabled = true;
    const r = await invoke(cmd, { equipmentId: eq.id, lockedStats, targetStat: target });
    $("rf-result").textContent = (mode === "preview" ? "【预览】\n" : "【洗练结果】\n") + rfSummarize(r);
    if (mode === "once") {
      toast("洗练完成", "ok");
      await loadReforge();
    }
  } catch (e) {
    $("rf-result").textContent = "失败：" + e;
    toast(String(e), "error");
  } finally {
    btn.disabled = false;
  }
}

async function rfAuto() {
  const eq = rfCurrent();
  if (!eq || rfBusy) return;
  const target = $("rf-target").value;
  rfBusy = true;
  $("btn-rf-stop").style.display = "";
  $("btn-rf-auto").disabled = true;
  let n = 0, hit = false;
  try {
    while (rfBusy && n < 30) {
      await invoke("reforge_exec", { equipmentId: eq.id, lockedStats: [...rfLocked], targetStat: target });
      n++;
      await loadReforge(); // 重新拉取（保留选中部位与锁定集）
      const cur = rfCurrent();
      if (!cur) break;
      const keys = (cur.affixes || []).map((a) => a.key);
      $("rf-result").textContent = `连续洗练中… 第 ${n} 次\n当前词条：${keys.map(rfStatLabel).join("、") || "（无）"}`;
      if (keys.includes(target)) { hit = true; break; }
      await new Promise((r) => setTimeout(r, 450)); // 节流
    }
  } catch (e) {
    toast(String(e), "error");
  }
  rfBusy = false;
  const stopBtn = $("btn-rf-stop"); if (stopBtn) stopBtn.style.display = "none";
  const autoBtn = $("btn-rf-auto"); if (autoBtn) autoBtn.disabled = false;
  toast(hit ? `已洗出目标词条「${rfStatLabel(target)}」（${n} 次）` : `连续洗练 ${n} 次未出目标词条`, hit ? "ok" : "info");
  await loadReforge();
}

// ---------------- 日志 ----------------
async function refreshRuns(force) {
  if (current === "logs" && !force && $("runs-pause")?.checked) return;
  try {
    const acc = parseInt($("runs-account")?.value || "", 10);
    const status = $("runs-status")?.value || "";
    const runs = await invoke("get_runs", { accountId: isNaN(acc) ? null : acc, limit: 2000 });
    runsCache = runs;
    if (current !== "logs") return;
    const tb = $("runs-table").querySelector("tbody");
    const shown = runs.slice(0, 1000)
      .filter((r) => !status || r.status === status);
    // 条数 + 覆盖时间范围提示（后端已放宽上限，历史日志能翻好几天）
    const ts = $("runs-count");
    if (ts) {
      const last = runs[0]?.finished_at;
      const first = runs[Math.min(runs.length - 1, 999)]?.finished_at;
      const fmt = (t) => (t ? new Date(t).toLocaleString() : "-");
      ts.textContent = runs.length
        ? `共 ${runs.length} 条（显示最新 ${shown.length}），${fmt(first)} ~ ${fmt(last)}`
        : "暂无日志";
    }
    tb.innerHTML = shown
      .map((r) => `<tr>
        <td>#${r.account_id}</td>
        <td>${esc(r.task)}</td>
        <td class="${r.status === "ok" ? "status-ok" : "status-failed"}">${r.status === "ok" ? "成功" : "失败"}</td>
        <td class="detail">${esc(r.detail)}</td>
        <td>${new Date(r.finished_at).toLocaleTimeString()}</td>
        <td>${r.status === "failed" ? `<button data-retry="${r.account_id}" data-task="${r.task}">重试</button>` : "-"}</td>
      </tr>`)
      .join("") || "<tr><td colspan=6 class='empty'>暂无日志</td></tr>";
    tb.querySelectorAll("button[data-retry]").forEach((b) => {
      b.onclick = async () => {
        try {
          await invoke("retry_run", { accountId: Number(b.dataset.retry), task: b.dataset.task });
          toast("已重置，下一轮自动重试", "ok");
          refreshRuns(true);
        } catch (e) { toast(String(e), "error"); }
      };
    });
  } catch (e) { toastThrottle("runs", "日志读取失败：" + e, 30000); }
}

function exportRunsCsv() {
  const header = "account_id,task,run_key,status,detail,finished_at";
  const lines = runsCache.map((r) =>
    [r.account_id, r.task, r.run_key, r.status, `"${String(r.detail).replace(/"/g, '""')}"`, new Date(r.finished_at).toISOString()].join(",")
  );
  const blob = new Blob(["﻿" + header + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `placegame-runs-${beijingToday()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${lines.length} 条日志`, "ok");
}

// ---------------- 设置 ----------------
const QUALITIES = [["white", "白"], ["green", "绿"], ["blue", "蓝"], ["purple", "紫"], ["orange", "橙"], ["red", "红"], ["gold", "金"]];
const SETTINGS_GROUPS = [
  { tab: "settings", title: "调度", fields: [
    ["concurrency", "并发账号数（处理一轮时同时操作的号数）", "number"],
    ["req_gap_ms", "每账号请求间隔下限（ms）", "number"],
  ]},
  { tab: "dashboard", title: "收菜", fields: [
    ["auto_equip", "收菜后自动换装（绑定优先）", "bool"],
    ["idle_adventure_pref", "奇遇偏好（领挂机收益触发奇遇时）", "adventure"],
  ]},
  { tab: "dashboard", title: "活动", fields: [
    ["arcade_free", "街机每日免费轮", "bool"],
    ["arcade_paid", "街机金币局（默认关）", "bool"],
    ["lottery_tickets", "大乐透每日张数（0=关）", "number"],
  ]},
  { tab: "accounts", title: "小号", fields: [
    ["join_target_level", "入会门槛等级（达到后申请入会；入会后持续练级无上限）", "number"],
    ["auto_map", "收菜时自动换更优地图", "bool"],
  ]},
  { tab: "guild", title: "公会 / 捐赠", fields: [
    ["guild_enabled", "公会协同总开关", "bool"],
    ["guild_equip_min_quality", "装备捐赠最低品质", "quality"],
    ["equip_donate_min_score", "装备捐仓评分门槛（≥此分才捐，0=不限）", "number"],
    ["deny_donate", "捐献保留列表（逗号分隔）", "text"],
  ]},
  { tab: "guild", title: "副职业", fields: [
    ["profession_key", "副职业", "profession"],
    ["profession_craft", "启用加工类动作", "bool"],
    ["supply_auto", "自动装配口粮/首领药剂", "bool"],
  ]},
  { tab: "guild", title: "内部市场", fields: [
    ["market_internal", "内部市场闭环", "bool"],
    ["market_price_factor", "内部价目系数（0.8-1.5）", "number"],
    ["market_daily_cap", "每日成交笔数上限", "number"],
  ]},
  { tab: "worldboss", title: "世界boss", fields: [
    ["boss_world", "世界首领协作（全部场次自动参与）", "bool"],
    ["boss_world_assists", "世界首领每场次数", "number"],
  ]},
  { tab: "equipment", title: "个人首领 / 大号 Boss", fields: [
    ["boss_daily", "每日个人/地图首领", "bool"],
    ["boss_material_boost", "大号 Boss 材料加成+35%", "bool"],
    ["boss_affix_key", "大号挑战词缀（none=不带）", "text"],
    ["boss_main_target_slot", "大号定向部位（大极品模式：刷到 rareRank=大极品；空=自动轮换最差）", "slot"],
    ["boss_set_quality", "地图套装达标品质（至少这个品质才算 1 件）", "quality"],
    ["boss_set_rareness", "地图套装达标稀有度（至少这个稀有度才算 1 件）", "rareness"],
  ]},
  { tab: "equipment", title: "大号养成", fields: [
    ["growth_enabled", "养成自动化总开关", "bool"],
    ["growth_slots", "养成部位（逗号分隔，空=全部）", "text"],
    ["reforge_target_stats", "目标词条优先级（逗号分隔）", "text"],
    ["reforge_max_per_day", "洗练每日每件上限", "number"],
    ["enhance_protect_from", "强化保护符起始等级", "number"],
    ["enhance_max_per_day", "强化每日每件上限", "number"],
    ["enhance_inherit_enabled", "强化继承（高风险，默认关）", "bool"],
    ["growth_stop_quality", "毕业阈值（命中目标词条数）", "number"],
    ["growth_gold_budget", "每日金币预算", "number"],
    ["growth_rare_budget", "每日元宝预算（默认0不动元宝）", "number"],
  ]},
  { tab: "decompose", title: "分解总开关", fields: [
    ["decompose_enabled", "收菜前按 9 档模板清理背包（一键分解）", "bool"],
  ]},
  { tab: "settings", title: "高级", fields: [
    ["base_url", "服务器地址", "text"],
  ]},
];
const ARRAY_FIELDS = new Set(["growth_slots", "reforge_target_stats", "deny_donate"]);
let settingsData = null;

function buildSettingsForm(containerId, tab) {
  const wrap = $(containerId);
  if (!wrap) return;
  const groups = SETTINGS_GROUPS.filter((g) => !tab || g.tab === tab);
  let html = "";
  for (const g of groups) {
    html += `<fieldset class="settings-group"><legend>${g.title}</legend>`;
    for (const [key, label] of g.fields) {
      html += `<label class="set-row" data-key="${key}"><span>${label}</span><span class="set-input"></span></label>`;
    }
    html += `</fieldset>`;
  }
  wrap.innerHTML = html || "<p class='hint'>该页没有独立设置项</p>";
  wrap.querySelectorAll(".set-row").forEach((row) => {
    const key = row.dataset.key;
    const type = SETTINGS_GROUPS.flatMap((g) => g.fields).find((f) => f[0] === key)[2];
    const input = row.querySelector(".set-input");
    let val = settingsData ? settingsData[key] : undefined;
    if (Array.isArray(val)) val = val.join(", ");
    if (type === "bool") {
      input.innerHTML = `<input type="checkbox" id="set-${key}" ${val ? "checked" : ""} />`;
    } else if (type === "quality") {
      input.innerHTML = `<select id="set-${key}">${QUALITIES.map(([k, n]) => `<option value="${k}" ${val === k ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    } else if (type === "rareness") {
      const opts = [["普通装备", "普通"], ["小极品", "小极品"], ["极品", "极品"], ["大极品", "大极品"]];
      input.innerHTML = `<select id="set-${key}">${opts.map(([k, n]) => `<option value="${k}" ${val === k ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    } else if (type === "slot") {
      const SLOTS = [["", "未指定（自动轮换最差部位）"], ["weapon", "武器"], ["armor", "铠甲"], ["helmet", "头盔"], ["necklace", "项链"], ["ring", "戒指"], ["belt", "腰带"], ["bracelet", "护腕"], ["boots", "靴子"], ["talisman", "护符"], ["medal", "勋章"]];
      input.innerHTML = `<select id="set-${key}">${SLOTS.map(([k, n]) => `<option value="${k}" ${val === k ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    } else if (type === "adventure") {
      const opts = [["exp", "经验增加优先"], ["gold", "金币优先"], ["drop", "掉落优先"], ["first", "取第一项"]];
      input.innerHTML = `<select id="set-${key}">${opts.map(([k, n]) => `<option value="${k}" ${val === k ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    } else if (type === "profession") {
      const opts = [["herbalism", "采药"], ["fishing", "垂钓"], ["cooking", "烹饪"], ["alchemy", "炼金"]];
      input.innerHTML = `<select id="set-${key}">${opts.map(([k, n]) => `<option value="${k}" ${val === k ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    } else {
      input.innerHTML = `<input id="set-${key}" value="${val === undefined ? "" : val}" />`;
    }
  });
}

async function loadSettings() {
  try {
    settingsData = await invoke("get_settings");
  } catch (e) { settingsData = {}; toast("读取设置失败：" + e, "error"); }
  buildSettingsForm("settings-form-settings", "settings");
}

// 按当前 Tab 加载并渲染该页的设置项（设置分散到各对应页面，保存时合并、不重置其他页）
async function loadTabSettings(tab) {
  if (!settingsData) {
    try { settingsData = await invoke("get_settings"); }
    catch (e) { settingsData = {}; }
  }
  buildSettingsForm("settings-form-" + tab, tab);
}

function collectSettings(container) {
  const root = container || document;
  const out = {};
  root.querySelectorAll(".set-row").forEach((row) => {
    const key = row.dataset.key;
    row.querySelectorAll("input,select").forEach((el) => {
      if (el.type === "checkbox") out[key] = el.checked;
      else if (el.tagName === "SELECT") out[key] = el.value;
      else {
        const raw = el.value;
        const t = typeof settingsData?.[key];
        out[key] = t === "number" ? Number(raw) : raw;
      }
    });
  });
  // 逗号分隔 → 数组
  for (const k of ARRAY_FIELDS) {
    if (typeof out[k] === "string") {
      out[k] = out[k].split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

// ---------------- 引导向导 ----------------
let wizStep = 1;
function wizShow(step) {
  wizStep = step;
  [1, 2, 3].forEach((i) => {
    $("wiz-page-" + i).style.display = i === step ? "block" : "none";
    $("wiz-dot-" + i).classList.toggle("on", i === step);
  });
  $("wiz-back").style.display = step > 1 ? "" : "none";
  $("wiz-next").textContent = step === 3 ? "创建并开跑" : "下一步";
}
function wizOpen() { $("wiz-modal").style.display = "flex"; wizShow(1); }
function wizClose() { $("wiz-modal").style.display = "none"; }
async function wizNext() {
  try {
    if (wizStep === 1) {
      const r = await invoke("add_main", { username: $("wiz-user").value.trim(), password: $("wiz-pass").value });
      toast("大号已添加 #" + r, "ok");
      wizShow(2);
    } else if (wizStep === 2) {
      const gid = await invoke("create_guild", { name: $("wiz-gname").value.trim(), motto: $("wiz-gmotto").value.trim() });
      toast("公会已创建 guildId=" + gid, "ok");
      wizShow(3);
    } else {
      const count = Number($("wiz-count").value) || 120;
      $("wiz-progress").textContent = "创建中…（逐个注册，请稍候）";
      const r = await invoke("add_alts", { count, job: $("wiz-job").value, accountType: "formal" });
      $("wiz-progress").textContent = "";
      toast(`小号创建：成功 ${r.created} / 失败 ${r.failed}`, r.failed > 0 ? "error" : "ok");
      await invoke("start_daemon");
      toast("已就绪：世界boss到点自动参加；收菜请点「🧺 一键收菜全部」", "ok");
      wizClose();
      refresh();
    }
  } catch (e) {
    toast(String(e), "error");
  }
}

// ---------------- 全局 ----------------
let refreshBusy = false; // 防重入：3s 轮询与手动刷新叠加时，上一次未完成则跳过本次
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const st = await invoke("get_status");
    statusCache = st;
    $("run-state").textContent = !st.running ? "○ 已关闭"
      : (st.world_window ? "● 世界boss场次中（自动参加）" : "○ 世界boss场次外待机");
    $("run-state").className = "badge" + (st.running ? (st.world_window ? " on" : "") : "");
    // 按当前页按需拉取：runs 只在总览/账号/日志页需要；账号列表只在账号页需要
    if (current === "dashboard" || current === "accounts" || current === "logs") {
      await refreshRuns(false); // 先拿 runs（账号状态/完成度依赖）
    }
    if (current === "dashboard") refreshDashboard(st);
    refreshGuild();
    if (current === "accounts") refreshAccounts();
    // 首次使用（无账号或无公会）弹引导向导
    if (!sessionStorage.getItem("wiz_dismissed") && (!st.accounts.length || !st.main_guild_id)) {
      wizOpen();
    }
  } catch (e) { toastThrottle("refresh", "刷新失败：" + e, 15000); }
  finally { refreshBusy = false; }
}

function bind() {
  // 挂机练级游戏：收菜手动触发（一键收菜全部 = 所有账号完整一轮），
  // 后台只自动参与世界boss（定时开放场次，到点自动打固定列表）
  $("btn-start").onclick = () => invoke("start_daemon").then(() => toast("世界boss自动参与已开启", "ok")).then(refresh);
  $("btn-stop").onclick = () => invoke("stop_daemon").then(() => toast("已关闭自动参与", "info")).then(refresh);
  // ⏹ 停止当前批量任务：置取消标志，正在跑的 一键收菜/领取收益/批量 停止分派剩余账号
  $("btn-cancel").onclick = async () => {
    try {
      await invoke("cancel_task");
      toast("已请求停止剩余任务，处理完当前账号即停", "info");
    } catch (e) { toast("停止失败：" + e, "error"); }
  };
  $("btn-rewards").onclick = async () => {
    const btn = $("btn-rewards");
    btn.disabled = true;
    btn.textContent = "领取中…（全部账号）";
    try {
      const out = await invoke("run_collect_rewards");
      const ok = (out || []).filter((x) => x.r && !String(x.r).startsWith("失败")).length;
      const err = (out || []).filter((x) => x.r && String(x.r).startsWith("失败")).length;
      toast(`领取收益完成：成功 ${ok} 号${err ? `，失败 ${err}` : ""}`, err ? "error" : "ok");
      refresh();
    } catch (e) {
      toast("领取收益失败：" + e, "error");
    }
    btn.disabled = false;
    btn.textContent = "⏫ 领取收益";
  };
  $("btn-save-decompose-tiers").onclick = () => saveDecomposeTiers();
  $("btn-sync").onclick = async () => {
    const btn = $("btn-sync");
    btn.disabled = true;
    btn.textContent = "收菜中…（全部账号）";
    try {
      const out = await invoke("run_collect_all");
      const items = (out && out.items) || [];
      toast(`一键收菜完成：${items.length} 条处理记录`, "ok");
      $("latest").textContent = items.join("\n") || "（全部完成）";
      $("latest-time").textContent = new Date().toLocaleTimeString();
    } catch (e) {
      toast("一键收菜失败：" + e, "error");
    }
    btn.disabled = false;
    btn.textContent = "🧺 一键收菜全部";
    refresh();
  };
  // 密度切换已移除（统一舒适排版）
  localStorage.removeItem("density");


  $("btn-add-main").onclick = async () => {
    try {
      const r = await invoke("add_main", { username: $("main-user").value.trim(), password: $("main-pass").value });
      toast("大号已添加 #" + r, "ok");
      $("main-user").value = ""; $("main-pass").value = "";
      refresh();
    } catch (e) { toast("登录失败：" + e + "（若未注册请点「注册新账号」）", "error"); }
  };
  $("btn-reg-main").onclick = async () => {
    try {
      const r = await invoke("register_main", { username: $("main-user").value.trim(), password: $("main-pass").value });
      toast("已注册并添加大号 #" + r, "ok");
      $("main-user").value = ""; $("main-pass").value = "";
      refresh();
    } catch (e) { toast("注册失败：" + e, "error"); }
  };
  $("btn-add-alts").onclick = async () => {
    const count = Number($("alt-count").value) || 10;
    $("btn-add-alts").textContent = "创建中…";
    $("alt-progress").textContent = "逐个注册中，请稍候";
    const r = await invoke("add_alts", { count, job: $("alt-job").value, accountType: $("alt-type").value });
    toast(`小号创建：成功 ${r.created} / 失败 ${r.failed}（${r.type === "formal" ? "正式账户" : "试玩账户"}）`, r.failed > 0 ? "error" : "ok");
    if (r.errors && r.errors.length) toast(r.errors[0], "error");
    $("btn-add-alts").textContent = "创建";
    $("alt-progress").textContent = "";
    refresh();
  };
  $("btn-create-guild").onclick = async () => {
    try {
      const gid = await invoke("create_guild", { name: $("g-name").value.trim(), motto: $("g-motto").value.trim() });
      toast("公会已创建 guildId=" + gid, "ok");
      refresh();
      refreshGuild();
    } catch (e) { toast("创建公会失败：" + e, "error"); }
  };
  $("btn-refresh-guild").onclick = () => refreshGuild();
  // 达标未入会小号：手动批量入会（等级达"入会等级"且阶段未 joined）
  $("btn-join-eligible").onclick = async () => {
    const btn = $("btn-join-eligible");
    btn.disabled = true;
    try {
      const out = await invoke("run_join_eligible");
      const ok = (out || []).filter((x) => x.r && !String(x.r).startsWith("失败")).length;
      const err = (out || []).filter((x) => x.r && String(x.r).startsWith("失败")).length;
      const lists = (out || []).map((x) => `#${x.id} ${x.r}`).join("\n") || "（没有等级达标且未入会的小号）";
      toast(`达标入会：成功 ${ok} 号${err ? `，失败 ${err}` : ""}`, err ? "error" : "ok");
      await confirmModal(`达标入会结果：\n${lists}`);
      refreshGuild(); refresh();
    } catch (e) { toast(String(e), "error"); }
    btn.disabled = false;
  };
  // 世界boss 页：刷新 + 立即参与一轮
  $("btn-wb-refresh").onclick = () => refreshWorldBoss();
  $("btn-solo-refresh").onclick = () => loadSoloBosses();
  $("btn-wb-run").onclick = async () => {
    const btn = $("btn-wb-run");
    btn.disabled = true;
    btn.textContent = "参与中…";
    try {
      const out = await invoke("run_task_batch", { task: "world" });
      const ok = (out || []).filter((x) => x.r && !String(x.r).startsWith("失败")).length;
      const err = (out || []).filter((x) => x.r && String(x.r).startsWith("失败")).length;
      toast(`世界boss 参与一轮：成功 ${ok} 号${err ? `，失败 ${err}` : ""}`, err ? "error" : "ok");
      refreshWorldBoss();
    } catch (e) {
      toast("参与失败：" + e, "error");
    }
    btn.disabled = false;
    btn.textContent = "⚔️ 立即参与一轮";
  };
  // 批量审批入会（一次性流程：同意所有待入会申请，全员入会/满员后自动停）
  $("btn-approve-all").onclick = async () => {
    const btn = $("btn-approve-all");
    btn.disabled = true;
    btn.textContent = "审批中…";
    try {
      const r = await invoke("approve_all");
      const before = r.pending_before || 0;
      const approved = r.approved || 0;
      const names = (r.names || []).slice(0, 8).join("、") + ((r.names || []).length > 8 ? "…" : "");
      if (before === 0) {
        toast("当前没有待审批申请", "info");
      } else {
        toast(`本次审批 ${approved}/${before} 个${names ? `：${names}` : ""}`, approved === before ? "ok" : "error");
      }
      refreshGuild();
    } catch (e) {
      toast("批量审批失败：" + e, "error");
    }
    btn.disabled = false;
    btn.textContent = "✅ 批量审批入会";
  };
  $("btn-rf-refresh").onclick = () => loadReforge();
  $("btn-submit-req").onclick = async () => {
    const key = $("req-key").value.trim();
    const amt = parseInt($("req-amount").value, 10) || 1;
    if (!key) { toast("请选择物资", "error"); return; }
    try {
      await invoke("submit_request", { itemKey: key, amount: amt });
      toast("需求已提交：" + key + " x" + amt, "ok");
      refreshGuild();
    } catch (e) { toast(String(e), "error"); }
  };
  const bindDonate = (mode, label, btnId) => async () => {
    const btn = $(btnId);
    btn.disabled = true; // 防连点：捐献一轮是全账号批量动作
    try {
      const out = await invoke("donate_round", { mode });
      const ok = (out || []).filter((r) => r.ok !== undefined).length;
      const err = (out || []).filter((r) => r.error).length;
      toast(`${label}：成功 ${ok} 号${err ? `，失败 ${err}` : ""}`, err ? "error" : "ok");
      refresh();
      refreshGuild();
    } catch (e) { toast(String(e), "error"); }
    finally { btn.disabled = false; }
  };
  $("btn-donate-materials").onclick = bindDonate("materials", "材料捐献", "btn-donate-materials");
  $("btn-donate-equip").onclick = bindDonate("equipment", "装备捐献", "btn-donate-equip");
  $("btn-donate-all").onclick = bindDonate("all", "全部捐献", "btn-donate-all");
  // 批量操作
  $("acc-all").onchange = (e) => {
    document.querySelectorAll(".acc-check").forEach((c) => {
      c.checked = e.target.checked;
      const id = Number(c.dataset.id);
      e.target.checked ? selected.add(id) : selected.delete(id);
    });
    renderBatchBar();
  };
  $("batch-enable").onclick = () => batchOp("enable");
  $("batch-disable").onclick = () => batchOp("disable");
  $("batch-collect").onclick = () => batchOp("collect");
  // 入会是一次性动作（非每日任务）：批量提交入会申请，已入会的自动跳过
  $("batch-join").onclick = async () => {
    const btn = $("batch-join");
    btn.disabled = true;
    try {
      const out = await invoke("run_task_batch", { task: "join" });
      const ok = (out || []).filter((x) => x.r && !String(x.r).startsWith("失败")).length;
      const err = (out || []).filter((x) => x.r && String(x.r).startsWith("失败")).length;
      toast(`批量入会：成功 ${ok} 号${err ? `，失败 ${err}` : ""}`, err ? "error" : "ok");
    } catch (e) {
      toast(String(e), "error");
    }
    btn.disabled = false;
    refresh();
  };
  $("batch-del").onclick = () => batchOp("del");
  // 日志导出/清空
  $("btn-runs-export").onclick = exportRunsCsv;
  // 清空日志：与其他破坏性操作一致，走自绘确认弹窗（window.confirm 被 Tauri 拦截）
  $("btn-runs-clear").onclick = async () => {
    const acc = parseInt($("runs-account")?.value || "", 10);
    const scope = isNaN(acc) ? "全部账号" : `账号 #${acc}`;
    if (!(await confirmModal(`确认清空 ${scope} 的日志？不可恢复。`))) return;
    const btn = $("btn-runs-clear");
    btn.disabled = true;
    try {
      const n = await invoke("clear_runs", { accountId: isNaN(acc) ? null : acc });
      toast(`已清空 ${scope} ${n} 条日志`, "ok");
      refreshRuns(true);
    } catch (e) { toast("清空失败：" + e, "error"); }
    btn.disabled = false;
  };
  // 网页登录凭证弹窗
  ["cred-user", "cred-pass"].forEach((id) => $(id).addEventListener("click", (e) => e.target.select()));
  $("btn-copy-user").onclick = async () => { await copyToClipboard($("cred-user").value); toast("账号已复制", "ok"); };
  $("btn-copy-pass").onclick = async () => { await copyToClipboard($("cred-pass").value); toast("密码已复制", "ok"); };
  $("btn-cred-close").onclick = () => { $("cred-modal").style.display = "none"; };
  $("cred-modal").addEventListener("click", (e) => { if (e.target === $("cred-modal")) $("cred-modal").style.display = "none"; });
  // 自绘确认弹窗（替代被拦截的 window.confirm）
  $("confirm-ok").onclick = () => closeConfirm(true);
  $("confirm-cancel").onclick = () => closeConfirm(false);
  $("confirm-modal").addEventListener("click", (e) => { if (e.target === $("confirm-modal")) closeConfirm(false); });
  // 向导
  $("wiz-next").onclick = wizNext;
  $("wiz-back").onclick = () => wizShow(wizStep - 1);
  $("wiz-skip").onclick = () => { sessionStorage.setItem("wiz_dismissed", "1"); wizClose(); };
  $("btn-runs-refresh").onclick = () => refreshRuns(true);
  // 账号搜索防抖：整表重绘成本高，停顿 250ms 再渲染
  let accSearchTimer = null;
  $("acc-search").addEventListener("input", () => {
    clearTimeout(accSearchTimer);
    accSearchTimer = setTimeout(renderAccounts, 250);
  });
  $("acc-phase-filter").addEventListener("change", renderAccounts);
  $("acc-err-only").addEventListener("change", renderAccounts);
  // 各页设置保存：只收集本页容器字段，与现有配置合并后保存（不重置其他页字段）
  const bindSave = (tab) => {
    const btn = $("btn-save-" + tab);
    if (!btn) return;
    btn.onclick = async () => {
      const collected = collectSettings($("settings-form-" + tab) || document);
      const merged = { ...(settingsData || {}), ...collected };
      try {
        await invoke("save_settings", { opts: merged });
        settingsData = merged;
        toast("设置已保存，立即生效", "ok");
        refresh();
      } catch (e) { toast("保存失败：" + e, "error"); }
    };
  };
  ["settings", "dashboard", "accounts", "guild", "worldboss", "equipment", "decompose"].forEach(bindSave);
}

bind();
route();
refresh();

// =============== ⚔️ 装备管理（大号：强化/升品/继承/分解/穿戴/解绑/锁定） ===============
const EQ_SLOTS = { weapon: "武器", armor: "衣服", helmet: "头盔", necklace: "项链", bracelet: "手镯", ring: "戒指", belt: "腰带", boots: "鞋子", talisman: "护符", medal: "勋章" };
const EQ_QUAL = { white: "普通", green: "优秀", blue: "精良", purple: "稀有", orange: "史诗", red: "传说", gold: "神话" };
const STAT_NAMES = { hp: "生命", attack: "攻击", magicAttack: "魔攻", summonAttack: "召唤", defense: "防御", magicDefense: "魔防", hit: "命中", dodge: "闪避", crit: "暴击", critDamage: "爆伤", attackSpeed: "攻速", luck: "幸运", expBonus: "经验", goldBonus: "金币", dropBonus: "爆率", rareDropBonus: "极品掉率", bossDropBonus: "首领掉落", lifesteal: "吸血", bossDamage: "首领伤害", idleEfficiency: "挂机效率" };
let eqCache = null;
let selEq = null;

async function loadEquip() {
  try {
    eqCache = await invoke("get_equipment");
    renderEquip();
  } catch (e) { toast("读取装备失败：" + e, "error"); }
}

function eqFmt(v) {
  if (typeof v !== "number") return v;
  const a = Math.abs(v);
  if (a > 0 && a < 0.2) return (v * 100).toFixed(1) + "%";
  if (a >= 0.2 && a < 10) return v.toFixed(2);
  return Math.round(v).toString();
}

function renderEquip() {
  const ec = eqCache; if (!ec) return;
  $("eq-player").textContent = `大号 Lv.${ec.player.level} · 战力 ${ec.player.power} · 金币 ${ec.player.gold} · 元宝 ${ec.player.rareCoin}`;
  const slotSel = $("eq-slot");
  if (slotSel.options.length <= 1) for (const [k, n] of Object.entries(EQ_SLOTS)) { const o = document.createElement("option"); o.value = k; o.textContent = n; slotSel.appendChild(o); }
  const qSel = $("eq-quality");
  if (qSel.options.length <= 1) for (const k of ["white", "green", "blue", "purple", "orange", "red", "gold"]) { const o = document.createElement("option"); o.value = k; o.textContent = EQ_QUAL[k]; qSel.appendChild(o); }
  const fs = $("eq-status").value, fsl = slotSel.value, fq = qSel.value;
  const list = (ec.equipment || []).filter((e) => (fs === "all" || e.status === fs) && (fsl === "all" || e.slot === fsl) && (fq === "all" || e.quality === fq));
  $("eq-tbody").innerHTML = list.map((e) => {
    const sel = selEq && selEq.id === e.id ? ' style="background:rgba(87,184,255,.14)"' : "";
    return `<tr${sel} data-id="${e.id}">
      <td>${EQ_SLOTS[e.slot] || esc(e.slot)}</td><td>${EQ_QUAL[e.quality] || esc(e.quality)}</td>
      <td>${esc(e.name)}${e.enhanceLevel > 0 ? " <b>+" + e.enhanceLevel + "</b>" : ""}</td>
      <td>${e.score}</td><td>Lv.${e.level}</td>
      <td>${e.status === "equipped" ? "穿戴中" : "背包"}</td>
      <td>${e.locked ? "🔒" : "-"}</td>
      <td>${e.bindStatus === "unbound" ? "可交易" : "绑定"}</td>
    </tr>`;
  }).join("") || "<tr><td colspan=8 class='hint'>无匹配装备</td></tr>";
  document.querySelectorAll("#eq-tbody tr").forEach((tr) => {
    tr.onclick = () => {
      selEq = list.find((e) => e.id === tr.dataset.id);
      renderEquip();
      renderEqDetail();
      // 联动：点选已穿戴装备时，洗练面板同步到该部位
      if (selEq && selEq.status === "equipped" && typeof renderReforgeSlots === "function") {
        rfSelectedSlot = selEq.slot;
        rfLocked = new Set();
        renderReforgeSlots();
        renderReforgeDetail();
      }
    };
  });
  renderEqDetail();
}

function renderEqDetail() {
  const box = $("eq-detail");
  const e = selEq;
  if (!e) { box.innerHTML = "<p class='hint'>点击上方装备查看详情与操作。</p>"; return; }
  const attrHtml = (t) => Object.entries(t || {}).map(([k, v]) => `<span class="eq-attr">${esc(STAT_NAMES[k] || k)}: ${eqFmt(v)}</span>`).join("") || "<span class='hint'>无</span>";
  const isBag = e.status === "in_bag";
  box.innerHTML = `
    <div class="eq-detail-head"><b>${EQ_QUAL[e.quality] || esc(e.quality)} ${esc(e.name)}</b> +${e.enhanceLevel}
      <span class="hint">评分 ${e.score} · 成色 ${esc(e.rareRank || "-")}(${esc(String(e.rareScore ?? "-"))}) · ${EQ_SLOTS[e.slot] || esc(e.slot)} · Lv.${e.level} · ${e.bindStatus === "unbound" ? "可交易" : "绑定"}${e.locked ? " · 🔒已锁定" : ""}</span></div>
    <div class="eq-block"><div class="rf-sub">基础属性</div>${attrHtml(e.baseAttrs)}</div>
    <div class="eq-block"><div class="rf-sub">额外词条</div>${attrHtml(e.extraAttrs)}</div>
    <div class="toolbar">
      <button data-op="wear" ${isBag ? "" : "disabled"}>穿戴</button>
      <button data-op="take_off" ${isBag ? "disabled" : ""}>脱下</button>
      <button data-op="toggle_lock">${e.locked ? "解锁" : "锁定"}</button>
      <button data-op="unbind" ${e.bindStatus !== "bound" ? "disabled" : ""}>解绑(交易封印)</button>
      <button data-op="enhance">⬆ 强化</button>
      <button data-op="quality">⭐ 升品</button>
      <button data-op="affix_inherit">🔀 词条继承</button>
      <button data-op="enhance_inherit">🔀 强化继承</button>
      <button data-op="decompose" ${isBag ? "" : "disabled"}>🗑 分解</button>
    </div>
    <div id="eq-op-result" class="hint"></div>`;
  box.querySelectorAll("button[data-op]").forEach((b) => { if (!b.disabled) b.onclick = () => eqOp(b.dataset.op); });
}

async function eqOp(op) {
  const e = selEq; if (!e) return;
  const out = $("eq-op-result"); out.textContent = "处理中…";
  const call = (act, payload, prev) => invoke("equip_run", { act, payload, preview: prev === true });
  const done = async (act, payload, okMsg) => {
    try { await call(act, payload); toast(okMsg || act + " 成功", "ok"); loadEquip(); }
    catch (err) { out.textContent = String(err); toast(String(err), "error"); }
  };
  try {
    if (op === "enhance" || op === "quality") {
      const act = op === "quality" ? "quality_upgrade" : "enhance";
      const pv = await call(act, { equipmentId: e.id }, true);
      if (pv && pv.blockedReason) { out.textContent = "被阻止：" + pv.blockedReason; return; }
      if (op === "enhance") {
        const msg = `强化预览：+${pv.currentLevel}→+${pv.nextLevel} 成功率 ${pv.successPercent}% 金币 ${pv.goldCost} ${pv.stoneName}x${pv.stoneCost}`;
        const useProtect = pv.canUseProtectCharm && await confirmModal(msg + "\n使用保护符？【确定=用 / 取消=不用】");
        if (!(await confirmModal("执行强化？" + (useProtect ? "（带保护符）" : "（不带）")))) return;
        await done("enhance", { equipmentId: e.id, useProtectCharm: !!useProtect }, `强化 +${pv.nextLevel} 完成`);
      } else {
        const costs = (pv.costItems || []).map((c) => `${c.itemName}x${c.amount}（有${c.owned}）`).join(" ");
        if (!(await confirmModal(`升品预览：${pv.currentQualityName}→${pv.nextQualityName} 评分+${pv.scoreGain} 金币${pv.goldCost} ${costs}\n执行？`))) return;
        await done("quality_upgrade", { equipmentId: e.id }, `升品为${pv.nextQualityName} 完成`);
      }
      return;
    }
    if (op === "affix_inherit" || op === "enhance_inherit") {
      const srcList = (eqCache?.equipment || []).filter((x) => x.slot === e.slot && x.status === "in_bag" && x.id !== e.id);
      if (!srcList.length) { out.textContent = "背包内没有同部位来源装备"; return; }
      const choice = prompt("选择来源装备编号（同部位）：\n" + srcList.map((x, i) => `${i}. ${x.name} +${x.enhanceLevel} 评分${x.score}${x.bindStatus === "bound" ? "(绑定)" : ""}`).join("\n"));
      const idx = parseInt(choice, 10);
      if (isNaN(idx) || !srcList[idx]) { out.textContent = "已取消"; return; }
      const src = srcList[idx];
      const pv = await call(op, { targetEquipmentId: e.id, sourceEquipmentId: src.id }, true);
      if (pv && pv.blockedReason) { out.textContent = "被阻止：" + pv.blockedReason; return; }
      const warn = op === "enhance_inherit" && pv && pv.targetDestroyedOnFailure ? "\n⚠️ 失败会摧毁目标装备！" : "";
      const info = `预览：${pv ? (pv.successText || `+${pv.resultEnhanceLevel || "-"}`) : ""}${warn}\n费用：金币 ${pv && pv.goldCost} 元宝 ${pv && pv.rareCoinCost}`;
      out.textContent = info;
      if (!(await confirmModal(info + "\n确定执行？"))) return;
      await done(op, { targetEquipmentId: e.id, sourceEquipmentId: src.id }, (op === "affix_inherit" ? "词条继承" : "强化继承") + " 完成");
      return;
    }
    if (op === "decompose") {
      const pv = await call("decompose", { equipmentIds: [e.id] }, true);
      const c = pv || {};
      const mats = (c.materials || []).map((m) => m.itemName + "x" + m.amount).join(" ");
      if (!(await confirmModal(`分解预览：${e.name} → 金币 ${c.goldGain} ${mats}\n确认后装备销毁，执行？`))) return;
      await done("decompose", { equipmentIds: [e.id] }, "分解完成");
      return;
    }
    if (op === "wear") await done("wear", { equipmentId: e.id }, "已穿戴");
    else if (op === "take_off") await done("take_off", { equipmentId: e.id }, "已脱下");
    else if (op === "toggle_lock") { await done("toggle_lock", { equipmentId: e.id }, e.locked ? "已解锁" : "已锁定"); }
    else if (op === "unbind") {
      if (await confirmModal("解绑将消耗 交易封印，装备变为可交易。确定？")) await done("unbind", { equipmentId: e.id }, "已解绑");
    }
  } catch (err) { out.textContent = String(err); }
}

["eq-status", "eq-slot", "eq-quality"].forEach((id) => { const el = $(id); if (el) el.addEventListener("change", renderEquip); });
const _eqRefresh = $("btn-eq-refresh"); if (_eqRefresh) _eqRefresh.onclick = loadEquip;
setInterval(refresh, 3000);
