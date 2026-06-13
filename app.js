// UI 逻辑：检测站点 -> 拉额度 / 模型列表（按供应商分组） -> 逐个 / 分组 / 全部测连通性。
import { detectStation, fetchQuota, listModels, testModel, corsHint } from "./api.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + Number(n).toFixed(2);
const level = (pct) => (pct >= 85 ? "crit" : pct >= 60 ? "warn" : "ok");
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

const CONCURRENCY = 5;
const LS = { url: "rc_url", key: "rc_key", remember: "rc_remember" };

// ── 供应商识别 ─────────────────────────────────────────────
// 按 model id 归类；顺序敏感（具体品牌在前，通用品类桶在后），未命中归「其他」。
const PROVIDERS = [
  { key: "openai",     name: "OpenAI",        re: /^(gpt[-_]?|o[1-4]([-.]|$|mini|pro|preview)|chatgpt|text-embedding|text-davinci|davinci|babbage|curie|ada|whisper|tts-|dall-e|omni-|computer-use|codex)/i },
  { key: "anthropic",  name: "Anthropic",     re: /^claude/i },
  { key: "google",     name: "Google Gemini", re: /^(gemini|gemma|palm|bison|text-bison|chat-bison|imagen|veo)/i },
  { key: "deepseek",   name: "DeepSeek",      re: /^deepseek/i },
  { key: "zhipu",      name: "智谱 GLM",       re: /^(glm|chatglm|cogview|cogvideo|codegeex|charglm|emohaa)/i },
  { key: "qwen",       name: "通义千问",        re: /^(qwen|qwq|qvq|tongyi|wanx|wan2)/i },
  { key: "moonshot",   name: "Moonshot Kimi", re: /^(moonshot|kimi)/i },
  { key: "minimax",    name: "MiniMax",       re: /^(minimax|abab)/i },
  { key: "baidu",      name: "百度 文心",       re: /^(ernie|wenxin|bce-)/i },
  { key: "bytedance",  name: "字节 豆包",       re: /^(doubao|skylark|ep-[0-9a-z]{6,})/i },
  { key: "tencent",    name: "腾讯 混元",       re: /^hunyuan/i },
  { key: "iflytek",    name: "讯飞 星火",       re: /^(spark|generalv|4\.0ultra|lite$|pro-128k)/i },
  { key: "stepfun",    name: "阶跃 Step",      re: /^step-/i },
  { key: "01ai",       name: "零一万物 Yi",     re: /^yi-/i },
  { key: "mistral",    name: "Mistral",       re: /^(mistral|mixtral|codestral|ministral|pixtral|magistral|devstral|open-m)/i },
  { key: "meta",       name: "Meta Llama",    re: /^(llama|meta-llama|code-?llama)/i },
  { key: "cohere",     name: "Cohere",        re: /^(command|c4ai|rerank|embed-(english|multilingual))/i },
  { key: "xai",        name: "xAI Grok",      re: /^grok/i },
  { key: "perplexity", name: "Perplexity",    re: /^(sonar|pplx|r1-1776)/i },
  { key: "midjourney", name: "Midjourney",    re: /^(midjourney|mj[_-]|niji)/i },
  { key: "image",      name: "图像 / 绘画",     re: /^(flux|stable-?diffusion|sd[-_]?[0-9]|sdxl|sd3|playground-v|kolors|recraft|ideogram|seedream|cogview|hidream)/i },
  { key: "audio",      name: "音频 / 语音",     re: /^(suno|udio|elevenlabs|sovits|fish-?speech|cosyvoice|gpt-4o-audio|gpt-sovits|chattts)/i },
  { key: "embedding",  name: "向量 Embedding", re: /(embedding|^bge|^m3e|^text2vec|^gte-|^jina-?embed|^multilingual-e5|^conan-embed)/i },
];
const ORDER = new Map(PROVIDERS.map((p, i) => [p.key, i]));
const OTHER = { key: "other", name: "其他" };

function providerOf(id) {
  for (const p of PROVIDERS) if (p.re.test(id)) return p;
  return OTHER;
}
const groupOrder = (key) => (ORDER.has(key) ? ORDER.get(key) : 999);

// ── 状态 ───────────────────────────────────────────────────
let baseUrl = "";
let apiKey = "";
let models = []; // [{ id, provider, state, latency, status, error }]
let abortCtrl = null;
let busy = false; // 批量测试进行中
let detecting = false;
const collapsed = new Set(); // 折叠的供应商 key

// 结果归类：连通 / 站可达但模型有问题(4xx) / 不通(网络·CORS·5xx)
function classify(r) {
  if (r.ok) return "ok";
  // 推理型模型在极小输出预算下「没说完就到上限」——这恰恰证明已连通、模型已执行，
  // 只是被探活请求的 max_tokens 卡住，按连通处理。
  const msg = (r.error || "").toLowerCase();
  if (r.status === 400 && /max_tokens|max_completion_tokens|output limit|could not finish|finish_reason/.test(msg)) {
    return "ok";
  }
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
    box.className = "readout bad";
    box.textContent = "请填写 Base URL 和 API Key";
    return;
  }
  persist();

  detecting = true;
  const btn = $("btn-detect");
  btn.disabled = true;
  btn.classList.add("scanning");
  box.hidden = false;
  box.className = "readout loading";
  box.textContent = "扫描中…";

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
  btn.disabled = false;
  btn.classList.remove("scanning");
}

function renderStationBadge(r) {
  const box = $("detect-status");
  if (r.status === "fulfilled") {
    const d = r.value;
    if (d.type === "unknown") {
      box.className = "readout ok";
      box.innerHTML = "已连接 · 通用 OpenAI 兼容接口";
    } else {
      const ver = d.version ? ` · ${esc(d.version)}` : "";
      const sn = d.systemName ? ` · ${esc(d.systemName)}` : "";
      box.className = "readout ok";
      box.innerHTML = `已识别 <b>${esc(d.type)}</b>${ver}${sn}`;
    }
  } else {
    box.className = "readout ok";
    box.innerHTML = "已尝试连接 · 按通用接口处理";
  }
}

// ── 额度仪表 ───────────────────────────────────────────────
function renderQuota(r) {
  const panel = $("quota-panel"), pct = $("quota-pct"), bar = $("quota-bar");
  const used = $("quota-used"), remain = $("quota-remain-val"), err = $("quota-err");

  if (r.status === "rejected") {
    panel.dataset.level = "err";
    pct.textContent = "—";
    bar.className = "meter-fill";
    bar.style.width = "0%";
    used.textContent = "额度查询失败";
    remain.textContent = "$—";
    err.hidden = false;
    err.textContent = corsHint(r.reason);
    return;
  }

  const q = r.value;
  const p = q.total > 0 ? Math.round((q.used / q.total) * 100) : 0;
  const lv = level(p);
  panel.dataset.level = lv;
  pct.textContent = p + "%";
  bar.className = `meter-fill ${lv}`;
  bar.style.width = Math.min(100, p) + "%";
  used.textContent = `已用 ${fmt(q.used)} · 总额 ${fmt(q.total)}`;
  remain.textContent = fmt(q.remaining);
  err.hidden = true;
}

// ── 模型：装载 ─────────────────────────────────────────────
function renderModelsResult(r) {
  const err = $("models-err");
  collapsed.clear();
  if (r.status === "rejected") {
    models = [];
    err.hidden = false;
    err.textContent = "模型列表获取失败：" + corsHint(r.reason);
    $("models-count").textContent = "";
    renderModels();
    return;
  }
  err.hidden = true;
  models = r.value.map((id) => ({ id, provider: providerOf(id), state: "untested", latency: 0, status: 0, error: "" }));
  $("models-count").textContent = `${models.length} 个`;
  renderModels();
}

// ── 分组 + 过滤 + 排序 ─────────────────────────────────────
function sortComparator(sort) {
  if (sort === "latency") {
    return (a, b) => {
      const av = a.state === "ok" ? a.latency : Infinity;
      const bv = b.state === "ok" ? b.latency : Infinity;
      return av - bv || a.id.localeCompare(b.id);
    };
  }
  if (sort === "status") {
    const rank = { ok: 0, warn: 1, fail: 2, testing: 3, untested: 4 };
    return (a, b) => (rank[a.state] - rank[b.state]) || a.id.localeCompare(b.id);
  }
  return (a, b) => a.id.localeCompare(b.id);
}

function visibleGroups() {
  const q = $("f-search").value.trim().toLowerCase();
  const filter = $("f-filter").value;
  const groups = new Map();
  for (const m of models) {
    if (q && !m.id.toLowerCase().includes(q)) continue;
    if (filter === "ok" && m.state !== "ok") continue;
    if (filter === "fail" && !(m.state === "fail" || m.state === "warn")) continue;
    if (filter === "untested" && m.state !== "untested") continue;
    const k = m.provider.key;
    if (!groups.has(k)) groups.set(k, { prov: m.provider, models: [] });
    groups.get(k).models.push(m);
  }
  const cmp = sortComparator($("f-sort").value);
  const arr = [...groups.values()];
  for (const g of arr) g.models.sort(cmp);
  arr.sort((a, b) => groupOrder(a.prov.key) - groupOrder(b.prov.key) || a.prov.name.localeCompare(b.prov.name));
  return arr;
}

// 某供应商的全量统计（不受过滤影响，反映该供应商真实总数）
function statsOf(key) {
  let total = 0, ok = 0, warn = 0, fail = 0;
  for (const m of models) {
    if (m.provider.key !== key) continue;
    total++;
    if (m.state === "ok") ok++;
    else if (m.state === "warn") warn++;
    else if (m.state === "fail") fail++;
  }
  return { total, ok, warn, fail };
}
function statHtml(s) {
  const part = (n, cls, sym) => (n ? `<span class="st ${cls}">${sym}${n}</span>` : "");
  return `<span class="chan-count">${s.total}</span>${part(s.ok, "ok", "✓")}${part(s.warn, "warn", "⚠")}${part(s.fail, "fail", "✗")}`;
}

function meterHtml(m) {
  if (m.state === "ok") {
    const w = Math.max(4, Math.min(100, Math.round(m.latency / 15)));
    const cls = m.latency < 300 ? "fast" : m.latency < 900 ? "mid" : "slow";
    return `<span class="lat ${cls}"><span class="lat-bar"><i style="width:${w}%"></i></span><span class="lat-ms">${m.latency}<small>ms</small></span></span>`;
  }
  if (m.state === "testing") return `<span class="m-state testing">测试中…</span>`;
  if (m.state === "warn") {
    const s = m.status ? `${m.status} ` : "";
    const full = `${s}${m.error || ""}`.trim();
    return `<span class="m-state warn" title="${esc(full)}">⚠ ${esc(s)}${esc(m.error || "")}</span>`;
  }
  if (m.state === "fail") return `<span class="m-state fail" title="${esc(m.error || "")}">✗ ${esc(m.error || "")}</span>`;
  return `<span class="m-state untested">未测</span>`;
}

function rowHtml(m) {
  return `<div class="mrow ${m.state}" data-id="${esc(m.id)}">
    <span class="led"></span>
    <span class="m-id" title="${esc(m.id)}">${esc(m.id)}</span>
    <span class="m-meter">${meterHtml(m)}</span>
    <button class="m-test" data-id="${esc(m.id)}" ${m.state === "testing" ? "disabled" : ""}>测试</button>
  </div>`;
}

function renderModels() {
  const box = $("models-list");
  if (!models.length) {
    box.innerHTML = `<div class="empty">无模型数据</div>`;
    return;
  }
  const groups = visibleGroups();
  if (!groups.length) {
    box.innerHTML = `<div class="empty">无匹配的模型</div>`;
    return;
  }
  box.innerHTML = groups
    .map((g) => {
      const k = g.prov.key;
      const col = collapsed.has(k) ? " data-collapsed" : "";
      const rows = g.models.map(rowHtml).join("");
      return `<section class="chan" data-group="${esc(k)}"${col}>
        <header class="chan-head">
          <span class="chan-caret"></span>
          <span class="chan-name">${esc(g.prov.name)}</span>
          <span class="chan-stat">${statHtml(statsOf(k))}</span>
          <button class="chan-test" data-group="${esc(k)}">测试该组</button>
        </header>
        <div class="chan-rows"><div class="chan-rows-inner">${rows}</div></div>
      </section>`;
    })
    .join("");
}

// 仅更新单行 + 该组统计（避免整列表重渲染闪烁）
function updateRow(m) {
  const row = $("models-list").querySelector(`.mrow[data-id="${cssEsc(m.id)}"]`);
  if (row) {
    row.className = `mrow ${m.state}`;
    row.querySelector(".m-meter").innerHTML = meterHtml(m);
    const btn = row.querySelector(".m-test");
    if (btn) btn.disabled = m.state === "testing";
  }
  updateGroupStats(m.provider.key);
}
function updateGroupStats(key) {
  const el = $("models-list").querySelector(`.chan[data-group="${cssEsc(key)}"] .chan-stat`);
  if (el) el.innerHTML = statHtml(statsOf(key));
}

function toggleCollapse(key) {
  const sec = $("models-list").querySelector(`.chan[data-group="${cssEsc(key)}"]`);
  if (!sec) return;
  if (collapsed.has(key)) { collapsed.delete(key); sec.removeAttribute("data-collapsed"); }
  else { collapsed.add(key); sec.setAttribute("data-collapsed", ""); }
}

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

async function runTests(targets, label) {
  if (busy || !targets.length) return;
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  setBusy(true);

  const total = targets.length;
  let done = 0;
  const tick = () => { $("test-progress").textContent = `${label} ${done}/${total}`; };
  tick();

  let i = 0;
  const worker = async () => {
    while (i < total && !signal.aborted) {
      const m = targets[i++];
      try { await testOne(m, signal); }
      catch (e) { if (e?.name === "AbortError") return; }
      done++;
      tick();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  } finally {
    const aborted = signal.aborted;
    abortCtrl = null;
    setBusy(false);
    $("test-progress").textContent = aborted ? `已停止 ${done}/${total}` : `完成 ${done}/${total}`;
    if (aborted) showToast("已停止");
    renderModels(); // 同步过滤 / 排序视图
  }
}

function setBusy(on) {
  busy = on;
  $("models-list").classList.toggle("busy", on);
  $("btn-test-all").hidden = on;
  $("btn-stop").hidden = !on;
}

const testAll = () => runTests(models.slice(), "全部");
function testGroup(key) {
  const targets = models.filter((m) => m.provider.key === key);
  const name = (targets[0] && targets[0].provider.name) || key;
  runTests(targets, name);
}
const stop = () => { if (abortCtrl) abortCtrl.abort(); };

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
$("btn-stop").addEventListener("click", stop);
$("f-search").addEventListener("input", renderModels);
$("f-filter").addEventListener("change", renderModels);
$("f-sort").addEventListener("change", renderModels);

// 列表内事件委托：单测 / 组测 / 折叠
$("models-list").addEventListener("click", (e) => {
  const single = e.target.closest(".m-test");
  if (single) {
    if (busy) return;
    const m = models.find((x) => x.id === single.dataset.id);
    if (m && m.state !== "testing") testOne(m).catch(() => {});
    return;
  }
  const grp = e.target.closest(".chan-test");
  if (grp) {
    if (busy) return;
    testGroup(grp.dataset.group);
    return;
  }
  const head = e.target.closest(".chan-head");
  if (head) toggleCollapse(head.closest(".chan").dataset.group);
});

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
