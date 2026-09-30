// Test Node avec jsdom : node test/fixed-sendbar.test.mjs   (npm install jsdom@24 au préalable)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
const extDir = path.join(root, 'scripts/extensions/third-party/fixed-sendbar');
fs.mkdirSync(extDir, { recursive: true });
fs.copyFileSync(path.join(here, '../index.js'), path.join(extDir, 'index.js'));
fs.writeFileSync(path.join(root, 'script.js'), 'export const eventSource = { on: () => {} };\nexport const event_types = {};\nexport const saveSettingsDebounced = () => {};\n');
fs.writeFileSync(path.join(root, 'scripts/extensions.js'), 'export const extension_settings = globalThis.__settings;\n');
globalThis.__settings = { 'fixed-sendbar': { mode: 'bogus', visibleLines: '99' } };

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="form_sheld"><div id="send_form"><div id="nonQRFormItems"><textarea id="send_textarea"></textarea></div></div></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.MutationObserver = dom.window.MutationObserver;
const winHandlers = {};
globalThis.addEventListener = (type, fn) => { (winHandlers[type] ||= []).push(fn); };
const fire = (type) => (winHandlers[type] || []).forEach((f) => f({ type }));
globalThis.scrollY = 0;
globalThis.scrollTo = (x, y) => { globalThis.scrollY = y; };
globalThis.innerHeight = 800;
let rafQueue = [];
globalThis.requestAnimationFrame = (f) => { rafQueue.push(f); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const runRaf = (ts) => { const q = rafQueue; rafQueue = []; q.forEach((f) => f(ts)); };
const { __test: t } = await import(pathToFileURL(path.join(extDir, 'index.js')).href);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

const M = { lineHeight: 20, paddingY: 10, borderY: 2, borderBox: true };

ok('defaults merge + sanitisation', () => {
    const s = t.getSettings();
    assert.equal(s.enabled, true);
    assert.equal(s.mode, 'fixed');
    assert.equal(s.visibleLines, 12); // clampé
    assert.equal(s.maxLines, 6);
    assert.equal(s.fixIosViewport, true);
    assert.equal(s.guardScroll, true);
    assert.equal(s.iosStrong, true);
    assert.equal(s.blockScrollIntoView, true);
    assert.equal(s.debug, false);
    Object.assign(s, { visibleLines: 3 });
});

ok('parseLineHeight', () => {
    assert.equal(t.parseLineHeight('20px', '16px'), 20);
    assert.equal(t.parseLineHeight('normal', '10px'), 12);
    assert.equal(t.parseLineHeight('1.5', '20px'), 30);
    assert.equal(t.parseLineHeight('', 'abc'), 16 * 1.2);
});

ok('heightForLines border-box / content-box', () => {
    assert.equal(t.heightForLines(3, M), 72);
    assert.equal(t.heightForLines(3, { ...M, borderBox: false }), 60);
});

ok('mode fixed : hauteur constante quel que soit le contenu', () => {
    const s = { mode: 'fixed', visibleLines: 3, heightPx: 0, maxLines: 6 };
    const hs = [0, 20, 60, 400, 5000].map(sh => t.computeTargetHeight(s, M, sh));
    assert.ok(hs.every(h => h === 72), hs.join());
    assert.equal(t.computeTargetHeight({ ...s, heightPx: 90 }, M, 500), 90);
});

ok('mode grow : 1 ligne -> maxLines puis plafond', () => {
    const s = { mode: 'grow', visibleLines: 3, heightPx: 0, maxLines: 4 };
    const one = t.computeGrowHeight(30, s, M); // 1 ligne = 20 + pad 10
    assert.equal(one.height, 32); assert.equal(one.overflowing, false);
    const two = t.computeGrowHeight(50, s, M);
    assert.equal(two.height, 52);
    const huge = t.computeGrowHeight(1000, s, M);
    assert.equal(huge.height, 92); assert.equal(huge.max, 92); assert.equal(huge.overflowing, true);
    assert.equal(t.computeGrowHeight(0, s, M).height, 32); // jamais sous 1 ligne
});

ok('visualViewport offset', () => {
    assert.equal(t.computeVvOffset(800, 800, 0, 1), 0);
    assert.equal(t.computeVvOffset(800, 799.5, 0, 1), 0); // < 1px
    assert.equal(t.computeVvOffset(800, 500, 0, 1), 300);
    assert.equal(t.computeVvOffset(800, 500, 120, 1), 180); // page décalée
    assert.equal(t.computeVvOffset(800, 500, 0, 2), 0); // zoom pinch : no-op
    assert.equal(t.computeVvOffset(800, 900, 0, 1), 0); // jamais négatif
    assert.equal(t.computeVvOffset(undefined, 500, 0, 1), 0);
    assert.equal(t.computeVvOffset(800, NaN, 0, 1), 0);
});

ok('shouldApplyVv / shouldResetScroll', () => {
    const s = { enabled: true, fixIosViewport: true, guardScroll: true };
    assert.equal(t.shouldApplyVv(s, 'fixed', 300), true);
    assert.equal(t.shouldApplyVv(s, 'fixed', 0), false);
    assert.equal(t.shouldApplyVv(s, 'absolute', 300), false);
    assert.equal(t.shouldApplyVv({ ...s, fixIosViewport: false }, 'fixed', 300), false);
    assert.equal(t.shouldApplyVv({ ...s, enabled: false }, 'fixed', 300), false);
    assert.equal(t.shouldResetScroll(s, true, 40), true);
    assert.equal(t.shouldResetScroll(s, true, 0), false);
    assert.equal(t.shouldResetScroll(s, false, 40), false);
    assert.equal(t.shouldResetScroll({ ...s, guardScroll: false }, true, 40), false);
});

ok('buildCss équilibré, !important, deux modes', () => {
    for (const mode of ['fixed', 'grow']) {
        const css = t.buildCss({ mode });
        assert.ok(t.braceBalance(css));
        assert.match(css, /#send_textarea/);
        assert.match(css, /resize:none !important/);
        assert.match(css, /overflow-y:auto !important/);
        assert.match(css, /align-items:flex-end !important/);
        assert.match(css, /--fs-vv-offset/);
    }
    assert.match(t.buildCss({ mode: 'fixed' }), /max-height:var\(--fs-h/);
    assert.match(t.buildCss({ mode: 'grow' }), /max-height:var\(--fs-max-h/);
    assert.ok(!/display\s*:\s*none/.test(t.buildCss({ mode: 'fixed' })), 'ne cache rien');
});

// --- DOM : enforcement + hostilité de ST (autoFit) ---
const ta = document.getElementById('send_textarea');
const stub = (scrollHeight) => Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => scrollHeight });
// jsdom n'a pas de mise en page : métriques via getComputedStyle inline
ta.style.cssText = 'line-height:20px;font-size:16px;padding:5px;border:1px solid #000;box-sizing:border-box';

ok('enforce mode fixed : impose 72px, !important, même après autoFit de ST', () => {
    const s = t.getSettings(); s.mode = 'fixed'; s.visibleLines = 3; s.heightPx = 0;
    t.applyStyle(); t.observeTextarea(); t.enforce();
    assert.equal(ta.style.getPropertyValue('height'), '72px');
    assert.equal(ta.style.getPropertyPriority('height'), 'important');
    assert.equal(document.getElementById('fixed-sendbar-style'), document.head.lastElementChild);
    assert.ok(document.documentElement.classList.contains('fs-on'));
    // ST : autoFitSendTextArea
    stub(400);
    ta.style.height = '400px';
    t.enforce(); // (en vrai : MutationObserver / handler d'input en capture)
    assert.equal(ta.style.getPropertyValue('height'), '72px');
    assert.equal(document.documentElement.style.getPropertyValue('--fs-h'), '72px');
});

ok('enforce mode grow : suit le contenu, plafonné', () => {
    const s = t.getSettings(); s.mode = 'grow'; s.maxLines = 4;
    t.applyStyle();
    stub(20); t.enforce(); assert.equal(ta.style.getPropertyValue('height'), '32px'); // min 1 ligne (20+10+2)
    stub(60); t.enforce(); assert.equal(ta.style.getPropertyValue('height'), '62px'); // scrollHeight 60 + border 2
    stub(9999); t.enforce(); assert.equal(ta.style.getPropertyValue('height'), '92px'); // 4 lignes
    assert.equal(ta.style.getPropertyPriority('height'), 'important');
});

ok('désactivation : relâche la hauteur et les variables', () => {
    const s = t.getSettings(); s.enabled = false;
    t.applyStyle(); t.releaseHeight();
    assert.equal(ta.style.getPropertyValue('height'), '');
    assert.ok(!document.documentElement.classList.contains('fs-on'));
    assert.equal(document.documentElement.style.getPropertyValue('--fs-h'), '');
    s.enabled = true; t.applyStyle();
});

ok('updateVv (ancienne méthode, iosStrong OFF) : no-op sans visualViewport, appliqué avec', () => {
    t.getSettings().iosStrong = false;
    t.updateVv();
    assert.ok(!document.documentElement.classList.contains('fs-vv'));
    globalThis.innerHeight = 800;
    globalThis.visualViewport = { height: 500, offsetTop: 0, scale: 1 };
    // jsdom : position fixed via style inline
    document.getElementById('form_sheld').style.position = 'fixed';
    t.updateVv();
    assert.ok(document.documentElement.classList.contains('fs-vv'));
    assert.equal(document.documentElement.style.getPropertyValue('--fs-vv-offset'), '300px');
    globalThis.visualViewport = { height: 800, offsetTop: 0, scale: 1 };
    t.updateVv();
    assert.ok(!document.documentElement.classList.contains('fs-vv'));
    assert.equal(document.documentElement.style.getPropertyValue('--fs-vv-offset'), '0px');
    globalThis.visualViewport = { height: 500, offsetTop: 0, scale: 1 };
    document.getElementById('form_sheld').style.position = 'static';
    t.updateVv();
    assert.ok(!document.documentElement.classList.contains('fs-vv'), 'non fixed => no-op');
    t.getSettings().iosStrong = true;
    t.updateVv();
    assert.ok(!document.documentElement.classList.contains('fs-vv'), 'mode renforcé : plus de translation');
    document.getElementById('form_sheld').style.position = '';
    globalThis.visualViewport = undefined;
});

// --- 1.1.0 : fonctions pures ---
ok('computeAnchorTop : clavier ouvert, offsets', () => {
    assert.equal(t.computeAnchorTop(0, 500, 80), 420);
    assert.equal(t.computeAnchorTop(120, 500, 80), 540); // page décalée de 120px
    assert.equal(t.computeAnchorTop(undefined, 500, 80), 420);
    assert.equal(t.computeAnchorTop(0, 500, 0), null);
    assert.equal(t.computeAnchorTop(0, NaN, 80), null);
    assert.equal(t.computeAnchorTop(0, 50, 80), 0); // jamais négatif
    assert.equal(t.computeAnchorTop(0.4, 500.4, 80.2), 421);
});

ok('computeAnchor : no-op si offset ~0, non fixed, sans focus, réglage OFF, zoom', () => {
    const s = { enabled: true, iosStrong: true };
    const m = { innerHeight: 800, vvHeight: 500, vvOffsetTop: 0, vvScale: 1, barHeight: 90, position: 'fixed' };
    assert.deepEqual(t.computeAnchor(s, true, m), { apply: true, top: 410, gap: 300 });
    assert.equal(t.computeAnchor(s, true, { ...m, vvOffsetTop: 100 }).top, 510);
    assert.equal(t.computeAnchor(s, true, { ...m, vvOffsetTop: 100 }).gap, 200);
    assert.equal(t.computeAnchor(s, true, { ...m, vvHeight: 800 }).apply, false);
    assert.equal(t.computeAnchor(s, true, { ...m, vvHeight: 799.5 }).apply, false);
    assert.equal(t.computeAnchor(s, false, m).apply, false);
    assert.equal(t.computeAnchor(s, true, { ...m, position: 'static' }).apply, false);
    assert.equal(t.computeAnchor({ ...s, iosStrong: false }, true, m).apply, false);
    assert.equal(t.computeAnchor({ ...s, enabled: false }, true, m).apply, false);
    assert.equal(t.computeAnchor(s, true, { ...m, vvScale: 2 }).apply, false);
    assert.equal(t.computeAnchor(s, true, { ...m, barHeight: 0 }).apply, false);
});

ok('shouldCounterScroll / shouldStickBottom / shouldBlockScroll / formatDebug', () => {
    const s = { enabled: true, iosStrong: true, guardScroll: true, blockScrollIntoView: true };
    assert.equal(t.shouldCounterScroll(s, true, 30, 0, 0), true);
    assert.equal(t.shouldCounterScroll(s, true, 0, 12, 0), true);
    assert.equal(t.shouldCounterScroll(s, true, 0, 0, 0), false);
    assert.equal(t.shouldCounterScroll(s, false, 30, 0, 0), false);
    assert.equal(t.shouldCounterScroll({ ...s, guardScroll: false }, true, 30, 0, 0), false);
    assert.equal(t.shouldCounterScroll({ ...s, iosStrong: false }, true, 30, 0, 0), false);
    assert.equal(t.shouldStickBottom(5, 5, 5), true);
    assert.equal(t.shouldStickBottom(2, 2, 5), false);
    assert.equal(t.shouldStickBottom(0, 5, 5), false);
    const a = {}, b = {};
    assert.equal(t.shouldBlockScroll(s, a, a, true, 99999), true);
    assert.equal(t.shouldBlockScroll(s, a, a, false, 100), true);
    assert.equal(t.shouldBlockScroll(s, a, a, false, 99999), false);
    assert.equal(t.shouldBlockScroll(s, b, a, true, 0), false);
    assert.equal(t.shouldBlockScroll({ ...s, blockScrollIntoView: false }, a, a, true, 0), false);
    const txt = t.formatDebug({ scrollY: 12, vvTop: 3.25, vvHeight: 500, innerHeight: 800, barTop: 410, barBottom: 500, anchored: true, anchorTop: 410, gap: 300, focused: true });
    assert.match(txt, /scrollY 12/); assert.match(txt, /vv\.top 3\.3/); assert.match(txt, /bot 500/); assert.match(txt, /anchor 410/);
    assert.match(t.formatDebug({}), /scrollY \?/);
});

ok('buildCss 1.1 : scroll-padding, overscroll-behavior, pas de position:fixed sur html/body', () => {
    for (const mode of ['fixed', 'grow']) {
        const css = t.buildCss({ mode });
        assert.ok(t.braceBalance(css));
        assert.match(css, /scroll-padding:0 !important/);
        assert.match(css, /fs-ios[^{]*\{overscroll-behavior:none !important/);
        assert.match(css, /height:100%/);
        assert.ok(!/position\s*:\s*fixed/.test(css), 'pas de position:fixed');
        assert.ok(!/inset\s*:/.test(css));
    }
});

// --- 1.1.0 : câblage des événements (jsdom) ---
const sheld = document.getElementById('form_sheld');
Object.defineProperty(sheld, 'offsetHeight', { configurable: true, get: () => 90 });
const fireDoc = (type, target, extra = {}) => {
    const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, extra);
    target.dispatchEvent(ev);
};

ok('focus : top inline !important + bottom:auto ; blur : override retiré, bottom:0 du thème', () => {
    const s = t.getSettings(); s.enabled = true; s.iosStrong = true; s.guardScroll = true; s.mode = 'fixed';
    sheld.style.cssText = 'position:fixed;bottom:0';
    globalThis.innerHeight = 800;
    globalThis.visualViewport = { height: 500, offsetTop: 0, scale: 1, addEventListener() {} };
    ta.focus();
    fireDoc('focusin', ta);
    assert.equal(sheld.style.getPropertyValue('top'), '410px');
    assert.equal(sheld.style.getPropertyPriority('top'), 'important');
    assert.equal(sheld.style.getPropertyValue('bottom'), 'auto');
    assert.equal(sheld.style.getPropertyPriority('bottom'), 'important');
    // la page a glissé (iOS) : offsetTop change => top suit
    globalThis.visualViewport = { height: 450, offsetTop: 60, scale: 1, addEventListener() {} };
    fire('scroll');
    assert.equal(sheld.style.getPropertyValue('top'), '420px');
    // clavier refermé / offset nul => no-op (override retiré)
    globalThis.visualViewport = { height: 800, offsetTop: 0, scale: 1, addEventListener() {} };
    fire('scroll');
    assert.equal(sheld.style.getPropertyValue('top'), '');
    assert.equal(sheld.style.getPropertyValue('bottom'), '0px');
    // de nouveau clavier ouvert puis blur
    globalThis.visualViewport = { height: 500, offsetTop: 0, scale: 1, addEventListener() {} };
    fire('scroll');
    assert.equal(sheld.style.getPropertyValue('top'), '410px');
    ta.blur();
    fireDoc('focusout', ta);
    assert.equal(sheld.style.getPropertyValue('top'), '');
    assert.equal(sheld.style.getPropertyValue('bottom'), '0px', 'bottom:0 d\'origine restauré');
    assert.equal(sheld.style.getPropertyValue('position'), 'fixed');
});

ok('scroll reset : scroll window => scrollTo(0,0) ; sans focus => intact', () => {
    const ta2 = document.getElementById('send_textarea');
    ta2.focus(); fireDoc('focusin', ta2);
    globalThis.scrollY = 120;
    document.documentElement.scrollTop = 120;
    fire('scroll');
    assert.equal(globalThis.scrollY, 0);
    globalThis.scrollY = 50;
    assert.equal(t.resetPageScroll(), true);
    assert.equal(globalThis.scrollY, 0);
    assert.equal(t.resetPageScroll(), false);
    ta2.blur(); fireDoc('focusout', ta2);
    globalThis.scrollY = 77;
    fire('scroll');
    assert.equal(globalThis.scrollY, 77, 'pas de reset sans focus');
    globalThis.scrollY = 0;
});

ok('boucle rAF : repositionne tant que focus, s\'arrête au blur', () => {
    const ta2 = document.getElementById('send_textarea');
    globalThis.visualViewport = { height: 500, offsetTop: 0, scale: 1, addEventListener() {} };
    rafQueue = [];
    ta2.focus(); fireDoc('focusin', ta2);
    assert.ok(rafQueue.length >= 1, 'boucle démarrée');
    globalThis.visualViewport = { height: 480, offsetTop: 0, scale: 1, addEventListener() {} };
    runRaf(10000);
    assert.equal(sheld.style.getPropertyValue('top'), '390px');
    assert.ok(rafQueue.length >= 1, 'boucle continue');
    ta2.blur(); fireDoc('focusout', ta2);
    runRaf(20000);
    assert.equal(rafQueue.length, 0, 'boucle arrêtée après blur');
    assert.equal(sheld.style.getPropertyValue('top'), '');
});

ok('Enter : défilement interne du champ, page remise à 0', () => {
    const ta2 = document.getElementById('send_textarea');
    ta2.focus(); fireDoc('focusin', ta2);
    ta2.value = 'a\nb\nc\n';
    ta2.setSelectionRange(ta2.value.length, ta2.value.length);
    stub(600);
    globalThis.scrollY = 40;
    fireDoc('keydown', ta2, { key: 'Enter' });
    t.keepCaretVisible();
    assert.equal(ta2.scrollTop, 600);
    assert.equal(globalThis.scrollY, 0);
    ta2.blur(); fireDoc('focusout', ta2);
});

ok('scrollIntoView / focus : bloqués pour #send_textarea seulement', () => {
    const calls = [];
    dom.window.Element.prototype.scrollIntoView = function () { calls.push(this.id || this.tagName); };
    globalThis.Element = dom.window.Element;
    globalThis.HTMLElement = dom.window.HTMLElement;
    const seen = [];
    const origFocus = dom.window.HTMLElement.prototype.focus;
    dom.window.HTMLElement.prototype.focus = function (opts) { seen.push(opts); return origFocus.call(this); };
    t.installScrollPatches();
    const ta2 = document.getElementById('send_textarea');
    const other = document.getElementById('nonQRFormItems');
    ta2.scrollIntoView(); // focus récent ou actif => bloqué
    other.scrollIntoView(); // autre élément => passe
    assert.deepEqual(calls, ['nonQRFormItems']);
    t.getSettings().blockScrollIntoView = false;
    ta2.scrollIntoView();
    assert.deepEqual(calls, ['nonQRFormItems', 'send_textarea']);
    t.getSettings().blockScrollIntoView = true;
    ta2.focus();
    assert.equal(seen.at(-1).preventScroll, true);
    ta2.blur(); fireDoc('focusout', ta2);
});

ok('debug : overlay créé / retiré', () => {
    const s = t.getSettings();
    s.debug = true; t.updateDebug();
    const el = document.getElementById('fs_debug');
    assert.ok(el); assert.match(el.textContent, /scrollY/);
    s.debug = false; t.updateDebug();
    assert.equal(document.getElementById('fs_debug'), null);
});

console.log(`\n${n} groupes OK`);
process.exit(0);
