// Keyboard and controller mapping for the built-in emulator – shared by Settings, Help and player.html (no imports on purpose).
// config.controls = { [button]: { keyCode, key, code? } }; keyCode is what EmulatorJS matches on, key is only for display,
// code (KeyboardEvent.code, the physical key) is set by presets and newer bindings – older configs without it still work.
export const BUTTONS = [
  // ejs = RetroArch joypad index in EmulatorJS' controls table (controller bindings: PAD_PRESETS below)
  { id: 'up', ejs: 4, keyCode: 38, key: 'ArrowUp' },
  { id: 'down', ejs: 5, keyCode: 40, key: 'ArrowDown' },
  { id: 'left', ejs: 6, keyCode: 37, key: 'ArrowLeft' },
  { id: 'right', ejs: 7, keyCode: 39, key: 'ArrowRight' },
  { id: 'a', ejs: 8, keyCode: 90, key: 'z' },
  { id: 'b', ejs: 0, keyCode: 88, key: 'x' },
  { id: 'x', ejs: 9, keyCode: 65, key: 'a', systems: ['nds'] },
  { id: 'y', ejs: 1, keyCode: 83, key: 's', systems: ['nds'] },
  { id: 'l', ejs: 10, keyCode: 81, key: 'q', systems: ['nds', 'gba'] },
  { id: 'r', ejs: 11, keyCode: 69, key: 'e', systems: ['nds', 'gba'] },
  { id: 'start', ejs: 3, keyCode: 13, key: 'Enter' },
  { id: 'select', ejs: 2, keyCode: 86, key: 'v' },
];

// Keys the Play view uses itself (web/views/play.mjs) – binding them would make one key do two things.
export const RESERVED = { 9: 'Tab', 27: 'Esc', 70: 'F', 77: 'M', 80: 'P', 82: 'R', 84: 'T', 116: 'F5', 119: 'F8', 123: 'F12',
  49: '1', 50: '2', 51: '3', 52: '4', 97: 'Num 1', 98: 'Num 2', 99: 'Num 3', 100: 'Num 4',
  187: '+ / =', 189: '-', 107: 'Num +', 109: 'Num -' }; // + / - = volume

const NAMED = { 8: 'Backspace', 13: 'Enter', 32: 'Space', 33: 'Page ↑', 34: 'Page ↓', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓',
  45: 'Insert', 46: 'Delete', 106: 'Num *', 107: 'Num +', 109: 'Num -', 110: 'Num ,', 111: 'Num /' };

/** Can EmulatorJS bind this key at all? (its keyMap; modifiers, Tab, Esc and lock keys are left out) */
export function bindable(keyCode) {
  const c = keyCode;
  return c in NAMED || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 96 && c <= 105) || (c >= 112 && c <= 123)
    || (c >= 186 && c <= 192) || (c >= 219 && c <= 222);
}

// ---- presets & keyboard layouts ---------------------------------------------------------------------------------
// Presets name physical keys (KeyboardEvent.code), so "WASD" is the same four keys on QWERTY, QWERTZ and AZERTY
// (where they print Z Q S D). None of them touches RESERVED on any of the three layouts (test/controls.test.mjs).
export const PRESETS = [
  // the classic default: D-pad on the arrows (right hand), buttons under the left hand
  { id: 'arrows', keys: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'KeyZ', b: 'KeyX', x: 'KeyA', y: 'KeyS', l: 'KeyQ', r: 'KeyE', start: 'Enter', select: 'KeyV' } },
  // D-pad under the left hand, face buttons as the console has them (B left of A, Y left of X) under the right;
  // R stays off the R key (reset) – Q/E sit right next to WASD anyway
  { id: 'wasd', keys: { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD', b: 'KeyJ', a: 'KeyK', y: 'KeyU', x: 'KeyI', l: 'KeyQ', r: 'KeyE', start: 'Enter', select: 'Space' } },
];

// What a layout prints on the keys where it differs from QWERTY – the fallback when the browser can't tell (no Keyboard Map API).
export const LAYOUTS = {
  qwerty: {},
  qwertz: { KeyY: 'z', KeyZ: 'y' },
  azerty: { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', KeyM: ',', Semicolon: 'm' },
};
const LANG_LAYOUT = { de: 'qwertz', fr: 'azerty' }; // es, it, en: QWERTY

const usChar = (code) => (/^Key[A-Z]$/.test(code) ? code[3].toLowerCase() : /^Digit\d$/.test(code) ? code[5] : undefined);
/** layout = { id, real, get(code) → printed character }; real = read from the system, not guessed. */
export function tableLayout(id) {
  const name = LAYOUTS[id] ? id : 'qwerty';
  return { id: name, real: false, get: (code) => LAYOUTS[name][code] ?? usChar(code) };
}
export const layoutForLang = (lang) => tableLayout(LANG_LAYOUT[String(lang || '').slice(0, 2).toLowerCase()]);

let current = tableLayout('qwerty');
export const currentLayout = () => current;

/** Use the system keyboard layout (Keyboard Map API: Chromium/Electron) or else guess it from the UI language. */
export async function detectLayout(lang) {
  if (!current.real) current = layoutForLang(lang ?? globalThis.navigator?.language);
  let nav = globalThis.navigator;
  try { if (globalThis.top && globalThis.top !== globalThis && globalThis.top.navigator) nav = globalThis.top.navigator; } catch { /* other origin */ }
  try {
    // only a top-level page may ask – from the emulator frame we ask the app window (same origin)
    const map = await Promise.race([nav?.keyboard?.getLayoutMap?.(), new Promise((r) => setTimeout(r, 500))]);
    if (map?.size) current = { id: 'system', real: true, get: (code) => map.get(code) };
  } catch { /* not allowed or not supported */ }
  return current;
}

const FIXED = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, NumpadEnter: 13, Space: 32, Backspace: 8,
  Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

/** Physical key → binding on a layout ({ keyCode, key, code }), or null if its keyCode can't be known in advance. */
export function keyFor(code, lay = current) {
  if (code in FIXED) return { keyCode: FIXED[code], key: code === 'Space' ? ' ' : code, code };
  let m = /^Numpad(\d)$/.exec(code);
  if (m) return { keyCode: 96 + Number(m[1]), key: m[1], code };
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { keyCode: 111 + Number(m[1]), key: code, code };
  const ch = lay.get(code);
  m = /^Digit(\d)$/.exec(code);
  if (m) return { keyCode: 48 + Number(m[1]), key: ch || m[1], code }; // also on AZERTY, where the row prints & é " …
  // keyCode follows the printed letter (QWERTZ: the key left of X is Y = 89)
  if (ch && /^[a-z]$/i.test(ch)) return { keyCode: ch.toUpperCase().charCodeAt(0), key: ch.toLowerCase(), code };
  if (!/^Key[A-Z]$/.test(code)) return null;
  if (ch && /^[\x20-\x7e]$/.test(ch)) return null; // punctuation (AZERTY's M key prints ","): its keyCode differs per platform
  return { keyCode: code.charCodeAt(3), key: ch || code[3].toLowerCase(), code }; // non-Latin layouts: browsers use the US letter
}

/** A preset as bindings on a layout. */
export function presetMap(id, lay = current) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
  return Object.fromEntries(BUTTONS.map((b) => [b.id, keyFor(p.keys[b.id], lay) || keyFor(p.keys[b.id], tableLayout('qwerty'))]));
}

/** Which preset the saved mapping is, on this layout – null = custom. No saved mapping = the default preset. */
export function activePreset(saved, lay = current) {
  if (!saved) return PRESETS[0].id;
  const m = resolve(saved, lay);
  return PRESETS.find((p) => { const pm = presetMap(p.id, lay); return BUTTONS.every((b) => m[b.id]?.keyCode === pm[b.id].keyCode); })?.id || null;
}

// A stored binding as it works on the layout in use: once the real layout is known, the physical key decides
// (keyCode follows the printed letter, so it changes with the layout). Guessed layouts keep the stored keyCode.
const live = (s, lay) => (s?.code && lay.real && keyFor(s.code, lay)) || s;

export function keyLabel(b, lay = current) {
  b = live(b, lay);
  const c = b?.keyCode;
  if (c == null) return '–';
  if (NAMED[c]) return NAMED[c];
  if (b.key && b.key.length === 1 && b.key !== ' ') return b.key.toUpperCase();
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) return String.fromCharCode(c);
  if (c >= 96 && c <= 105) return `Num ${c - 96}`;
  if (c >= 112 && c <= 123) return `F${c - 111}`;
  return b.key || `#${c}`;
}

/** The default mapping (first preset) on a layout – on QWERTZ the A button is the key printed Y, left of X. */
export const defaults = (lay = current) => presetMap(PRESETS[0].id, lay);

/** Stored mapping → complete, valid mapping (unknown, reserved or doubled keys fall back to the default). */
export function resolve(saved, lay = current) {
  const out = {};
  const used = new Set();
  const def = defaults(lay);
  for (const b of BUTTONS) {
    const s = live(saved?.[b.id], lay);
    let v = s && Number.isInteger(s.keyCode) && bindable(s.keyCode) && !(s.keyCode in RESERVED) && !used.has(s.keyCode) ? s : null;
    if (!v && !used.has(def[b.id].keyCode)) v = def[b.id];
    if (v) used.add(v.keyCode);
    out[b.id] = v ? { keyCode: v.keyCode, key: v.key || '', ...(v.code ? { code: v.code } : {}) } : null;
  }
  return out;
}

/** Stored mapping → { keyCode: button } – how the native players (lib/nativeplayer.mjs, lib/ctrplayer.mjs) read keys. */
export function keyButtons(saved, lay = current) {
  return Object.fromEntries(Object.entries(resolve(saved, lay)).filter(([, v]) => v).map(([b, v]) => [v.keyCode, b]));
}

/** EmulatorJS controls table (EJS_defaultControls): the 12 game buttons on keyboard and controller. */
export function ejsControls(saved, lay = current, pads = null) {
  const m = resolve(saved, lay);
  const pm = padMap(pads);
  const p1 = {};
  for (const b of BUTTONS) p1[b.ejs] = { value: m[b.id]?.keyCode ?? -1, value2: pm[b.id] || '' };
  return { 0: p1, 1: {}, 2: {}, 3: {} };
}

// ---- fast-forward hotkeys ---------------------------------------------------------------------------------------
// As in mGBA: hold Tab = fast-forward while it is held, Shift+Tab = fast-forward on / off – both at the turbo speed
// picked last in the play view (web/views/play.mjs handles them, the player pages only forward the keys). They can be
// re-bound like the game buttons and are stored next to them: config.controls.ffHold / .ffToggle = { keyCode, key,
// code, shift? }; on a controller config.pads.map.ffHold / .ffToggle = a button label (none unless the player picks one).
export const HOTKEYS = [
  { id: 'ffHold', keyCode: 9, key: 'Tab', code: 'Tab' },
  { id: 'ffToggle', keyCode: 9, key: 'Tab', code: 'Tab', shift: true },
];
const TAB = 9;

/** Can a hotkey sit on this key? Tab, or any key a game button could have – never one of the Play view's other shortcuts. */
export const hotkeyBindable = (keyCode) => keyCode === TAB || (bindable(keyCode) && !(keyCode in RESERVED));

/** The same key with the same Shift (Tab and Shift+Tab are two hotkeys). */
export const sameCombo = (a, b) => !!a && !!b && a.keyCode === b.keyCode && !!a.shift === !!b.shift;

/**
 * Stored mapping → the hotkeys' keys, { ffHold, ffToggle }: { keyCode, key, code?, shift? } or null. A key a game
 * button has, a key no hotkey may have or the other hotkey's (with the same Shift) falls back to the default.
 */
export function resolveHotkeys(saved, lay = current) {
  const buttons = new Set(Object.values(resolve(saved, lay)).filter(Boolean).map((v) => v.keyCode));
  const taken = [];
  const ok = (v) => !!v && Number.isInteger(v.keyCode) && hotkeyBindable(v.keyCode) && !buttons.has(v.keyCode) && !taken.some((x) => sameCombo(x, v));
  const out = {};
  for (const h of HOTKEYS) {
    const s = saved?.[h.id] && typeof saved[h.id] === 'object' ? { ...live(saved[h.id], lay), shift: !!saved[h.id].shift } : null;
    const v = ok(s) ? s : ok(h) ? h : null;
    if (v) taken.push(v);
    out[h.id] = v ? { keyCode: v.keyCode, key: v.key || '', ...(v.code ? { code: v.code } : {}), ...(v.shift ? { shift: true } : {}) } : null;
  }
  return out;
}

/** Is this key event ({ keyCode?, code?, key? }) on the binding's key? The physical key when both know it. */
export function keyMatches(e, b) {
  if (!b || !e) return false;
  if (e.code && b.code) return e.code === b.code;
  const code = Number.isInteger(e.keyCode) ? e.keyCode : e.key === 'Tab' ? TAB : null;
  return code === b.keyCode;
}

/**
 * Does a player page keep this key press (a DOM KeyboardEvent) to itself – a hotkey's key, with or without Shift? Then
 * Tab doesn't move the focus out of the game while it is the fast-forward key. Ctrl / Alt / Cmd combos stay the browser's.
 */
export const isHotkeyKey = (e, hot) => !!e && !e.ctrlKey && !e.altKey && !e.metaKey && HOTKEYS.some((h) => keyMatches(e, hot?.[h.id]));

/** Which hotkey a key press is ({ keyCode?, code?, key?, shift }): its key with exactly its Shift – else null. */
export function hotkeyOf(e, hot) {
  return HOTKEYS.find((h) => hot?.[h.id] && keyMatches(e, hot[h.id]) && !!e.shift === !!hot[h.id].shift)?.id || null;
}

// ---- controllers ------------------------------------------------------------------------------------------------
// The browser reports every controller in the "standard" layout (Gamepad API): button 0 is the bottom face button,
// 1 the right, 2 the left, 3 the top – whatever is printed on them. EmulatorJS names them BUTTON_1 … BUTTON_4.
// config.pads = { preset: 'nintendo'|'xbox', map?: { [button]: label } } – map holds what the player re-bound.
export const PAD_LABELS = ['BUTTON_1', 'BUTTON_2', 'BUTTON_3', 'BUTTON_4', 'LEFT_TOP_SHOULDER', 'RIGHT_TOP_SHOULDER',
  'LEFT_BOTTOM_SHOULDER', 'RIGHT_BOTTOM_SHOULDER', 'SELECT', 'START', 'LEFT_STICK', 'RIGHT_STICK', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT'];
const SHARED_PAD = { up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', l: 'LEFT_TOP_SHOULDER', r: 'RIGHT_TOP_SHOULDER', start: 'START', select: 'SELECT' };
export const PAD_PRESETS = [
  // where the buttons sit on a Game Boy Advance / DS: A right, B bottom, X top, Y left
  { id: 'nintendo', map: { ...SHARED_PAD, a: 'BUTTON_2', b: 'BUTTON_1', x: 'BUTTON_4', y: 'BUTTON_3' } },
  // what an Xbox pad prints: A bottom, B right, X left, Y top
  { id: 'xbox', map: { ...SHARED_PAD, a: 'BUTTON_1', b: 'BUTTON_2', x: 'BUTTON_3', y: 'BUTTON_4' } },
];
/** Controller buttons the Play view uses itself (left stick = D-pad comes on top): not bindable to game buttons. */
export const PAD_HOTKEYS = { RIGHT_BOTTOM_SHOULDER: 'turbo', LEFT_BOTTOM_SHOULDER: 'pause' };

/** Saved controller settings → complete label per game button (a doubled or unknown label falls back to the preset). */
export function padMap(pads) {
  const preset = PAD_PRESETS.find((p) => p.id === pads?.preset) || PAD_PRESETS[0];
  const out = {};
  const used = new Set();
  for (const b of BUTTONS) {
    const want = pads?.map?.[b.id];
    const v = PAD_LABELS.includes(want) && !(want in PAD_HOTKEYS) && !used.has(want) ? want : preset.map[b.id];
    out[b.id] = used.has(v) ? '' : v;
    if (v) used.add(v);
  }
  return out;
}

/**
 * Saved controller settings → the hotkeys' buttons, { ffHold, ffToggle }: a label, or '' (none – the default). Never
 * a game button's, ZL / ZR (pause / turbo) or the other hotkey's.
 */
export function padHotkeys(pads) {
  const game = new Set(Object.values(padMap(pads)).filter(Boolean));
  const out = {};
  for (const h of HOTKEYS) {
    const want = pads?.map?.[h.id];
    const ok = PAD_LABELS.includes(want) && !(want in PAD_HOTKEYS) && !game.has(want) && !Object.values(out).includes(want);
    out[h.id] = ok ? want : '';
  }
  return out;
}

/**
 * The controller buttons a player page hands to the play view, by their standard index → action: ZR / RT / R2 steps
 * the turbo, ZL / LT / L2 and Home (16) pause, and the fast-forward buttons the player picked (ffHold: pressed and
 * released, ffToggle: pressed).
 */
export function padActions(pads) {
  const out = { 7: 'turbo', 6: 'pause', 16: 'pause' };
  for (const [id, label] of Object.entries(padHotkeys(pads))) if (label) out[PAD_LABELS.indexOf(label)] = id;
  return out;
}

/**
 * One poll of those buttons (`held`: what was down at the last poll, updated here) → the messages for the play view,
 * { type: 'emu-pad', action, down }: a press of each, and the release of the fast-forward hold. While the app's menus
 * have the controller (appHasPad) only pause and turbo go through – ZL / Home still resume the game.
 */
export function padHotkeyPresses(pad, actions, held, appHas = false) {
  const out = [];
  for (const [i, action] of Object.entries(actions)) {
    const on = !!pad?.buttons?.[i]?.pressed;
    if (on && !held[i] && !(appHas && (action === 'ffHold' || action === 'ffToggle'))) out.push({ type: 'emu-pad', action, down: true });
    else if (!on && held[i] && action === 'ffHold') out.push({ type: 'emu-pad', action, down: false });
    held[i] = on;
  }
  return out;
}

/**
 * Diagnostics of a player page's controller: the device that plays and the last presses – which standard button (index,
 * label) came in, which game buttons it was mapped to and whether the app's menus had the controller then. A player's
 * "the remapping doesn't apply in game" (Discord, Windows, a DualSense and an Xbox pad) is otherwise invisible.
 */
export function padRecorder(max = 40) {
  const presses = [];
  let last = [];
  let picked = null;
  return {
    /** Every poll: the picked device (or null) and what the page made of it. */
    see(pad, map, appHas = false) {
      if (!pad) {
        picked = null;
        last = [];
        return;
      }
      if (picked?.id !== pad.id || picked?.index !== pad.index) {
        picked = { id: String(pad.id).slice(0, 120), index: pad.index, mapping: pad.mapping || '', buttons: pad.buttons.length, axes: pad.axes.length };
      }
      pad.buttons.forEach((b, i) => {
        const on = !!b.pressed;
        if (on && !last[i]) {
          const label = PAD_LABELS[i] ?? null;
          presses.push({ t: Math.round(performance.now()), i, label, game: Object.keys(map).filter((k) => map[k] === label), app: !!appHas });
          if (presses.length > max) presses.shift();
        }
        last[i] = on;
      });
    },
    info: (cfg, map) => ({ cfg: cfg || null, map, picked, presses: presses.slice() }),
  };
}

/** Which kind of controller, from the id the browser reports (vendor ids: 054c Sony, 045e Microsoft, 057e Nintendo). */
export function padFamily(id = '') {
  const s = String(id).toLowerCase();
  // vendor ids first (exact), then names – "Wireless Controller" alone is Sony's name, but Xbox pads say it too
  if (/vendor: 054c|054c-/.test(s)) return 'playstation';
  if (/vendor: 045e|045e-/.test(s)) return 'xbox';
  if (/vendor: 057e|057e-/.test(s)) return 'switch';
  if (/xbox|xinput/.test(s)) return 'xbox';
  if (/dualsense|dualshock|playstation|^wireless controller/.test(s)) return 'playstation';
  if (/pro controller|joy-con|nintendo|switch/.test(s)) return 'switch';
  return 'generic';
}

// What is printed on each standard button, per family (Switch: B bottom, A right, Y left, X top).
const PAD_PRINT = {
  playstation: { BUTTON_1: '✕', BUTTON_2: '○', BUTTON_3: '□', BUTTON_4: '△', LEFT_TOP_SHOULDER: 'L1', RIGHT_TOP_SHOULDER: 'R1', LEFT_BOTTOM_SHOULDER: 'L2', RIGHT_BOTTOM_SHOULDER: 'R2', SELECT: 'Create', START: 'Options', LEFT_STICK: 'L3', RIGHT_STICK: 'R3' },
  xbox: { BUTTON_1: 'A', BUTTON_2: 'B', BUTTON_3: 'X', BUTTON_4: 'Y', LEFT_TOP_SHOULDER: 'LB', RIGHT_TOP_SHOULDER: 'RB', LEFT_BOTTOM_SHOULDER: 'LT', RIGHT_BOTTOM_SHOULDER: 'RT', SELECT: 'View', START: 'Menu', LEFT_STICK: 'LS', RIGHT_STICK: 'RS' },
  switch: { BUTTON_1: 'B', BUTTON_2: 'A', BUTTON_3: 'Y', BUTTON_4: 'X', LEFT_TOP_SHOULDER: 'L', RIGHT_TOP_SHOULDER: 'R', LEFT_BOTTOM_SHOULDER: 'ZL', RIGHT_BOTTOM_SHOULDER: 'ZR', SELECT: '−', START: '+', LEFT_STICK: 'L3', RIGHT_STICK: 'R3' },
  generic: { BUTTON_1: '⬇', BUTTON_2: '➡', BUTTON_3: '⬅', BUTTON_4: '⬆', LEFT_TOP_SHOULDER: 'L1', RIGHT_TOP_SHOULDER: 'R1', LEFT_BOTTOM_SHOULDER: 'L2', RIGHT_BOTTOM_SHOULDER: 'R2', SELECT: 'Select', START: 'Start', LEFT_STICK: 'L3', RIGHT_STICK: 'R3' },
};
const DPAD_PRINT = { DPAD_UP: '↑', DPAD_DOWN: '↓', DPAD_LEFT: '←', DPAD_RIGHT: '→' };
/** names: the page's localized words for buttons without a print (generic pads: "bottom button" …). */
export const padLabel = (label, family = 'generic', names = {}) => (label
  ? DPAD_PRINT[label] || (family === 'generic' && names[label]) || PAD_PRINT[family]?.[label] || PAD_PRINT.generic[label] || label : '–');

// ---- which connected device plays ---------------------------------------------------------------------------------
// The Gamepad API lists more than controllers: on Windows a USB microphone or headset with its own buttons (a player's
// "DGM20 USB Microphone", issue #2) shows up as a gamepad too – often before the real one, which then never got to
// play. So souldew picks the controller itself: the one chosen in Settings › Controller (config.pads.device, the id
// the browser reports, remembered across starts) when it is connected, else the most controller-like device. A device
// that doesn't look like a controller at all is never picked on its own – only when the player chooses it.

/** Names of devices that are no controllers (audio, cameras, keyboards, mice …) – unless they report a standard layout. */
const NOT_A_PAD = /\b(mic|mics|microphone|headset|headphones?|earphones?|earbuds?|speakers?|audio|sound|webcam|camera|keyboard|mouse|dac|yeti|quadcast|stream ?deck)\b/i;

const count = (x) => (Array.isArray(x) || (x && typeof x === 'object' && Number.isInteger(x.length)) ? x.length : Number(x) || 0);
const isStandard = (p) => p?.mapping === 'standard' || p?.standard === true;

/** A device's id without what changes from start to start – what config.pads.device stores. */
export const padKey = (id) => String(id || '').trim().slice(0, 200);

/**
 * How much a device looks like a game controller: -1 = not one (a microphone, headset or anything with fewer than
 * four buttons), else higher = more likely (standard layout, a known make, enough buttons and a stick).
 * `p`: a Gamepad from navigator.getGamepads() or { id, mapping | standard, buttons, axes } (arrays or counts).
 */
export function padScore(p) {
  if (!p) return -1;
  const standard = isStandard(p);
  const buttons = count(p.buttons);
  const axes = count(p.axes);
  if (!standard && (buttons < 4 || NOT_A_PAD.test(String(p.id || '')))) return -1;
  return (standard ? 8 : 0) + (padFamily(p.id) !== 'generic' ? 4 : 0) + (buttons >= 10 ? 2 : 0) + (axes >= 2 ? 1 : 0);
}

export const looksLikePad = (p) => padScore(p) >= 0;

/**
 * The connected device that plays: the remembered one (`wanted` = config.pads.device) if it is there – the player
 * chose it, whatever it looks like – else the most controller-like one (the lowest index among equals), or null when
 * nothing connected looks like a controller.
 */
export function pickPad(pads, wanted = null) {
  const list = [...(pads || [])].filter((p) => p && p.connected !== false);
  const key = wanted ? padKey(wanted) : '';
  const mine = key && list.find((p) => padKey(p.id) === key);
  if (mine) return mine;
  let best = null;
  let bestScore = -1;
  for (const p of list) {
    const s = padScore(p);
    if (s > bestScore || (s === bestScore && s >= 0 && p.index < best.index)) [best, bestScore] = [p, s];
  }
  return bestScore >= 0 ? best : null;
}

// ---- the app's own screens ----------------------------------------------------------------------------------------
/**
 * Does the app use the controller right now (web/lib/padnav.mjs: the game is paused, in the corner or a menu is open
 * over it)? The game frames ask with their own window and then ignore the game buttons – never the turbo / pause
 * hotkeys, so ZL / Home still resume the game. False outside the app (a frame of its own, another origin).
 */
export function appHasPad(win = globalThis) {
  try {
    return win.parent !== win && !!win.parent?.__souldewPad?.mute;
  } catch {
    return false;
  }
}
