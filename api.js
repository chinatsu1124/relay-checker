// 中转站检测 fetch 层 —— 纯浏览器原生 fetch，无任何后端/扩展依赖。
//
// 跨域说明：本工具是纯静态网页，没有扩展的 host_permissions 豁免，
// 浏览器直连第三方中转站能否成功取决于该站是否开启 CORS
// （多数 one-api / new-api 默认 Access-Control-Allow-Origin: *）。
// 若没开，fetch 会抛 TypeError，corsHint() 会给出友好提示。
//
// 涉及接口（OpenAI 兼容 / one-api / new-api）：
//   GET  {base}/v1/models                              -> 可用模型列表
//   POST {base}/v1/chat/completions                    -> 连通性测试（最短请求）
//   GET  {base}/v1/dashboard/billing/subscription      -> 总额度(USD)
//   GET  {base}/v1/dashboard/billing/usage?...         -> 已用(美分)
//   GET  {base}/api/status                             -> 站点指纹（one-api / new-api）

const trimBase = (u) => String(u || "").trim().replace(/\/+$/, "");
const authHeaders = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

// 把 fetch 抛出的底层错误翻译成人话。fetch 在 CORS / 网络失败时抛 TypeError。
export function corsHint(e) {
  const msg = e?.message || String(e);
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
    return "无法直连：可能该站未开启 CORS，或地址/网络有误";
  }
  return msg;
}

// ── 额度：沿用参考项目 ai-quota-ext/api.js 的字段映射 ──────────
function normalizeTotal(sub) {
  const cand = [sub.hard_limit_usd, sub.system_hard_limit_usd, sub.soft_limit_usd];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number(sub.hard_limit_usd) || 0;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * 查询额度。
 * @returns {Promise<{total:number, used:number, remaining:number}>}
 */
export async function fetchQuota(baseUrl, apiKey) {
  const base = trimBase(baseUrl);
  const headers = authHeaders(apiKey);

  const subRes = await fetch(`${base}/v1/dashboard/billing/subscription`, { headers });
  if (!subRes.ok) throw new Error(`额度接口 HTTP ${subRes.status}`);
  const sub = await subRes.json();
  const total = normalizeTotal(sub);

  let used = 0;
  try {
    const now = new Date();
    const start = "2024-01-01";
    const end = ymd(new Date(now.getTime() + 86400000));
    const useRes = await fetch(
      `${base}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
      { headers }
    );
    if (useRes.ok) {
      const u = await useRes.json();
      used = Number(u.total_usage ?? 0) / 100;
    }
  } catch {
    /* 已用量拉取失败不致命 */
  }

  return { total, used, remaining: Math.max(total - used, 0) };
}

// ── 站点指纹：沿用参考项目的 /api/status 识别 ────────────────
const NEW_API_MARKERS = [
  "setup", "chats", "HeaderNavModules", "default_use_auto_group",
  "data_export_default_time", "quota_display_type", "self_use_mode_enabled",
  "linuxdo_oauth", "telegram_oauth", "usd_exchange_rate",
  "stripe_unit_price", "demo_site_enabled",
];

/**
 * 探测 Base URL 指向的中转站类型（公开接口，无需 key）。
 * @returns {Promise<{type:'one-api'|'new-api'|'unknown', version:string, systemName:string}>}
 */
export async function detectStation(baseUrl) {
  const base = trimBase(baseUrl);
  const res = await fetch(`${base}/api/status`);
  if (!res.ok) throw new Error(`/api/status HTTP ${res.status}`);
  const json = await res.json();
  const d = (json && json.data) || {};

  let type = "unknown";
  if (NEW_API_MARKERS.some((k) => k in d)) {
    type = "new-api";
  } else if ("quota_per_unit" in d || "display_in_currency" in d || "version" in d) {
    type = "one-api";
  }
  return {
    type,
    version: d.version || "",
    systemName: d.system_name || "",
  };
}

// ── 模型列表 ─────────────────────────────────────────────────
/**
 * 列出该站可用模型 id（升序）。
 * @returns {Promise<string[]>}
 */
export async function listModels(baseUrl, apiKey) {
  const res = await fetch(`${trimBase(baseUrl)}/v1/models`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`/v1/models HTTP ${res.status}`);
  const json = await res.json();
  const ids = (json.data || json.models || [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ── 单模型连通性（最短请求 + 延迟）──────────────────────────
/**
 * 发一条最短 chat 请求探活。
 * @returns {Promise<{ok:boolean, latency:number, status?:number, error?:string}>}
 */
export async function testModel(baseUrl, apiKey, model, { signal } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${trimBase(baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(apiKey),
      signal,
      body: JSON.stringify({
        // 极短探活请求。max_tokens 给 16（而非 1）：推理型模型会先消耗预算做
        // 推理，给 1 会「还没输出就到顶」而 400 报错，给 16 仍极短、几乎无成本。
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 16,
        stream: false,
      }),
    });
    const latency = Math.round(performance.now() - t0);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j.error?.message || j.message || msg;
      } catch {
        /* 非 JSON 错误体，保留 HTTP 状态 */
      }
      return { ok: false, latency, status: res.status, error: msg };
    }
    // 200：消费掉响应体以确保请求完整结束
    await res.json().catch(() => {});
    return { ok: true, latency, status: res.status };
  } catch (e) {
    if (e?.name === "AbortError") throw e; // 由调用方处理（停止）
    return { ok: false, latency: Math.round(performance.now() - t0), error: corsHint(e) };
  }
}
