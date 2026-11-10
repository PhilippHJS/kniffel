// Regeln, Wertung und Items. Reine Logik ohne Browser-Abhängigkeiten,
// damit sie sich mit `node --test` prüfen lässt.

export const MAX_PLAYERS = 6;
export const HAND_LIMIT = 3;
export const START_ITEMS = 2;
export const GIFT_ROUNDS = [5, 9];
export const DOUBLE_CAP = 30;
export const CURSE_PENALTY = 10;
export const UPPER_BONUS_AT = 63;
export const UPPER_BONUS = 35;
export const EXTRA_KNIFFEL_BONUS = 50;
export const TOTAL_ROUNDS = 13;
export const PEN_COUNT = 6;

export const CATEGORIES = [
  { id: 'ones', name: 'Einser', section: 'upper', face: 1, max: 5, hint: 'Nur Einsen zählen' },
  { id: 'twos', name: 'Zweier', section: 'upper', face: 2, max: 10, hint: 'Nur Zweien zählen' },
  { id: 'threes', name: 'Dreier', section: 'upper', face: 3, max: 15, hint: 'Nur Dreien zählen' },
  { id: 'fours', name: 'Vierer', section: 'upper', face: 4, max: 20, hint: 'Nur Vieren zählen' },
  { id: 'fives', name: 'Fünfer', section: 'upper', face: 5, max: 25, hint: 'Nur Fünfen zählen' },
  { id: 'sixes', name: 'Sechser', section: 'upper', face: 6, max: 30, hint: 'Nur Sechsen zählen' },
  { id: 'threeKind', name: 'Dreierpasch', section: 'lower', max: 30, hint: 'Drei gleiche, alle Augen zählen' },
  { id: 'fourKind', name: 'Viererpasch', section: 'lower', max: 30, hint: 'Vier gleiche, alle Augen zählen' },
  { id: 'fullHouse', name: 'Full House', section: 'lower', max: 25, hint: 'Drei gleiche und zwei gleiche, 25 Punkte' },
  { id: 'smallStraight', name: 'Kleine Straße', section: 'lower', max: 30, hint: 'Vier Zahlen in Folge, 30 Punkte' },
  { id: 'largeStraight', name: 'Große Straße', section: 'lower', max: 40, hint: 'Fünf Zahlen in Folge, 40 Punkte' },
  { id: 'kniffel', name: 'Kniffel', section: 'lower', max: 50, hint: 'Fünf gleiche, 50 Punkte' },
  { id: 'chance', name: 'Chance', section: 'lower', max: 30, hint: 'Alle Augen zählen' },
];

const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const categoryById = (id) => (typeof id === 'string' && Object.hasOwn(CAT_BY_ID, id) ? CAT_BY_ID[id] : null);

// kind: 'self' wirkt auf den eigenen Zug, 'attack' auf den nächsten Zug des Ziels.
// needs: was die Oberfläche vor dem Einsetzen abfragen muss.
export const ITEMS = {
  extra: {
    name: 'Zusatzwurf', icon: '🎲', kind: 'self', needs: null, weight: 3,
    text: 'Du darfst in diesem Zug einmal mehr würfeln.',
  },
  flip: {
    name: 'Dreher', icon: '🔄', kind: 'self', needs: 'die', weight: 3,
    text: 'Dreht einen Würfel auf die Gegenseite: 1↔6, 2↔5, 3↔4.',
  },
  wish: {
    name: 'Wunschwürfel', icon: '✨', kind: 'self', needs: 'dieValue', weight: 1.5,
    text: 'Stellt einen Würfel auf eine Zahl deiner Wahl.',
  },
  double: {
    name: 'Doppler', icon: '✌️', kind: 'self', needs: null, weight: 1.5,
    text: `Dein Eintrag in diesem Zug zählt doppelt (höchstens +${DOUBLE_CAP}).`,
  },
  shield: {
    name: 'Schild', icon: '🛡️', kind: 'self', needs: null, weight: 2,
    text: 'Wehrt das nächste Item ab, das jemand gegen dich einsetzt.',
  },
  brake: {
    name: 'Wurfbremse', icon: '🐌', kind: 'attack', needs: 'target', weight: 3,
    text: 'Das Ziel hat in seinem nächsten Zug einen Wurf weniger.',
    status: 'hat im nächsten Zug einen Wurf weniger',
  },
  ice: {
    name: 'Eiswürfel', icon: '❄️', kind: 'attack', needs: 'target', weight: 3,
    text: 'Im nächsten Zug des Ziels friert nach dem ersten Wurf ein zufälliger Würfel fest.',
    status: 'bekommt im nächsten Zug einen Würfel eingefroren',
  },
  thief: {
    name: 'Taschendieb', icon: '🧤', kind: 'attack', needs: 'target', weight: 2,
    text: 'Klaut dem Ziel ein zufälliges Item.',
  },
  curse: {
    name: 'Fluch', icon: '🌩️', kind: 'attack', needs: 'target', weight: 2,
    text: `Der nächste Eintrag des Ziels zählt ${CURSE_PENALTY} Punkte weniger (nie unter 0).`,
    status: `verliert beim nächsten Eintrag ${CURSE_PENALTY} Punkte`,
  },
};

const NEXT_TURN_EFFECTS = ['brake', 'ice', 'curse'];
const itemById = (id) => (typeof id === 'string' && Object.hasOwn(ITEMS, id) ? ITEMS[id] : null);

// Der Angriff, der auf den nächsten Zug dieses Spielers wartet (oder null).
export function pendingAttack(player) {
  return NEXT_TURN_EFFECTS.find((id) => player.effects && player.effects[id]) || null;
}

// ---------- Wertung ----------

function countFaces(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  let sum = 0;
  for (const d of dice) {
    counts[d] += 1;
    sum += d;
  }
  return { counts, sum };
}

function longestRun(counts) {
  let best = 0;
  let run = 0;
  for (let face = 1; face <= 6; face += 1) {
    run = counts[face] > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function isRolled(dice) {
  return Array.isArray(dice) && dice.length === 5 && dice.every((d) => d >= 1 && d <= 6);
}

export function isKniffel(dice) {
  return isRolled(dice) && dice.every((d) => d === dice[0]);
}

export function scoreFor(catId, dice) {
  const cat = categoryById(catId);
  if (!cat || !isRolled(dice)) return 0;
  const { counts, sum } = countFaces(dice);
  const most = Math.max(...counts);
  if (cat.section === 'upper') return counts[cat.face] * cat.face;
  switch (catId) {
    case 'threeKind': return most >= 3 ? sum : 0;
    case 'fourKind': return most >= 4 ? sum : 0;
    case 'fullHouse': return counts.includes(3) && counts.includes(2) ? 25 : 0;
    case 'smallStraight': return longestRun(counts) >= 4 ? 30 : 0;
    case 'largeStraight': return longestRun(counts) >= 5 ? 40 : 0;
    case 'kniffel': return most === 5 ? 50 : 0;
    case 'chance': return sum;
    default: return 0;
  }
}

// Weiterer Kniffel, nachdem das Kniffel-Feld schon 50 Punkte hat:
// 50 Bonuspunkte, und der Wurf gilt als Joker (Höchstwert in einem freien Feld).
export function jokerActive(player, dice) {
  return isKniffel(dice) && player.scores.kniffel === 50;
}

export function potentialScore(player, catId, dice) {
  const cat = categoryById(catId);
  if (!cat) return 0;
  if (jokerActive(player, dice)) return cat.max;
  return scoreFor(catId, dice);
}

export function filledCount(player) {
  return Object.keys(player.scores).length;
}

export function totals(player) {
  let upper = 0;
  let lower = 0;
  for (const cat of CATEGORIES) {
    const value = player.scores[cat.id];
    if (typeof value !== 'number') continue;
    if (cat.section === 'upper') upper += value;
    else lower += value;
  }
  const bonus = upper >= UPPER_BONUS_AT ? UPPER_BONUS : 0;
  const kniffelBonus = player.kniffelBonus || 0;
  const itemPoints = player.itemPoints || 0;
  return {
    upper,
    bonus,
    lower,
    kniffelBonus,
    itemPoints,
    total: upper + bonus + lower + kniffelBonus + itemPoints,
    filled: filledCount(player),
  };
}

export function handSize(player) {
  return Array.isArray(player.items) ? player.items.length : player.itemCount || 0;
}

// ---------- Spielzustand ----------

export function createGame() {
  return {
    v: 1,
    phase: 'lobby',
    options: { items: true },
    players: [],
    current: 0,
    round: 1,
    turn: null,
    giftsGiven: [],
    log: [],
    logSeq: 0,
    nextId: 1,
  };
}

function freshEffects() {
  return { shield: false, brake: false, ice: false, curse: false };
}

function resetPlayer(player) {
  player.scores = {};
  player.kniffelBonus = 0;
  player.itemPoints = 0;
  player.items = [];
  player.effects = freshEffects();
  player.removed = false;
}

export function cleanName(raw, fallback) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name || fallback;
}

function uniqueName(state, wanted, exceptId) {
  const taken = new Set(state.players.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 20; n += 1) {
    const candidate = `${wanted.slice(0, 14)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return wanted;
}

export function addPlayer(state, { name, owner }) {
  if (state.phase !== 'lobby') return null;
  if (state.players.length >= MAX_PLAYERS) return null;
  const id = `p${state.nextId}`;
  state.nextId += 1;
  const usedPens = new Set(state.players.map((p) => p.pen));
  let pen = 0;
  while (usedPens.has(pen) && pen < PEN_COUNT) pen += 1;
  const player = {
    id,
    name: uniqueName(state, cleanName(name, `Spieler ${state.players.length + 1}`), id),
    owner,
    pen,
    connected: true,
  };
  resetPlayer(player);
  state.players.push(player);
  return player;
}

export function renamePlayer(state, playerId, name) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || state.phase !== 'lobby') return false;
  player.name = uniqueName(state, cleanName(name, player.name), playerId);
  return true;
}

// notify: wem die Oberfläche die Meldung zusätzlich einblendet –
// 'all' für alle am Tisch oder eine Liste von Spieler-Kennungen.
function log(state, text, tone = 'info', notify = null) {
  state.logSeq += 1;
  const entry = { n: state.logSeq, text, tone };
  if (notify) entry.notify = notify;
  state.log.push(entry);
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

function activePlayers(state) {
  return state.players.filter((p) => !p.removed);
}

function rollDie(rng) {
  return 1 + Math.min(5, Math.floor(rng() * 6));
}

// Allein am Tisch gibt es nichts abzuwehren und niemanden zu ärgern.
const SOLO_ITEMS = ['extra', 'flip', 'wish', 'double'];

function pickItem(state, rng) {
  const solo = activePlayers(state).length < 2;
  const ids = solo ? SOLO_ITEMS : Object.keys(ITEMS);
  const total = ids.reduce((sum, id) => sum + ITEMS[id].weight, 0);
  let mark = rng() * total;
  for (const id of ids) {
    mark -= ITEMS[id].weight;
    if (mark < 0) return id;
  }
  return ids[ids.length - 1];
}

function giveItem(state, player, rng) {
  if (!state.options.items) return null;
  if (player.items.length >= HAND_LIMIT) return null;
  const id = pickItem(state, rng);
  player.items.push(id);
  return id;
}

function currentRound(state) {
  const active = activePlayers(state);
  if (active.length === 0) return state.round;
  const least = Math.min(...active.map(filledCount));
  return Math.min(TOTAL_ROUNDS, least + 1);
}

function startTurn(state, rng) {
  const player = state.players[state.current];
  const previousRollId = state.turn ? state.turn.rollId : 0;

  state.round = currentRound(state);
  if (state.options.items && GIFT_ROUNDS.includes(state.round) && !state.giftsGiven.includes(state.round)) {
    state.giftsGiven.push(state.round);
    for (const p of activePlayers(state)) giveItem(state, p, rng);
    log(state, `Runde ${state.round}: Alle bekommen ein Item.`, 'item', 'all');
  }

  const turn = {
    dice: [0, 0, 0, 0, 0],
    held: [false, false, false, false, false],
    frozen: [false, false, false, false, false],
    rollsUsed: 0,
    rollsMax: 3,
    rollId: previousRollId,
    itemUsed: false,
    double: false,
    icePending: false,
    braked: false,
  };
  if (player.effects.brake) {
    player.effects.brake = false;
    turn.rollsMax = 2;
    turn.braked = true;
  }
  if (player.effects.ice) {
    player.effects.ice = false;
    turn.icePending = true;
  }
  state.turn = turn;
}

function advance(state, rng) {
  const n = state.players.length;
  for (let step = 1; step <= n; step += 1) {
    const index = (state.current + step) % n;
    const player = state.players[index];
    if (!player.removed && filledCount(player) < TOTAL_ROUNDS) {
      state.current = index;
      startTurn(state, rng);
      return;
    }
  }
  state.phase = 'finished';
  state.turn = null;
  const ranking = activePlayers(state)
    .map((p) => ({ name: p.name, total: totals(p).total }))
    .sort((a, b) => b.total - a.total);
  if (ranking.length > 0) {
    log(state, `Spiel beendet. ${ranking[0].name} gewinnt mit ${ranking[0].total} Punkten.`, 'big', 'all');
  }
}

export function startGame(state, rng) {
  if (state.phase !== 'lobby') return fail('Das Spiel läuft schon.');
  if (state.players.length === 0) return fail('Es ist noch niemand im Raum.');
  for (const player of state.players) resetPlayer(player);
  state.phase = 'playing';
  state.giftsGiven = [];
  state.log = [];
  state.round = 1;
  state.turn = null;
  if (state.options.items) {
    for (const player of state.players) {
      for (let i = 0; i < START_ITEMS; i += 1) giveItem(state, player, rng);
    }
  }
  state.current = Math.min(state.players.length - 1, Math.floor(rng() * state.players.length));
  log(state, `Los geht's. ${state.players[state.current].name} fängt an.`, 'info');
  startTurn(state, rng);
  return ok();
}

export function backToLobby(state) {
  state.players = state.players.filter((p) => !p.removed);
  for (const player of state.players) resetPlayer(player);
  state.phase = 'lobby';
  state.turn = null;
  state.current = 0;
  state.round = 1;
  state.giftsGiven = [];
  state.log = [];
  return ok();
}

export function removePlayer(state, playerId, rng) {
  const index = state.players.findIndex((p) => p.id === playerId);
  if (index < 0) return fail('Diesen Spieler gibt es nicht.');
  const player = state.players[index];
  if (state.phase === 'lobby') {
    state.players.splice(index, 1);
    return ok();
  }
  if (player.removed) return ok();
  player.removed = true;
  player.items = [];
  player.effects = freshEffects();
  if (state.phase === 'playing') {
    log(state, `${player.name} ist nicht mehr dabei.`, 'info', 'all');
    if (index === state.current) advance(state, rng);
  }
  return ok();
}

function ok() {
  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}

function validDie(index) {
  return Number.isInteger(index) && index >= 0 && index < 5;
}

// Warum ein Item gerade nicht gegen dieses Ziel geht; null, wenn es geht.
// Funktioniert auch auf der gefilterten Sicht eines Mitspielers.
export function targetProblem(state, actorId, itemId, targetId) {
  const target = state.players.find((p) => p.id === targetId);
  if (!target || target.removed) return 'Dieses Ziel gibt es nicht.';
  if (target.id === actorId) return 'Du kannst dich nicht selbst treffen.';
  if (itemId === 'thief') {
    return handSize(target) > 0 ? null : `${target.name} hat kein Item.`;
  }
  if (NEXT_TURN_EFFECTS.includes(itemId)) {
    if (filledCount(target) >= TOTAL_ROUNDS) return `${target.name} hat keinen Zug mehr.`;
    if (pendingAttack(target)) return `Auf ${target.name} liegt schon ein Angriff.`;
    return null;
  }
  return 'Dieses Item wirkt nicht auf andere.';
}

// Warum ein Item gerade gar nicht spielbar ist; null, wenn es spielbar ist.
export function itemProblem(state, actorId, itemId) {
  const turn = state.turn;
  const actor = state.players[state.current];
  if (state.phase !== 'playing' || !turn || !actor || actor.id !== actorId) return 'Du bist nicht dran.';
  if (!state.options.items) return 'Items sind ausgeschaltet.';
  if (turn.itemUsed) return 'Pro Zug nur ein Item.';
  const item = itemById(itemId);
  if (!item) return 'Dieses Item gibt es nicht.';
  if ((itemId === 'flip' || itemId === 'wish') && turn.rollsUsed === 0) return 'Erst würfeln.';
  if (itemId === 'double' && turn.double) return 'Der Doppler ist schon aktiv.';
  if (itemId === 'shield' && actor.effects.shield) return 'Dein Schild ist schon aktiv.';
  if (item.kind === 'attack') {
    const anyTarget = state.players.some((p) => targetProblem(state, actorId, itemId, p.id) === null);
    if (!anyTarget) return 'Dafür gibt es gerade kein Ziel.';
  }
  return null;
}

function useItem(state, actor, action, rng) {
  const turn = state.turn;
  const itemId = action.item;
  const item = itemById(itemId);
  const handIndex = item ? actor.items.indexOf(itemId) : -1;
  if (!item || handIndex < 0) return fail('Dieses Item hast du nicht.');
  const problem = itemProblem(state, actor.id, itemId);
  if (problem) return fail(problem);

  if (item.needs === 'die' || item.needs === 'dieValue') {
    if (!validDie(action.die)) return fail('Wähle einen Würfel.');
  }
  if (item.needs === 'dieValue') {
    if (!Number.isInteger(action.value) || action.value < 1 || action.value > 6) return fail('Wähle eine Zahl von 1 bis 6.');
  }
  let target = null;
  if (item.kind === 'attack') {
    const targetIssue = targetProblem(state, actor.id, itemId, action.target);
    if (targetIssue) return fail(targetIssue);
    target = state.players.find((p) => p.id === action.target);
  }

  actor.items.splice(handIndex, 1);
  turn.itemUsed = true;

  if (target) {
    if (target.effects.shield) {
      target.effects.shield = false;
      log(state, `${actor.name} setzt ${item.name} gegen ${target.name} ein, aber der Schild wehrt es ab.`, 'item', [actor.id, target.id]);
      return ok();
    }
    if (itemId === 'thief') {
      const stolenIndex = Math.min(target.items.length - 1, Math.floor(rng() * target.items.length));
      const [stolen] = target.items.splice(stolenIndex, 1);
      actor.items.push(stolen);
      log(state, `${actor.name} klaut ${target.name} ein Item.`, 'item', [target.id]);
      return ok();
    }
    target.effects[itemId] = true;
    log(state, `${actor.name} setzt ${item.name} gegen ${target.name} ein: ${target.name} ${item.status}.`, 'item', [target.id]);
    return ok();
  }

  switch (itemId) {
    case 'extra':
      turn.rollsMax += 1;
      log(state, `${actor.name} setzt Zusatzwurf ein.`, 'item');
      break;
    case 'flip': {
      const before = turn.dice[action.die];
      turn.dice[action.die] = 7 - before;
      log(state, `${actor.name} dreht eine ${before} zur ${7 - before}.`, 'item');
      break;
    }
    case 'wish': {
      const before = turn.dice[action.die];
      turn.dice[action.die] = action.value;
      log(state, `${actor.name} macht mit dem Wunschwürfel aus einer ${before} eine ${action.value}.`, 'item');
      break;
    }
    case 'double':
      turn.double = true;
      log(state, `${actor.name} setzt den Doppler ein: Der Eintrag zählt doppelt.`, 'item');
      break;
    case 'shield':
      actor.effects.shield = true;
      log(state, `${actor.name} stellt einen Schild auf.`, 'item');
      break;
    default:
      break;
  }
  return ok();
}

// Führt eine Spielaktion des Spielers `playerId` aus. Verändert `state` direkt.
export function applyAction(state, playerId, action, rng = Math.random) {
  if (state.phase !== 'playing' || !state.turn) return fail('Gerade läuft kein Spiel.');
  const actor = state.players[state.current];
  if (!actor || actor.id !== playerId) return fail('Du bist nicht dran.');
  const turn = state.turn;

  switch (action && action.type) {
    case 'roll': {
      if (turn.rollsUsed >= turn.rollsMax) return fail('Kein Wurf mehr übrig.');
      const first = turn.rollsUsed === 0;
      if (!first && turn.held.every(Boolean)) return fail('Alle Würfel sind festgehalten.');
      for (let i = 0; i < 5; i += 1) {
        if (first || !turn.held[i]) turn.dice[i] = rollDie(rng);
      }
      turn.rollsUsed += 1;
      turn.rollId += 1;
      if (first && turn.icePending) {
        const frozenIndex = Math.min(4, Math.floor(rng() * 5));
        turn.frozen[frozenIndex] = true;
        turn.held[frozenIndex] = true;
        turn.icePending = false;
        log(state, `Eiswürfel: Bei ${actor.name} friert eine ${turn.dice[frozenIndex]} fest.`, 'item');
      }
      if (isKniffel(turn.dice)) log(state, `${actor.name} würfelt einen Kniffel!`, 'big', 'all');
      return ok();
    }

    case 'hold': {
      if (!validDie(action.die)) return fail('Diesen Würfel gibt es nicht.');
      if (turn.rollsUsed === 0) return fail('Erst würfeln.');
      if (turn.frozen[action.die]) return fail('Dieser Würfel ist eingefroren.');
      turn.held[action.die] = !turn.held[action.die];
      return ok();
    }

    case 'score': {
      const cat = categoryById(action.cat);
      if (!cat) return fail('Dieses Feld gibt es nicht.');
      if (turn.rollsUsed === 0) return fail('Erst würfeln.');
      if (typeof actor.scores[cat.id] === 'number') return fail('Dieses Feld ist schon belegt.');

      const joker = jokerActive(actor, turn.dice);
      const value = joker ? cat.max : scoreFor(cat.id, turn.dice);
      actor.scores[cat.id] = value;
      if (value === 0) log(state, `${actor.name} streicht ${cat.name}.`, 'score');
      else log(state, `${actor.name} trägt ${value} bei ${cat.name} ein.`, 'score');

      if (joker) {
        actor.kniffelBonus += EXTRA_KNIFFEL_BONUS;
        log(state, `Weiterer Kniffel: ${EXTRA_KNIFFEL_BONUS} Bonuspunkte für ${actor.name}.`, 'big');
      }
      if (turn.double) {
        const extra = Math.min(value, DOUBLE_CAP);
        actor.itemPoints += extra;
        if (extra > 0) log(state, `Doppler: +${extra} für ${actor.name}.`, 'item');
        else log(state, `Der Doppler von ${actor.name} verpufft.`, 'item');
      }
      if (actor.effects.curse) {
        const penalty = Math.min(CURSE_PENALTY, value);
        actor.itemPoints -= penalty;
        actor.effects.curse = false;
        if (penalty > 0) log(state, `Fluch: −${penalty} für ${actor.name}.`, 'item');
        else log(state, `Der Fluch gegen ${actor.name} verpufft.`, 'item');
      }
      if (value === 0 && giveItem(state, actor, rng)) {
        log(state, `${actor.name} bekommt fürs Streichen ein Item.`, 'item', [actor.id]);
      }
      advance(state, rng);
      return ok();
    }

    case 'item':
      return useItem(state, actor, action, rng);

    default:
      return fail('Unbekannte Aktion.');
  }
}

// Was ein Mitspieler sehen darf: fremde Items nur als Anzahl, keine Zugangsschlüssel.
export function viewFor(state, owner) {
  const view = JSON.parse(JSON.stringify(state));
  for (const player of view.players) {
    player.mine = owner !== null && owner !== undefined && player.owner === owner;
    player.itemCount = player.items.length;
    if (!player.mine) player.items = null;
    delete player.owner;
  }
  delete view.nextId;
  return view;
}
