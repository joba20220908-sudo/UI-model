#!/usr/bin/env node
// MindDeck 本地视觉代理 —— CORS 兜底
//
// 用途：浏览器直连 https://open.bigmodel.cn 被 CORS 拦截时，启用本代理。
// 用法：
//   ZHIPU_API_KEY=your_key node scripts/vision-proxy.js
//   （默认监听 http://localhost:8787）
//
// 然后在浏览器 Console 设置切换：
//   localStorage.setItem('minddeck:use_proxy', '1')
// 或在 askViaZhipu 函数里把 endpoint 临时改成 http://localhost:8787/vision
//
// 本脚本零依赖，纯 Node 原生 http 模块。

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.ZHIPU_API_KEY;
const UPSTREAM = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

if (!API_KEY) {
  console.error('❌ 缺少环境变量 ZHIPU_API_KEY');
  console.error('   用法：ZHIPU_API_KEY=your_key node scripts/vision-proxy.js');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // CORS：允许任意来源（仅本地开发用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/vision') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'POST /vision only' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const url = new URL(UPSTREAM);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const upstream = https.request(opts, upRes => {
      res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
      upRes.pipe(res);
    });
    upstream.on('error', err => {
      console.error('upstream error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    upstream.write(body);
    upstream.end();
  });
});

server.listen(PORT, () => {
  console.log(`✅ MindDeck vision proxy 监听 http://localhost:${PORT}`);
  console.log(`   转发目标：${UPSTREAM}`);
  console.log(`   前端 endpoint 改为 http://localhost:${PORT}/vision 即可`);
});
