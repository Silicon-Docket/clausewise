/**
 * What the browser tests run inside the page. They are strings and not functions on purpose: a
 * function handed to `page.evaluate` is serialised from its transformed source, and the test
 * transform can rename a helper inside it. A string is the code that runs, character for character.
 *
 * `COLOR_MATH` has no page in it, so `judge.test.ts` runs the very same text in Node and pins its
 * answers (black on white is 21, and so on). `PRELUDE` is run once per page load, after which
 * `window.__pw` holds the readers that the other strings call. Nothing here changes the page: the
 * readers only look, and the one script that writes (`RESET_FOCUS`) moves where Tab starts from.
 *
 * Strings written here use no template placeholder and no backtick, so they can stay raw text.
 */

/** Relative luminance and contrast as WCAG 2.x defines them. Pure: no page, no DOM. */
export const COLOR_MATH = String.raw`
function parseColor(css, fallback) {
  var s = String(css).trim();
  var m = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*(?:[,/]\s*([0-9.]+)(%?)\s*)?\)$/.exec(s);
  if (m) {
    var a = m[4] === undefined ? 1 : m[5] === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  }
  m = /^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)(%?)\s*)?\)$/.exec(s);
  if (m) {
    var b = m[4] === undefined ? 1 : m[5] === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]) * 255, parseFloat(m[2]) * 255, parseFloat(m[3]) * 255, b];
  }
  if (s === 'transparent') return [0, 0, 0, 0];
  if (fallback) return fallback(s);
  throw new Error('a colour that is not understood');
}
function over(top, bottom) {
  var a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}
function channel(v) {
  var c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(c) {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}
function contrast(a, b) {
  var la = luminance(a);
  var lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function hex(c) {
  function h(v) { var n = Math.max(0, Math.min(255, Math.round(v))); return (n < 16 ? '0' : '') + n.toString(16); }
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}
`;

const PRELUDE_BODY = String.raw`(function () {
if (window.__pw) return 'ready';
//COLOR_MATH_HERE
var canvas = document.createElement('canvas');
canvas.width = 1;
canvas.height = 1;
var ctx = canvas.getContext('2d', { willReadFrequently: true });
function viaCanvas(css) {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000000';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  var d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}
function color(css) { return parseColor(css, viaCanvas); }
function style(el, pseudo) { return getComputedStyle(el, pseudo || null); }

var ids = new WeakMap();
var nextId = 1;
function idOf(el) {
  var i = ids.get(el);
  if (!i) { i = nextId++; ids.set(el, i); }
  return i;
}

function canvasColor() {
  var probe = document.createElement('div');
  probe.style.cssText = 'background-color: Canvas; position: absolute; width: 1px; height: 1px; left: -9999px; top: 0;';
  document.documentElement.appendChild(probe);
  var c = color(style(probe).backgroundColor);
  probe.remove();
  return c.slice(0, 3).concat([1]);
}

// The background a point of an element sits on: the page colour with every background colour from
// the root down to the element laid over it. A background image makes the answer a guess, and the
// reading says so. Opacity is carried as one number.
function bgOf(el, base) {
  var chain = [];
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
  chain.reverse();
  var out = base;
  var image = '';
  var opacity = 1;
  for (var i = 0; i < chain.length; i++) {
    var s = style(chain[i]);
    if (s.backgroundImage !== 'none') { var dd = desc(chain[i]); image = dd.tag + (dd.cls ? '.' + dd.cls.split(' ')[0] : ''); }
    var c = color(s.backgroundColor);
    if (c[3] > 0) out = over(c, out);
    var o = parseFloat(s.opacity);
    if (o < 1) opacity *= o;
  }
  return { color: out, image: image, opacity: opacity };
}

function desc(el) {
  return { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', id: el.id || '' };
}

function label(el) {
  var t = el.getAttribute('aria-label');
  if (!t) {
    var by = el.getAttribute('aria-labelledby');
    if (by) t = by.split(/\s+/).map(function (i) { var x = document.getElementById(i); return x ? x.textContent : ''; }).join(' ');
  }
  if (!t && el.labels && el.labels.length > 0) t = el.labels[0].textContent;
  if (!t && el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) t = el.value;
  if (!t) t = el.textContent;
  if (!t) t = el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 60);
}

function inClosedDetails(el) {
  for (var n = el.parentElement; n; n = n.parentElement) {
    if (n.tagName === 'DETAILS' && !n.open) {
      var first = n.firstElementChild;
      if (!(first && first.tagName === 'SUMMARY' && (el === first))) return true;
    }
  }
  return false;
}

function rendered(el) {
  if (el.getClientRects().length === 0) return false;
  if (style(el).visibility !== 'visible') return false;
  return !inClosedDetails(el);
}

var SEL = 'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

function tabbableNow(el) {
  if (el.matches(':disabled')) return false;
  if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
  if (el.closest('[inert]')) return false;
  if (el.tagName === 'SUMMARY') {
    var p = el.parentElement;
    if (!(p && p.tagName === 'DETAILS' && p.firstElementChild === el)) return false;
  } else if (el.tabIndex < 0) return false;
  return rendered(el);
}

function hasTabbableInside(el) {
  var list = el.querySelectorAll(SEL);
  for (var i = 0; i < list.length; i++) if (tabbableNow(list[i])) return true;
  return false;
}

// A box that scrolls and holds nothing a key can reach is a Tab stop in Chromium.
function scrollerStop(el) {
  if (el.tagName === 'BODY' || el.tagName === 'HTML') return false;
  if (!(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return false;
  var s = style(el);
  var scrolls = /(auto|scroll)/.test(s.overflowX) || /(auto|scroll)/.test(s.overflowY);
  if (!scrolls) return false;
  if (el.hasAttribute('tabindex')) return false;
  return rendered(el) && !hasTabbableInside(el);
}

function box(el) {
  var r = el.getClientRects()[0] || el.getBoundingClientRect();
  var left = r.left;
  var top = r.top;
  var right = r.right;
  var bottom = r.bottom;
  // A control inside a box that scrolls is drawn where the box shows it, not where its content
  // would lie if the box were as tall or as wide as the content.
  for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    var s = style(n);
    var c = null;
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) {
      c = n.getBoundingClientRect();
      if (top > c.bottom) { top = c.bottom - 1; bottom = c.bottom - 1; }
      else if (top < c.top) { top = c.top; bottom = c.top; }
    }
    if (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1) {
      c = n.getBoundingClientRect();
      if (left > c.right) { left = c.right - 1; right = c.right - 1; }
      else if (left < c.left) { left = c.left; right = c.left; }
    }
  }
  return { left: left + scrollX, top: top + scrollY, right: right + scrollX, bottom: bottom + scrollY };
}

// Every element that Tab can stop on, in document order, with where it sits on the page. A radio
// group is one stop: the chosen button, or the first when none is chosen (Chromium lands on the
// first going back as well, which is what the walks measured).
function tabbables() {
  var out = [];
  var seenGroups = {};
  var all = document.querySelectorAll('*');
  var groups = {};
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var isRadio = el.tagName === 'INPUT' && el.type === 'radio' && el.name;
    if (el.matches(SEL) && tabbableNow(el)) {
      if (isRadio) {
        var key = (el.form ? idOf(el.form) : 0) + ':' + el.name;
        (groups[key] = groups[key] || []).push(el);
        continue;
      }
      out.push({ el: el, scroller: false });
    } else if (scrollerStop(el)) out.push({ el: el, scroller: true });
  }
  // Put each radio group at the place of its representative.
  Object.keys(groups).forEach(function (key) {
    var list = groups[key];
    var chosen = list.filter(function (r) { return r.checked; })[0];
    var pick = chosen || list[0];
    out.push({ el: pick, scroller: false, group: key, groupSize: list.length });
  });
  out.sort(function (a, b) {
    if (a.el === b.el) return 0;
    return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return out.map(function (c) {
    var d = desc(c.el);
    var b = box(c.el);
    return {
      id: idOf(c.el), tag: d.tag, type: c.el.type || null, idAttr: d.id, cls: d.cls, label: label(c.el),
      tabIndex: c.el.tabIndex, scroller: c.scroller, group: c.group || null, groupSize: c.groupSize || 0,
      left: b.left, top: b.top, right: b.right, bottom: b.bottom
    };
  });
}

function stickyBottom(except) {
  var bottom = 0;
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var s = style(all[i]);
    if (s.position !== 'sticky' && s.position !== 'fixed') continue;
    if (except && all[i].contains(except)) continue;
    var r = all[i].getBoundingClientRect();
    if (r.width < innerWidth / 3 || r.height === 0) continue;
    if (r.top <= 1 && r.bottom > 0 && r.bottom > bottom) bottom = r.bottom;
  }
  return bottom;
}

function stuck(el) {
  for (var n = el; n && n !== document.body; n = n.parentElement) {
    var p = style(n).position;
    if (p === 'sticky' || p === 'fixed') return true;
  }
  return false;
}

function ringOf(el) {
  var s = style(el);
  var w = parseFloat(s.outlineWidth) || 0;
  var off = parseFloat(s.outlineOffset) || 0;
  var kind = 'none';
  var ring = null;
  if (s.outlineStyle !== 'none' && w > 0) { kind = 'outline'; ring = color(s.outlineColor); }
  else if (s.boxShadow && s.boxShadow !== 'none') {
    var m = /(rgba?\([^)]*\)|color\([^)]*\))/.exec(s.boxShadow);
    if (m) { kind = 'shadow'; ring = color(m[1]); }
  }
  var base = canvasColor();
  var ratios = [];
  var worst = null;
  if (ring) {
    var r = el.getClientRects()[0] || el.getBoundingClientRect();
    // An outline lies between off and off + w measured outwards from the border box. A shadow is
    // taken as a ring of four pixels outside it.
    var near = kind === 'outline' ? off : 0;
    var far = kind === 'outline' ? off + w : 4;
    if (far > 0) {
      // The part outside the box is seen against whatever is drawn just beyond it.
      var d = far + 1;
      var pts = [
        [r.left + r.width / 2, r.top - d], [r.left + r.width / 2, r.bottom + d],
        [r.left - d, r.top + r.height / 2], [r.right + d, r.top + r.height / 2]
      ];
      pts.forEach(function (p) {
        if (p[0] < 0 || p[1] < 0 || p[0] >= innerWidth || p[1] >= innerHeight) return;
        var stack = document.elementsFromPoint(p[0], p[1]);
        var under = null;
        for (var i = 0; i < stack.length; i++) { if (stack[i] !== el && !el.contains(stack[i])) { under = stack[i]; break; } }
        if (!under) return;
        // A part that sticks to the top is drawn over the ring there, and hides it; that is a matter
        // of what is covered (the stop reading says so), not of how well the ring reads.
        if (stuck(under)) return;
        var bg = bgOf(under, base).color;
        var q = contrast(over(ring, bg), bg);
        ratios.push(q);
        if (worst === null || q < worst.ratio) { var wd = desc(under); worst = { ratio: q, on: wd.tag + (wd.cls ? '.' + wd.cls.split(' ')[0] : '') }; }
      });
    }
    if (near < 0) {
      // The part inside the box is seen against the box's own fill.
      var own = bgOf(el, base).color;
      ratios.push(contrast(over(ring, own), own));
    }
    if (ratios.length === 0) {
      var parentBg = bgOf(el.parentElement || el, base).color;
      ratios.push(contrast(over(ring, parentBg), parentBg));
    }
  }
  return {
    kind: kind, style: s.outlineStyle, width: w, offset: off,
    color: ring ? hex(ring) : null, on: worst ? worst.on : null,
    ratio: ratios.length ? Math.round(Math.min.apply(null, ratios) * 100) / 100 : null
  };
}

function stop() {
  var el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { none: true };
  var d = desc(el);
  var r = el.getClientRects()[0] || el.getBoundingClientRect();
  var onscreen = r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  // Five points of the box (the middle and four corners, a little in): what is drawn over each?
  var sampled = 0;
  var hidden = 0;
  var coveredBy = null;
  if (onscreen) {
    var inset = Math.min(3, r.width / 4, r.height / 4);
    var pts = [
      [r.left + r.width / 2, r.top + r.height / 2], [r.left + inset, r.top + inset], [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset], [r.right - inset, r.bottom - inset]
    ];
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0];
      var y = pts[i][1];
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      sampled++;
      var top = document.elementFromPoint(x, y);
      if (top && top !== el && !el.contains(top)) {
        hidden++;
        coveredBy = top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '');
      }
    }
  }
  var covered = sampled > 0 && hidden === sampled;
  var partly = hidden > 0;
  // A box taller than the part of the window that is left under the sticky header cannot all be in view.
  var oversize = r.height > innerHeight - stickyBottom(el);
  var tabbable = (tabbableNow(el) && el.matches(SEL)) || scrollerStop(el);
  // Shift+Tab into a date field lands on the browser's own calendar button, which the browser draws
  // a ring on and which is not the field's own focus.
  var native = el.tagName === 'INPUT' && /^(date|time|datetime-local|month|week)$/.test(el.type) && !el.matches(':focus');
  return {
    none: false, native: native, id: idOf(el), tag: d.tag, type: el.type || null, idAttr: d.id, cls: d.cls, label: label(el),
    tabbable: tabbable, onscreen: onscreen, covered: covered, partly: partly, oversize: oversize, coveredBy: coveredBy,
    left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY,
    ring: ringOf(el)
  };
}

function textSamples() {
  var out = {};
  var base = canvasColor();
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var node;
  var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TITLE: 1, OPTION: 1, OPTGROUP: 1, TEXTAREA: 1 };
  while ((node = walker.nextNode())) {
    if (!/\S/.test(node.nodeValue || '')) continue;
    var el = node.parentElement;
    if (!el || skip[el.tagName]) continue;
    var range = document.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    var seen = false;
    for (var i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) seen = true;
    if (!seen || inClosedDetails(el)) continue;
    var s = style(el);
    if (s.visibility !== 'visible') continue;
    var hidden = false;
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var ns = style(n);
      if (parseFloat(ns.width) <= 1 && parseFloat(ns.height) <= 1 && ns.overflow === 'hidden') { hidden = true; break; }
    }
    if (hidden) continue;
    var fill = color(s.webkitTextFillColor || s.color);
    var fg = fill[3] > 0 ? fill : color(s.color);
    var bg = bgOf(el, base);
    var fgEff = over([fg[0], fg[1], fg[2], fg[3] * bg.opacity], bg.color);
    var px = parseFloat(s.fontSize);
    var weight = parseInt(s.fontWeight, 10) || 400;
    var large = px >= 24 || (px >= 18.66 && weight >= 700);
    var disabled = !!el.closest(':disabled, [aria-disabled="true"]');
    var ratio = Math.round(contrast(fgEff, bg.color) * 100) / 100;
    var d = desc(el);
    var key = [d.tag, d.cls, hex(fgEff), hex(bg.color), px, weight, disabled, bg.image].join('|');
    if (out[key]) { out[key].count++; continue; }
    out[key] = {
      tag: d.tag, cls: d.cls, text: node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 50),
      ratio: ratio, need: large ? 3 : 4.5, size: px, weight: weight, fg: hex(fgEff), bg: hex(bg.color),
      disabled: disabled, image: bg.image, opacity: bg.opacity, count: 1
    };
  }
  // The text a control shows without a text node: a typed value, a chosen option, a placeholder.
  var controls = document.querySelectorAll('input, select, textarea');
  for (var j = 0; j < controls.length; j++) {
    var c = controls[j];
    if (c.type === 'hidden' || c.type === 'checkbox' || c.type === 'radio' || c.type === 'file') continue;
    if (!rendered(c)) continue;
    var cs = style(c);
    var cbg = bgOf(c, base);
    var cfg = color(cs.color);
    var show = c.tagName === 'SELECT' || (c.value !== '' && c.tagName !== 'TEXTAREA');
    if (show) {
      var e = over([cfg[0], cfg[1], cfg[2], cfg[3] * cbg.opacity], cbg.color);
      var dd = desc(c);
      out['control|' + j] = {
        tag: dd.tag, cls: dd.cls, text: (c.tagName === 'SELECT' ? 'option shown' : 'value shown'), ratio: Math.round(contrast(e, cbg.color) * 100) / 100,
        need: 4.5, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, fg: hex(e), bg: hex(cbg.color),
        disabled: c.disabled, image: cbg.image, opacity: cbg.opacity, count: 1
      };
    }
    if (c.placeholder) {
      var ps = style(c, '::placeholder');
      var pc = color(ps.color);
      var pe = over([pc[0], pc[1], pc[2], pc[3] * parseFloat(ps.opacity || '1') * cbg.opacity], cbg.color);
      var pd = desc(c);
      out['placeholder|' + j] = {
        tag: pd.tag, cls: pd.cls, text: 'placeholder: ' + c.placeholder.slice(0, 30), ratio: Math.round(contrast(pe, cbg.color) * 100) / 100,
        need: 4.5, size: parseFloat(cs.fontSize), weight: 400, fg: hex(pe), bg: hex(cbg.color),
        disabled: c.disabled, image: cbg.image, opacity: cbg.opacity, count: 1
      };
    }
  }
  return Object.keys(out).map(function (k) { return out[k]; });
}

// What a person can read and reach, as sets that two renderings of one page can be compared on.
function signature() {
  var texts = {};
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var node;
  while ((node = walker.nextNode())) {
    var t = (node.nodeValue || '').replace(/\s+/g, ' ').trim().replace(/[0-9]{1,2} [A-Za-z]+ [0-9]{4}, [0-9]{2}:[0-9]{2} UTC/g, '<time>');
    if (!t) continue;
    var el = node.parentElement;
    if (!el || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
    var range = document.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    var seen = false;
    for (var i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) seen = true;
    if (!seen || inClosedDetails(el) || style(el).visibility !== 'visible') continue;
    texts[t] = true;
  }
  var controls = tabbables().map(function (c) { return c.tag + ':' + c.label; });
  return { texts: Object.keys(texts).sort(), controls: controls };
}

// Small boxes that mean something by being seen (a shape, a bar, a mark), and whether each can
// still be told from what is behind it.
function marks() {
  var base = canvasColor();
  var out = [];
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.children.length > 0 || (el.textContent || '').trim() !== '') continue;
    if (el.tagName === 'INPUT' || el.tagName === 'IMG' || el.tagName === 'BR' || el.tagName === 'HR' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
    var r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    var s = style(el);
    if (s.visibility !== 'visible') continue;
    var own = bgOf(el, base).color;
    var behind = bgOf(el.parentElement, base).color;
    var drawn = contrast(own, behind) > 1.2;
    var bw = parseFloat(s.borderTopWidth) || 0;
    var edge = s.borderTopStyle !== 'none' && bw > 0 && contrast(over(color(s.borderTopColor), behind), behind) > 1.2;
    if (!drawn && !edge && s.backgroundImage === 'none') continue;
    var d = desc(el);
    out.push({ tag: d.tag, cls: d.cls, seen: drawn || edge || s.backgroundImage !== 'none', ink: hex(own), behind: hex(behind) });
  }
  return out;
}

function reflow() {
  var doc = document.documentElement;
  var outside = [];
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length && outside.length < 12; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!(r.right > innerWidth + 1 || r.left < -1)) continue;
    var held = false;
    for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      var s = style(n);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { var pr = n.getBoundingClientRect(); if (pr.right <= innerWidth + 1 && pr.left >= -1) { held = true; break; } }
    }
    var ns = style(el);
    if (!held && ns.position === 'absolute' && el.getClientRects()[0] && el.getBoundingClientRect().width <= 1) held = true;
    if (!held && el.classList.contains('skip-link')) held = true;
    if (!held) { var d = desc(el); outside.push(d.tag + (d.cls ? '.' + d.cls.split(' ')[0] : '') + ' right=' + Math.round(r.right) + ' left=' + Math.round(r.left)); }
  }
  return {
    scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, innerWidth: innerWidth, innerHeight: innerHeight,
    bodyScrollWidth: document.body.scrollWidth, overflowing: outside, stickyBottom: stickyBottom(null)
  };
}

function motion() {
  var running = document.getAnimations().length;
  var timed = 0;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var s = style(all[i]);
    var t = parseFloat(s.transitionDuration) || 0;
    var a = parseFloat(s.animationDuration) || 0;
    if (t > 0.001 || a > 0.001) timed++;
  }
  return { running: running, timed: timed, scrollBehavior: style(document.documentElement).scrollBehavior };
}

function resetFocus() {
  // Tab starts from where focus was last. Focusing the body (which takes no part in Tab order) puts
  // the start back at the beginning of the document, wherever a script had left it.
  var b = document.body;
  var had = b.hasAttribute('tabindex');
  if (!had) b.setAttribute('tabindex', '-1');
  b.focus({ preventScroll: true });
  if (!had) b.removeAttribute('tabindex');
  window.scrollTo(0, 0);
  return true;
}

function active() {
  var el = document.activeElement;
  if (!el || el === document.body) return null;
  var d = desc(el);
  return { id: idOf(el), tag: d.tag, idAttr: d.id, cls: d.cls, label: label(el), hash: location.hash, scrollY: scrollY, value: el.value === undefined ? null : el.value };
}

// Controls a person can see and click that Tab skips, because a script or the markup took them out of
// the order with a tabindex below zero. (The main region and the inspector take focus from a link or a
// script, and are not controls.)
function skipped() {
  var out = [];
  var list = document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"], [role="link"]');
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (el.matches(':disabled') || el.closest('[inert]')) continue;
    if (el.tabIndex >= 0 || !rendered(el)) continue;
    var d = desc(el);
    out.push({ tag: d.tag, cls: d.cls, label: label(el) });
  }
  return out;
}

// The first control inside the main region that Tab can reach: where the skip link has to lead.
function firstInMain() {
  var main = document.getElementById('main');
  if (!main) return null;
  var list = tabbables();
  for (var i = 0; i < list.length; i++) {
    var el = null;
    var all = document.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) if (idOf(all[j]) === list[i].id) { el = all[j]; break; }
    if (el && main.contains(el) && el !== main) return list[i].id;
  }
  return null;
}

window.__pw = {
  firstInMain: firstInMain, skipped: skipped,
  tabbables: tabbables, stop: stop, textSamples: textSamples, signature: signature, marks: marks,
  reflow: reflow, motion: motion, resetFocus: resetFocus, active: active, idOf: idOf, label: label
};
return 'ready';
})()`;

/** Defines `window.__pw`. Safe to run twice. Returns "ready". */
export const PRELUDE = PRELUDE_BODY.replace("//COLOR_MATH_HERE", () => COLOR_MATH);
