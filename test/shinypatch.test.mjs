import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { findShinySites, applyShinyOdds, cleanOdds } from '../shared/shinypatch.mjs';

// A tiny fake GBA image with one shiny check: ands/eors/lsrs…/cmp r0,#7
function fake() {
  const rom = new Uint8Array(0x200000);
  rom[0xb2] = 0x96;
  const code = [0x4018, 0x0c00, 0x4041, 0x0c09, 0x4041, 0x4051, 0x2807, 0xd800];
  code.forEach((w, i) => { rom[0x1000 + 2 * i] = w & 255; rom[0x1001 + 2 * i] = w >> 8; });
  return rom;
}

test('shiny odds: finds and patches the check', () => {
  const rom = fake();
  assert.deepEqual(findShinySites(rom), [0x100c]);
  assert.equal(cleanOdds(7), null);
  assert.equal(cleanOdds(257), null);
  assert.equal(cleanOdds(256), 256);
});

test('shiny odds: refuses a game without the check', () => {
  assert.throws(() => applyShinyOdds(fake(), 64), /Gen 3/); // one site is fewer than MIN_SITES
  assert.throws(() => applyShinyOdds(new Uint8Array(100), 64), /between|Gen 3/);
});

// The real game is not in the repository; with a local copy (SOULDEW_TEST_EMERALD) the whole thing is checked.
const emerald = process.env.SOULDEW_TEST_EMERALD;
test('shiny odds: Pokémon Emerald', { skip: !emerald || !existsSync(emerald) }, () => {
  const rom = new Uint8Array(readFileSync(emerald));
  const sites = findShinySites(rom);
  assert.equal(sites.length, 5);
  const r = applyShinyOdds(rom, 64);
  assert.equal(r.sites, 5);
  for (const o of sites) assert.equal(rom[o], 63);
  assert.equal(findShinySites(rom).length, 0); // patched checks no longer read #7
});
