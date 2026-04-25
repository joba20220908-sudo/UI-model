// ============================================================
// MindDeck — AI 热点定位 adapter 层
// ============================================================
// 把"识图找热点"抽象成 provider 链：
//   ocrServer    → 本地 OCR + LLM 语义匹配（推荐，精度高、无 CORS）
//   windowClaude → Claude Code Web 预览注入的 window.claude（仅云端预览）
//   zhipuVision  → 直连智谱 vision 模型（兜底，限流严）
//
// 接口契约：
//   provider.locate({img, targets, opts}) →
//     { candidates: { label: [{xInFull, yInFull, w, h, conf}, ...] },
//       fullW, fullH,
//       source: '<provider-name>' }
//   返回 null 表示"未命中/不可用"，调用方继续尝试下一个 provider。
//
// 加新 provider 只需 push 到 LocatorChain 即可，autolocateNode 不用动。
// ============================================================

(function () {
  'use strict';

  // ----- 工具函数 -----

  function extractJsonArray(text) {
    let s = (text || '').trim();
    const m = s.match(/\[[\s\S]*\]/);
    if (m) s = m[0];
    try { return JSON.parse(s); } catch { return null; }
  }

  // 把整图切片（OpenAI 兼容的 vision 模型对单图尺寸敏感，长图必须分块）
  // 返回 [{b64, tileW, tileH, offsetYInFull, fullW, fullH}, ...]
  async function sliceForModel(img, { targetW = 900, tileH = 900, overlap = 300 } = {}) {
    const scale = Math.min(1, targetW / img.naturalWidth);
    const fullW = Math.round(img.naturalWidth * scale);
    const fullH = Math.round(img.naturalHeight * scale);
    const full = document.createElement('canvas');
    full.width = fullW; full.height = fullH;
    full.getContext('2d').drawImage(img, 0, 0, fullW, fullH);
    const tiles = [];
    if (fullH <= tileH) {
      tiles.push({ canvas: full, tileW: fullW, tileH: fullH, offsetYInFull: 0, fullW, fullH });
    } else {
      let y = 0;
      while (y < fullH) {
        const h = Math.min(tileH, fullH - y);
        const c = document.createElement('canvas');
        c.width = fullW; c.height = h;
        c.getContext('2d').drawImage(full, 0, y, fullW, h, 0, 0, fullW, h);
        tiles.push({ canvas: c, tileW: fullW, tileH: h, offsetYInFull: y, fullW, fullH });
        if (y + h >= fullH) break;
        y += (tileH - overlap);
      }
    }
    return tiles.map(t => ({
      b64: t.canvas.toDataURL('image/jpeg', 0.8).split(',')[1],
      tileW: t.tileW, tileH: t.tileH,
      offsetYInFull: t.offsetYInFull, fullW: t.fullW, fullH: t.fullH
    }));
  }

  // 限并发 map（避免触发智谱 QPS 限流 429）
  async function runWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  // 解析 vision LLM 返回的 bbox：自动识别 [x,y,w,h] 还是 [x1,y1,x2,y2]
  function parseTileBboxes(arr, tile) {
    const out = [];
    for (const item of arr || []) {
      if (!item || !Array.isArray(item.bbox) || item.bbox.length !== 4) continue;
      const conf = Number(item.confidence) || 0;
      if (conf <= 0) continue;
      let [a, b, c, d] = item.bbox.map(Number);
      if (![a, b, c, d].every(Number.isFinite)) continue;
      if (a === 0 && b === 0 && c === 0 && d === 0) continue;
      let x = a, y = b, w = c, h = d;
      const exceedsAsXYWH = (a + c) > tile.tileW * 1.1 || (b + d) > tile.tileH * 1.1;
      const validAsXYXY = c > a && d > b && (c - a) > 0 && (d - b) > 0 && (c - a) < tile.tileW && (d - b) < tile.tileH;
      if (exceedsAsXYWH && validAsXYXY) { w = c - a; h = d - b; }
      if (w <= 0 || h <= 0) continue;
      if (w >= tile.tileW * 0.98 && h >= tile.tileH * 0.98) continue;
      out.push({
        label: item.label,
        xInFull: x, yInFull: y + tile.offsetYInFull,
        w, h, conf
      });
    }
    return out;
  }

  function buildPrompt(tile, targets) {
    return `这是一张移动端 APP 截图的一部分,尺寸 ${tile.tileW}×${tile.tileH} 像素(坐标原点在本切片左上角)。

请在本切片中找以下目标元素对应的可点击区域(按钮/导航项/列表行/卡片/Tab 标签),返回紧贴其外边框的 bbox 像素坐标。

目标元素:
${targets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

规则:
- 仅返回**本切片内**能看到的元素;完全不在本切片内的目标不要返回
- 短文本 tab/按钮:bbox 覆盖整个按钮容器,不要只框文字
- 列表行:bbox 宽度覆盖整行
- 若同一目标出现多次,取最上面/最醒目那一个
- 忽略状态栏、底部系统 Tab Bar、返回图标等无关元素
- confidence 表示你对定位的把握 (0.0-1.0)

严格返回 JSON 数组,无任何额外文字或代码块标记:
[{"label":"原样复制的目标文字","bbox":[x,y,w,h],"confidence":0.0-1.0}]
如果本切片中一个目标都没找到,返回 []`;
  }

  // 把切片识别结果聚合为 candidates
  function aggregateTileCandidates(tileResults) {
    const candidates = {};
    for (const items of tileResults) {
      for (const it of items) {
        (candidates[it.label] = candidates[it.label] || []).push({
          xInFull: it.xInFull, yInFull: it.yInFull,
          w: it.w, h: it.h, conf: it.conf
        });
      }
    }
    return candidates;
  }

  // ============================================================
  // Provider 1: 本地 OCR + LLM 语义匹配服务
  // ============================================================
  const OCR_LOCATE_URL = 'http://localhost:8788/ocr-locate';

  const ocrServerProvider = {
    name: 'ocr-server',
    async locate({ img, targets }) {
      let b64;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        b64 = canvas.toDataURL('image/png').split(',')[1];
      } catch (e) {
        console.warn('[locator/ocr] 图片转 base64 失败:', e.message);
        return null;
      }
      const zhipuKey = localStorage.getItem('minddeck:zhipu_key') || '';
      let resp;
      try {
        resp = await fetch(OCR_LOCATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: b64, targets, zhipu_key: zhipuKey })
        });
      } catch (e) {
        console.info('[locator/ocr] 本地服务未启动（' + OCR_LOCATE_URL + '），跳过此 provider。启用方法：bash scripts/start.sh');
        return null;
      }
      if (!resp.ok) { console.warn('[locator/ocr] 服务返回 ' + resp.status); return null; }
      const data = await resp.json().catch(() => null);
      if (!data || !data.ok) return null;

      const matchSource = data.match_source || 'unknown';
      console.info(`[locator/ocr] ${(data.ocr_items || []).length} 条文本，匹配方式: ${matchSource}，fullSize ${data.fullW}×${data.fullH}`);
      const candidates = {};
      let hits = 0, miss = 0;
      for (const r of (data.results || [])) {
        if (r.status !== 'ok' || !r.bbox) { miss++; continue; }
        const [x, y, w, h] = r.bbox;
        if (w <= 0 || h <= 0) { miss++; continue; }
        (candidates[r.label] = candidates[r.label] || []).push({
          xInFull: x, yInFull: y, w, h, conf: r.confidence || 1.0
        });
        hits++;
      }
      console.info(`[locator/ocr/${matchSource}] ${hits}/${targets.length} 命中（miss ${miss}）`);
      if (hits === 0) return null;
      return { candidates, fullW: data.fullW, fullH: data.fullH, source: 'ocr-server' };
    }
  };

  // ============================================================
  // Provider 2: Claude Code Web 注入的 window.claude
  // ============================================================
  const windowClaudeProvider = {
    name: 'window-claude',
    async locate({ img, targets }) {
      if (typeof window.claude === 'undefined' || !window.claude.complete) return null;
      const tiles = await sliceForModel(img);
      const tileResults = await runWithConcurrency(tiles, 1, async (tile) => {
        try {
          const raw = await window.claude.complete({
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: tile.b64 } },
              { type: 'text', text: buildPrompt(tile, targets) }
            ]}]
          });
          return parseTileBboxes(extractJsonArray(raw), tile);
        } catch (e) {
          console.warn('[locator/claude] tile 失败:', e.message);
          return [];
        }
      });
      const candidates = aggregateTileCandidates(tileResults);
      return { candidates, fullW: tiles[0].fullW, fullH: tiles[0].fullH, source: 'window-claude' };
    }
  };

  // ============================================================
  // Provider 3: 直连智谱 vision（兜底）
  // ============================================================
  const zhipuVisionProvider = {
    name: 'zhipu-vision',
    model: 'glm-5v-turbo',
    // 内置 429 指数退避（智谱免费/低档 RPM 严格）
    async _askTile(tile, prompt, maxRetry = 4) {
      let apiKey = localStorage.getItem('minddeck:zhipu_key');
      if (!apiKey) {
        apiKey = window.prompt('请输入智谱 API Key（只存在本地 localStorage，不会上传）：');
        if (!apiKey) throw new Error('未提供 API Key');
        localStorage.setItem('minddeck:zhipu_key', apiKey.trim());
      }
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${tile.b64}` } },
              { type: 'text', text: prompt }
            ]}]
          })
        });
        if (resp.status === 429 && attempt < maxRetry) {
          const retryAfter = Number(resp.headers.get('Retry-After')) || 0;
          const wait = Math.max(retryAfter * 1000, 2000 * Math.pow(2, attempt));
          console.warn(`[locator/zhipu 429] 第 ${attempt + 1}/${maxRetry} 次重试，等待 ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          if (resp.status === 401) localStorage.removeItem('minddeck:zhipu_key');
          throw new Error(`Zhipu API ${resp.status}: ${err.error?.message || resp.statusText}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      }
      throw new Error('Zhipu API 429 重试 ' + maxRetry + ' 次后仍然限流');
    },
    async locate({ img, targets }) {
      const tiles = await sliceForModel(img);
      const tileResults = await runWithConcurrency(tiles, 1, async (tile) => {
        try {
          const raw = await this._askTile(tile, buildPrompt(tile, targets));
          return parseTileBboxes(extractJsonArray(raw), tile);
        } catch (e) {
          console.warn('[locator/zhipu] tile 失败:', e.message);
          return [];
        }
      });
      const candidates = aggregateTileCandidates(tileResults);
      return { candidates, fullW: tiles[0].fullW, fullH: tiles[0].fullH, source: 'zhipu-vision' };
    }
  };

  // ============================================================
  // 默认链 & 统一入口
  // ============================================================
  window.LocatorProviders = {
    ocrServer: ocrServerProvider,
    windowClaude: windowClaudeProvider,
    zhipuVision: zhipuVisionProvider,
  };
  window.LocatorChain = [ocrServerProvider, windowClaudeProvider, zhipuVisionProvider];

  // 主入口：按链顺序尝试，第一个返回非空 candidates 的赢
  window.locateHotspots = async function ({ img, targets, opts = {} }) {
    for (const p of window.LocatorChain) {
      try {
        const r = await p.locate({ img, targets, opts });
        if (r && r.candidates && Object.keys(r.candidates).length) {
          return r;
        }
      } catch (e) {
        console.warn(`[locator] ${p.name} 抛异常:`, e.message);
      }
    }
    return null;
  };
})();
