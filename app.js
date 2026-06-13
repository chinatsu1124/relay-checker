// UI 逻辑：检测站点 -> 并行拉额度 / 模型列表 -> 按需逐个 / 批量测连通性。
import { detectStation, fetchQuota, listModels, testModel, corsHint } from "./api.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + Number(n).toFixed(2);
const level = (pct) => (pct >= 85 ? "crit" : pct >= 60 ? "warn" : "ok");
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CONCURRENCY = 5;
const LS = { url: "rc_url", key: "rc_key", remember: "rc_remember" };

// ── 状态 ───────────────────────────────────────────────────
let baseUrl = "";
let apiKey = "";
let models = []; // [{ id, state:'untested'|'testing'|'ok'|'warn'|'fail', latency, status, error }]
let abortCtrl = null; // 「测试全部」用
let detecting = false;

// 把单次测试结果归类：连通 / 站可达但模型有问题(4xx) / 不通(网络·CORS·5xx)
function classify(r) {
  if (r.ok) return "ok";
  if (typeof r.status === "number" && r.status >= 400 && r.status < 500) return "warn";
  return "fail";
}

// ── 检测 ───────────────────────────────────────────────────
async function detect() {
  if (detecting) return;
  baseUrl = $("f-url").value.trim();
  apiKey = $("f-key").value.trim();
  const box = $("detect-status");

  if (!baseUrl || !apiKey) {
    box.hidden = false;
    box.className = "detect bad";
    box.textContent = "请填写 Base URL 和 API Key";
    return;
  }
  persist();

  detecting = true;
  $("btn-detect").disabled = true;
  box.hidden = false;
  box.className = "detect loading";
  box.textContent = "检测中…";

  // 三个请求互不依赖，并行发起，各自渲染
  const [stationR, quotaR, modelsR] = await Promise.allSettled([
    detectStation(baseUrl),
    fetchQuota(baseUrl, apiKey),
    listModels(baseUrl, apiKey),
  ]);

  renderStationBadge(stationR);
  $("results").hidden = false;
  renderQuota(quotaR);
  renderModelsResult(modelsR);

  detecting = false;
  $("btn-detect").disabled = false;
}

function renderStationBadge(r) {
  const box = $("detect-status");
  if (r.status === "fulfilled") {
    const d = r.value;
    if (d.type === "unknown") {
      box.className = "detect ok";
      box.innerHTML = "✓ 已连接（未识别为 one-api/new-api，按通用 OpenAI 兼容接口处理）";
    } else {
      const ver = d.version ? ` · ${esc(d.version)}` : "";
      const sn = d.systemName ? ` · ${esc(d.systemName)}` : "";
      box.className = "detect ok";
      box.innerHTML = `✓ 检测到 <b>${esc(d.type)}</b>${ver}${sn}`;
    }
  } else {
    // /api/status 失败不致命（可能不是 one-api/new-api），仅提示
    box.className = "detect ok";
    box.innerHTML = "✓ 已尝试连接（/api/status 不可用，继续按通用接口处理）";
  }
}

// ── 额度卡 ─────────────────────────────────────────────────
function renderQuota(r) {
  const dot = $("quota-dot"), pct = $("quota-pct"), bar = $("quota-bar");
  const used = $("quota-used"), remain = $("quota-remain"), err = $("quota-err");

  if (r.status === "rejected") {
    dot.className = "dot err";
    pct.className = "pct err";
    pct.textContent = "!";
    bar.style.width = "0%";
    bar.className = "bar-fill";
    used.textContent = "额度查询失败";
    remain.textContent = "";
    err.hidden = false;
    err.textContent = corsHint(r.reason);
    return;
  }

  const q = r.value;
  const p = q.total > 0 ? Math.round((q.used / q.total) * 100) : 0;
  const lv = level(p);
  dot.className = `dot ${lv}`;
  pct.className = `pct ${lv}`;
  pct.textContent = p + "%";
  bar.className = `bar-fill ${lv}`;
  bar.style.width = Math.min(100, p) + "%";
  used.textContent = `已用 ${fmt(q.used)} / ${fmt(q.total)}`;
  remain.innerHTML = `剩 <b>${fmt(q.remaining)}</b>`;
  err.hidden = true;
}

// ── 模型列表 ───────────────────────────────────────────────
function renderModelsResult(r) {
  const err = $("models-err");
  if (r.status === "rejected") {
    models = [];
    err.hidden = false;
    err.textContent = "模型列表获取失败：" + corsHint(r.reason);
    $("models-count").textContent = "";
    renderModels();
    return;
  }
  err.hidden = true;
  models = r.value.map((id) => ({ id, state: "untested", latency: 0, status: 0, error: "" }));
  $("models-count").textContent = `(${models.length})`;
  renderModels();
}

function statusHtml(m) {
  if (m.state === "ok") return `<span class="m-status ok">✓ ${m.latency}ms</span>`;
  if (m.state === "testing") return `<span class="m-status testing">测试中…</span>`;
  if (m.state === "warn") {
    const s = m.status ? `${m.status} ` : "";
    const full = `${s}${m.error || ""}`.trim();
    return `<span class="m-status warn" title="${esc(full)}">⚠ ${esc(s)}<span class="m-err">${esc(m.error || "")}</span></span>`;
  }
  if (m.state === "fail") return `<span class="m-status fail" title="${esc(m.error || "")}">✗ <span class="m-err">${esc(m.error || "")}</span></span>`;
  return `<span class="m-status untested">未测</span>`;
}

function visibleModels() {
  const q = $("f-search").value.trim().toLowerCase();
  const filter = $("f-filter").value;
  const sort = $("f-sort").value;

  let list = models.filter((m) => {
    if (q && !m.id.toLowerCase().includes(q)) return false;
    if (filter === "ok") return m.state === "ok";
    if (filter === "fail") return m.state === "fail" || m.state === "warn";
    if (filter === "untested") return m.state === "untested";
    return true;
  });

  if (sort === "latency") {
    // 已连通的按延迟升序在前，其余排后
    list = [...list].sort((a, b) => {
      const av = a.state === "ok" ? a.latency : Infinity;
      const bv = b.state === "ok" ? b.latency : Infinity;
      return av - bv || a.id.localeCompare(b.id);
    });
  } else if (sort === "status") {
    const rank = { ok: 0, warn: 1, fail: 2, testing: 3, untested: 4 };
    list = [...list].sort((a, b) => (rank[a.state] - rank[b.state]) || a.id.localeCompare(b.id));
  }
  return list;
}

function renderModels() {
  const box = $("models-list");
  const list = visibleModels();
  if (!models.length) {
    box.innerHTML = `<div class="models-empty">无模型数据</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="models-empty">无匹配的模型</div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (m) => `
      <div class="mrow ${m.state}" data-id="${esc(m.id)}">
        <span class="m-dot"></span>
        <span class="m-id" title="${esc(m.id)}">${esc(m.id)}</span>
        ${statusHtml(m)}
        <button class="m-test" data-id="${esc(m.id)}" ${m.state === "testing" ? "disabled" : ""}>测试</button>
      </div>`
    )
    .join("");
}

// 仅更新单行 DOM（避免整列表重渲染导致的闪烁）
function updateRow(m) {
  const row = $("models-list").querySelector(`.mrow[data-id="${cssEsc(m.id)}"]`);
  if (!row) return; // 被过滤掉了，下次 renderModels 会带上
  row.className = `mrow ${m.state}`;
  row.querySelector(".m-status").outerHTML = statusHtml(m);
  const btn = row.querySelector(".m-test");
  if (btn) btn.disabled = m.state === "testing";
}

const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

// ── 测试 ───────────────────────────────────────────────────
async function testOne(m, signal) {
  m.state = "testing";
  updateRow(m);
  try {
    const r = await testModel(baseUrl, apiKey, m.id, { signal });
    m.state = classify(r);
    m.latency = r.latency || 0;
    m.status = r.status || 0;
    m.error = r.error || "";
  } catch (e) {
    if (e?.name === "AbortError") { m.state = "untested"; updateRow(m); throw e; }
    m.state = "fail";
    m.error = corsHint(e);
  }
  updateRow(m);
}

async function testAll() {
  if (abortCtrl || !models.length) return;
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  $("btn-test-all").hidden = true;
  $("btn-stop").hidden = false;

  const targets = models.slice(); // 测全部
  let done = 0;
  const prog = $("test-progress");
  const tick = () => { prog.textContent = `${done}/${targets.length}`; };
  tick();

  let i = 0;
  const worker = async () => {
    while (i < targets.length && !signal.aborted) {
      const m = targets[i++];
      try {
        await testOne(m, signal);
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
      done++;
      tick();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  } finally {
    finishTestAll(signal.aborted);
  }
}

function finishTestAll(aborted) {
  abortCtrl = null;
  $("btn-test-all").hidden = false;
  $("btn-stop").hidden = true;
  if (aborted) showToast("已停止");
  renderModels(); // 同步过滤/排序视图
}

function stopAll() {
  if (abortCtrl) abortCtrl.abort();
}

// ── 事件 ───────────────────────────────────────────────────
$("btn-detect").addEventListener("click", detect);
$("f-key").addEventListener("keydown", (e) => { if (e.key === "Enter") detect(); });
$("f-url").addEventListener("keydown", (e) => { if (e.key === "Enter") detect(); });

$("btn-eye").addEventListener("click", () => {
  const f = $("f-key");
  const show = f.type === "password";
  f.type = show ? "text" : "password";
  $("btn-eye").textContent = show ? "隐藏" : "显示";
});

$("btn-test-all").addEventListener("click", testAll);
$("btn-stop").addEventListener("click", stopAll);

$("f-search").addEventListener("input", renderModels);
$("f-filter").addEventListener("change", renderModels);
$("f-sort").addEventListener("change", renderModels);

// 单个模型「测试」按钮（事件委托）
$("models-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".m-test");
  if (!btn) return;
  const m = models.find((x) => x.id === btn.dataset.id);
  if (m && m.state !== "testing") testOne(m).catch(() => {});
});

// 记住开关
$("f-remember").addEventListener("change", (e) => {
  if (e.target.checked) persist();
  else clearPersist();
});

// ── localStorage ───────────────────────────────────────────
function persist() {
  if (!$("f-remember").checked) return;
  try {
    localStorage.setItem(LS.remember, "1");
    localStorage.setItem(LS.url, $("f-url").value.trim());
    localStorage.setItem(LS.key, $("f-key").value.trim());
  } catch { /* 隐私模式等可能禁用 */ }
}
function clearPersist() {
  try {
    localStorage.removeItem(LS.remember);
    localStorage.removeItem(LS.url);
    localStorage.removeItem(LS.key);
  } catch { /* ignore */ }
}

// ── toast ──────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 250);
  }, 1600);
}

// ── 启动 ───────────────────────────────────────────────────
(function init() {
  try {
    if (localStorage.getItem(LS.remember) === "1") {
      $("f-remember").checked = true;
      $("f-url").value = localStorage.getItem(LS.url) || "";
      $("f-key").value = localStorage.getItem(LS.key) || "";
    }
  } catch { /* ignore */ }
})();
