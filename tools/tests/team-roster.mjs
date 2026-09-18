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
import { PLAYER_FIELDS, ROSTER_LIMIT, looksLikeRiotId, mergeRoster, sanitiseRoster, teamContent } from '../../public/teams.js';
import { CsvError, csvTemplate, parseDelimited, readRosterCsv, readTeamCsv, sniffDelimiter } from '../../public/team-csv.js';

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

  /*
   * A ROSTER IS MERGED, NOT REPLACED, and 26a is the assertion that matters.
   *
   * `import()` has always promised "adds and updates, never deletes", and until
   * a spreadsheet could carry players that promise only had to hold at the TEAM
   * level. Replacing meant a sheet naming four of a team's five players dropped
   * the fifth and took every stored PUUID on that team with it - nothing
   * failing, nothing logged, surfacing weeks later as a roster that no longer
   * matches a lobby. Restore `existing.players = roster` and 26a, 27a and 27c
   * all go red.
   *
   * Removing somebody stays the EDITOR's job, which assertion 8 above pins: an
   * empty array from save() really does empty the squad. A file that does not
   * mention somebody is silent about them; an operator deleting a row is not.
   */
  store.save({
    id: sen.id,
    name: 'Sentinels',
    players: [
      { displayName: 'TenZ', riotId: 'TenZ#SEN', puuid: 'abc-123', puuidSource: 'henrik', puuidCheckedAt: 99 },
      { displayName: 'zekken', riotId: 'zekken#NA1' },
    ],
  });

  const withRoster = store.import([{ name: 'Sentinels', players: [{ displayName: 'New', riotId: 'New#EU1' }] }]);
  const senRoster = store.get(sen.id).players;
  ok(
    '26. importing a file WITH a roster applies it',
    senRoster.some((p) => p.displayName === 'New'),
    JSON.stringify(senRoster.map((p) => p.displayName)),
  );
  ok(
    '26a. ...and removes nobody it did not mention',
    senRoster.map((p) => p.displayName).join(',') === 'TenZ,zekken,New',
    JSON.stringify(senRoster.map((p) => p.displayName)),
  );
  ok('27. ...and reports it as an update', withRoster.updated === 1, JSON.stringify(withRoster));
  ok(
    '27a. a stored identity survives an import that did not mention it',
    senRoster[0].puuid === 'abc-123' && senRoster[0].puuidCheckedAt === 99,
    JSON.stringify(senRoster[0]),
  );

  /*
   * A row that CHANGES somebody's Riot ID retires the verification, exactly as
   * typing in the box does - leaving the lamp lit would say "this identity is
   * confirmed" about a handle nobody has looked up. The puuid itself stays,
   * because it is still a true fact about the player.
   */
  store.import([{ name: 'Sentinels', players: [{ displayName: 'TenZ', riotId: 'TenZ#NEW' }] }]);
  const moved = store.get(sen.id).players[0];
  ok('27b. an imported Riot ID change is applied', moved.riotId === 'TenZ#NEW', JSON.stringify(moved));
  ok(
    '27c. ...and retires the verification without dropping the identity',
    moved.puuidCheckedAt === 0 && moved.puuid === 'abc-123',
    JSON.stringify(moved),
  );

  // Re-importing the same sheet has to look like doing nothing, because that is
  // what re-syncing is. The browser's diff asks mergeRoster the same question.
  const again = store.import([{ name: 'Sentinels', players: [{ displayName: 'TenZ', riotId: 'TenZ#NEW' }] }]);
  ok('27d. re-importing the same rows changes nothing', again.added === 0 && again.updated === 0, JSON.stringify(again));

  const fresh = store.import([{ name: 'Fnatic', players: [{ displayName: 'Boaster', riotId: 'Boaster#FNC' }] }]);
  ok('28. a new team arrives with its roster', fresh.added === 1);
  ok('29. ...and it is there', store.list().find((t) => t.name === 'Fnatic').players.length === 1);

  // -------------------------------------------------------------- on disk ---

  await store.flush();
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  ok('30. the roster reached disk', onDisk.find((t) => t.name === 'Sentinels').players.length === 3, JSON.stringify(onDisk.find((t) => t.name === 'Sentinels').players.map((p) => p.displayName)));

  // And a reload gets it back, which is what makes the file worth writing.
  const reopened = makeTeamStore(file);
  await reopened.load();
  ok('31. and survives a reload', reopened.get(sen.id)?.players?.[0]?.displayName === 'TenZ', JSON.stringify(reopened.get(sen.id)?.players?.[0]));
  ok('32. every player field survives the round trip', PLAYER_FIELDS.every((f) => f.key in reopened.get(sen.id).players[0]));

  // A library written before rosters existed has no `players` key at all, and
  // every reader assumes the key is there.
  const legacy = makeTeamStore(path.join(dir, 'legacy.json'));
  await legacy.load();
  legacy.save({ name: 'Old Team' });
  ok('33. a team saved with no roster still has the key', Array.isArray(legacy.get(legacy.list()[0].id).players));

  // ============================================================ spreadsheets ===
  //
  // A sign-up sheet with thirty-two orgs and a hundred and sixty players in it,
  // read without a server and without a browser - which is what lets these
  // assert on exactly what a sheet turns into rather than on what a panel says.

  // ------------------------------------------------------------ the format ---
  //
  // Three delimiters, because three is how many ways a sheet actually arrives:
  // a saved .csv, Excel in a comma-as-decimal-point locale, and a block pasted
  // straight out of a spreadsheet.

  ok('34. a comma sheet is read as one', sniffDelimiter('Team name,Tricode,Player name') === ',');
  ok('35. a semicolon sheet is too', sniffDelimiter('Team name;Tricode;Player name') === ';');
  ok('36. and a block pasted from a spreadsheet', sniffDelimiter('Team name\tTricode\tPlayer name') === '\t');
  ok(
    '37. a delimiter inside quotes does not vote',
    sniffDelimiter('"a,b,c,d";x;y') === ';',
    'a team called "Team, Liquid" must not decide the format',
  );

  const quoted = parseDelimited('a,"b,c",d\r\ne,"f""g",h\r\n');
  ok('38. a quoted comma stays in its cell', quoted.rows[0].cells[1] === 'b,c', JSON.stringify(quoted.rows[0].cells));
  ok('39. a doubled quote is one quote', quoted.rows[1].cells[1] === 'f"g', JSON.stringify(quoted.rows[1].cells));
  ok('40. a trailing newline is not a row', quoted.rows.length === 2, String(quoted.rows.length));

  /*
   * A newline INSIDE a quoted cell, and the line number that follows it.
   *
   * The number is what a problem is reported against, and it is not the row's
   * index the moment one cell has carried a newline of its own - which is the
   * shape every "org name with a line break in it" sheet has.
   */
  const wrapped = parseDelimited('a,"b\nc",d\ne,f,g');
  ok('41. a newline inside a quoted cell stays in it', wrapped.rows[0].cells[1] === 'b\nc', JSON.stringify(wrapped.rows[0].cells));
  ok('42. ...and the next row knows which LINE it is on', wrapped.rows[1].line === 3, String(wrapped.rows[1].line));

  ok('43. a BOM is not part of the first heading', parseDelimited('\ufeffTeam name,Tricode').rows[0].cells[0] === 'Team name');

  // ----------------------------------------------------------- the columns ---

  const spelling = readTeamCsv('TEAM_NAME,Short Name,player name,RiotID\nSentinels,SEN,TenZ,TenZ#SEN');
  ok('44. headings are matched however they are spelled', spelling.teams[0].name === 'Sentinels', JSON.stringify(spelling.teams[0]));
  ok('45. ...on every column', spelling.teams[0].shortName === 'SEN' && spelling.teams[0].players[0].riotId === 'TenZ#SEN');

  /*
   * A heading this cannot tell apart from another one STOPS the import.
   *
   * `Name` is the org's column on a sheet made by whoever runs the competition
   * and the player's on one made by whoever collected the sign-ups. Picking
   * either would mislabel every row in the file identically - a hundred and
   * sixty teams, or one team with a hundred and sixty players - and nothing on
   * screen would look wrong.
   */
  let refused = null;
  try {
    /*
     * A sheet that is otherwise FINE - it has a team column and a data row - so
     * the ambiguous heading is the only thing left to refuse it for.
     *
     * The first version of this used a sheet with no team column at all and was
     * vacuous: delete the ambiguity check and it was still refused, for the
     * other reason, and 46 stayed green while only 47 went red. Found by
     * breaking it, which is the only way anyone ever finds one.
     */
    readTeamCsv('Team name,Name\nSentinels,TenZ');
  } catch (error) {
    refused = error;
  }
  ok('46. an ambiguous heading is refused rather than guessed', refused instanceof CsvError, String(refused));
  ok('47. ...naming both spellings it would accept', /Team name.+Player name/.test(refused?.message ?? ''), refused?.message);
  // And the other half of the pair: a heading it simply does not KNOW is
  // ignored rather than refused, so the two behaviours cannot be confused for
  // each other by a future edit that makes one of them the other.
  ok('47a. ...while a heading it does not know is ignored instead', readTeamCsv('Team name,Seed\nSentinels,1').teams.length === 1);

  let doubled = null;
  try {
    readTeamCsv('Team,Org\nA,B');
  } catch (error) {
    doubled = error;
  }
  ok('48. two headings meaning one field are refused', doubled instanceof CsvError, String(doubled));
  ok('49. ...naming both of them', /"Team".+"Org"/.test(doubled?.message ?? ''), doubled?.message);

  let headless = null;
  try {
    readTeamCsv('Player name,Riot ID\nTenZ,TenZ#SEN');
  } catch (error) {
    headless = error;
  }
  ok('50. a sheet with no team column is refused', headless instanceof CsvError, String(headless));

  // An unrecognised column is reported and IGNORED, never refused: an entry
  // sheet carries seed numbers, contact emails and a "paid?" tick, and refusing
  // the file over one would send an operator to edit somebody else's document.
  const extra = readTeamCsv('Team name,Seed,Contact\nSentinels,1,a@b.test');
  ok('51. an unrecognised column does not refuse the file', extra.teams.length === 1);
  ok('52. ...but is reported', extra.problems.some((p) => /Seed/.test(p.text)), JSON.stringify(extra.problems));

  // ------------------------------------------------------------- the rows ---

  const sheet = readTeamCsv(
    [
      'Team Name,Tricode,Region,Logo,Colour,Player Name,Riot ID',
      'Sentinels,SEN,Americas,https://x.test/a.png,#ff4655,TenZ,TenZ#SEN',
      'sentinels,,,,,zekken,zekken#NA1',
      'Sentinels,,,,,TenZ,TenZ#DUPLICATE',
      ',,,,,orphan,orphan#NA1',
      'Team Liquid,TL,,not-a-url,red,Jamppi,JamppiEU',
    ].join('\n'),
  );

  ok('53. one row per player, the team columns repeated', sheet.teams.length === 2, JSON.stringify(sheet.teams.map((t) => t.name)));
  ok('54. ...and the players gather under their team', sheet.teams[0].players.length === 2, JSON.stringify(sheet.teams[0].players));
  ok('55. a team is matched on what its name slugs to', sheet.teams[0].players[1].displayName === 'zekken', 'sentinels and Sentinels are one team');

  /*
   * FIRST NON-BLANK WINS for a team field, and that is what makes the repeated
   * columns harmless in both directions: a logo typed once on the first of five
   * rows reaches the team, and four blank cells under it do not wipe it again.
   */
  ok('56. a team field typed once reaches the team', sheet.teams[0].logo === 'https://x.test/a.png', sheet.teams[0].logo);
  ok('57. ...and a blank cell below it does not clear it', sheet.teams[0].shortName === 'SEN', sheet.teams[0].shortName);

  ok('58. a row naming no team is skipped', !JSON.stringify(sheet.teams).includes('orphan'));
  ok('59. ...and says which line it was on', sheet.problems.some((p) => p.line === 5 && /team name/i.test(p.text)), JSON.stringify(sheet.problems));
  ok('60. the same player twice on one team is skipped', sheet.teams[0].players.length === 2, JSON.stringify(sheet.teams[0].players));

  /*
   * Every value refused is a value the server's sanitiser would have dropped on
   * the way in anyway. The difference is that this one says so with a line
   * number while the operator still has the sheet open, rather than leaving a
   * blank logo to be found by looking at the graphic.
   */
  ok('61. a logo that is not a URL is dropped', !sheet.teams[1].logo, sheet.teams[1].logo);
  ok('62. ...and reported against its line', sheet.problems.some((p) => p.line === 6 && /Logo/.test(p.text)), JSON.stringify(sheet.problems));
  ok('63. a colour that is not hex is dropped', !sheet.teams[1].colour, sheet.teams[1].colour);
  ok(
    '64. a malformed Riot ID is KEPT and flagged',
    sheet.teams[1].players[0].riotId === 'JamppiEU' && sheet.problems.some((p) => /GameName#Tag/.test(p.text)),
    JSON.stringify(sheet.teams[1].players[0]),
  );

  ok('65. a hex colour without its hash is repaired', readTeamCsv('Team name,Colour\nA,FF4655').teams[0].colour === '#ff4655');

  /*
   * A sheet naming no player column at all must not MENTION the rosters.
   *
   * An empty `players` on every record would be read as "empty every squad" by
   * the diff and by the store - which is the one thing an import must never be
   * able to do, and it would take out every PUUID on the way.
   */
  const teamsOnly = readTeamCsv('Org,Tag\nAlpha,ALP\nBeta,BET');
  ok('66. a sheet with no player column imports teams only', teamsOnly.teams.length === 2);
  ok('67. ...and says NOTHING about the rosters', teamsOnly.teams.every((t) => t.players === undefined), JSON.stringify(teamsOnly.teams));
  ok('68. ...and says so out loud', teamsOnly.problems.some((p) => /teams only/.test(p.text)), JSON.stringify(teamsOnly.problems));

  // The template has to be readable by the thing that produced it, or it is a
  // document that teaches the wrong format.
  const template = readTeamCsv(csvTemplate());
  ok('69. the template this offers is one it can read', template.teams.length === 2, JSON.stringify(template.teams.map((t) => t.name)));
  ok('70. ...with no problems in it', template.problems.length === 0, JSON.stringify(template.problems));

  // ------------------------------------------------------- one team's roster ---
  //
  // The team columns are IGNORED rather than refused: an operator selects this
  // team's five rows out of the competition's sheet and pastes them in without
  // deleting the columns that name a team they are already looking at.

  const pasted = readRosterCsv('Team name\tPlayer name\tRiot ID\nSentinels\tTenZ\tTenZ#SEN\nSentinels\tzekken\tzekken#NA1');
  ok('71. a roster paste ignores the team columns', pasted.players.length === 2, JSON.stringify(pasted.players));
  ok('72. ...and keeps the player ones', pasted.players[0].riotId === 'TenZ#SEN');

  let noPlayers = null;
  try {
    readRosterCsv('Team name,Tricode\nSentinels,SEN');
  } catch (error) {
    noPlayers = error;
  }
  ok('73. a paste with no player column is refused', noPlayers instanceof CsvError, String(noPlayers));

  // ------------------------------------------------------------ the merge ---

  const before = [
    { displayName: 'TenZ', riotId: 'TenZ#SEN', photo: '', puuid: 'p1', puuidSource: 'henrik', puuidCheckedAt: 99 },
    { displayName: 'Sub', riotId: 'sub#NA1', photo: '', puuid: '', puuidSource: '', puuidCheckedAt: 0 },
  ];
  const folded = mergeRoster(before, [{ displayName: 'TenZ', riotId: 'TenZ#NEW' }, { displayName: 'zekken', riotId: 'zekken#NA1' }]);

  ok('74. a merge adds who it names', folded.added === 1 && folded.players.length === 3, JSON.stringify(folded));
  ok('75. ...updates who it matches', folded.updated === 1 && folded.players[0].riotId === 'TenZ#NEW');
  ok('76. ...and removes nobody it did not mention', folded.players.some((p) => p.displayName === 'Sub'), JSON.stringify(folded.players.map((p) => p.displayName)));
  ok('77. a changed Riot ID retires the verification', folded.players[0].puuidCheckedAt === 0, JSON.stringify(folded.players[0]));
  ok('78. ...without dropping the identity itself', folded.players[0].puuid === 'p1');
  ok('79. the source array is left alone', before[0].riotId === 'TenZ#SEN', JSON.stringify(before[0]));

  const full = mergeRoster(
    Array.from({ length: ROSTER_LIMIT }, (_, i) => ({ displayName: `P${i}`, riotId: `P${i}#EU1` })),
    [{ displayName: 'One More', riotId: 'more#EU1' }],
  );
  ok('80. a full roster refuses the overflow', full.players.length === ROSTER_LIMIT && full.added === 0, JSON.stringify(full.players.length));
  ok('81. ...and names who was left out', full.skipped.join(',') === 'One More', JSON.stringify(full.skipped));

  // Matched on the Riot ID FIRST, because that is the identity and the name is
  // what somebody is called this week.
  const renamedPlayer = mergeRoster([{ displayName: 'TenZ', riotId: 'TenZ#SEN', puuid: '', puuidSource: '', puuidCheckedAt: 0 }], [
    { displayName: 'Tyson', riotId: 'TenZ#SEN' },
  ]);
  ok('82. the Riot ID matches before the name', renamedPlayer.players.length === 1, JSON.stringify(renamedPlayer.players));
  ok('83. ...so a rename is an update, not a second row', renamedPlayer.players[0].displayName === 'Tyson');

} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.stack}`);
} finally {
  // Guarded, because Windows answers ENOTEMPTY here often enough that an
  // unguarded rm turns a green run into a crash with no tally printed at all.
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* windows */
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
