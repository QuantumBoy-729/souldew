import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTONS, RESERVED, PRESETS, bindable, detectLayout, currentLayout, tableLayout, layoutForLang, keyFor, presetMap, activePreset, resolve, keyLabel, ejsControls, defaults }
  from '../web/lib/controls.mjs';

const QWERTY = tableLayout('qwerty');
const QWERTZ = tableLayout('qwertz');
const AZERTY = tableLayout('azerty');
const LAYOUTS = { QWERTY, QWERTZ, AZERTY };
// what the Keyboard Map API would report for a real German keyboard
const realQwertz = { id: 'system', real: true, get: (c) => QWERTZ.get(c) };
const labels = (m, lay) => BUTTONS.map((b) => keyLabel(m[b.id], lay)).join(' ');

test('every preset binds all 12 buttons, distinct, bindable and never on an app shortcut – on every layout', () => {
  for (const p of PRESETS) {
    assert.deepEqual(Object.keys(p.keys).sort(), BUTTONS.map((b) => b.id).sort(), p.id);
    for (const [name, lay] of Object.entries(LAYOUTS)) {
      const m = presetMap(p.id, lay);
      const codes = BUTTONS.map((b) => m[b.id].keyCode);
      assert.equal(new Set(codes).size, codes.length, `${p.id} on ${name}: doubled key`);
      for (const c of codes) {
        assert.ok(bindable(c), `${p.id} on ${name}: ${c} not bindable`);
        assert.ok(!(c in RESERVED), `${p.id} on ${name}: ${c} is ${RESERVED[c]}`);
      }
      // the app's letter shortcuts match on the printed character – none of them may be printed on a preset key
      for (const b of BUTTONS) assert.ok(!/^[fmprt]$/i.test(m[b.id].key), `${p.id} on ${name}: ${b.id} prints ${m[b.id].key}`);
      assert.deepEqual(resolve(m, lay), m, `${p.id} on ${name} survives resolve()`);
    }
  }
});

test('the arrow-key preset is the classic default on QWERTY', () => {
  const m = presetMap('arrows', QWERTY);
  for (const b of BUTTONS) assert.equal(m[b.id].keyCode, b.keyCode, b.id);
  assert.deepEqual(defaults(QWERTY), m);
  assert.deepEqual(ejsControls(null, QWERTY), ejsControls(m, QWERTY));
});

test('WASD means the same physical keys on every layout, printed as the layout prints them', () => {
  const dpad = (lay) => ['up', 'left', 'down', 'right'].map((id) => keyLabel(presetMap('wasd', lay)[id], lay)).join('');
  assert.equal(dpad(QWERTY), 'WASD');
  assert.equal(dpad(QWERTZ), 'WASD');
  assert.equal(dpad(AZERTY), 'ZQSD');
  // keyCode follows the printed letter: on AZERTY "up" is the key printing Z
  assert.equal(presetMap('wasd', AZERTY).up.keyCode, 90);
  assert.equal(presetMap('wasd', AZERTY).left.keyCode, 81);
  assert.equal(presetMap('wasd', AZERTY).up.code, 'KeyW');
});

test('QWERTZ swaps Y and Z, AZERTY moves A/Q/W/Z', () => {
  assert.deepEqual(keyFor('KeyZ', QWERTZ), { keyCode: 89, key: 'y', code: 'KeyZ' });
  assert.deepEqual(keyFor('KeyY', QWERTZ), { keyCode: 90, key: 'z', code: 'KeyY' });
  assert.equal(keyFor('KeyQ', AZERTY).keyCode, 65);
  assert.equal(keyFor('Semicolon', AZERTY).keyCode, 77);
  assert.equal(keyFor('KeyM', AZERTY), null); // prints "," – keyCode not predictable
  assert.equal(keyFor('Digit1', AZERTY).keyCode, 49);
  assert.deepEqual(keyFor('ArrowUp', AZERTY), { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
  assert.equal(keyFor('Space', QWERTY).keyCode, 32);
  // non-Latin layouts (e.g. Russian): browsers report the US letter
  assert.equal(keyFor('KeyF', { real: true, get: () => 'а' }).keyCode, 70);
  assert.equal(labels(presetMap('arrows', QWERTZ), QWERTZ), '↑ ↓ ← → Y X A S Q E Enter V');
  assert.equal(labels(presetMap('arrows', AZERTY), AZERTY), '↑ ↓ ← → W X Q S A E Enter V');
});

test('the fallback layout follows the UI language', () => {
  assert.equal(layoutForLang('de').id, 'qwertz');
  assert.equal(layoutForLang('de-AT').id, 'qwertz');
  assert.equal(layoutForLang('fr').id, 'azerty');
  for (const l of ['en', 'es', 'it', '', null, undefined]) assert.equal(layoutForLang(l).id, 'qwerty');
});

test('active preset or custom', () => {
  assert.equal(activePreset(null, QWERTZ), 'arrows');
  for (const [, lay] of Object.entries(LAYOUTS)) for (const p of PRESETS) assert.equal(activePreset(presetMap(p.id, lay), lay), p.id);
  const m = presetMap('wasd', QWERTY);
  assert.equal(activePreset({ ...m, select: { keyCode: 66, key: 'b', code: 'KeyB' } }, QWERTY), null);
  // an old config without codes that equals the classic default is still recognised
  const old = Object.fromEntries(BUTTONS.map((b) => [b.id, { keyCode: b.keyCode, key: b.key }]));
  assert.equal(activePreset(old, QWERTY), 'arrows');
});

test('old configs (keyCode only) keep their keys; physical codes follow the real layout', () => {
  const old = { a: { keyCode: 75, key: 'k' }, up: { keyCode: 87, key: 'w' } };
  for (const lay of [QWERTY, QWERTZ, realQwertz]) {
    const m = resolve(old, lay);
    assert.equal(m.a.keyCode, 75);
    assert.equal(m.up.keyCode, 87);
  }
  // the arrow preset saved on a US keyboard, later played on a real German keyboard: still the same physical keys
  const saved = presetMap('arrows', QWERTY);
  assert.equal(saved.a.keyCode, 90);
  assert.equal(resolve(saved, realQwertz).a.keyCode, 89);
  assert.equal(keyLabel(saved.a, realQwertz), 'Y');
  // a guessed layout never overrides what was stored (label and keyCode stay consistent)
  assert.equal(resolve(saved, QWERTZ).a.keyCode, 90);
  assert.equal(keyLabel(saved.a, QWERTZ), 'Z');
  // EmulatorJS table carries the live keyCodes
  assert.equal(ejsControls(saved, realQwertz)[0][8].value, 89);
});

test('reserved, unbindable or doubled saved keys fall back to the layout default', () => {
  const m = resolve({ a: { keyCode: 80, key: 'p' }, b: { keyCode: 16, key: 'Shift' }, x: { keyCode: 38, key: 'ArrowUp' } }, QWERTZ);
  assert.equal(m.a.keyCode, 89); // P = pause → default (QWERTZ Y)
  assert.equal(m.b.keyCode, 88);
  assert.equal(m.up.keyCode, 38);
  assert.equal(m.x.keyCode, 65); // ArrowUp already taken by up
});

test('detectLayout guesses from the language, then prefers the Keyboard Map API (kept across language changes)', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
    assert.equal((await detectLayout('fr')).id, 'azerty');
    assert.equal((await detectLayout(null)).id, 'qwerty'); // no app language yet → the browser's
    assert.equal(keyLabel(resolve(null).a), 'Z');
    globalThis.navigator.keyboard = { getLayoutMap: async () => new Map([['KeyZ', 'y'], ['KeyY', 'z'], ['KeyW', 'w']]) };
    assert.equal((await detectLayout('fr')).real, true);
    assert.equal(keyLabel(resolve(null).a), 'Y');
    assert.equal((await detectLayout('en')).id, 'system');
    assert.equal(currentLayout().real, true);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
  }
});

test('controllers: Nintendo layout by default, family from the id, re-bound buttons never doubled', async () => {
  const c = await import('../web/lib/controls.mjs');
  const def = c.padMap(null);
  assert.equal(def.a, 'BUTTON_2'); // right face button, like on the GBA / DS
  assert.equal(def.b, 'BUTTON_1');
  assert.equal(c.padMap({ preset: 'xbox' }).a, 'BUTTON_1');
  // a re-bound button wins, a hotkey (turbo trigger) is refused, no label is used twice
  const m = c.padMap({ preset: 'nintendo', map: { a: 'BUTTON_4', select: 'RIGHT_BOTTOM_SHOULDER' } });
  assert.equal(m.a, 'BUTTON_4');
  assert.equal(m.select, 'SELECT');
  const labels = Object.values(m).filter(Boolean);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(c.padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(c.padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(c.padFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'switch');
  assert.equal(c.padFamily('8BitDo SN30 Pro (Vendor: 2dc8)'), 'generic');
  assert.equal(c.padLabel('BUTTON_2', 'switch'), 'A');
  assert.equal(c.padLabel('BUTTON_1', 'playstation'), '✕');
  // the EmulatorJS table carries the controller labels next to the keys
  const table = c.ejsControls(null, undefined, { preset: 'xbox' });
  assert.equal(table[0][8].value2, 'BUTTON_1'); // RetroArch A
});

// ---- which connected device plays (issue #2: a USB microphone was taken for the controller) ----
const fakePad = (index, id, { mapping = '', buttons = 17, axes = 4, connected = true } = {}) => ({
  index, id, mapping, connected, buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })), axes: Array(axes).fill(0),
});
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const MIC = 'DGM20 USB Microphone (Vendor: 1fc9 Product: 0117)';

test('controllers: a USB microphone listed first never beats the PS5 controller', async () => {
  const c = await import('../web/lib/controls.mjs');
  const mic = fakePad(0, MIC, { buttons: 3, axes: 0 });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  assert.equal(c.pickPad([mic, ps5]), ps5);
  assert.equal(c.pickPad([ps5, mic]), ps5);
  // the microphone alone is no controller – nothing plays rather than the mic
  assert.equal(c.pickPad([mic]), null);
  assert.equal(c.looksLikePad(mic), false);
  // even a microphone/headset that reports plenty of buttons and axes, by its name
  assert.equal(c.pickPad([fakePad(0, 'HyperX Cloud II Wireless Headset (Vendor: 03f0)', { buttons: 12, axes: 2 })]), null);
  assert.equal(c.pickPad([fakePad(0, 'USB Audio Device (Vendor: 0d8c Product: 0014)', { buttons: 8, axes: 1 })]), null);
  // anything with 0–3 buttons and no standard layout
  for (const n of [0, 1, 2, 3]) assert.equal(c.pickPad([fakePad(0, `HID device ${n} (Vendor: 1234 Product: 5678)`, { buttons: n, axes: n ? 1 : 0 })]), null, `${n} buttons`);
  // "Microsoft" is no "mic": an Xbox pad by its maker's name still plays
  assert.ok(c.looksLikePad(fakePad(0, 'Controller (Xbox One For Windows) (Vendor: 045e Product: 02ea) Microsoft', { mapping: 'standard' })));
});

test('controllers: the most controller-like device plays – standard layout, known make, buttons and sticks', async () => {
  const c = await import('../web/lib/controls.mjs');
  const xbox = fakePad(2, XBOX, { mapping: 'standard' });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  const generic = fakePad(0, 'USB Gamepad (Vendor: 0079 Product: 0011)', { buttons: 10, axes: 2 });
  // a cheap pad without the standard layout is still a controller – and plays when it is the only one
  assert.equal(c.pickPad([generic]), generic);
  assert.ok(c.padScore(ps5) > c.padScore(generic));
  // standard + known make: the lowest index among equals (the one connected first)
  assert.equal(c.pickPad([generic, ps5, xbox]), ps5);
  assert.equal(c.pickPad([xbox, generic]), xbox);
  // disconnected slots and holes (Chrome keeps null for a pad that left)
  assert.equal(c.pickPad([null, fakePad(1, DUALSENSE, { mapping: 'standard', connected: false }), xbox]), xbox);
  assert.equal(c.pickPad([]), null);
  assert.equal(c.pickPad(null), null);
  // counts work as well as arrays (the Settings page keeps counts)
  assert.equal(c.padScore({ id: DUALSENSE, standard: true, buttons: 17, axes: 4 }), c.padScore(ps5));
});

test('controllers: the controller chosen in Settings plays whenever it is connected – even one that looks odd', async () => {
  const c = await import('../web/lib/controls.mjs');
  const mic = fakePad(0, MIC, { buttons: 3, axes: 0 });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  const xbox = fakePad(2, XBOX, { mapping: 'standard' });
  assert.equal(c.pickPad([mic, ps5, xbox], XBOX), xbox);
  // the player's own choice wins over the heuristics
  assert.equal(c.pickPad([mic, ps5], MIC), mic);
  // remembered but not connected: the automatic choice
  assert.equal(c.pickPad([mic, ps5], 'Some Other Pad (Vendor: 0001)'), ps5);
  // the stored key is the trimmed id (indexes change from start to start, the id doesn't)
  assert.equal(c.padKey(`  ${DUALSENSE} `), DUALSENSE);
  assert.equal(c.pickPad([mic, xbox, ps5], ` ${DUALSENSE}`), ps5);
  assert.equal(c.padKey('x'.repeat(300)).length, 200);
});

test('controller diagnostics: the picked device and each new press with the game buttons it maps to', async () => {
  const { padRecorder, padMap } = await import('../web/lib/controls.mjs');
  const rec = padRecorder(3);
  const map = padMap({ preset: 'nintendo', map: { a: 'BUTTON_1', b: 'BUTTON_2' } });
  const pad = (pressed) => ({ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, mapping: 'standard',
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes: [0, 0, 0, 0] });
  rec.see(pad([0]), map);
  rec.see(pad([0]), map); // held: one press, not two
  rec.see(pad([]), map);
  rec.see(pad([1]), map, true);
  const info = rec.info({ preset: 'nintendo' }, map);
  assert.equal(info.picked.mapping, 'standard');
  assert.deepEqual(info.presses.map(({ i, label, game, app }) => ({ i, label, game, app })), [
    { i: 0, label: 'BUTTON_1', game: ['a'], app: false },
    { i: 1, label: 'BUTTON_2', game: ['b'], app: true },
  ]);
  rec.see(null, map);
  assert.equal(rec.info(null, map).picked, null);
});

test('fast-forward hotkeys: Tab held and Shift+Tab by default, as in mGBA – on every layout and preset', async () => {
  const { HOTKEYS, resolveHotkeys, hotkeyOf, keyMatches, hotkeyBindable, isHotkeyKey } = await import('../web/lib/controls.mjs');
  assert.deepEqual(HOTKEYS.map((h) => h.id), ['ffHold', 'ffToggle']);
  for (const [name, lay] of Object.entries(LAYOUTS)) {
    for (const p of [null, ...PRESETS.map((x) => presetMap(x.id, lay))]) {
      const hot = resolveHotkeys(p, lay);
      assert.deepEqual(hot.ffHold, { keyCode: 9, key: 'Tab', code: 'Tab' }, name);
      assert.deepEqual(hot.ffToggle, { keyCode: 9, key: 'Tab', code: 'Tab', shift: true }, name);
      // never on a game button's key
      for (const b of BUTTONS) assert.notEqual(resolve(p, lay)[b.id].keyCode, 9);
    }
  }
  const hot = resolveHotkeys(null, QWERTY);
  // what the player pages forward ({ key, code, keyCode, shift }) – and older ones without the keyCode
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9, shift: false }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9, shift: true }, hot), 'ffToggle');
  assert.equal(hotkeyOf({ key: 'Tab', shift: false }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 't', code: 'KeyT', keyCode: 84 }, hot), null, 'T stays the turbo step');
  // the release of the hold key matches with or without Shift (Shift may be let go first)
  assert.ok(keyMatches({ key: 'Tab', code: 'Tab', shift: true }, hot.ffHold));
  assert.ok(!keyMatches({ key: 'g', code: 'KeyG', keyCode: 71 }, hot.ffHold));
  // the player pages keep Tab (no focus change) – not Ctrl / Alt / Cmd combos, not other keys
  assert.ok(isHotkeyKey({ keyCode: 9, code: 'Tab', shiftKey: true }, hot));
  assert.ok(!isHotkeyKey({ keyCode: 9, code: 'Tab', ctrlKey: true }, hot));
  assert.ok(!isHotkeyKey({ keyCode: 9, code: 'Tab', metaKey: true }, hot));
  assert.ok(!isHotkeyKey({ keyCode: 90, code: 'KeyZ' }, hot));
  // which keys a hotkey may have: Tab and any key a game button could have, none of the other shortcuts
  assert.ok(hotkeyBindable(9));
  assert.ok(hotkeyBindable(71)); // G
  assert.ok(hotkeyBindable(32)); // Space
  for (const c of [84, 80, 77, 70, 82, 27, 49, 116, 119, 123, 187]) assert.ok(!hotkeyBindable(c), String(c));
  assert.ok(!hotkeyBindable(16)); // Shift alone
});

test('fast-forward hotkeys: re-bound like the game buttons; a clash falls back to the default', async () => {
  const { resolveHotkeys, hotkeyOf, isHotkeyKey } = await import('../web/lib/controls.mjs');
  const G = { keyCode: 71, key: 'g', code: 'KeyG' };
  // re-bound: G held, Shift+G toggles; Tab is free again (the page may move the focus with it)
  let hot = resolveHotkeys({ ffHold: G, ffToggle: { ...G, shift: true } }, QWERTY);
  assert.deepEqual(hot.ffHold, G);
  assert.deepEqual(hot.ffToggle, { ...G, shift: true });
  assert.equal(hotkeyOf({ key: 'g', code: 'KeyG', keyCode: 71 }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 'G', code: 'KeyG', keyCode: 71, shift: true }, hot), 'ffToggle');
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9 }, hot), null);
  assert.ok(!isHotkeyKey({ keyCode: 9, code: 'Tab' }, hot));
  // the game buttons stay as they were
  assert.deepEqual(resolve({ ffHold: G }, QWERTY), defaults(QWERTY));
  // stored with the physical key: on a real QWERTZ keyboard the key printing Z (KeyY) still is the one picked
  hot = resolveHotkeys({ ffHold: { keyCode: 89, key: 'y', code: 'KeyY' } }, realQwertz);
  assert.equal(hot.ffHold.code, 'KeyY');
  assert.equal(hot.ffHold.keyCode, 90);
  // a game button's key (Z = A), one of the other shortcuts (T), Tab+Shift twice, junk → the default
  assert.equal(resolveHotkeys({ ffHold: { keyCode: 90, key: 'z', code: 'KeyZ' } }, QWERTY).ffHold.keyCode, 9);
  assert.equal(resolveHotkeys({ ffToggle: { keyCode: 84, key: 't', code: 'KeyT' } }, QWERTY).ffToggle.keyCode, 9);
  assert.equal(resolveHotkeys({ ffHold: { keyCode: 'x' } }, QWERTY).ffHold.keyCode, 9);
  hot = resolveHotkeys({ ffHold: { keyCode: 9, key: 'Tab', code: 'Tab', shift: true } }, QWERTY);
  assert.deepEqual(hot.ffHold, { keyCode: 9, key: 'Tab', code: 'Tab', shift: true });
  assert.equal(hot.ffToggle, null, 'Shift+Tab is taken and the default is the same – no toggle key then');
  // the two swapped
  hot = resolveHotkeys({ ffHold: { keyCode: 9, key: 'Tab', code: 'Tab', shift: true }, ffToggle: { keyCode: 9, key: 'Tab', code: 'Tab' } }, QWERTY);
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9, shift: true }, hot), 'ffHold');
  assert.equal(hotkeyOf({ key: 'Tab', code: 'Tab', keyCode: 9 }, hot), 'ffToggle');
  // a preset that puts a game button on the hotkey's key wins: the hotkey goes back to Tab
  const wasd = presetMap('wasd', QWERTY); // B on J
  assert.equal(resolveHotkeys({ ...wasd, ffHold: { keyCode: 74, key: 'j', code: 'KeyJ' } }, QWERTY).ffHold.keyCode, 9);
});

test('fast-forward on a controller: no button by default, never a game button, ZL / ZR or both on one', async () => {
  const { padHotkeys, padActions, padHotkeyPresses, padMap: pm } = await import('../web/lib/controls.mjs');
  assert.deepEqual(padHotkeys(null), { ffHold: '', ffToggle: '' });
  assert.deepEqual(padActions(null), { 7: 'turbo', 6: 'pause', 16: 'pause' });
  const pads = { preset: 'nintendo', map: { ffHold: 'RIGHT_STICK', ffToggle: 'LEFT_STICK' } };
  assert.deepEqual(padHotkeys(pads), { ffHold: 'RIGHT_STICK', ffToggle: 'LEFT_STICK' });
  assert.deepEqual(padActions(pads), { 7: 'turbo', 6: 'pause', 16: 'pause', 11: 'ffHold', 10: 'ffToggle' });
  assert.deepEqual(pm(pads), pm(null), 'the game buttons don\'t change');
  assert.deepEqual(padHotkeys({ map: { ffHold: 'BUTTON_2' } }), { ffHold: '', ffToggle: '' }, 'A (Nintendo layout) is a game button');
  assert.deepEqual(padHotkeys({ map: { ffHold: 'RIGHT_BOTTOM_SHOULDER', ffToggle: 'LEFT_BOTTOM_SHOULDER' } }), { ffHold: '', ffToggle: '' });
  assert.deepEqual(padHotkeys({ map: { ffHold: 'LEFT_STICK', ffToggle: 'LEFT_STICK' } }), { ffHold: 'LEFT_STICK', ffToggle: '' });
  assert.deepEqual(padHotkeys({ map: { ffHold: 'NOPE' } }), { ffHold: '', ffToggle: '' });
  // a game button moved onto the hotkey's button wins it
  assert.equal(padHotkeys({ map: { a: 'RIGHT_STICK', ffHold: 'RIGHT_STICK' } }).ffHold, '');

  // a poll after another: the hold is pressed and released, the toggle and ZR only pressed
  const actions = padActions(pads);
  const held = {};
  const pad = { buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
  const poll = (on, appHas = false) => {
    pad.buttons.forEach((b, i) => (b.pressed = on.includes(i)));
    return padHotkeyPresses(pad, actions, held, appHas).map((m) => `${m.action}:${m.down}`);
  };
  assert.deepEqual(poll([11]), ['ffHold:true']);
  assert.deepEqual(poll([11]), [], 'held: nothing new');
  assert.deepEqual(poll([]), ['ffHold:false']);
  assert.deepEqual(poll([10]), ['ffToggle:true']);
  assert.deepEqual(poll([]), [], 'the toggle has no release');
  assert.deepEqual(poll([7]), ['turbo:true']);
  assert.deepEqual(poll([]), []);
  // the app's menus have the controller: fast-forward doesn't start, ZL still resumes the game
  assert.deepEqual(poll([11, 6], true), ['pause:true']);
  assert.deepEqual(poll([], true), ['ffHold:false'], 'a release never hurts');
});
