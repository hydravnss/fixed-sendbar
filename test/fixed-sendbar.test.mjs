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
globalThis.addEventListener = () => {};
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

ok('updateVv : no-op sans visualViewport, appliqué avec', () => {
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
});

console.log(`\n${n} groupes OK`);
process.exit(0);
