// Shiny odds for Generation 3 (GBA) games, as a ROM patch.
//
// Gen 3 decides shininess in code: (TID ^ SID ^ PID_hi ^ PID_lo) < 8, i.e. 8 of 65536 values = 1/8192. The compiled
// check is a Thumb `cmp rN, #7` that follows the XOR chain, so raising the immediate raises the odds:
// `cmp rN, #(odds-1)` makes odds/65536 shiny. An 8-bit immediate caps this at 256 (= 1/256).
//
// The game has the check in a few places: the sprite palette, the shiny sparkle, the summary star, and the "this
// trainer's Pokémon is never shiny" re-roll loop. All of them are patched, otherwise a Pokémon could look shiny in one
// screen and not in another, or a trainer's could become shiny. Checked on Pokémon Emerald (USA/Europe) – 5 places.
// Other Gen 3 releases compile the same check, but are not verified: findShinySites() returns what it found and the
// caller decides (applyShinyOdds refuses a ROM with fewer than MIN_SITES).

export const DEFAULT_ODDS = 8; // out of 65536
export const MAX_ODDS = 256; // an 8-bit immediate holds at most 255 = odds - 1
export const MIN_SITES = 3;

const isGba = (rom) => rom.length >= 0x200000 && rom[0xb2] === 0x96; // the cartridge header's fixed byte

/** Offsets of the `cmp rN, #7` instructions that end a (TID ^ SID ^ PID) shiny check. */
export function findShinySites(rom) {
  if (!isGba(rom)) return [];
  const sites = [];
  const end = Math.min(rom.length, 0x1000000) - 2; // code lives in the first 16 MB
  for (let o = 0x100; o < end; o += 2) {
    const w = rom[o] | (rom[o + 1] << 8);
    if ((w & 0xf8ff) !== 0x2807) continue; // cmp rN, #7 (N is 0–7)
    let lsr = 0, eor = 0;
    for (let k = 1; k <= 14; k++) {
      const p = rom[o - 2 * k] | (rom[o - 2 * k + 1] << 8);
      if ((p & 0xffc0) === 0x0c00) lsr++; // lsrs rd, rm, #16 – the high half of the ID or the PID
      if ((p & 0xffc0) === 0x4040) eor++; // eors rd, rm
    }
    if (lsr >= 2 && eor >= 3) sites.push(o);
  }
  return sites;
}

/** The odds as a whole number out of 65536 between DEFAULT_ODDS and MAX_ODDS, or null. */
export function cleanOdds(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= DEFAULT_ODDS && n <= MAX_ODDS ? n : null;
}

/** Patch `rom` (a Buffer/Uint8Array) in place; returns { sites, odds }. Throws when the ROM isn't a game it can patch. */
export function applyShinyOdds(rom, odds) {
  const n = cleanOdds(odds);
  if (n == null) throw new Error(`Shiny odds must be between ${DEFAULT_ODDS} and ${MAX_ODDS} (out of 65536)`);
  const sites = findShinySites(rom);
  if (sites.length < MIN_SITES) throw new Error('Could not find the shiny check in this game – the shiny odds can only be changed in Gen 3 (GBA) games');
  if (n === DEFAULT_ODDS) return { sites: sites.length, odds: n };
  for (const o of sites) rom[o] = n - 1; // the immediate is the low byte of the instruction
  return { sites: sites.length, odds: n };
}
