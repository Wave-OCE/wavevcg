/**
 * Team and player libraries, as a file you hand to somebody.
 *
 * Copy, never link. A team or a name that arrives this way becomes the
 * receiving account's own, editable by them and unaffected by whatever the
 * sender does next. That is the point rather than a limitation: a name is baked
 * onto a card at ingest and un-baked by the server's reresolve() straight into
 * live scoreboard and select state, so any design where another account's edit
 * reaches your resolver is one keystroke away from renaming a player on
 * somebody else's live graphic. A copy cannot do that.
 *
 * A file is also the only thing in this system that crosses accounts at all.
 * The dashboard addresses exactly one session per page load and switchTo() does
 * a full reload, so there is no moment where two libraries are in memory
 * together - except the one this module creates.
 *
 * Shared by both dashboards. Nothing here touches the network: export writes a
 * Blob, import reads a File, and the diff is arithmetic over two arrays the
 * page already holds.
 */

import { TEAM_FIELDS, mergeRoster, teamSlug } from './teams.js';
import { aliasKey } from './select-schema.js';

/**
 * Bumped only if the shape changes in a way an older reader would misread.
 * Compared with `!==` rather than `<`, because a file from a NEWER version is
 * exactly as unreadable as one from an older one and guessing is worse than
 * refusing.
 */
export const LIBRARY_FILE_VERSION = 1;

const KINDS = ['teams', 'players'];

/** What a team looks like in a file: the id, plus the fields the editor edits. */
const teamForFile = (team) => {
  const out = { id: String(team?.id ?? '') };
  for (const field of TEAM_FIELDS) out[field.key] = team?.[field.key] ?? '';
  return out;
};

/**
 * What a player looks like in a file.
 *
 * Only the three fields that are somebody's work. Deliberately NOT `seenAt`,
 * which is a fact about the sender's lobbies and means nothing at the receiving
 * desk, and deliberately NOT `rejected`, which is a list of "this is NOT that
 * player" answers given at the sender's desk about accounts the receiver may
 * never meet. The importer leaves the receiver's own `rejected` untouched.
 */
const playerForFile = (player) => ({
  id: String(player?.id ?? ''),
  riotId: String(player?.riotId ?? ''),
  alias: String(player?.alias ?? ''),
});

/**
 * Build the file. Returns the object, so callers can size it before offering it.
 *
 * `from` is a username and nothing else - no id, no key. It is there so a person
 * looking at a file in their downloads folder six weeks later knows what it is.
 */
export function buildLibraryFile(kind, entries, from = '') {
  if (!KINDS.includes(kind)) throw new Error(`Unknown library kind: ${kind}`);

  const rows = Array.isArray(entries) ? entries : [];
  return {
    riotlineLibrary: LIBRARY_FILE_VERSION,
    kind,
    from: String(from ?? '').slice(0, 32),
    exported: new Date().toISOString(),
    // Players are filtered to the named ones: an unnamed sighting is not work,
    // is useless to anybody else, and is the only thing that could push a
    // receiving library over its cap.
    ...(kind === 'teams'
      ? { teams: rows.map(teamForFile) }
      : { players: rows.filter((entry) => String(entry?.alias ?? '').trim()).map(playerForFile) }),
  };
}

/** Hand the file to the browser. A Blob and a synthetic click - no route. */
export function downloadLibraryFile(kind, entries, from = '') {
  const payload = buildLibraryFile(kind, entries, from);
  const stamp = payload.exported.slice(0, 10);
  const name = `riotline-${kind}-${from ? `${from}-` : ''}${stamp}.json`;

  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoked on the next frame rather than immediately: the click is synchronous
  // but the fetch the browser does for it is not.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { name, count: (payload.teams ?? payload.players).length };
}

/**
 * Read a file the operator picked, or throw something worth showing them.
 *
 * Every refusal names what is wrong with the FILE rather than saying "invalid",
 * because the two mistakes people actually make are picking the wrong file and
 * picking the right file on the wrong panel.
 */
export async function readLibraryFile(file, wantKind) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not JSON. Pick a library file exported from this tool.');
  }

  if (payload?.riotlineLibrary !== LIBRARY_FILE_VERSION) {
    throw new Error('That is not a library file from this tool, or it came from a different version.');
  }
  if (payload.kind !== wantKind) {
    // Both panels sit on the Global tab, so the useful half of this message is
    // which PANEL, not which tab.
    const panel = payload.kind === 'teams' ? 'Team library' : payload.kind === 'players' ? 'Player aliases' : null;
    throw new Error(
      panel
        ? `That file holds ${payload.kind}. Import it in the ${panel} panel instead.`
        : 'That file is not a team or player library.',
    );
  }

  const rows = wantKind === 'teams' ? payload.teams : payload.players;
  if (!Array.isArray(rows) || !rows.length) throw new Error('That file is empty.');

  return { from: String(payload.from ?? ''), exported: String(payload.exported ?? ''), rows };
}

// ------------------------------------------------------------------ diffs ---

/**
 * Compare a file against the library in memory.
 *
 * Three outcomes and only one of them asks a question. `identical` rows are
 * never sent and never shown - re-importing the same file must look like doing
 * nothing, because that is what re-syncing is.
 */
export function diffTeams(incoming, mine) {
  const bySlug = new Map((Array.isArray(mine) ? mine : []).map((team) => [teamSlug(team.name), team]));

  const added = [];
  const identical = [];
  const differs = [];

  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (!String(row?.name ?? '').trim()) continue;

    const existing = bySlug.get(teamSlug(row.name));
    if (!existing) {
      added.push({ row, label: row.name, players: (row.players ?? []).length });
      continue;
    }

    /*
     * How many players this row would actually move, asked of the same function
     * the server's import will use.
     *
     * Not a comparison of the two arrays, and that is the whole point: the
     * import MERGES, so a sheet listing four of a team's five players changes
     * nothing about the fifth - and a straight compare would report the team as
     * differing and offer the operator a choice between two identical outcomes.
     * Re-importing the same sheet has to look like doing nothing, because that
     * is what re-syncing is, and one function answering both questions is what
     * stops the panel and the write disagreeing about which it was.
     *
     * An absent `players` is silence about the roster, not an empty one - the
     * rule `save()` and `import()` both apply, and the reason a JSON library
     * file (which carries no rosters at all) cannot empty a squad.
     */
    const roster = row?.players === undefined ? null : mergeRoster(existing.players ?? [], row.players);

    const changed = TEAM_FIELDS.filter((field) => (existing[field.key] ?? '') !== (row[field.key] ?? '')).map(
      (field) => field.label.toLowerCase(),
    );
    if (roster?.added) changed.push(`${roster.added} new player${roster.added === 1 ? '' : 's'}`);
    if (roster?.updated) changed.push(`${roster.updated} player${roster.updated === 1 ? '' : 's'} changed`);

    if (!changed.length) identical.push({ row, label: row.name });
    else differs.push({ row, mine: existing, label: row.name, changed });
  }

  return { added, identical, differs };
}

export function diffPlayers(incoming, mine) {
  const byKey = new Map((Array.isArray(mine) ? mine : []).map((player) => [aliasKey(player), player]));

  const added = [];
  const identical = [];
  const differs = [];

  for (const row of Array.isArray(incoming) ? incoming : []) {
    const alias = String(row?.alias ?? '').trim();
    if (!alias) continue;

    // Matched the same way the server matches, so what the panel shows and what
    // the import does cannot disagree.
    const existing = byKey.get(aliasKey(row));
    const label = alias;

    if (!existing) {
      added.push({ row, label, riotId: row.riotId });
      continue;
    }
    if (existing.alias === alias) identical.push({ row, label });
    else differs.push({ row, mine: existing, label, was: existing.alias, riotId: existing.riotId || row.riotId });
  }

  return { added, identical, differs };
}

/** How many of the receiver's rows a resolved import would change. */
export const importSummary = (diff, choices) => ({
  added: diff.added.length,
  replaced: diff.differs.filter((_, index) => choices[index] === 'theirs').length,
  kept: diff.differs.filter((_, index) => choices[index] !== 'theirs').length,
  identical: diff.identical.length,
});

/**
 * The rows to POST: everything new, plus the collisions resolved to "theirs".
 *
 * A row the operator kept is simply absent, and so is an identical one - the
 * server upserts, so absence means "leave mine alone" rather than "delete".
 */
export const resolveImport = (diff, choices) => [
  ...diff.added.map((entry) => entry.row),
  ...diff.differs.filter((_, index) => choices[index] === 'theirs').map((entry) => entry.row),
];
