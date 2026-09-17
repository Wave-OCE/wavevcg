/**
 * Rosters on the team library.
 *
 * A unit test with no server and no port, so it can assert on exactly what
 * reaches disk and exactly what a caller is handed back.
 *
 * Two properties carry most of the weight. A roster must NOT travel onto a
 * graphic when a team is picked - `teamContent()` copies every TEAM_FIELD, and
 * players are deliberately not one. And a save that does not mention players
 * must not clear them, because the team editor and the roster editor are
 * different panels and one of them does not know the other exists.
 *
 *   node tools/tests/team-roster.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeTeamStore } from '../../graphics.js';
import { PLAYER_FIELDS, ROSTER_LIMIT, looksLikeRiotId, sanitiseRoster, teamContent } from '../../public/teams.js';

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const dir = await mkdtemp(path.join(tmpdir(), 'rl-roster-'));
const file = path.join(dir, 'teams.json');

try {
  const store = makeTeamStore(file);
  await store.load();

  // ------------------------------------------------------------- the shape ---

  const squad = [
    { displayName: 'TenZ', riotId: 'TenZ#SEN' },
    { displayName: 'zekken', riotId: 'zekken#NA1' },
  ];
  const sen = store.save({ name: 'Sentinels', shortName: 'SEN', players: squad });

  ok('1. a team can be saved with a roster', sen.players.length === 2);
  ok('2. the fields survive', sen.players[0].displayName === 'TenZ' && sen.players[0].riotId === 'TenZ#SEN');
  ok('3. the puuid fields exist and are empty', sen.players[0].puuid === '' && sen.players[0].puuidSource === '');

  // --------------------------------- the roster does not travel to a graphic ---
  //
  // Add `players` to TEAM_FIELDS and 4 goes red. That is the assertion standing
  // between a roster and three graphic states carrying ten player records each.

  const copied = teamContent(sen);
  ok('4. teamContent does NOT carry the roster', copied.players === undefined, JSON.stringify(Object.keys(copied)));
  ok('5. ...but does carry the fields', copied.name === 'Sentinels' && copied.shortName === 'SEN');

  // ------------------------------------------------------------ preserving ---
  //
  // Drop the `players !== undefined` guard in save() and 6 goes red.

  const renamed = store.save({ id: sen.id, name: 'Sentinels', shortName: 'SEN', colour: '#ff0000' });
  ok('6. a save that does not mention players keeps them', renamed.players.length === 2, JSON.stringify(renamed.players));
  ok('7. ...and still applies the field it did mention', renamed.colour === '#ff0000');

  const emptied = store.save({ id: sen.id, name: 'Sentinels', players: [] });
  ok('8. an empty array is a real instruction to clear', emptied.players.length === 0);

  store.save({ id: sen.id, name: 'Sentinels', players: squad });

  // ------------------------------------------------ a verification survives ---

  store.save({
    id: sen.id,
    name: 'Sentinels',
    players: [{ displayName: 'TenZ', riotId: 'TenZ#SEN', puuid: 'abc-123', puuidSource: 'riot', puuidCheckedAt: 99 }],
  });
  const verified = store.get(sen.id).players[0];
  ok('9. a stored puuid survives a save', verified.puuid === 'abc-123');
  ok('10. ...with its provenance', verified.puuidSource === 'riot' && verified.puuidCheckedAt === 99);

  // An unknown source is not a source. A value nobody can trace is worse than
  // none, because it looks like evidence.
  store.save({ id: sen.id, name: 'Sentinels', players: [{ displayName: 'TenZ', puuid: 'x', puuidSource: 'vibes' }] });
  ok('11. an unrecognised puuid source is dropped', store.get(sen.id).players[0].puuidSource === '');

  store.save({ id: sen.id, name: 'Sentinels', players: squad });

  // ---------------------------------------------------------------- limits ---

  const big = Array.from({ length: 25 }, (_, i) => ({ displayName: `P${i}`, riotId: `P${i}#EU1` }));
  ok('12. a roster is capped', sanitiseRoster(big).length === ROSTER_LIMIT);

  ok(
    '13. a row with neither a name nor a Riot ID is not a player',
    sanitiseRoster([{ displayName: '', riotId: '' }, { displayName: 'Real' }]).length === 1,
  );
  ok('14. ...but a name alone is enough', sanitiseRoster([{ displayName: 'Real' }])[0].displayName === 'Real');
  ok('15. ...and a Riot ID alone is too', sanitiseRoster([{ riotId: 'Ghost#EU1' }])[0].riotId === 'Ghost#EU1');

  // ------------------------------------------------------------- riot ids ---

  ok('16. a plain Riot ID is accepted', looksLikeRiotId('TenZ#SEN'));
  ok('17. unicode game names are accepted', looksLikeRiotId('한지민#KR1'), 'a regexp must not refuse real players');
  ok('18. spaces in a game name are fine', looksLikeRiotId('Some One#EU1'));
  ok('19. no hash is not a Riot ID', !looksLikeRiotId('TenZ'));
  ok('20. two hashes is not either', !looksLikeRiotId('a#b#c'));
  ok('21. an empty tag is not', !looksLikeRiotId('TenZ#'));
  ok('22. blank is not, but is allowed elsewhere', !looksLikeRiotId(''));

  // ------------------------------------------------------- handing out copies ---
  //
  // Splice the copy in list() back to a plain spread and 23 goes red.

  const listed = store.list().find((team) => team.id === sen.id);
  listed.players.pop();
  listed.players[0].displayName = 'VANDAL';
  const afterMeddling = store.get(sen.id);
  ok('23. list() hands out a copy, not the store', afterMeddling.players.length === 2);
  ok('24. ...deeply enough to protect a player', afterMeddling.players[0].displayName === 'TenZ');

  // ---------------------------------------------------------------- import ---

  store.import([{ name: 'Sentinels', shortName: 'SEN' }]);
  ok('25. importing a file with no rosters keeps the ones here', store.get(sen.id).players.length === 2);

  const withRoster = store.import([{ name: 'Sentinels', players: [{ displayName: 'New', riotId: 'New#EU1' }] }]);
  ok('26. importing a file WITH a roster applies it', store.get(sen.id).players[0].displayName === 'New');
  ok('27. ...and reports it as an update', withRoster.updated === 1, JSON.stringify(withRoster));

  const fresh = store.import([{ name: 'Fnatic', players: [{ displayName: 'Boaster', riotId: 'Boaster#FNC' }] }]);
  ok('28. a new team arrives with its roster', fresh.added === 1);
  ok('29. ...and it is there', store.list().find((t) => t.name === 'Fnatic').players.length === 1);

  // -------------------------------------------------------------- on disk ---

  await store.flush();
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  ok('30. the roster reached disk', onDisk.find((t) => t.name === 'Sentinels').players.length === 1);

  // And a reload gets it back, which is what makes the file worth writing.
  const reopened = makeTeamStore(file);
  await reopened.load();
  ok('31. and survives a reload', reopened.get(sen.id)?.players?.[0]?.displayName === 'New');
  ok('32. every player field survives the round trip', PLAYER_FIELDS.every((f) => f.key in reopened.get(sen.id).players[0]));

  // A library written before rosters existed has no `players` key at all, and
  // every reader assumes the key is there.
  const legacy = makeTeamStore(path.join(dir, 'legacy.json'));
  await legacy.load();
  legacy.save({ name: 'Old Team' });
  ok('33. a team saved with no roster still has the key', Array.isArray(legacy.get(legacy.list()[0].id).players));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.stack}`);
} finally {
  await rm(dir, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
