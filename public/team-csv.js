/**
 * A spreadsheet of teams and the players on them, folded into the library.
 *
 * The case this exists for: a competition's entry form lands in somebody's
 * inbox as a sheet with thirty-two orgs and a hundred and sixty players in it,
 * and the alternative to this file is an operator opening the team editor a
 * hundred and sixty times. That is not a convenience problem - it is where
 * misspelled Riot IDs come from, and a misspelled Riot ID is a player the lobby
 * matcher never finds.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it: the
 * suite drives it with no server and no port, which is what lets it assert on
 * exactly what a sheet turns into.
 *
 * ## Three rules the rest of this file is downstream of
 *
 * IT PARSES, IT DOES NOT WRITE. The output is a list of team records shaped
 * exactly like the ones the JSON library import already carries, so a CSV goes
 * through the SAME diff, the same collision prompt and the same
 * `action: 'import'` as a file exported from another desk. A second import path
 * with its own idea of what a collision means is how one of them ends up
 * deleting a roster nobody mentioned.
 *
 * NOTHING IS SILENTLY DROPPED. Every value this file refuses comes back as a
 * `problem` naming the LINE it was on, because a sheet is something an operator
 * can go and fix, and a logo that quietly did not arrive is discovered on air.
 * The one exception is stated where it happens: an unrecognised column is
 * reported and the import still runs, or adding a "Seed" column to a sheet
 * would refuse the whole thing.
 *
 * REFUSE A GUESS, NEVER GUESS. A header this file cannot tell apart from
 * another one - `Name`, which is either the org or the player depending on who
 * wrote the sheet - stops the import and says which two spellings it would
 * accept. Guessing wrong here mislabels every row in the file identically, and
 * nothing downstream would look wrong.
 */

import {
  PLAYER_FIELDS,
  ROSTER_LIMIT,
  TEAM_FIELDS,
  TEAM_REGIONS,
  imageValue,
  looksLikeRiotId,
  teamSlug,
} from './teams.js';

/*
 * `mergeRoster` is NOT here, and this note is where somebody will look for it.
 *
 * Folding one roster into another is a fact about ROSTERS rather than about
 * spreadsheets - the server's team import needs it for a reason that has
 * nothing to do with this file - so it lives in teams.js beside sanitiseRoster,
 * and both the browser and the store reach it there. It was defined here first;
 * moving it is what made the store's import stop deleting players a sheet did
 * not happen to mention.
 */

/**
 * How many teams one sheet may carry.
 *
 * The same number the server refuses above, deliberately, so the panel can say
 * so before spending a round trip - and stated as a constant here rather than
 * duplicated as a literal, because two copies of a cap drift and the symptom is
 * an import that the browser promised and the server refused.
 */
export const CSV_TEAM_LIMIT = 500;

/** A refusal worth showing an operator verbatim. Every one names the fix. */
export class CsvError extends Error {}

// --------------------------------------------------------------- the file ---

/**
 * Which character separates the columns.
 *
 * Sniffed rather than required, because the three ways a sheet actually arrives
 * are a comma (a saved .csv), a semicolon (Excel in any locale where the comma
 * is the decimal point - which is most of Europe, and it is not a setting the
 * person sending the file knows they have) and a TAB (a block selected in a
 * spreadsheet and pasted straight into the box). Asking an operator to convert
 * a file before importing it is asking them to open the thing they were trying
 * to avoid opening.
 *
 * Counted on the header line only, and outside quotes: a team called
 * `Team, Liquid` in row nine must not vote on the delimiter.
 */
export function sniffDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === '\n') break;
    if (ch in counts) counts[ch] += 1;
  }

  // Comma wins a tie, because it is the only one of the three that is in the
  // name of the format.
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Text in, a grid of strings out. RFC 4180 as far as it is worth going.
 *
 * Quotes are honoured only at the START of a field, which is the forgiving half
 * of this: `5'10"` in the middle of a cell is a quote character and not the
 * beginning of a quoted section, and a sheet with one unbalanced quote in it
 * therefore damages one cell rather than swallowing every row after it into a
 * single field. The strict reading is correct and the failure it produces -
 * "why did my hundred and sixty players import as one team" - is unreadable.
 *
 * Returns the line NUMBER beside each row, because that is what an operator
 * needs to go and fix the sheet, and it is not the row's index once a quoted
 * cell has carried a newline of its own.
 */
export function parseDelimited(input) {
  const raw = String(input ?? '');
  // The BOM Excel writes in front of a UTF-8 file. Left in place it becomes
  // part of the first header's name and nothing matches it.
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
  const delimiter = sniffDelimiter(text);

  const rows = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startedAt = 1;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push({ line: startedAt, cells });
    cells = [];
    startedAt = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      if (ch === '\n') line += 1;
      cell += ch;
      continue;
    }

    if (ch === '"' && cell === '') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      continue;
    }
    if (ch === '\n') {
      // Counted BEFORE the row is closed, so `endRow` files the row under the
      // line it STARTED on and opens the next one on the line after it.
      line += 1;
      endRow();
      continue;
    }
    cell += ch;
  }

  // Whatever is left is the last row, unless the file ended on a newline and
  // left nothing behind at all.
  if (cell !== '' || cells.length) endRow();

  // A sheet exported from anywhere has trailing blank lines. They are not rows.
  while (rows.length && rows[rows.length - 1].cells.every((value) => !value.trim())) rows.pop();

  return { rows, delimiter };
}

// ------------------------------------------------------------ the columns ---

/**
 * `Player Name`, `player_name` and `PLAYERNAME` are one column.
 *
 * Everything that is not a letter or a digit is removed rather than mapped to a
 * space, so a header cannot depend on which of the six ways of writing a space
 * the person who made the sheet used.
 */
export const headerKey = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * What this file understands, and the whole of it.
 *
 * `where` decides which record the value lands on, which is the one thing that
 * cannot be derived from the field name: `photo` and `playerPhoto` are both
 * images of a person, and one of them belongs to the TEAM as the stand-in for
 * anybody without their own.
 *
 * The synonyms are deliberately generous in one direction only. Every spelling
 * here is unambiguous on its own; the ones that are not are in AMBIGUOUS below
 * and stop the import rather than picking a side.
 */
export const CSV_COLUMNS = [
  { field: 'name', where: 'team', label: 'Team name', names: ['teamname', 'team', 'org', 'organisation', 'organization', 'club'] },
  {
    field: 'shortName',
    where: 'team',
    label: 'Tricode',
    names: ['tricode', 'shortname', 'short', 'abbr', 'abbreviation', 'tag', 'teamtag', 'teamshortname', 'teamabbreviation'],
  },
  { field: 'region', where: 'team', label: 'Region', names: ['region', 'teamregion'] },
  { field: 'logo', where: 'team', label: 'Logo', names: ['logo', 'logourl', 'teamlogo', 'crest', 'badge'] },
  { field: 'banner', where: 'team', label: 'Backdrop', names: ['banner', 'backdrop', 'keyart', 'teambanner', 'bannerurl'] },
  {
    field: 'playerPhoto',
    where: 'team',
    label: 'Default player photo',
    names: ['defaultplayerphoto', 'playerphotodefault', 'fallbackphoto', 'teamplayerphoto', 'defaultphoto'],
  },
  {
    field: 'colour',
    where: 'team',
    label: 'Team colour',
    names: ['colour', 'color', 'teamcolour', 'teamcolor', 'hex', 'hexcolour', 'hexcolor'],
  },
  {
    field: 'displayName',
    where: 'player',
    label: 'Player name',
    names: ['playername', 'player', 'displayname', 'handle', 'ign', 'gamertag', 'nickname', 'alias'],
  },
  { field: 'riotId', where: 'player', label: 'Riot ID', names: ['riotid', 'riot', 'riotidtag', 'valorantid', 'riotname'] },
  {
    field: 'photo',
    where: 'player',
    label: 'Player photo',
    names: ['photo', 'imageurl', 'image', 'playerphoto', 'portrait', 'picture', 'headshot', 'photourl', 'avatar'],
  },
];

/**
 * Headers that mean two different things depending on who wrote the sheet.
 *
 * `Name` is the whole list today and it is the one that matters: a sheet made
 * by whoever runs the competition calls the org's column `Name`, and a sheet
 * made by whoever collected the sign-ups calls the PLAYER's column `Name`.
 * Picking either would mislabel every row in the file the same way, so nothing
 * on screen would look wrong - the import would simply produce a hundred and
 * sixty teams, or one team with a hundred and sixty players.
 */
export const AMBIGUOUS = {
  name: ['Team name', 'Player name'],
};

/**
 * One spelling must not appear twice, and this is checked at import rather than
 * reviewed.
 *
 * A duplicate would resolve to whichever entry comes first and the other column
 * would be silently ignored - the shape of drift `assertContract` exists for in
 * companion-schema.js. Six lines that cannot rot beat a convention.
 */
(function assertColumns() {
  const seen = new Set();
  for (const column of CSV_COLUMNS) {
    for (const name of column.names) {
      if (seen.has(name)) throw new Error(`team-csv: "${name}" names two columns`);
      seen.add(name);
    }
    for (const name of column.names) {
      if (AMBIGUOUS[name]) throw new Error(`team-csv: "${name}" is both a synonym and ambiguous`);
    }
  }
  const known = new Set([...TEAM_FIELDS.map((f) => f.key), ...PLAYER_FIELDS.map((f) => f.key)]);
  for (const column of CSV_COLUMNS) {
    if (!known.has(column.field)) throw new Error(`team-csv: "${column.field}" is not a team or player field`);
  }
})();

/** Every spelling this understands, for the panel to print. One source. */
export const columnHelp = () =>
  CSV_COLUMNS.map((column) => ({ label: column.label, where: column.where, names: column.names }));

/**
 * Read the header row.
 *
 * An unrecognised column is a PROBLEM and not a refusal, deliberately: an entry
 * sheet carries seed numbers, contact emails and a "paid?" tick, and refusing
 * the file over a column this tool has no use for would send an operator to
 * delete columns out of somebody else's spreadsheet.
 */
export function mapHeader(cells) {
  const map = [];
  const problems = [];
  const taken = new Map();

  cells.forEach((raw, index) => {
    const key = headerKey(raw);
    const label = String(raw ?? '').trim();
    if (!key) {
      map[index] = null;
      return;
    }

    if (AMBIGUOUS[key]) {
      throw new CsvError(
        `A column called "${label}" could be the team or the player. Rename it "${AMBIGUOUS[key].join('" or "')}".`,
      );
    }

    const column = CSV_COLUMNS.find((entry) => entry.names.includes(key));
    if (!column) {
      map[index] = null;
      problems.push({ line: 1, text: `Column "${label}" is not one this understands - ignored.` });
      return;
    }

    // Two columns resolving to one field is the same failure as an ambiguous
    // header wearing a different hat: one of them wins and nothing says which.
    const already = taken.get(column.field);
    if (already !== undefined) {
      throw new CsvError(`Two columns both mean ${column.label}: "${already}" and "${label}". Remove one.`);
    }
    taken.set(column.field, label);
    map[index] = column;
  });

  return { map, problems, has: (field) => taken.has(field) };
}

// ------------------------------------------------------------ the records ---

const HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Clean one value, or say why it could not be used.
 *
 * Every refusal here is a value the server's sanitiser would have dropped on
 * the way in anyway. The difference is that this one says so with a line number
 * while the operator still has the sheet open, rather than leaving a blank logo
 * to be found by looking at the graphic.
 */
function cleanValue(column, raw, line, problems) {
  const value = String(raw ?? '').trim();
  if (!value) return '';

  const field = [...TEAM_FIELDS, ...PLAYER_FIELDS].find((entry) => entry.key === column.field);

  if (field?.type === 'image') {
    const url = imageValue(value, '');
    if (!url) {
      problems.push({
        line,
        text: `${column.label} "${short(value)}" is not a web address - ignored. It needs http(s):// or a path on this server.`,
      });
      return '';
    }
    return url;
  }

  if (field?.type === 'hex') {
    if (!HEX.test(value)) {
      problems.push({ line, text: `${column.label} "${short(value)}" is not a hex colour like #ff4655 - ignored.` });
      return '';
    }
    // `ff4655` is what a spreadsheet cell holds once somebody has typed a hash
    // into it and Excel has decided it is a comment. Adding it back is safe:
    // the test above has already established the rest is hex.
    return (value.startsWith('#') ? value : `#${value}`).toLowerCase();
  }

  if (column.field === 'region' && !TEAM_REGIONS.includes(value)) {
    // Kept, not dropped - `sanitiseTeamFields` deliberately preserves a region
    // this build has never heard of, and an event running one should not lose
    // it. Flagged because the likelier cause is a typo that would go on air.
    problems.push({ line, text: `Region "${short(value)}" is not one of the usual ones - kept as typed.` });
  }

  if (column.field === 'riotId' && !looksLikeRiotId(value)) {
    // Kept for the reason the roster editor keeps it: a value that vanishes
    // when you look away is worse than one that is visibly wrong, and the
    // Verify button is what actually decides.
    problems.push({ line, text: `Riot ID "${short(value)}" is not GameName#Tag - kept, but it will not verify.` });
  }

  if (field?.max && value.length > field.max) {
    problems.push({ line, text: `${column.label} "${short(value)}" is longer than ${field.max} characters - it will be cut.` });
  }

  return value;
}

const short = (value) => (value.length > 40 ? `${value.slice(0, 37)}…` : value);

/**
 * A sheet of teams and their players.
 *
 * ONE ROW IS ONE PLAYER, and the team columns repeat down the rows - which is
 * what a sign-up sheet already looks like, and is the only shape that does not
 * ask somebody to put five names in one cell. A row naming a team and no player
 * is a team with an empty roster, which is an ordinary thing to want.
 *
 * The first non-blank value wins for a team field. That is the rule that makes
 * the repeated columns harmless in both directions: a logo typed once on the
 * first of five rows reaches the team, and four blank cells under it do not
 * wipe it out again.
 */
export function readTeamCsv(text) {
  const { rows } = parseDelimited(text);
  if (!rows.length) throw new CsvError('That file is empty.');

  const { map, problems, has } = mapHeader(rows[0].cells);
  if (!has('name')) {
    throw new CsvError('No team column. One column has to be called "Team name" - see the list of what this understands.');
  }
  const wantsPlayers = has('displayName') || has('riotId');
  if (!wantsPlayers) {
    problems.push({
      line: 1,
      text: 'No "Player name" or "Riot ID" column, so this imports teams only - the rosters stay as they are.',
    });
  }

  /** teamSlug -> the record being built. Slugged, so "SEN" and "sen" are one. */
  const bySlug = new Map();
  const order = [];

  for (const { line, cells } of rows.slice(1)) {
    if (cells.every((value) => !String(value ?? '').trim())) continue;

    const team = {};
    const player = {};
    map.forEach((column, index) => {
      if (!column) return;
      const value = cleanValue(column, cells[index], line, problems);
      if (!value) return;
      if (column.where === 'team') team[column.field] = value;
      else player[column.field] = value;
    });

    if (!team.name) {
      problems.push({ line, text: 'No team name on this row - skipped.' });
      continue;
    }

    const slug = teamSlug(team.name);
    let record = bySlug.get(slug);
    if (!record) {
      if (bySlug.size >= CSV_TEAM_LIMIT) {
        problems.push({ line, text: `More than ${CSV_TEAM_LIMIT} teams - "${short(team.name)}" and anything after it were left out.` });
        continue;
      }
      // `players` is always present, even empty. An absent key means "leave the
      // squad alone" to both the store and the diff, and a sheet that names a
      // player column is making a statement about the roster.
      record = { ...team, players: [] };
      bySlug.set(slug, record);
      order.push(record);
    } else {
      // First non-blank wins. See the docblock.
      for (const [key, value] of Object.entries(team)) if (!record[key]) record[key] = value;
    }

    if (!player.displayName && !player.riotId) continue;

    const clash = record.players.find(
      (entry) =>
        (player.riotId && entry.riotId.toLowerCase() === player.riotId.toLowerCase()) ||
        (player.displayName && entry.displayName.toLowerCase() === player.displayName.toLowerCase()),
    );
    if (clash) {
      problems.push({
        line,
        text: `"${short(player.displayName || player.riotId)}" is already on ${short(record.name)} - this row was skipped.`,
      });
      continue;
    }

    if (record.players.length >= ROSTER_LIMIT) {
      problems.push({
        line,
        text: `${short(record.name)} already has ${ROSTER_LIMIT} players - "${short(player.displayName || player.riotId)}" was left out.`,
      });
      continue;
    }

    record.players.push({ displayName: player.displayName ?? '', riotId: player.riotId ?? '', photo: player.photo ?? '' });
  }

  if (!order.length) throw new CsvError('No teams in that file - every row was missing a team name.');

  // When the sheet names no player column at all, the rosters must not be
  // mentioned: an empty `players` on every record would be read as "empty every
  // squad", which is the one thing an import must never be able to do.
  const teams = wantsPlayers ? order : order.map(({ players, ...fields }) => fields);

  return { teams, problems, players: order.reduce((n, team) => n + team.players.length, 0) };
}

/**
 * The same sheet, read for ONE team's roster.
 *
 * The team columns are ignored rather than refused - the whole point is that an
 * operator can take the competition's sheet, select the five rows that are this
 * team, and paste them in without editing anything out first. Which team they
 * belong to is not in question: it is the team whose editor is open.
 */
export function readRosterCsv(text) {
  const { rows } = parseDelimited(text);
  if (!rows.length) throw new CsvError('There is nothing there.');

  const { map, problems, has } = mapHeader(rows[0].cells);
  if (!has('displayName') && !has('riotId')) {
    throw new CsvError('No player column. One column has to be called "Player name" or "Riot ID".');
  }

  const players = [];
  for (const { line, cells } of rows.slice(1)) {
    if (cells.every((value) => !String(value ?? '').trim())) continue;

    const player = {};
    map.forEach((column, index) => {
      if (!column || column.where !== 'player') return;
      const value = cleanValue(column, cells[index], line, problems);
      if (value) player[column.field] = value;
    });

    if (!player.displayName && !player.riotId) continue;
    players.push({ displayName: player.displayName ?? '', riotId: player.riotId ?? '', photo: player.photo ?? '', line });
  }

  if (!players.length) throw new CsvError('No players in that - every row was missing a name and a Riot ID.');
  return { players, problems };
}

/**
 * A sheet with the right headings in it, for an operator to fill in.
 *
 * Generated from CSV_COLUMNS rather than written out, so a column added above
 * appears in the template without anybody remembering to put it there - and the
 * example row is what makes the format obvious without reading anything.
 */
export function csvTemplate() {
  const heads = CSV_COLUMNS.map((column) => column.label);
  const example = [
    ['Sentinels', 'SEN', 'Americas', 'https://example.com/sen.png', '', '', '#ff4655', 'TenZ', 'TenZ#SEN', ''],
    ['Sentinels', 'SEN', '', '', '', '', '', 'zekken', 'zekken#NA1', ''],
    ['Team Liquid', 'TL', 'EMEA', '', '', '', '#041e42', 'Jamppi', 'Jamppi#EU', ''],
  ];
  const escape = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [heads, ...example].map((row) => row.map(escape).join(',')).join('\r\n');
}
