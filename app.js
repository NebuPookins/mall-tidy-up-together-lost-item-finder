// "Mall: Tidy Up Together" save-file map viewer.
// Reads a .sav (UE4 GVAS) file in the browser and draws a top-down canvas map:
//   grey  = Result 1 (on a shelf)
//   blue  = Result 0 (on the ground somewhere)
//   orange = hardcoded player spawn point (-1317, 21.3, 16)
(function () {
  'use strict';

  // ---- palette (light theme) ----
  var COLORS = {
    surface: '#fcfcfb',
    ink: '#0b0b0b',
    ink2: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    onShelf: '#8f8e88',   // grey
    offShelf: '#2a78d6',  // blue
    spawn: '#eb6834'      // orange
  };

  var SPAWN = { x: -1317.0, y: 21.3, z: 16.0 };

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('map');
  var ctx = canvas.getContext('2d');
  var dropzone = $('dropzone');
  var fileInput = $('file');
  var summary = $('summary');
  var errorBox = $('error');
  var tooltip = $('tooltip');
  var donateOverlay = $('donateOverlay');

  // ---- app state ----
  var items = [];            // extracted {cat, typ, slot, result, x, y, z}
  var onShelf = [];          // result === 1
  var offShelf = [];         // result === 0
  var bounds = null;         // {xmin, xmax, ymin, ymax}
  var view = { s: 1, tx: 0, ty: 0 }; // current scale + translation
  var baseScale = 1;         // fit scale for a fresh view
  var hoverItem = null;      // item currently under the cursor (or 'spawn')
  var currentFile = null;    // most recently loaded file (for the summary label)

  // ---- pure helpers ----
  function findField(el, key) {
    for (var i = 0; i < el.length; i++) {
      if (el[i].name && el[i].name.indexOf(key) === 0) return el[i];
    }
    return null;
  }

  function extractItems(productSave) {
    var out = [];
    for (var pi = 0; pi < productSave.value.length; pi++) {
      var el = productSave.value[pi];
      var cat = findField(el, 'Category').value;
      var typ = findField(el, 'Type').value;
      var shelves = findField(el, 'Shelves').value;
      var locations = findField(el, 'Locations').value;
      for (var i = 0; i < shelves.length; i++) {
        var si = shelves[i];
        var result = findField(si, 'Result').value;
        var loc = locations[i];
        var t = null;
        for (var k = 0; k < loc.length; k++) {
          if (loc[k].name === 'Translation') { t = loc[k]; break; }
        }
        var vec = t.value; // {x,y,z}
        out.push({ cat: cat, typ: typ, slot: i, result: result, x: vec.x, y: vec.y, z: vec.z });
      }
    }
    return out;
  }

  function computeBounds(pts) {
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < xmin) xmin = p.x;
      if (p.x > xmax) xmax = p.x;
      if (p.y < ymin) ymin = p.y;
      if (p.y > ymax) ymax = p.y;
    }
    // include the spawn point
    if (SPAWN.x < xmin) xmin = SPAWN.x;
    if (SPAWN.x > xmax) xmax = SPAWN.x;
    if (SPAWN.y < ymin) ymin = SPAWN.y;
    if (SPAWN.y > ymax) ymax = SPAWN.y;
    var padX = (xmax - xmin) * 0.04 || 1;
    var padY = (ymax - ymin) * 0.04 || 1;
    return { xmin: xmin - padX, xmax: xmax + padX, ymin: ymin - padY, ymax: ymax + padY };
  }

  function niceTicks(lo, hi, step) {
    var out = [];
    for (var v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-6; v += step) {
      if (v >= lo - 1e-6 && v <= hi + 1e-6) out.push(v);
    }
    return out;
  }

  function pickSteps(range) {
    // choose an x/y step so roughly 4-7 gridlines fit the range
    var target = range / 5;
    var mag = Math.pow(10, Math.floor(Math.log10(target)));
    var norm = target / mag;
    var step;
    if (norm < 1.5) step = mag;
    else if (norm < 3.5) step = 2 * mag;
    else if (norm < 7.5) step = 5 * mag;
    else step = 10 * mag;
    return step;
  }

  // world -> screen (current view)
  function sx(wx) { return (wx - bounds.xmin) * view.s + view.tx; }
  function sy(wy) { return (bounds.ymax - wy) * view.s + view.ty; }

  // ---- canvas sizing (device-pixel-ratio aware) ----
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.parentElement.getBoundingClientRect();
    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  // ---- rendering ----
  function render() {
    var dim = resize();
    var w = dim.w, h = dim.h;
    ctx.clearRect(0, 0, w, h);

    if (!bounds) return;

    // background
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, w, h);

    // grid + axes (only when zoomed out enough to be useful)
    if (view.s * (bounds.xmax - bounds.xmin) > 120) {
      var xStep = pickSteps(bounds.xmax - bounds.xmin);
      var yStep = pickSteps(bounds.ymax - bounds.ymin);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      var xticks = niceTicks(bounds.xmin, bounds.xmax, xStep);
      var yticks = niceTicks(bounds.ymin, bounds.ymax, yStep);
      ctx.beginPath();
      for (var i = 0; i < xticks.length; i++) {
        var gx = sx(xticks[i]);
        ctx.moveTo(gx, 0); ctx.lineTo(gx, h);
      }
      for (var j = 0; j < yticks.length; j++) {
        var gy = sy(yticks[j]);
        ctx.moveTo(0, gy); ctx.lineTo(w, gy);
      }
      ctx.stroke();
    }

    // grey dots (on-shelf) — the context layer
    ctx.fillStyle = COLORS.onShelf;
    for (var g = 0; g < onShelf.length; g++) {
      var p = onShelf[g];
      var px = sx(p.x), py = sy(p.y);
      if (px < -4 || px > w + 4 || py < -4 || py > h + 4) continue;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }

    // blue dots (off-shelf) — drawn larger and on top
    for (var b = 0; b < offShelf.length; b++) {
      var q = offShelf[b];
      var qx = sx(q.x), qy = sy(q.y);
      if (qx < -20 || qx > w + 20 || qy < -20 || qy > h + 20) continue;
      ctx.beginPath();
      ctx.arc(qx, qy, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(qx, qy, 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.offShelf;
      ctx.fill();
    }

    // spawn point marker (crosshair + ring)
    drawSpawn(w, h);

    // labels for off-shelf items
    ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    for (var l = 0; l < offShelf.length; l++) {
      drawOffShelfLabel(offShelf[l]);
    }
  }

  function drawSpawn(w, h) {
    var px = sx(SPAWN.x), py = sy(SPAWN.y);
    if (px < -40 || px > w + 40 || py < -40 || py > h + 40) return;
    ctx.strokeStyle = COLORS.spawn;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.stroke();
    // crosshair
    ctx.beginPath();
    ctx.moveTo(px - 15, py); ctx.lineTo(px + 15, py);
    ctx.moveTo(px, py - 15); ctx.lineTo(px, py + 15);
    ctx.stroke();
    // center dot
    ctx.fillStyle = COLORS.spawn;
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
    // label
    ctx.font = '700 11px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.ink2;
    ctx.fillText('Player spawn', px + 16, py - 8);
    ctx.font = '400 10px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText('(-1317, 21.3)', px + 16, py + 6);
  }

  function drawOffShelfLabel(item) {
    var px = sx(item.x), py = sy(item.y);
    var w = (bounds.xmax - bounds.xmin) * view.s;
    var h = (bounds.ymax - bounds.ymin) * view.s;
    if (px < -120 || px > w + 120 || py < -120 || py > h + 120) return;
    var txt = '#' + item.cat + '/' + item.typ + ' · slot ' + item.slot;
    ctx.fillStyle = COLORS.surface;
    ctx.strokeStyle = COLORS.surface;
    ctx.lineWidth = 3;
    ctx.strokeText(txt, px + 9, py - 7);
    ctx.fillStyle = COLORS.ink2;
    ctx.fillText(txt, px + 9, py - 7);
    ctx.font = '400 9.5px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.strokeStyle = COLORS.surface;
    ctx.strokeText('(' + item.x.toFixed(0) + ', ' + item.y.toFixed(0) + ')', px + 9, py + 6);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText('(' + item.x.toFixed(0) + ', ' + item.y.toFixed(0) + ')', px + 9, py + 6);
    ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  }

  function resetView() {
    if (!bounds) return;
    var dim = resize();
    baseScale = Math.min(
      (dim.w - 48) / (bounds.xmax - bounds.xmin),
      (dim.h - 48) / (bounds.ymax - bounds.ymin)
    );
    view.s = baseScale;
    view.tx = (dim.w - (bounds.xmax - bounds.xmin) * view.s) / 2;
    view.ty = (dim.h - (bounds.ymax - bounds.ymin) * view.s) / 2;
    render();
  }

  // ---- hover hit-testing ----
  function hitTest(mx, my) {
    var best = null, bestD = Infinity;
    // off-shelf items first (bigger grab radius)
    var r = 14, r2 = r * r;
    for (var i = 0; i < offShelf.length; i++) {
      var it = offShelf[i];
      var dx = sx(it.x) - mx, dy = sy(it.y) - my;
      var d2 = dx * dx + dy * dy;
      if (d2 < r2 && d2 < bestD) { bestD = d2; best = it; }
    }
    var sdx = sx(SPAWN.x) - mx, sdy = sy(SPAWN.y) - my;
    if (sdx * sdx + sdy * sdy < r2 && sdx * sdx + sdy * sdy < bestD) { best = 'spawn'; }
    // on-shelf items (smaller grab radius)
    r = 6; r2 = r * r;
    for (var j = 0; j < onShelf.length; j++) {
      var p = onShelf[j];
      var dx2 = sx(p.x) - mx, dy2 = sy(p.y) - my;
      var d3 = dx2 * dx2 + dy2 * dy2;
      if (d3 < r2 && d3 < bestD) { bestD = d3; best = p; }
    }
    return best;
  }

  function showTooltip(thing, mx, my) {
    var lines;
    if (thing === 'spawn') {
      lines = ['<b>Player spawn</b>', '(-1317.0, 21.3, 16.0)'];
    } else if (thing) {
      var status = thing.result === 0 ? 'On the ground' : 'On a shelf';
      lines = [
        '<b>#' + thing.cat + '/' + thing.typ + ' · slot ' + thing.slot + '</b>',
        status,
        '(' + thing.x.toFixed(1) + ', ' + thing.y.toFixed(1) + ', ' + thing.z.toFixed(1) + ')'
      ];
    } else {
      tooltip.style.display = 'none';
      return;
    }
    tooltip.innerHTML = lines.join('<br>');
    tooltip.style.display = 'block';
    // position, clamped to viewport
    var pad = 12;
    var tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    var left = mx + pad;
    var top = my + pad;
    if (left + tw > window.innerWidth - 8) left = mx - tw - pad;
    if (top + th > window.innerHeight - 8) top = my - th - pad;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  // ---- interaction ----
  var dragging = false, lastX = 0, lastY = 0;

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!bounds) return;
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var factor = Math.exp(-e.deltaY * 0.0015);
    var newS = Math.min(Math.max(view.s * factor, baseScale * 0.05), baseScale * 120);
    // keep world point under cursor fixed
    var wx = (mx - view.tx) / view.s;
    var wy = (my - view.ty) / view.s;
    view.s = newS;
    view.tx = mx - wx * view.s;
    view.ty = my - wy * view.s;
    render();
  }, { passive: false });

  canvas.addEventListener('mousedown', function (e) {
    if (!bounds) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', function (e) {
    if (dragging) {
      view.tx += e.clientX - lastX;
      view.ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      render();
      return;
    }
    if (!bounds) return;
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
      tooltip.style.display = 'none';
      return;
    }
    var hit = hitTest(mx, my);
    showTooltip(hit, e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', function () {
    dragging = false;
    canvas.style.cursor = 'grab';
  });

  $('reset').addEventListener('click', resetView);
  $('loadAnother').addEventListener('click', function () { fileInput.click(); });

  $('export').addEventListener('click', function () {
    if (!bounds) return;
    // export at full canvas resolution (no HTML overlay)
    var a = document.createElement('a');
    a.download = 'mall-map.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  });

  // ---- file loading ----
  function handleFile(file) {
    errorBox.style.display = 'none';
    if (!file) return;
    currentFile = file;
    fileInput.value = ''; // allow re-selecting the same file later
    var reader = new FileReader();
    reader.onerror = function () {
      showError('Could not read the file.');
    };
    reader.onload = function () {
      try {
        loadBytes(new Uint8Array(reader.result));
      } catch (err) {
        showError(err.message || String(err));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function loadBytes(bytes) {
    var parsed = parseGvas(bytes);
    var productSave = null;
    for (var i = 0; i < parsed.props.length; i++) {
      var p = parsed.props[i];
      if (p.name === 'ProductSave' && p.type === 'ArrayProperty') { productSave = p; break; }
    }
    if (!productSave) {
      throw new Error('No "ProductSave" array found. This does not look like a Mall: Tidy Up Together save file.');
    }

    items = extractItems(productSave);
    onShelf = items.filter(function (it) { return it.result === 1; });
    offShelf = items.filter(function (it) { return it.result === 0; });
    bounds = computeBounds(items);
    hoverItem = null;

    // summary
    $('total').textContent = items.length;
    $('onShelf').textContent = onShelf.length;
    $('offShelf').textContent = offShelf.length;
    $('filename').textContent = currentFile ? currentFile.name : '';
    summary.style.display = 'block';
    $('controls').style.display = 'flex';
    dropzone.style.display = 'none';
    $('mapWrap').style.display = 'block';

    resetView();
    showDonation();
  }

  function showError(msg) {
    errorBox.textContent = 'Error: ' + msg;
    errorBox.style.display = 'block';
  }

  // ---- donation modal ----
  function showDonation() {
    donateOverlay.hidden = false;
  }

  function hideDonation() {
    donateOverlay.hidden = true;
  }

  $('donateClose').addEventListener('click', hideDonation);
  donateOverlay.addEventListener('click', function (e) {
    if (e.target === donateOverlay) hideDonation();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !donateOverlay.hidden) hideDonation();
  });

  // ---- upload wiring ----
  dropzone.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove('over');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    e.stopPropagation(); // don't let the window-level fallback also handle it
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // fallback: dragging a file over the page but missing the dropzone
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && (!bounds || e.target !== canvas)) { handleFile(f); }
  });

  window.addEventListener('resize', function () {
    if (bounds) render();
  });

  // initial paint
  resize();
})();
