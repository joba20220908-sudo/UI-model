#!/usr/bin/env python3
"""parse-docx.py — 把 Word 需求文档解析为 MindDeck 项目骨架

用法：
    python3 scripts/parse-docx.py <input.docx> <output-project-dir> [--id <project-id>]

例：
    python3 scripts/parse-docx.py spec.docx Projects/my-project --id my-project

依赖（一次性）：
    pip3 install --user python-docx

行为：
    1. 解析 .docx 内 H1/H2/H3 层级建树
    2. 第一个 H1（如「一、功能简介」）整段并进根节点 note
    3. 第二个 H1（如「二、需求描述」）下的 H2 → depth=1 父节点，H3 → depth=2 页面节点
    4. 每个节点的 description 字段聚合其下所有段落 + 列表项（保留 `• ` 前缀）
    5. 节点首张内嵌图 → image 字段；额外图标记为 [图N] 留在 description 末尾
    6. 节点内 <w:tbl> → tables 字段（每表 {headers, rows}）
    7. 图片以内容 sha1 命名导出到 <output>/screenshots/
    8. data.js 输出扩展 schema（含 description / tables / nav_targets）
"""

import argparse
import hashlib
import json
import os
import re
import sys

try:
    from docx import Document
    from docx.oxml.ns import qn
except ImportError:
    print("❌ 缺少 python-docx，跑：pip3 install --user python-docx", file=sys.stderr)
    sys.exit(1)


# ----------------- 标题清洗 -----------------
TITLE_PREFIX_PATTERNS = [
    re.compile(r'^[一二三四五六七八九十百千]+、\s*'),     # 一、二、
    re.compile(r'^[IVXLCM]+\.\s*', re.IGNORECASE),        # I. II. iii.
    re.compile(r'^\d+[、\.]\s*'),                         # 1、 1.
    re.compile(r'^[（(]\d+[）)]\s*'),                     # (1) （1）
]


def clean_title(raw):
    t = (raw or '').strip()
    for p in TITLE_PREFIX_PATTERNS:
        t = p.sub('', t, count=1)
    return t.replace('\n', ' ').strip()


# ----------------- 段落 / 块解析 -----------------
def get_para_style(p):
    pPr = p.find(qn('w:pPr'))
    if pPr is None:
        return ''
    ps = pPr.find(qn('w:pStyle'))
    if ps is None:
        return ''
    return ps.get(qn('w:val')) or ''


def get_para_text(p):
    return ''.join(t.text or '' for t in p.iter(qn('w:t')))


def get_inline_image_rids(p):
    """返回该段落内所有 inline image 的 rId 列表（按出现顺序，可能多张）"""
    rids = []
    for blip in p.iter(qn('a:blip')):
        rid = blip.get(qn('r:embed'))
        if rid:
            rids.append(rid)
    return rids


def parse_table(tbl):
    """返回 {headers, rows}；headers 取第一行（若像表头），否则全归 rows"""
    rows = []
    for tr in tbl.findall(qn('w:tr')):
        cells = []
        for tc in tr.findall(qn('w:tc')):
            text = '\n'.join(
                ''.join(t.text or '' for t in p.iter(qn('w:t')))
                for p in tc.findall(qn('w:p'))
            ).strip()
            cells.append(text)
        rows.append(cells)
    if not rows:
        return None
    return {'headers': rows[0], 'rows': rows[1:]}


# ----------------- 图片导出 -----------------
def export_image(part, screenshots_dir, exported):
    """part: docx ImagePart；返回保存的文件名"""
    blob = part.blob
    digest = hashlib.sha1(blob).hexdigest()
    if digest in exported:
        return exported[digest]
    ext = (part.partname.rsplit('.', 1)[-1] or 'png').lower()
    if ext not in ('png', 'jpg', 'jpeg', 'gif', 'webp'):
        ext = 'png'
    fname = f'{digest}.{ext}'
    fpath = os.path.join(screenshots_dir, fname)
    if not os.path.exists(fpath):
        with open(fpath, 'wb') as f:
            f.write(blob)
    exported[digest] = fname
    return fname


# ----------------- 节点构造 -----------------
class Node:
    __slots__ = ('uid', 'depth', 'title', 'rawTitle', 'note', 'image',
                 'description_parts', 'extra_images', 'tables', 'children')

    def __init__(self, depth, raw_title):
        self.uid = None  # 后填
        self.depth = depth
        self.rawTitle = raw_title
        self.title = clean_title(raw_title)
        self.note = None
        self.image = None
        self.description_parts = []  # list of strings (含列表项前缀)
        self.extra_images = []        # 额外图片文件名（首张归 image，其余在此）
        self.tables = []
        self.children = []

    def add_para(self, text, list_style=False):
        if not text or not text.strip():
            return
        if list_style:
            text = '• ' + text.strip()
        self.description_parts.append(text)

    def add_image(self, fname):
        if self.image is None:
            self.image = fname
        else:
            self.extra_images.append(fname)

    def add_table(self, t):
        if t:
            self.tables.append(t)

    def to_dict(self, with_children=True):
        desc_parts = list(self.description_parts)
        if self.extra_images:
            desc_parts.append('（另附 {} 张参考图）'.format(len(self.extra_images)))
        description = '\n\n'.join(desc_parts) if desc_parts else None
        out = {
            'uid': self.uid,
            'depth': self.depth,
            'title': self.title,
            'rawTitle': self.rawTitle,
            'note': self.note,
            'image': self.image,
            'description': description,
            'tables': self.tables if self.tables else None,
            'nav_targets': None,  # Step 3 LLM pass 填
            'children': [c.to_dict() for c in self.children] if with_children else [],
        }
        return out


# ----------------- 主解析 -----------------
def parse_docx(input_path, project_id, output_dir):
    doc = Document(input_path)
    screenshots_dir = os.path.join(output_dir, 'screenshots')
    os.makedirs(screenshots_dir, exist_ok=True)
    exported = {}  # sha1 → filename

    # 根节点：标题取 docx core_properties.title；没设就用文件名
    doc_title = (doc.core_properties.title or '').strip()
    if not doc_title:
        stem = os.path.splitext(os.path.basename(input_path))[0]
        # 去除尾部时间戳类后缀（- 加 8+ 位数字）
        stem = re.sub(r'-\d{8,}$', '', stem)
        doc_title = stem
    root = Node(0, doc_title)

    # 状态：current_h1_phase ∈ {'intro', 'requirements', None}
    # intro = 第一个 H1（功能简介）— 内容并入 root.note
    # requirements = 第二个 H1（需求描述）— 创建 H2/H3 树
    h1_phase = None
    current_h2 = None
    current_h3 = None
    intro_paras = []  # 第一个 H1 阶段的内容（最后变成 root.note）
    intro_tables = []

    # 当前内容应该追加到的目标节点
    def current_target():
        if h1_phase == 'requirements':
            return current_h3 or current_h2
        return None  # intro 阶段单独处理

    # 遍历 body 子元素
    body = doc.element.body
    for child in body.iterchildren():
        tag = child.tag.split('}')[-1]

        if tag == 'p':
            style = get_para_style(child)
            text = get_para_text(child).strip()
            rids = get_inline_image_rids(child)

            if style == 'Heading1':
                if h1_phase is None:
                    # 首个 H1（如「一、功能简介」）→ 进入 intro 阶段，内容并入 root.note
                    h1_phase = 'intro'
                else:
                    # 第二个 H1（如「二、需求描述」）→ 进入 requirements 阶段
                    h1_phase = 'requirements'
                    current_h2 = None
                    current_h3 = None
                continue

            if style == 'Heading2' and h1_phase == 'requirements':
                current_h2 = Node(1, text)
                current_h3 = None
                root.children.append(current_h2)
                continue

            if style == 'Heading3' and h1_phase == 'requirements':
                if current_h2 is None:
                    # H3 没爹 → 兜底建一个无名 H2
                    current_h2 = Node(1, '')
                    current_h2.title = '(未分组)'
                    root.children.append(current_h2)
                current_h3 = Node(2, text)
                current_h2.children.append(current_h3)
                continue

            # 非 heading 段落
            if h1_phase == 'intro':
                if text:
                    intro_paras.append(text)
                # intro 阶段的图也提取（万一有）
                for rid in rids:
                    try:
                        part = doc.part.related_parts[rid]
                        fname = export_image(part, screenshots_dir, exported)
                        if root.image is None:
                            root.image = fname
                    except KeyError:
                        pass

            elif h1_phase == 'requirements':
                tgt = current_target()
                if tgt is None:
                    continue  # H1=requirements 但还没遇到 H2，丢弃
                # 文本
                is_list = (style == 'ListParagraph')
                if text:
                    tgt.add_para(text, list_style=is_list)
                # 图片
                for rid in rids:
                    try:
                        part = doc.part.related_parts[rid]
                        fname = export_image(part, screenshots_dir, exported)
                        tgt.add_image(fname)
                    except KeyError:
                        pass

        elif tag == 'tbl':
            t = parse_table(child)
            if h1_phase == 'intro':
                if t:
                    intro_tables.append(t)
            elif h1_phase == 'requirements':
                tgt = current_target()
                if tgt and t:
                    tgt.add_table(t)

    # intro 阶段：纯文本段落 → root.note；表格 → root.tables（避免重复）
    root.note = '\n\n'.join(intro_paras) if intro_paras else None
    if intro_tables:
        root.tables = intro_tables

    # pre-order 分配 uid
    counter = [0]

    def assign_uid(n):
        n.uid = 'n' + str(counter[0])
        counter[0] += 1
        for c in n.children:
            assign_uid(c)

    assign_uid(root)

    # 项目元信息
    meta = {'id': project_id, 'title': root.title or project_id, 'sub': None}
    return root, meta, exported


# ----------------- 输出 data.js -----------------
def render_data_js(meta, root):
    return (
        f'window.PROJECT_META = {json.dumps(meta, ensure_ascii=False)};\n'
        f'window.PROTOTYPE_TREE = {json.dumps(root.to_dict(), ensure_ascii=False, indent=2)};\n'
    )


# ----------------- CLI -----------------
def sanitize_id(name):
    base = os.path.splitext(os.path.basename(name))[0].lower()
    s = re.sub(r'[^a-z0-9一-鿿]+', '-', base)  # 保留中文
    return s.strip('-') or 'project'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='.docx 输入文件')
    ap.add_argument('output', help='输出项目目录')
    ap.add_argument('--id', help='项目 ID（默认从文件名推断）')
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(f'❌ 输入文件不存在: {args.input}', file=sys.stderr)
        sys.exit(1)

    project_id = args.id or sanitize_id(args.input)
    os.makedirs(args.output, exist_ok=True)

    print(f'解析中：{args.input}')
    root, meta, exported = parse_docx(args.input, project_id, args.output)

    data_js_path = os.path.join(args.output, 'data.js')
    with open(data_js_path, 'w', encoding='utf-8') as f:
        f.write(render_data_js(meta, root))

    # 统计
    def count_nodes(n):
        return 1 + sum(count_nodes(c) for c in n.children)

    def count_with_image(n):
        c = 1 if n.image else 0
        return c + sum(count_with_image(ch) for ch in n.children)

    def count_with_desc(n):
        c = 1 if n.description_parts else 0
        return c + sum(count_with_desc(ch) for ch in n.children)

    print(f'✓ 解析完成')
    print(f'  项目 ID         : {project_id}')
    print(f'  根标题          : {root.title}')
    print(f'  节点总数        : {count_nodes(root)}')
    print(f'  H2 父节点       : {len(root.children)}')
    print(f'  含截图节点      : {count_with_image(root)}')
    print(f'  含描述节点      : {count_with_desc(root)}')
    print(f'  截图文件（去重）: {len(exported)}')
    print(f'  data.js         : {data_js_path}')
    print('')
    print('下一步：从 Template/ 复制 Prototype.html / app.js / locator.js 到此目录，浏览器打开。')


if __name__ == '__main__':
    main()
