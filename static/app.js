"use strict";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#paintCanvas");
const ctx = canvas.getContext("2d");
const PALETTE_STORAGE_KEY = "my-painter-shop-palettes";

const state = {
  config: null,
  lineImage: null,
  palette: [],
  paletteGroups: [],
  activePaletteGroupId: null,
  reimportGroup: null,
  activeColorId: null,
  strokes: [],
  undo: [],
  redo: [],
  drawing: false,
  currentStroke: null,
  paper: "square",
  zoom: 1,
  zoomMode: "fit",
  colorDraft: null,
  backgroundColor: "#ffffff",
};

function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function savePalettes() {
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(state.paletteGroups));
  } catch { /* local storage may be unavailable */ }
  fetch("/api/palettes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ palettes: state.paletteGroups }) }).catch(() => {});
}

function loadPalettes() {
  try {
    const saved = JSON.parse(localStorage.getItem(PALETTE_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return;
    state.paletteGroups = saved.filter((group) => group && Array.isArray(group.colors));
    state.activePaletteGroupId = state.paletteGroups[0]?.id || null;
    state.palette = state.paletteGroups[0]?.colors || [];
    state.activeColorId = state.palette[0]?.id || null;
  } catch { /* ignore invalid or unavailable saved data */ }
}

async function loadServerPalettes() {
  try {
    const response = await fetch("/api/palettes");
    const saved = await response.json();
    if (!Array.isArray(saved)) return;
    let local = [];
    try { local = JSON.parse(localStorage.getItem(PALETTE_STORAGE_KEY) || "[]"); } catch { /* ignore */ }
    if (!saved.length && local.length) {
      state.paletteGroups = local.filter((group) => group && Array.isArray(group.colors));
      state.activePaletteGroupId = state.paletteGroups[0]?.id || null;
      state.palette = state.paletteGroups[0]?.colors || [];
      savePalettes();
      return;
    }
    state.paletteGroups = saved.filter((group) => group && Array.isArray(group.colors));
    state.activePaletteGroupId = state.paletteGroups[0]?.id || null;
    state.palette = state.paletteGroups[0]?.colors || [];
  } catch { loadPalettes(); }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function setStatus(message, error = false) {
  const element = $("#status");
  element.textContent = message;
  element.classList.toggle("error", error);
}

function setZoom(value, mode = "manual") {
  state.zoom = Math.min(4, Math.max(0.02, value));
  state.zoomMode = mode;
  canvas.style.width = `${Math.round(canvas.width * state.zoom)}px`;
  canvas.style.height = `${Math.round(canvas.height * state.zoom)}px`;
  $("#zoomOutput").textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitCanvas() {
  const stage = $("#canvasStage");
  const style = getComputedStyle(stage);
  const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
  const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
  setZoom(Math.min(availableWidth / canvas.width, availableHeight / canvas.height), "fit");
}

function scheduleFit() {
  requestAnimationFrame(() => requestAnimationFrame(fitCanvas));
}

function paletteColor(id) {
  return state.palette.find((item) => item.id === id);
}

function snapshot() {
  return state.strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => [...point]),
  }));
}

function restore(value) {
  state.strokes = value.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => [...point]) }));
  render();
  updateUsedColors();
  updateHistoryButtons();
}

function checkpoint() {
  state.undo.push(snapshot());
  if (state.undo.length > 50) state.undo.shift();
  state.redo = [];
}

function updateHistoryButtons() {
  $("#undoButton").disabled = !state.undo.length;
  $("#redoButton").disabled = !state.redo.length;
}

function drawPaper(context, width, height) {
  context.fillStyle = state.backgroundColor;
  context.fillRect(0, 0, width, height);
}

function formatDimensions(format, sourceWidth = 1200, sourceHeight = 1200) {
  const longEdge = Math.max(sourceWidth, sourceHeight);
  if (format === "portrait") return [Math.round(longEdge * 0.75), longEdge];
  if (format === "landscape") return [longEdge, Math.round(longEdge * 0.75)];
  return [longEdge, longEdge];
}

function fittedRect(width, height) {
  if (!state.lineImage) return { x: 0, y: 0, width, height };
  const scale = Math.min(width / state.lineImage.naturalWidth, height / state.lineImage.naturalHeight);
  const fittedWidth = state.lineImage.naturalWidth * scale;
  const fittedHeight = state.lineImage.naturalHeight * scale;
  return {
    x: (width - fittedWidth) / 2,
    y: (height - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

function applyCanvasFormat(format, preserveStrokes = true) {
  const oldRect = fittedRect(canvas.width, canvas.height);
  const sourceWidth = state.lineImage?.naturalWidth || canvas.width;
  const sourceHeight = state.lineImage?.naturalHeight || canvas.height;
  const [width, height] = formatDimensions(format, sourceWidth, sourceHeight);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const newRect = {
    width: sourceWidth * scale,
    height: sourceHeight * scale,
  };
  newRect.x = (width - newRect.width) / 2;
  newRect.y = (height - newRect.height) / 2;
  if (preserveStrokes && state.strokes.length && oldRect.width) {
    const ratio = newRect.width / oldRect.width;
    const transform = (strokes) => strokes.forEach((stroke) => {
        stroke.points = stroke.points.map(([x, y]) => [
          newRect.x + (x - oldRect.x) * ratio,
          newRect.y + (y - oldRect.y) * ratio,
        ]);
        stroke.size *= ratio;
      });
    transform(state.strokes);
    state.undo.forEach(transform);
    state.redo.forEach(transform);
  }
  state.paper = format;
  canvas.width = width;
  canvas.height = height;
  render();
  scheduleFit();
}

function drawStroke(context, stroke) {
  const item = paletteColor(stroke.colorId);
  if (!item || !stroke.points.length) return;
  context.save();
  context.strokeStyle = item.color;
  context.fillStyle = item.color;
  context.lineWidth = stroke.size;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(stroke.points[0][0], stroke.points[0][1], stroke.size / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(...stroke.points[0]);
    for (let index = 1; index < stroke.points.length; index += 1) {
      context.lineTo(...stroke.points[index]);
    }
    context.stroke();
  }
  context.restore();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawPaper(ctx, canvas.width, canvas.height);
  state.strokes.forEach((stroke) => drawStroke(ctx, stroke));
  if (state.lineImage) {
    const fitted = fittedRect(canvas.width, canvas.height);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(state.lineImage, fitted.x, fitted.y, fitted.width, fitted.height);
    ctx.restore();
  }
}

function renderPalette() {
  const container = $("#palette");
  container.replaceChildren();
  const selector = $("#paletteSelector");
  selector.replaceChildren();
  state.paletteGroups.forEach((group) => selector.add(new Option(group.name, group.id)));
  selector.value = state.activePaletteGroupId || "";
  renderPaletteCards();
  const group = state.paletteGroups.find((item) => item.id === state.activePaletteGroupId);
  for (const item of (group?.colors || [])) {
    const row = document.createElement("div");
    row.className = `palette-row${item.id === state.activeColorId ? " active" : ""}`;
    row.innerHTML = `
      <span class="palette-swatch" style="background:${item.color}" aria-label="${item.color}"></span>
      <span class="palette-code">${escapeHtml(item.code)}</span>`;
    row.addEventListener("click", () => setActiveColor(item.id));
      container.append(row);
  }
  $("#paletteEmpty").hidden = state.palette.length > 0;
  updateActiveLabel();
}

function renderPaletteCards() {
  const cards = $("#paletteCards");
  if (!cards) return;
  cards.replaceChildren();
  const groups = document.body.classList.contains("palette-page")
    ? state.paletteGroups
    : state.paletteGroups.filter((group) => group.id === state.activePaletteGroupId);
  groups.forEach((group) => {
    const card = document.createElement("div");
    card.className = "palette-card";
    card.innerHTML = `<strong>${escapeHtml(group.name)}</strong><span class="palette-card-actions"><button type="button" class="rename-palette">重命名</button><button type="button" class="reimport-palette">重新导入</button><button type="button" class="delete-palette">删除</button></span><div class="palette-card-colors">${group.colors.map((item) => `<button type="button" class="palette-card-color" style="background:${item.color}" title="${escapeHtml(item.code)}">${escapeHtml(item.code)}</button>`).join("")}</div>`;
    card.querySelector(".rename-palette").addEventListener("click", () => {
      const name = window.prompt("调色板名称", group.name);
      if (name?.trim()) { group.name = name.trim(); savePalettes(); renderPalette(); }
    });
    card.querySelector(".reimport-palette").addEventListener("click", async () => {
      state.reimportGroup = group;
      $("#paletteName").value = group.name;
      $("#palettePath").value = group.sourcePath || "";
      $("#paletteDialog").showModal();
    });
    card.querySelector(".delete-palette").addEventListener("click", () => {
      if (!window.confirm(`确定删除“${group.name}”吗？`)) return;
      state.paletteGroups = state.paletteGroups.filter((item) => item.id !== group.id);
      if (state.activePaletteGroupId === group.id) state.activePaletteGroupId = state.paletteGroups[0]?.id || null;
      state.palette = state.paletteGroups.find((item) => item.id === state.activePaletteGroupId)?.colors || [];
      savePalettes(); renderPalette(); updateUsedColors();
    });
    card.querySelectorAll(".palette-card-color").forEach((button, index) => button.addEventListener("click", () => selectPaletteColor(group.colors[index])));
    cards.append(card);
  });
}

function selectPaletteColor(item) {
  state.activeColorId = item.id;
  state.colorDraft = item.color;
  updateActiveLabel();
  renderPaletteCards();
  $("#selectedPaletteColor").textContent = `${item.code} · ${item.color}`;
  $("#paletteColorPreview").style.backgroundColor = item.color;
  const [r, g, b] = item.color.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16));
  $("#redValue").value = r; $("#greenValue").value = g; $("#blueValue").value = b;
  drawColorWheel();
  ["redValue", "greenValue", "blueValue"].forEach((id) => $("#" + id).oninput = () => {
    state.colorDraft = `#${["redValue", "greenValue", "blueValue"].map((key) => Number($("#" + key).value).toString(16).padStart(2, "0")).join("")}`;
    $("#selectedPaletteColor").textContent = `${item.code} · ${state.colorDraft}`;
    $("#paletteColorPreview").style.backgroundColor = state.colorDraft;
  });
}

function drawColorWheel() {
  const canvas = $("#paletteColorWheel"), context = canvas.getContext("2d"), size = canvas.width, center = size / 2, radius = center - 4;
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - center, dy = y - center, distance = Math.sqrt(dx * dx + dy * dy), index = (y * size + x) * 4;
    if (distance > radius) { image.data[index + 3] = 0; continue; }
    const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const rgb = hsvToRgb(hue, distance / radius, 1);
    image.data.set([...rgb, 255], index);
  }
  context.putImageData(image, 0, 0);
}
function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 30) % 12; return v - v * s * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
  return [f(0), f(8), f(4)].map((value) => Math.round(value * 255));
}
drawColorWheel();
$("#paletteColorWheel").addEventListener("click", (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const canvas = event.currentTarget;
  const x = Math.round((event.clientX - rect.left) * canvas.width / rect.width);
  const y = Math.round((event.clientY - rect.top) * canvas.height / rect.height);
  const pixel = canvas.getContext("2d").getImageData(Math.max(0, Math.min(canvas.width - 1, x)), Math.max(0, Math.min(canvas.height - 1, y)), 1, 1).data;
  const item = paletteColor(state.activeColorId);
  if (!item) return;
  if (pixel[3] === 0) return;
  $("#paletteBrightness").value = 100;
  const rgb = [pixel[0], pixel[1], pixel[2]];
  state.colorDraft = `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  selectPaletteColor({ ...item, color: state.colorDraft });
});
$("#paletteBrightness").addEventListener("input", () => {
  const item = paletteColor(state.activeColorId);
  if (!item || !state.colorDraft) return;
  const rgb = state.colorDraft.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16));
  const value = Number($("#paletteBrightness").value) / 100;
  const scaled = rgb.map((channel) => Math.round(channel * value));
  state.colorDraft = `#${scaled.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  selectPaletteColor({ ...item, color: state.colorDraft });
});
$("#savePaletteColorButton").addEventListener("click", () => {
  const item = paletteColor(state.activeColorId);
  if (!item || !state.colorDraft) return;
  item.color = state.colorDraft;
  savePalettes(); renderPaletteCards();
  setStatus(`已保存 ${item.code} 的颜色。`);
});
function hslToRgb(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function escapeHtml(text) {
  const element = document.createElement("span");
  element.textContent = text;
  return element.innerHTML;
}

function setActiveColor(id) {
  state.activeColorId = id;
  renderPalette();
}

function updateActiveLabel() {
  const item = paletteColor(state.activeColorId);
  $("#activeColorLabel").textContent = item ? `当前：${item.code}` : "尚未选择颜色";
  $("#activeColorPreview").style.backgroundColor = item?.color || "transparent";
}

function updateUsedColors() {
  const ids = [...new Set(state.strokes.map((stroke) => stroke.colorId))];
  const used = ids.map(paletteColor).filter(Boolean);
  const container = $("#usedColors");
  container.replaceChildren();
  used.forEach((item) => {
    const button = document.createElement("button");
    button.className = "used-chip";
    button.innerHTML = `<i style="background:${item.color}"></i>${escapeHtml(item.code)}`;
    button.addEventListener("click", () => setActiveColor(item.id));
    container.append(button);
  });
  $("#usedEmpty").hidden = used.length > 0;
  fillSelect($("#replaceFrom"), used);
  fillSelect($("#replaceTo"), state.palette);
  $("#replaceButton").disabled = !used.length || state.palette.length < 2;
}

function fillSelect(select, items) {
  const old = select.value;
  select.replaceChildren();
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.code;
    select.append(option);
  });
  if (items.some((item) => item.id === old)) select.value = old;
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return [
    (event.clientX - rect.left) * canvas.width / rect.width,
    (event.clientY - rect.top) * canvas.height / rect.height,
  ];
}

canvas.addEventListener("pointerdown", (event) => {
  if (!paletteColor(state.activeColorId)) return setStatus("请先选择一个颜色。", true);
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  checkpoint();
  state.drawing = true;
  state.currentStroke = {
    colorId: state.activeColorId,
    size: Number($("#brushSize").value),
    points: [canvasPoint(event)],
  };
  state.strokes.push(state.currentStroke);
  $("#canvasEmpty").classList.add("hidden");
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drawing || !state.currentStroke) return;
  event.preventDefault();
  const point = canvasPoint(event);
  const previous = state.currentStroke.points.at(-1);
  if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1) return;
  state.currentStroke.points.push(point);
  render();
});

function finishStroke() {
  if (!state.drawing) return;
  state.drawing = false;
  state.currentStroke = null;
  updateUsedColors();
  updateHistoryButtons();
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);

$("#brushSize").addEventListener("input", (event) => {
  $("#brushOutput").textContent = `${event.target.value} px`;
});

$("#zoomOutButton").addEventListener("click", () => setZoom(state.zoom / 1.25));
$("#zoomInButton").addEventListener("click", () => setZoom(state.zoom * 1.25));
$("#fitButton").addEventListener("click", fitCanvas);
$("#canvasStage").addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
}, { passive: false });
window.addEventListener("resize", () => { if (state.zoomMode === "fit") fitCanvas(); });
new ResizeObserver(() => {
  if (state.zoomMode === "fit") fitCanvas();
}).observe($("#canvasStage"));

$("#undoButton").addEventListener("click", () => {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
});
$("#redoButton").addEventListener("click", () => {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
});

$("#paletteSelector").addEventListener("change", (event) => {
  state.activePaletteGroupId = event.target.value;
  state.palette = state.paletteGroups.find((group) => group.id === state.activePaletteGroupId)?.colors || [];
  state.activeColorId = state.palette[0]?.id || null;
  renderPalette();
  updateUsedColors();
});
$("#choosePaletteButton")?.addEventListener("click", () => { renderPalette(); $("#paletteEditorDialog").showModal(); });
$("#closePaletteEditorButton").addEventListener("click", () => $("#paletteEditorDialog").close());
$("#fillBackgroundButton").addEventListener("click", () => {
  const item = paletteColor(state.activeColorId);
  if (!item) return setStatus("请先选择一个色号。", true);
  checkpoint();
  state.backgroundColor = item.color;
  state.strokes = state.strokes.filter((stroke) => stroke.colorId === item.id);
  render();
  updateUsedColors();
  setStatus(`已用 ${item.code} 填充背景，并移除其他色号。`);
});
$("#paletteEditorName").addEventListener("input", (event) => {
  const group = state.paletteGroups.find((item) => item.id === state.activePaletteGroupId);
  if (!group) return;
  group.name = event.target.value.trim() || "未命名画材";
  savePalettes();
  renderPalette();
});

$("#replaceButton").addEventListener("click", () => {
  const from = $("#replaceFrom").value;
  const to = $("#replaceTo").value;
  if (!from || !to || from === to) return setStatus("请选择两个不同的色号。", true);
  checkpoint();
  state.strokes.forEach((stroke) => { if (stroke.colorId === from) stroke.colorId = to; });
  render();
  updateUsedColors();
  setStatus("已替换画面中的全部对应笔画。");
});

$("#papers").addEventListener("click", (event) => {
  const button = event.target.closest(".paper");
  if (!button) return;
  applyCanvasFormat(button.dataset.paper);
  document.querySelectorAll(".paper").forEach((item) => item.classList.toggle("selected", item === button));
  setStatus(`画布已切换为 ${button.textContent.trim()}。`);
});

async function openLineArt() {
  const path = $("#linePath").value.trim();
  if (!path) return setStatus("请输入线稿路径。", true);
  try {
    setStatus("正在载入线稿…");
    const data = await api("/api/images/open", { method: "POST", body: JSON.stringify({ path }) });
    const image = new Image();
    image.onload = () => {
      state.lineImage = image;
      state.strokes = [];
      state.undo = [];
      state.redo = [];
      applyCanvasFormat(state.paper, false);
      updateUsedColors();
      updateHistoryButtons();
      $("#canvasEmpty").classList.add("hidden");
      $("#exportButton").disabled = false;
      $("#lineDialog").close();
      setStatus(`已载入 ${data.name} · ${data.width} × ${data.height}`);
    };
    image.onerror = () => setStatus("浏览器无法解码这张图片。", true);
    image.src = data.dataUrl;
  } catch (error) { setStatus(error.message, true); }
}

async function recognizePalette() {
  const path = $("#palettePath").value.trim();
  if (!path) return setStatus("请输入色卡路径。", true);
  try {
    setStatus("正在识别色卡，这可能需要几秒…");
    const data = await api("/api/palette/recognize", { method: "POST", body: JSON.stringify({ path }) });
    const name = $("#paletteName").value.trim() || path.split(/[\\/]/).pop().replace(/\.[^.]+$/, "") || "未命名画材";
    const colors = data.colors.map((item) => ({ ...item, id: uid() }));
    const group = state.reimportGroup || { id: uid(), name, sourcePath: path, colors: [] };
    group.name = name;
    group.sourcePath = path;
    group.colors = colors;
    if (!state.reimportGroup) state.paletteGroups.push(group);
    state.reimportGroup = null;
    state.activePaletteGroupId = group.id;
    state.palette = group.colors;
    savePalettes();
    state.activeColorId = state.palette[0]?.id || null;
    renderPalette();
    updateUsedColors();
    render();
    $("#paletteDialog").close();
    setStatus(data.warning || `识别到 ${state.palette.length} 个色号，请检查并纠正结果。`, Boolean(data.warning));
  } catch (error) { setStatus(error.message, true); }
}

$("#openLineDialogButton").addEventListener("click", () => $("#lineDialog").showModal());
$("#openLineButton").addEventListener("click", (event) => {
  event.preventDefault();
  openLineArt();
});
$("#clearLineButton").addEventListener("click", () => {
  state.lineImage = null;
  render();
  $("#canvasEmpty").classList.toggle("hidden", state.strokes.length > 0);
  setStatus("已移除线稿，当前使用空白画布。已有笔画已保留。");
});
$("#openPaletteDialogButton").addEventListener("click", () => { state.reimportGroup = null; $("#paletteDialog").showModal(); });
$("#recognizeButton").addEventListener("click", (event) => {
  event.preventDefault();
  recognizePalette();
});
$("#paletteTab").addEventListener("click", () => switchPaletteTab("palette"));
$("#importPaletteTab").addEventListener("click", () => switchPaletteTab("import"));
function switchPaletteTab(tab) {
  const importing = tab === "import";
  $("#paletteSection").hidden = importing;
  $("#paletteImportSection").hidden = !importing;
  $("#paletteTab").classList.toggle("active", !importing);
  $("#importPaletteTab").classList.toggle("active", importing);
}
function switchTopPage(page) {
  const palette = page === "palette";
  document.body.classList.toggle("palette-page", palette);
  $("#paintPageTab").classList.toggle("active", !palette);
  $("#palettePageTab").classList.toggle("active", palette);
  if (palette) {
    $("#paletteSection").hidden = false;
    $("#paletteImportSection").hidden = false;
  } else {
    switchPaletteTab("palette");
  }
}
$("#paintPageTab").addEventListener("click", () => switchTopPage("paint"));
$("#palettePageTab").addEventListener("click", () => switchTopPage("palette"));

function setupAutocomplete(field) {
  const input = field.querySelector("input");
  const list = field.querySelector(".suggestions");
  const kind = field.dataset.kind;
  let matches = [];
  let active = -1;
  let timer;

  const close = () => { matches = []; active = -1; list.replaceChildren(); };
  const choose = (index) => {
    const match = matches[index];
    if (!match) return;
    input.value = match.path + (match.directory ? "/" : "");
    close();
    input.focus();
    if (match.directory) load();
  };
  const paint = () => {
    list.replaceChildren();
    matches.forEach((match, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `suggestion${index === active ? " active" : ""}`;
      button.textContent = `${match.directory ? "▸ " : ""}${match.path}`;
      button.addEventListener("mousedown", (event) => { event.preventDefault(); choose(index); });
      list.append(button);
    });
  };
  const load = async () => {
    try {
      const data = await api(`/api/files/complete?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(input.value)}`);
      matches = data.matches;
      active = matches.length ? 0 : -1;
      paint();
    } catch { close(); }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 120); });
  input.addEventListener("focus", load);
  input.addEventListener("blur", () => setTimeout(close, 100));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && matches.length) {
      event.preventDefault(); active = (active + 1) % matches.length; paint();
    } else if (event.key === "ArrowUp" && matches.length) {
      event.preventDefault(); active = (active - 1 + matches.length) % matches.length; paint();
    } else if (event.key === "Tab" && matches.length) {
      event.preventDefault(); choose(Math.max(0, active));
    } else if (event.key === "Escape") close();
    else if (event.key === "Enter" && !matches[active]?.directory) {
      close();
      (kind === "line_art" ? openLineArt : recognizePalette)();
    }
  });
}
document.querySelectorAll(".path-field").forEach(setupAutocomplete);

$("#exportButton").addEventListener("click", () => $("#exportDialog").showModal());
$("#confirmExport").addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    setStatus("正在导出 PNG…");
    render();
    const data = await api("/api/export", {
      method: "POST",
      body: JSON.stringify({ filename: $("#exportFilename").value, dataUrl: canvas.toDataURL("image/png") }),
    });
    $("#exportDialog").close();
    setStatus(`已导出到 ${data.path}`);
  } catch (error) { setStatus(error.message, true); }
});

async function initialize() {
    render();
    scheduleFit();
    await loadServerPalettes();
    renderPalette();
  updateUsedColors();
  try {
    state.config = await api("/api/config");
    const slash = (path) => path.endsWith("/") ? path : `${path}/`;
    $("#linePath").value = slash(state.config.paths.line_art_import);
    $("#palettePath").value = slash(state.config.paths.palette_import);
    $("#paletteName").value = "";
    $("#exportLocation").textContent = `保存到：${state.config.paths.finished_export}`;
    $("#exportButton").disabled = false;
    setStatus(`配置：${state.config.configPath}`);
  } catch (error) { setStatus(error.message, true); }
}

initialize();
