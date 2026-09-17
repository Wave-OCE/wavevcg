/**
 * Every player this tournament knows about, from both places that know one.
 *
 * There are two, and that is not an accident waiting to be tidied up:
 *
 *   a TEAM ROSTER is a squad - somebody sat down and wrote out who plays for
 *   this org, with the Riot ID they will be in the lobby under.
 *
 *   the ALIAS LIBRARY is a dictionary - what a Riot ID is called on air. Most
 *   of it arrives on its own, because every player the agent select feed
 *   reports is recorded whether anybody has named them or not.
 *
 * They overlap and neither contains the other. A player on a roster who has
 * never been in a lobby has no alias record until the team is saved; a player
 * the feed saw last night belongs to no team at all. A page that showed one and
 * not the other would be missing people in both directions, and the operator's
 * question - "who is this handle and what do we call them" - does not care
 * which of the two the answer came from.
 *
 * So this merges them into one row per PERSON. Pure, and deliberately so: it is
 * a function from two arrays to a third with no DOM and no fetch in it, which
 * is what lets it be asserted on in a unit test rather than driven through a
 * browser.
 */

import { riotIdKey, stripTagline } from './select-schema.js';

/**
 * What a row is called.
 *
 * The roster's name wins, because it is the one somebody typed against a team
 * with a squad list in front of them. Then the alias, then the Riot ID with its
 * tagline stripped - the same fallback ladder `displayName` uses, so this page
 * says what the cards will say.
 */
const rowName = (player, alias, riotId) =>
  String(player?.displayName ?? '').trim() || String(alias ?? '').trim() || stripTagline(riotId);

/**
 * One row per person, sorted by what they are called.
 *
 * `player` and `team` are LIVE references into the arrays handed in, not copies.
 * That is what lets a verification write straight into the roster it came from
 * and then save that team; copying here would mean a second merge on the way
 * back, keyed on something, and that something would be the Riot ID that the
 * verification may just have re-spelled.
 */
export function indexPlayers({ teams = [], aliases = [] } = {}) {
  const rows = new Map();

  /*
   * Keyed on the Riot ID where there is one, because that is the only thing
   * both sides carry. `riotIdKey` rather than the raw string: the game client
   * writes "RTLine #GLHF" with a space and a roster is typed "RTLine#GLHF", and
   * two rows for one person is precisely the failure this page exists to fix.
   *
   * Without a Riot ID a row cannot merge with anything, so it gets a key that
   * cannot collide instead of being dropped - a player with a name and no
   * handle yet is an ordinary state on a roster typed a week early.
   */
  const at = (key, seed) => {
    if (!rows.has(key)) rows.set(key, { key, riotId: '', name: '', alias: '', accountId: '', teams: [], player: null, team: null, aliasRecord: null, ...seed });
    return rows.get(key);
  };

  for (const team of teams) {
    (team?.players ?? []).forEach((player, index) => {
      const riotId = String(player?.riotId ?? '').trim();
      const key = riotIdKey(riotId) || `roster:${team.id}:${index}`;
      const row = at(key, { riotId });
      // First team wins the editable seat. A player on two rosters is rare and
      // is usually a mistake worth SEEING rather than hiding, so both teams are
      // listed even though only one of them is written to.
      if (!row.player) {
        row.player = player;
        row.team = team;
      }
      if (!row.riotId) row.riotId = riotId;
      row.teams.push({ id: team.id, name: team.name, shortName: team.shortName });
    });
  }

  for (const record of aliases) {
    const riotId = String(record?.riotId ?? '').trim();
    const key = riotIdKey(riotId) || `account:${record?.id ?? ''}`;
    if (!riotIdKey(riotId) && !record?.id) continue;
    const row = at(key, { riotId });
    row.aliasRecord = record;
    row.alias = String(record?.alias ?? '');
    row.accountId = String(record?.id ?? '');
    if (!row.riotId) row.riotId = riotId;
  }

  for (const row of rows.values()) row.name = rowName(row.player, row.alias, row.riotId);

  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Does this row match what was typed in the box?
 *
 * Every field an operator might have in their head, because the whole point of
 * a search across both libraries is that they do not know which one the person
 * is in. Blank matches everything - an empty search is not a filter.
 */
export function matchesPlayer(row, needle) {
  const wanted = String(needle ?? '').trim().toLowerCase();
  if (!wanted) return true;
  const hay = [
    row.name,
    row.riotId,
    row.alias,
    row.accountId,
    ...row.teams.flatMap((team) => [team.name, team.shortName]),
  ];
  return hay.some((value) => String(value ?? '').toLowerCase().includes(wanted));
}

/**
 * A short line saying where this row came from, for the operator who is about
 * to edit it. Three states, and they are genuinely different things to be:
 * on a squad, in the dictionary because the feed saw them, or written down by
 * hand before either.
 */
export function playerOrigin(row) {
  const teams = row.teams.map((team) => team.shortName || team.name).filter(Boolean);
  if (teams.length) return teams.join(', ');
  if (row.accountId) return 'seen in a lobby';
  return 'typed in';
}
