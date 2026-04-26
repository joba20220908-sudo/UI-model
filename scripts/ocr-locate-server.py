#!/usr/bin/env python3
"""
MindDeck 本地 OCR 定位服务（macOS Vision Framework 后端）

启动:
  python3 scripts/ocr-locate-server.py [port]    # 默认 8788

接口:
  POST /ocr-locate
  Body: {
    "image_b64": "<纯 base64 字符串，不含 data: 前缀>",
    "targets": ["近1月", "阶段涨幅", ...],         # 可选；保留只是为了向后兼容字符串匹配
    "languages": ["zh-Hans", "en-US"]            # 可选，默认中英
  }
  Response: {
    "ok": true,
    "fullW": 828,
    "fullH": 6056,
    # 全量 OCR 文本：留给前端做语义匹配（推荐）
    "ocr_items": [
      {"id": 0, "text": "基金详情", "bbox": [x, y, w, h], "confidence": 1.0},
      {"id": 1, "text": "近1月", "bbox": [x, y, w, h], "confidence": 1.0},
      ...
    ],
    # 服务端字符串匹配结果（仅 targets 非空时填充，作为简单 fallback）
    "results": [
      {"label": "近1月", "bbox": [x, y, w, h], "confidence": 1.0, "matchedText": "近1月", "status": "ok"},
      ...
    ]
  }

依赖（一次性）: pip3 install --user ocrmac pillow
"""

import base64
import hashlib
import io
import json
import os
import re
import sys
import threading
import traceback
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from PIL import Image
    from ocrmac import ocrmac
except ImportError as e:
    print(f"❌ 缺依赖: {e}\n请跑: pip3 install --user ocrmac pillow", file=sys.stderr)
    sys.exit(1)


# 切片参数：单片不超过 1500×∞，重叠 200，避免长图漏识别
TILE_H = 1500
OVERLAP = 200
# 切片并行上限（macOS Vision 线程安全；Intel Mac 4 路够用）
OCR_PARALLELISM = int(os.environ.get('OCR_PARALLELISM', '4'))

# OCR 结果缓存：sha256(image_bytes) → ocr_items
# 重复跑同一张图（评审反复操作）时秒级返回
_OCR_CACHE = {}
_OCR_CACHE_LOCK = threading.Lock()

# 语义匹配模型（智谱）
# - glm-4-flash: 轻量、响应快（< 2s）、文本任务足够、不挤 vision 配额。推荐。
# - glm-4.6: reasoning 模型，长 prompt 会被智谱断连（Remote end closed）
# 可通过环境变量 ZHIPU_MATCH_MODEL 覆盖
LLM_MATCH_MODEL = os.environ.get('ZHIPU_MATCH_MODEL', 'glm-4-flash')
LLM_MATCH_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'


def _ocr_one_tile(args):
    """单切片 OCR 任务：每个线程拿到独立 PIL Image（已 crop+load），只负责 save+OCR"""
    crop_img, offset_y, languages = args
    tmp = f'/tmp/_minddeck_ocr_{os.getpid()}_{offset_y}.png'
    crop_img.save(tmp)
    try:
        rs = ocrmac.OCR(
            tmp,
            language_preference=languages,
            recognition_level='accurate'
        ).recognize(px=True)
    except Exception as ex:
        print(f"  片 y={offset_y} OCR 失败: {ex}", file=sys.stderr, flush=True)
        rs = []
    finally:
        try: os.unlink(tmp)
        except: pass
    return [(text, conf, (x1, y1 + offset_y, x2, y2 + offset_y))
            for text, conf, (x1, y1, x2, y2) in rs]


def ocr_full_image(img: Image.Image, languages):
    """对长图分块并行 OCR，返回 [(text, conf, (x1,y1,x2,y2)), ...] 整图像素坐标。
    PIL Image 非线程安全，必须主线程预 crop 出独立 Image 后再分发给线程池"""
    W, H = img.size
    img.load()   # 强制把数据读完，避免 lazy 状态被多线程触发
    tiles_meta = []
    y = 0
    while y < H:
        h = min(TILE_H, H - y)
        crop = img.crop((0, y, W, y + h)).copy()  # .copy() 切断与原图的关联，独立内存
        crop.load()
        tiles_meta.append((crop, y, languages))
        if y + h >= H: break
        y += (TILE_H - OVERLAP)
    if len(tiles_meta) <= 1:
        return _ocr_one_tile(tiles_meta[0]) if tiles_meta else []
    with ThreadPoolExecutor(max_workers=min(OCR_PARALLELISM, len(tiles_meta))) as ex:
        all_lists = list(ex.map(_ocr_one_tile, tiles_meta))
    flat = []
    for lst in all_lists:
        flat.extend(lst)
    return flat


def ocr_full_image_cached(image_bytes, languages):
    """带缓存的 OCR：相同 image bytes 直接命中缓存"""
    key = hashlib.sha256(image_bytes).hexdigest() + ':' + ','.join(languages)
    with _OCR_CACHE_LOCK:
        cached = _OCR_CACHE.get(key)
    if cached is not None:
        return cached, True
    img = Image.open(io.BytesIO(image_bytes))
    items = ocr_full_image(img, languages)
    with _OCR_CACHE_LOCK:
        _OCR_CACHE[key] = items
    return items, False


def shortlist_ocr_for_targets(targets, ocr_items, max_per_target=10, min_total=30):
    """关键字预筛：缩小 OCR 候选给 LLM。
    避免 223 条全部喂给 LLM 导致长 prompt 出错或漏匹配。

    策略：
    - 优先字符匹配命中（保留 id）
    - 每个 target 留 top-N 个相似候选（按字符 overlap 计算）
    - 总条数下限保底（防止过窄）
    """
    by_id = {it['id']: it for it in ocr_items}
    keep_ids = set()
    for label in targets:
        # 1. 子串包含
        for it in ocr_items:
            if label in it['text'] or it['text'] in label:
                keep_ids.add(it['id'])
        # 2. 字符 overlap：每个 OCR 项跟当前 label 共享多少字
        if len(targets) <= 30:  # target 太多就不做相似度筛选
            scored = []
            label_chars = set(label)
            for it in ocr_items:
                if not it['text']: continue
                shared = label_chars & set(it['text'])
                if shared:
                    scored.append((len(shared), it['id']))
            scored.sort(reverse=True)
            for _, _id in scored[:max_per_target]:
                keep_ids.add(_id)
    # 保底：如果筛得太狠，加上 conf=1.0 的所有项
    if len(keep_ids) < min_total:
        for it in ocr_items:
            if it.get('confidence', 0) >= 0.9:
                keep_ids.add(it['id'])
            if len(keep_ids) >= min_total: break
    # 按原 id 顺序返回
    return [it for it in ocr_items if it['id'] in keep_ids]


def match_targets_via_llm(targets, ocr_items, zhipu_key):
    """调智谱文本模型做语义匹配。返回 {target_index → ocr_id} 映射，失败抛异常"""
    if not zhipu_key:
        raise RuntimeError('缺 zhipu_key')
    # 预筛：缩小候选集，避免长 prompt 漏匹配
    shortlist = shortlist_ocr_for_targets(targets, ocr_items)
    print(f"[ocr] LLM 候选预筛: {len(ocr_items)} → {len(shortlist)}")
    ocr_lines = '\n'.join(f'{it["id"]}. "{it["text"]}"' for it in shortlist)
    target_lines = '\n'.join(f'{i + 1}. "{t}"' for i, t in enumerate(targets))
    prompt = f'''你是 UI 原型工具的语义匹配助手。我会给你一组「目标 label」和一份「OCR 候选列表」，请为每个目标找到最匹配的 OCR 候选 id。

匹配优先级：
1. 精确字符匹配（如"近1月" 匹配 OCR "近1月"）—— 必须命中
2. 子串包含（如"基金详情" 匹配 OCR "基金详情页"）—— 必须命中
3. 语义同义（如"我的" 匹配 OCR "用户中心"、"确认" 匹配 "下一步"）
4. 跳转描述提取关键词（如"点击进入持仓详情" 匹配 OCR "持仓"）

【强制要求】
- 输出数组的元素数量必须**等于**目标数量（共 {len(targets)} 个）
- target_index 从 1 到 {len(targets)} 必须每个都有对应行，不能漏
- 完全无合理匹配时 matched_id=-1
- 仅当目标 label 里的关键词在 OCR 候选完全找不到时才用 -1

OCR 候选（id. "text"）：
{ocr_lines}

目标 label（编号. "label"）：
{target_lines}

严格输出 JSON 数组（共 {len(targets)} 项），不要任何额外文字、不要代码块标记、不要解释：
[{{"target_index":1,"matched_id":3}},{{"target_index":2,"matched_id":-1}}]'''

    body = json.dumps({
        'model': LLM_MATCH_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.1
    }).encode('utf-8')
    req = urllib.request.Request(
        LLM_MATCH_URL,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {zhipu_key}'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    raw = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    print(f"[ocr] LLM 原始返回: {raw[:500]}")
    m = re.search(r'\[[\s\S]*\]', raw)
    if not m:
        raise ValueError(f'LLM 返回无 JSON: {raw[:200]}')
    arr = json.loads(m.group(0))
    mapping = {}
    parsed_count = 0
    for it in arr:
        ti = it.get('target_index')
        mid = it.get('matched_id')
        parsed_count += 1
        if isinstance(ti, int) and isinstance(mid, int) and mid >= 0:
            mapping[ti] = mid
    print(f"[ocr] LLM 解析出 {parsed_count} 项，{len(mapping)} 命中")
    return mapping


def match_review_to_nodes(nodes, review_text, zhipu_key):
    """把会议纪要文本匹配到节点树。
    nodes: [{uid, title, note?, description?}, ...]（前端最多传 80 个）
    review_text: 评审会议纪要原文
    返回 list，与前端约定：
    [{"nodeUid":"n3","matchScore":0.9,"matchReason":"...","newConclusion":"...",
      "newTodos":[{"text":"...","status":"open"}],"resolveTodoIds":[]}, ...]
    未命中的纪要段不输出。失败抛异常。
    """
    if not zhipu_key:
        raise RuntimeError('缺 zhipu_key')
    if not nodes or not review_text or not review_text.strip():
        return []

    # 节点列表压缩：只保留 LLM 真正需要的字段
    slim = []
    for n in nodes[:80]:
        item = {'uid': n.get('uid'), 'title': n.get('title')}
        if n.get('note'): item['note'] = str(n['note'])[:120]
        if n.get('description'): item['description'] = str(n['description'])[:200]
        slim.append(item)
    node_json = json.dumps(slim, ensure_ascii=False)

    prompt = f'''你是 UI 评审助手。请把会议纪要中的各段评审内容匹配到对应的节点，并提取「评审结论」和「待确认事项」。

节点列表 (JSON):
{node_json}

会议纪要原文:
{review_text}

匹配指引：
1. 优先按节点 title 与纪要中页面/功能名匹配；title 模糊时参考 note/description
2. 一段纪要只对应一个节点；若覆盖多页，按段落分别匹配
3. 「评审结论」= 整页的决议性陈述（如"本页通过"、"按方案 B 修改"）
4. 「待确认事项」= 具体的待办/疑问（如"按钮文案待 PM 确认"），status="open" 默认
5. 纪要中明确标注「已解决」「已确认」的待确认事项 → 写到 resolveTodoIds（暂留空）
6. matchScore: 0~1，title 完全相同 0.95+，关键词命中 0.7~0.9，弱推断 0.5~0.7
7. 完全无法匹配的段落不输出

严格输出 JSON 数组（不加代码块、不加解释）：
[{{"nodeUid":"n3","matchScore":0.9,"matchReason":"纪要中『高净值首页』与节点 title 一致","newConclusion":"...","newTodos":[{{"text":"...","status":"open"}}],"resolveTodoIds":[]}}]'''

    body = json.dumps({
        'model': LLM_MATCH_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.2
    }).encode('utf-8')
    req = urllib.request.Request(
        LLM_MATCH_URL,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {zhipu_key}'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    raw = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    print(f"[review-match] LLM 原始返回: {raw[:500]}")
    m = re.search(r'\[[\s\S]*\]', raw)
    if not m:
        raise ValueError(f'LLM 返回无 JSON: {raw[:200]}')
    arr = json.loads(m.group(0))
    # 校验 + 过滤：必须含 nodeUid 且 nodeUid 在 nodes 列表里
    valid_uids = {n.get('uid') for n in nodes}
    cleaned = []
    for it in arr:
        if not isinstance(it, dict): continue
        uid = it.get('nodeUid')
        if uid not in valid_uids: continue
        # 标准化字段
        # 清掉 LLM 偶发回吐的 prompt 占位（"..." / "示例" / 空白）
        concl = str(it.get('newConclusion') or '').strip()
        if concl in ('', '...', '...。', '示例', '...示例...'):
            concl = None
        cleaned.append({
            'nodeUid': uid,
            'matchScore': float(it.get('matchScore') or 0),
            'matchReason': str(it.get('matchReason') or ''),
            'newConclusion': concl,
            'newTodos': [
                {'text': str(t.get('text') or '').strip(),
                 'status': 'resolved' if t.get('status') == 'resolved' else 'open'}
                for t in (it.get('newTodos') or []) if isinstance(t, dict) and (t.get('text') or '').strip()
            ],
            'resolveTodoIds': [str(x) for x in (it.get('resolveTodoIds') or []) if x],
        })
    print(f"[review-match] 命中 {len(cleaned)}/{len(arr)} 项")
    return cleaned


def build_results_from_mapping(targets, ocr_items, mapping):
    """按 target_index → ocr_id 映射构建 results 数组（与字符串匹配输出格式一致）"""
    out = []
    by_id = {it['id']: it for it in ocr_items}
    for i, label in enumerate(targets):
        ocr_id = mapping.get(i + 1)
        if ocr_id is None or ocr_id not in by_id:
            out.append({"label": label, "bbox": None, "confidence": 0, "status": "miss"})
            continue
        it = by_id[ocr_id]
        out.append({
            "label": label,
            "bbox": it['bbox'],
            "confidence": it['confidence'],
            "matchedText": it['text'],
            "status": "ok"
        })
    return out


def match_targets(ocr_results, targets):
    """对每个 target 字符串，从 OCR 结果里挑最佳命中"""
    out = []
    for label in targets:
        label = label.strip()
        if not label:
            out.append({"label": label, "bbox": None, "confidence": 0, "status": "empty-label"})
            continue
        # 模糊匹配：互相包含
        hits = []
        for text, conf, bbox in ocr_results:
            if label in text or text in label:
                # 长度差异越小越好（避免 "近6月" 匹配到 "6"）
                len_diff = abs(len(text) - len(label))
                hits.append((text, conf, bbox, len_diff))
        if not hits:
            out.append({"label": label, "bbox": None, "confidence": 0, "status": "miss"})
            continue
        # 排序：长度差小 > 置信度高 > y 小（取上面那个）
        hits.sort(key=lambda h: (h[3], -h[1], h[2][1]))
        text, conf, (x1, y1, x2, y2), _ = hits[0]
        out.append({
            "label": label,
            "bbox": [x1, y1, x2 - x1, y2 - y1],   # 转回 [x, y, w, h]
            "confidence": conf,
            "matchedText": text,
            "status": "ok"
        })
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 简洁日志
        sys.stdout.write(f"[ocr] {fmt % args}\n")

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_review_match(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            nodes = payload.get('nodes') or []
            review_text = payload.get('reviewText') or ''
            zhipu_key = (
                payload.get('zhipu_key')
                or os.environ.get('ZHIPU_API_KEY')
                or os.environ.get('ANTHROPIC_AUTH_TOKEN')
                or ''
            )
            if not nodes or not review_text.strip():
                self._send_json(400, {'ok': False, 'error': 'nodes 与 reviewText 都是必填'})
                return
            if not zhipu_key:
                self._send_json(400, {'ok': False, 'error': '服务端无 ZHIPU_API_KEY，且请求未带 zhipu_key'})
                return
            print(f"[review-match] 收到 {len(nodes)} 个节点 + {len(review_text)} 字纪要")
            # 直接返回数组（前端 fetch 后期望 Array）
            results = match_review_to_nodes(nodes, review_text, zhipu_key)
            body = json.dumps(results, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {'ok': False, 'error': str(e)})

    def do_POST(self):
        if self.path == '/review-match':
            self._handle_review_match()
            return
        if self.path != '/ocr-locate':
            self.send_response(404); self._cors(); self.end_headers()
            self.wfile.write(b'{"error":"POST /ocr-locate or /review-match only"}')
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            b64 = payload.get('image_b64', '')
            targets = payload.get('targets', [])
            languages = payload.get('languages') or ['zh-Hans', 'en-US']
            if not b64 or not targets:
                raise ValueError('image_b64 和 targets 都是必填')
            # 解码图片
            raw = base64.b64decode(b64)
            img = Image.open(io.BytesIO(raw))
            W, H = img.size
            print(f"[ocr] 收到 {W}×{H} 图，{len(targets)} 个 target")
            ocr_results, from_cache = ocr_full_image_cached(raw, languages)
            print(f"[ocr] OCR 出 {len(ocr_results)} 条文本（{'缓存命中' if from_cache else '新算'}）")
            # 全量 OCR：每项带稳定 id
            ocr_items = []
            for i, (text, conf, (x1, y1, x2, y2)) in enumerate(ocr_results):
                ocr_items.append({
                    "id": i,
                    "text": text,
                    "bbox": [x1, y1, x2 - x1, y2 - y1],
                    "confidence": conf
                })

            # 匹配策略（混合）：
            #   1. 字符串精确匹配命中的，直接采用（最准、零成本）
            #   2. 字符串没命中的 target，交给 LLM 做语义匹配（处理同义词/跳转描述/文档场景）
            # 这种分工让简单按钮场景 100% 准，复杂场景 LLM 补漏
            string_results = match_targets(ocr_results, targets) if targets else []
            results = list(string_results)
            match_source = 'string'
            zhipu_key = (
                payload.get('zhipu_key')
                or os.environ.get('ZHIPU_API_KEY')
                or os.environ.get('ANTHROPIC_AUTH_TOKEN')
                or ''
            )
            string_hits = sum(1 for r in string_results if r.get('status') == 'ok')

            if targets and zhipu_key:
                # 找出字符串没命中的 target（保持原索引以便后续合并）
                miss_indices = [i for i, r in enumerate(string_results) if r.get('status') != 'ok']
                if miss_indices:
                    miss_targets = [targets[i] for i in miss_indices]
                    print(f"[ocr] 字符串先命中 {string_hits}/{len(targets)}，剩 {len(miss_targets)} 个交给 LLM 语义匹配")
                    try:
                        mapping = match_targets_via_llm(miss_targets, ocr_items, zhipu_key)
                        llm_results = build_results_from_mapping(miss_targets, ocr_items, mapping)
                        # 合并：用 LLM 结果填回 string 漏掉的位置
                        for j, idx in enumerate(miss_indices):
                            if llm_results[j].get('status') == 'ok':
                                results[idx] = llm_results[j]
                        match_source = 'string+llm' if string_hits > 0 else 'llm'
                    except Exception as match_err:
                        print(f"[ocr] LLM 补漏失败，仅用字符串结果: {match_err}")
                else:
                    print(f"[ocr] 字符串已 {string_hits}/{len(targets)} 全命中，跳过 LLM")
            elif targets:
                print(f"[ocr] 字符串匹配 {string_hits}/{len(targets)} 命中（未提供 zhipu_key，跳过 LLM 补漏）")

            final_hits = sum(1 for r in results if r.get('status') == 'ok')
            print(f"[ocr] 最终 {final_hits}/{len(targets)} 命中（match_source={match_source}）")

            body = json.dumps({
                "ok": True,
                "fullW": W,
                "fullH": H,
                "ocr_items": ocr_items,
                "results": results,
                "match_source": match_source
            }, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            traceback.print_exc()
            err = json.dumps({"ok": False, "error": str(e)}).encode('utf-8')
            self.send_response(500)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(err)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    print(f"✅ MindDeck OCR 定位服务 → http://localhost:{port}")
    print(f"   接口: POST /ocr-locate · POST /review-match")
    print(f"   切片: {TILE_H}px 高，重叠 {OVERLAP}px")
    print(f"   后端: macOS Vision (ocrmac)")
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ocr] 退出")


if __name__ == '__main__':
    main()
