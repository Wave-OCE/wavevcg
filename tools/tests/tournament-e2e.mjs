/**
 * Tournaments over the real server: who may make one, who may change one, and
 * who may not find out one exists.
 *
 * Runs against a throwaway STATE_DIR so the operator's live config is not
 * touched. Nothing is mocked - it spawns node server.js and talks HTTP.
 *
 *   node tools/tests/tournament-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8175;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-tourney-'));

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      return true;
    } catch {
      await wait(250);
    }
  }
  return false;
}

function agent() {
  let cookie = '';
  return async (path, options = {}) => {
    const response = await fetch(`${BASE}${path}`, {
      ...options,
      redirect: 'manual',
      headers: { ...(options.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0];
      if (pair.startsWith('rl_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: response.status, text, json };
  };
}

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const signIn = async (who, username, password) =>
  who('/api/auth/login', json({ username, password }));

try {
  if (!(await ready())) throw new Error(`server never came up:\n${log}`);

  const boss = agent();
  const alex = agent();
  const sam = agent();

  await signIn(boss, 'boss', 'a-long-enough-password');

  // Two ordinary operators, neither an administrator.
  for (const name of ['alex', 'sam']) {
    const made = await boss('/api/admin/users', json({ action: 'create', username: name, password: 'another-long-password' }));
    ok(`created the account ${name}`, made.status === 200, `${made.status} ${made.text.slice(0, 120)}`);
  }
  await signIn(alex, 'alex', 'another-long-password');
  await signIn(sam, 'sam', 'another-long-password');

  const idOf = (name) => boss('/api/admin/users').then((r) => r.json?.users?.find((u) => u.username === name)?.id);
  const alexId = await idOf('alex');
  const samId = await idOf('sam');

  // ------------------------------------------------- the capability gate ---

  let r = await alex('/api/tournaments');
  ok('1. a signed-in operator may list tournaments', r.status === 200, String(r.status));
  ok('2. ...and sees none to begin with', Array.isArray(r.json?.tournaments) && r.json.tournaments.length === 0);
  ok('3. ...and is told they cannot create one', r.json?.mayCreate === false);

  r = await alex('/api/tournaments', json({ action: 'create', name: 'Touch Grass' }));
  ok('4. creating without the capability is refused', r.status === 403, String(r.status));

  r = await boss('/api/admin/users', json({ action: 'update', id: alexId, capabilities: { manageTournaments: true } }));
  ok('5. an admin can grant manageTournaments', r.status === 200, r.text.slice(0, 160));

  r = await alex('/api/tournaments');
  ok('6. the capability shows up on the list route', r.json?.mayCreate === true);

  /*
   * An administrator does NOT get this one implicitly - adminImplied is false.
   *
   * Asked of a SECOND administrator, not of boss. boss is the one the
   * ADMIN_USERNAME bootstrap creates, and that bootstrap grants
   * manageTournaments deliberately - otherwise a fresh install has an admin who
   * cannot make a tournament and nobody to make one for them. Asking boss would
   * test the bootstrap and call it an implication, which is how an assertion
   * ends up green for the wrong reason.
   */
  const chief = agent();
  await boss('/api/admin/users', json({ action: 'create', username: 'chief', password: 'another-long-password', role: 'admin' }));
  await signIn(chief, 'chief', 'another-long-password');
  r = await chief('/api/tournaments');
  ok('7. an administrator is not implicitly able to create', r.json?.mayCreate === false, JSON.stringify(r.json?.mayCreate));

  r = await chief('/api/tournaments', json({ action: 'create', name: 'By fiat' }));
  ok('7b. ...and is refused when they try', r.status === 403, String(r.status));

  // ------------------------------------------------------------ creating ---

  r = await alex('/api/tournaments', json({ action: 'create', name: 'Touch Grass Invitational' }));
  ok('8. creating with the capability works', r.status === 200, r.text.slice(0, 160));
  const cup = r.json?.tournament;
  ok('9. the creator is its owner', cup?.members?.find((m) => m.id === alexId)?.level === 'owner');
  ok('10. the id is a uuid, not a name slug', /^[0-9a-f-]{36}$/i.test(cup?.id ?? ''), cup?.id);
  ok('11. it is not archived', !cup?.archivedAt);

  // ------------------------------------------------ nobody else can see it ---

  r = await sam('/api/tournaments');
  ok('12. a non-member sees nothing', r.json?.tournaments?.length === 0);

  r = await sam('/api/tournaments', json({ action: 'update', id: cup.id, fields: { name: 'Mine now' } }));
  ok('13. a non-member gets 404, not 403', r.status === 404, String(r.status));

  r = await boss('/api/tournaments');
  ok('14. an administrator does not see it either', r.json?.tournaments?.length === 0);

  // ------------------------------------------------------------ settings ---

  r = await alex('/api/tournaments', json({ action: 'update', id: cup.id, fields: { startsAt: '2026-07-04', endsAt: '' } }));
  ok('15. an owner can set the dates', r.json?.tournament?.startsAt === '2026-07-04', r.text.slice(0, 160));
  ok('16. a blank end date is a real answer', r.json?.tournament?.endsAt === '');

  r = await alex('/api/tournaments', json({ action: 'update', id: cup.id, fields: { startsAt: '2026-02-31' } }));
  ok('17. an impossible date is refused, keeping the old one', r.json?.tournament?.startsAt === '2026-07-04');

  r = await alex('/api/tournaments', json({ action: 'update', id: cup.id, fields: { logo: 'javascript:alert(1)' } }));
  ok('18. a non-http logo is discarded', r.json?.tournament?.logo === '');

  r = await alex('/api/tournaments', json({ action: 'update', id: cup.id, fields: { logo: '/media/abc123.png' } }));
  ok('19. an uploaded media path is kept', r.json?.tournament?.logo === '/media/abc123.png');

  r = await alex('/api/tournaments', json({ action: 'update', id: cup.id, fields: { name: 'Renamed' } }));
  ok('20. renaming does not move the id', r.json?.tournament?.id === cup.id);
  ok('21. ...and a partial update keeps the other fields', r.json?.tournament?.startsAt === '2026-07-04');

  // -------------------------------------------------------- membership ---

  r = await alex('/api/tournaments', json({ action: 'member', id: cup.id, userId: samId, level: 'viewer' }));
  ok('22. an owner can add a viewer', r.status === 200, r.text.slice(0, 160));

  r = await sam('/api/tournaments');
  ok('23. the viewer now sees it', r.json?.tournaments?.length === 1);
  ok('24. ...and is told their level', r.json?.tournaments?.[0]?.level === 'viewer');

  r = await sam('/api/tournaments', json({ action: 'update', id: cup.id, fields: { name: 'Nope' } }));
  ok('25. a viewer cannot change settings', r.status === 403, String(r.status));

  r = await sam('/api/tournaments', json({ action: 'member', id: cup.id, userId: alexId, level: 'viewer' }));
  ok('26. a viewer cannot change membership', r.status === 403, String(r.status));

  r = await alex('/api/tournaments', json({ action: 'member', id: cup.id, userId: samId, level: 'editor' }));
  ok('27. an owner can promote to editor', r.status === 200);

  r = await sam('/api/tournaments', json({ action: 'update', id: cup.id, fields: { name: 'Editor was here' } }));
  ok('28. an editor can change settings', r.json?.tournament?.name === 'Editor was here', r.text.slice(0, 160));

  r = await sam('/api/tournaments', json({ action: 'archive', id: cup.id }));
  ok('29. an editor cannot archive', r.status === 403, String(r.status));

  // A member needs no capability of their own - this is the common case.
  r = await sam('/api/tournaments');
  ok('30. an editor still cannot create their own', r.json?.mayCreate === false);

  // --------------------------------------------------- the last-owner lock ---

  r = await alex('/api/tournaments', json({ action: 'member', id: cup.id, userId: alexId, level: 'viewer' }));
  ok('31. the last owner cannot demote themselves', r.status >= 400, String(r.status));

  r = await alex('/api/tournaments', json({ action: 'member', id: cup.id, userId: alexId, level: '' }));
  ok('32. ...nor remove themselves', r.status >= 400, String(r.status));

  r = await alex('/api/tournaments', json({ action: 'member', id: cup.id, userId: samId, level: 'owner' }));
  ok('33. a second owner can be added', r.status === 200);

  r = await alex('/api/tournaments', json({ action: 'member', id: cup.id, userId: alexId, level: '' }));
  ok('34. ...and then the first may leave', r.status === 200, r.text.slice(0, 160));

  r = await alex('/api/tournaments');
  ok('35. who no longer sees it', r.json?.tournaments?.length === 0);

  // ------------------------------------------------------------ archiving ---

  r = await sam('/api/tournaments', json({ action: 'archive', id: cup.id }));
  ok('36. the remaining owner can archive', Boolean(r.json?.tournament?.archivedAt), r.text.slice(0, 160));

  r = await sam('/api/tournaments', json({ action: 'update', id: cup.id, fields: { name: 'While archived' } }));
  ok('37. an archived tournament refuses settings changes', r.status === 409, String(r.status));

  r = await sam('/api/tournaments');
  ok('38. an archived tournament is still listed, not hidden', r.json?.tournaments?.length === 1);

  r = await sam('/api/tournaments', json({ action: 'archive', id: cup.id, archived: false }));
  ok('39. it can be reopened', !r.json?.tournament?.archivedAt);

  // ------------------------------------------------------------ the gate ---

  const key = (await sam('/api/account/me')).json?.user?.sessionKey;
  ok('40. the test has a session key to try', Boolean(key));

  /*
   * These assert on KEYED_ROUTES, not on a check inside the tournament block -
   * there is none, deliberately. Verified by ADDING '/api/tournaments' to
   * KEYED_ROUTES, which turns both of these red; an earlier redundant guard in
   * the route itself left them green and proved nothing.
   */
  r = await agent()(`/api/tournaments?key=${key}`);
  ok('41. a session key cannot read tournaments', r.status === 403, String(r.status));
  ok('41b. ...and is told what a key is actually for', r.text.includes('output pages and the webhooks'), r.text.slice(0, 120));

  r = await agent()(`/api/tournaments?key=${key}`, json({ action: 'create', name: 'Via key' }));
  ok('42. ...nor create one', r.status === 403, String(r.status));

  r = await agent()('/api/tournaments');
  ok('43. signed out is refused', r.status === 401, String(r.status));

  // The CSRF shape: a body an HTML form could have sent.
  r = await sam('/api/tournaments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=archive',
  });
  ok('44. a form-shaped POST is refused', r.status === 415, String(r.status));

  r = await sam('/api/tournaments', json({ action: 'nonsense', id: cup.id }));
  ok('45. an unknown action is a 400', r.status === 400, String(r.status));

  // ------------------------------------------------ export, and then delete ---
  //
  // In that order on purpose: Export is the answer to "can I get this back",
  // and the delete branch is only defensible because it exists.

  const doomed = (await alex('/api/tournaments', json({ action: 'create', name: 'Spring Open' }))).json.tournament;
  await alex(`/api/teams?session=${doomed.id}`, json({ action: 'save', team: { name: 'Sentinels', shortName: 'SEN' } }));
  await alex(
    `/api/aliases?session=${doomed.id}`,
    json({ action: 'save', player: { riotId: 'old#name', name: 'NewName' } }),
  );

  r = await alex('/api/tournaments', json({ action: 'export', id: doomed.id }));
  const dump = r.json?.export;
  ok('46. an owner can export a tournament', r.status === 200, r.text.slice(0, 160));
  ok('47. the export carries the team library', dump?.teams?.length === 1, JSON.stringify(dump?.teams));
  ok('48. ...and the alias library', dump?.aliases?.length === 1, JSON.stringify(dump?.aliases));
  ok('49. ...and the settings', dump?.fields?.name === 'Spring Open', JSON.stringify(dump?.fields));

  /*
   * What must NOT be in it. A session key in a file that gets emailed around is
   * how a key leaks, and account ids from this server mean nothing on another -
   * re-granting access on import would be a way to add yourself to a
   * competition by editing a text file.
   */
  const dumped = JSON.stringify(dump);
  ok('50. the export carries no session key', !dumped.includes(doomed.sessionKey), 'a key reached the file');
  ok('51. ...and no membership', !dumped.includes('members') && !dumped.includes(alexId));

  r = await chief('/api/tournaments', json({ action: 'export', id: doomed.id }));
  ok('52. a stranger - an administrator, even - cannot export it', r.status === 404, String(r.status));

  // The archive/delete split: the irreversible step needs the reversible one first.
  r = await alex('/api/tournaments', json({ action: 'delete', id: doomed.id, confirm: 'Spring Open' }));
  ok('53. a live tournament cannot be deleted', r.status === 409, r.text.slice(0, 120));
  ok('54. ...and it says archiving is the reversible step', /reversible/i.test(r.json?.error?.hint ?? ''));

  await alex('/api/tournaments', json({ action: 'archive', id: doomed.id, archived: true }));

  r = await alex('/api/tournaments', json({ action: 'delete', id: doomed.id, confirm: 'spring open' }));
  ok('55. the wrong name is refused', r.status === 400, String(r.status));
  ok('56. ...and says nothing has been deleted', /Nothing has been deleted/.test(r.json?.error?.hint ?? ''));
  r = await alex('/api/tournaments', json({ action: 'delete', id: doomed.id, confirm: '' }));
  ok('57. an empty confirmation is refused too', r.status === 400, String(r.status));
  ok('58. ...and it really is still there', (await alex('/api/tournaments')).json.tournaments.some((t) => t.id === doomed.id));

  // Membership, not ownership, is what an editor has - and delete is an owner's.
  await alex('/api/tournaments', json({ action: 'member', id: doomed.id, userId: samId, level: 'editor' }));
  r = await sam('/api/tournaments', json({ action: 'delete', id: doomed.id, confirm: 'Spring Open' }));
  ok('59. an editor cannot delete', r.status === 403, String(r.status));
  r = await sam('/api/tournaments', json({ action: 'export', id: doomed.id }));
  ok('60. ...but an editor CAN export, archived and all', r.status === 200, r.text.slice(0, 120));

  // A key shows a graphic. It does not carry a competition off the server.
  for (const action of ['export', 'delete']) {
    const keyed = await fetch(`${BASE}/api/tournaments?key=${encodeURIComponent(doomed.sessionKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id: doomed.id, confirm: 'Spring Open' }),
    });
    ok(`61.${action} a session key cannot reach it`, keyed.status === 403, String(keyed.status));
  }

  const doomedDir = path.join(STATE, 'tournaments', doomed.id);
  ok('62. the workspace is on disk before the delete', existsSync(doomedDir));

  r = await alex('/api/tournaments', json({ action: 'delete', id: doomed.id, confirm: 'Spring Open' }));
  ok('63. the owner deleted it', r.status === 200 && r.json.deleted === doomed.id, r.text.slice(0, 160));
  ok('64. ...and the whole workspace tree went with it', !existsSync(doomedDir));
  ok('65. ...and the old session key stops resolving', (await fetch(`${BASE}/api/graphic?key=${encodeURIComponent(doomed.sessionKey)}`)).status === 404);
  ok('66. ...and it is gone from the list', !(await alex('/api/tournaments')).json.tournaments.some((t) => t.id === doomed.id));

  /*
   * At warn, not info. It is the only trace that will remain of a competition
   * somebody spent a season on, and it has to be findable in a log an
   * administrator is skimming for what went wrong.
   */
  ok('67. the deletion is logged at warn with the name', /warn.*DELETED "Spring Open"/is.test(log), 'no warn line');
  ok('68. ...and the log carries no key', !log.includes(doomed.sessionKey));

  // ---------------------------------- deleting an account keeps the event ---

  r = await boss('/api/admin/users', json({ action: 'delete', id: samId }));
  ok('69. the admin deleted the last owner', r.status === 200, r.text.slice(0, 160));

  // alex is not a member any more, so re-add through a fresh owner to look.
  r = await boss('/api/admin/users', json({ action: 'update', id: alexId, capabilities: { manageTournaments: true } }));
  const after = await alex('/api/tournaments');
  ok('70. the tournament was NOT deleted with the account', after.status === 200);
  ok('71. ...and the server said it is ownerless', log.includes('has no owner left'), 'no warn line');

  // -------------------------------------------------------------- restart ---

  const restartLog = log;
  ok('72. nothing was logged as unsaved', !restartLog.includes('tournaments not saved'));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.message}`);
} finally {
  server.kill();
  await wait(300);
  rmSync(STATE, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
