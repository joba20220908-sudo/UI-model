// ===== 导入/导出 UI =====
function openExportDialog() {
  closeAllPopovers();
  document.querySelectorAll('.modal-overlay').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>导出评审数据</span>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="export-summary" id="export-summary">统计中…</div>
        <label class="opt-row">
          <input type="radio" name="exp-mode" value="light" checked>
          <div>
            <div class="opt-title">轻量(推荐)</div>
            <div class="opt-desc">只含评论、热点位置、图片映射。<b>不包含图片 Blob</b>。体积小,适合多人同步评审结果;接收方需有相同的本地截图文件。</div>
          </div>
        </label>
        <label class="opt-row">
          <input type="radio" name="exp-mode" value="full">
          <div>
            <div class="opt-title">完整归档</div>
            <div class="opt-desc">包含所有上传/替换过的图片 Blob(base64 编码)。<b>体积大</b>(可能十几 MB),但可跨设备完整搬迁。</div>
          </div>
        </label>
      </div>
      <div class="modal-footer">
        <button class="pv-btn ghost" data-act="cancel">取消</button>
        <button class="pv-btn primary" data-act="export">导出下载</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());

  (async () => {
    const c = loadComments();
    const h = loadHotspotPositions();
    const o = loadImgOverrides();
    const cN = Object.values(c).reduce((n, a) => n + a.length, 0);
    const hN = Object.values(h).reduce((n, o) => n + Object.keys(o || {}).length, 0);
    const oN = Object.keys(o).length;
    let idbN = 0;
    try { idbN = (await idbAllEntries()).length; } catch {}
    overlay.querySelector('#export-summary').innerHTML =
      `<b>${cN}</b> 条评论 · <b>${hN}</b> 项热点位置 · <b>${oN}</b> 张替换截图(IDB 中共 ${idbN} 个 Blob)`;
  })();

  overlay.querySelector('[data-act="export"]').addEventListener('click', async () => {
    const mode = overlay.querySelector('input[name="exp-mode"]:checked').value;
    const btn = overlay.querySelector('[data-act="export"]');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      const data = await buildExport({ includeImages: mode === 'full' });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const suffix = mode === 'full' ? 'full' : 'light';
      const pid = (META.title || PROJECT_ID).replace(/[\s\/\\:]/g, '-');
      downloadJSON(`MindDeck-${pid}-${suffix}-${ts}.json`, data);
      overlay.remove();
    } catch (err) {
      alert('导出失败:' + (err.message || err));
      btn.disabled = false; btn.textContent = '导出下载';
    }
  });
}

function openImportDialog() {
  closeAllPopovers();
  document.querySelectorAll('.modal-overlay').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>导入评审数据</span>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="import-drop" id="import-drop">
          <div class="drop-icon">📥</div>
          <div class="drop-hint">点击选择文件,或拖拽 JSON 到这里</div>
          <div class="drop-filename" id="drop-filename">尚未选择</div>
          <input type="file" id="import-file" accept=".json,application/json" hidden>
        </div>
        <div class="import-preview" id="import-preview"></div>
        <div class="opt-group-title">合并策略</div>
        <label class="opt-row compact">
          <input type="radio" name="imp-strategy" value="merge-keep" checked>
          <div>
            <div class="opt-title">合并(保留本地)</div>
            <div class="opt-desc small">同 ID 的评论/热点以<b>本地为准</b>,只把新数据加进来。最安全。</div>
          </div>
        </label>
        <label class="opt-row compact">
          <input type="radio" name="imp-strategy" value="merge-overwrite">
          <div>
            <div class="opt-title">合并(以导入为准)</div>
            <div class="opt-desc small">同 ID 用<b>导入的</b>覆盖本地,本地独有的数据保留。</div>
          </div>
        </label>
        <label class="opt-row compact">
          <input type="radio" name="imp-strategy" value="replace">
          <div>
            <div class="opt-title">全量替换(危险)</div>
            <div class="opt-desc small">清空本地所有评审数据,完全替换为导入内容。<b style="color:#ef4444">不可撤销</b>。</div>
          </div>
        </label>
      </div>
      <div class="modal-footer">
        <button class="pv-btn ghost" data-act="cancel">取消</button>
        <button class="pv-btn primary" data-act="import" disabled>导入</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());

  const drop = overlay.querySelector('#import-drop');
  const fileInput = overlay.querySelector('#import-file');
  const filename = overlay.querySelector('#drop-filename');
  const preview = overlay.querySelector('#import-preview');
  const importBtn = overlay.querySelector('[data-act="import"]');
  let loadedData = null;

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) loadFile(f);
  });

  async function loadFile(file) {
    filename.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.schema !== 'minddeck' && data.schema !== 'proto-review') throw new Error('不是 MindDeck 存档格式');
      loadedData = data;
      const cN = Object.values(data.comments || {}).reduce((n, a) => n + a.length, 0);
      const hN = Object.values(data.hotspots || {}).reduce((n, o) => n + Object.keys(o || {}).length, 0);
      const iN = Object.keys(data.images || {}).length;
      preview.innerHTML = `
        <div class="preview-ok">✓ 已读取 · v${data.version} · 导出于 ${new Date(data.exportedAt).toLocaleString('zh-CN')}</div>
        <div class="preview-stats">
          <span><b>${cN}</b> 评论</span>
          <span><b>${hN}</b> 热点位置</span>
          <span><b>${Object.keys(data.imgOverridesMeta || {}).length}</b> 截图映射</span>
          ${data.includeImages ? `<span><b>${iN}</b> 图片 Blob</span>` : '<span class="muted">不含图片 Blob</span>'}
        </div>
      `;
      importBtn.disabled = false;
    } catch (err) {
      loadedData = null;
      preview.innerHTML = `<div class="preview-err">✗ 读取失败:${escapeHtml(err.message || String(err))}</div>`;
      importBtn.disabled = true;
    }
  }

  importBtn.addEventListener('click', async () => {
    if (!loadedData) return;
    const strategy = overlay.querySelector('input[name="imp-strategy"]:checked').value;
    if (strategy === 'replace' && !confirm('确认要清空本地所有评审数据,并用导入文件完全替换吗?此操作不可撤销。')) return;
    importBtn.disabled = true; importBtn.textContent = '导入中…';
    try {
      const stats = await applyImport(loadedData, strategy);
      overlay.remove();
      const node = nodeIndex.get(CURRENT);
      if (node) { renderScreen(node); renderInspector(node); }
      renderTree();
      updateCommentBadge();
      showToast(`导入完成 · ${stats.comments} 评论 · ${stats.hotspots} 热点${stats.images ? ' · ' + stats.images + ' 图片' : ''}`);
    } catch (err) {
      alert('导入失败:' + (err.message || err));
      importBtn.disabled = false; importBtn.textContent = '导入';
    }
  });
}

// 简易 toast
function showToast(msg, duration = 2600) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}
