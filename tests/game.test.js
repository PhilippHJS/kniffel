import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, ITEMS, HAND_LIMIT, TOTAL_ROUNDS,
  scoreFor, potentialScore, jokerActive, totals, filledCount,
  createGame, addPlayer, startGame, applyAction, removePlayer, backToLobby,
  viewFor, itemProblem, targetProblem, pendingAttack,
} from '../js/game.js';

// Zufall, der eine feste Folge liefert; die(n) erzwingt die Augenzahl n.
const die = (n) => (n - 1) / 6 + 0.01;
function rngFrom(values) {
  let i = 0;
  return () => {
    const value = values[i % values.length];
    i += 1;
    return value;
  };
}
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function setup(names, { items = false, rng = () => 0 } = {}) {
  const state = createGame();
  state.options.items = items;
  for (const name of names) addPlayer(state, { name, owner: `token-${name}` });
  assert.equal(startGame(state, rng).ok, true);
  return state;
}
const cur = (state) => state.players[state.current];
function rollExactly(state, dice) {
  const result = applyAction(state, cur(state).id, { type: 'roll' }, rngFrom(dice.map(die)));
  assert.equal(result.ok, true, result.error);
}
function act(state, action, rng = () => 0) {
  return applyAction(state, cur(state).id, action, rng);
}

test('Wertung der einzelnen Felder', () => {
  assert.equal(scoreFor('ones', [1, 1, 3, 4, 1]), 3);
  assert.equal(scoreFor('sixes', [6, 6, 6, 6, 2]), 24);
  assert.equal(scoreFor('fives', [1, 2, 3, 4, 6]), 0);
  assert.equal(scoreFor('threeKind', [4, 4, 4, 2, 1]), 15);
  assert.equal(scoreFor('threeKind', [4, 4, 3, 2, 1]), 0);
  assert.equal(scoreFor('fourKind', [5, 5, 5, 5, 2]), 22);
  assert.equal(scoreFor('fourKind', [5, 5, 5, 2, 2]), 0);
  assert.equal(scoreFor('fourKind', [3, 3, 3, 3, 3]), 15);
  assert.equal(scoreFor('fullHouse', [2, 2, 5, 5, 5]), 25);
  assert.equal(scoreFor('fullHouse', [2, 2, 5, 5, 4]), 0);
  assert.equal(scoreFor('fullHouse', [5, 5, 5, 5, 5]), 0, 'Fünf gleiche sind kein Full House');
  assert.equal(scoreFor('smallStraight', [1, 2, 3, 4, 4]), 30);
  assert.equal(scoreFor('smallStraight', [6, 3, 5, 4, 3]), 30);
  assert.equal(scoreFor('smallStraight', [1, 3, 4, 5, 6]), 30);
  assert.equal(scoreFor('smallStraight', [1, 2, 3, 5, 6]), 0);
  assert.equal(scoreFor('largeStraight', [2, 3, 4, 5, 6]), 40);
  assert.equal(scoreFor('largeStraight', [5, 1, 3, 2, 4]), 40);
  assert.equal(scoreFor('largeStraight', [1, 2, 3, 4, 6]), 0);
  assert.equal(scoreFor('kniffel', [4, 4, 4, 4, 4]), 50);
  assert.equal(scoreFor('kniffel', [4, 4, 4, 4, 3]), 0);
  assert.equal(scoreFor('chance', [1, 2, 3, 4, 6]), 16);
  assert.equal(scoreFor('chance', [0, 0, 0, 0, 0]), 0, 'ohne Wurf keine Punkte');
});

test('Höchstwerte der Felder stimmen mit der Wertung überein', () => {
  for (const cat of CATEGORIES) {
    let best = 0;
    for (let a = 1; a <= 6; a += 1) for (let b = 1; b <= 6; b += 1) for (let c = 1; c <= 6; c += 1) {
      for (let d = 1; d <= 6; d += 1) for (let e = 1; e <= 6; e += 1) {
        best = Math.max(best, scoreFor(cat.id, [a, b, c, d, e]));
      }
    }
    assert.equal(best, cat.max, cat.name);
  }
});

test('Bonus ab 63 Punkten im oberen Teil', () => {
  const player = { scores: { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18 }, kniffelBonus: 0, itemPoints: 0 };
  assert.deepEqual(totals(player), { upper: 63, bonus: 35, lower: 0, kniffelBonus: 0, itemPoints: 0, total: 98, filled: 6 });
  player.scores.sixes = 12;
  assert.equal(totals(player).bonus, 0);
  assert.equal(totals(player).total, 57);
});

test('Zugablauf: würfeln, halten, eintragen, nächster Spieler', () => {
  const state = setup(['Anna', 'Ben']);
  const first = cur(state);
  assert.equal(act(state, { type: 'score', cat: 'chance' }).error, 'Erst würfeln.');
  assert.equal(act(state, { type: 'hold', die: 0 }).error, 'Erst würfeln.');

  rollExactly(state, [6, 6, 1, 2, 3]);
  assert.deepEqual(state.turn.dice, [6, 6, 1, 2, 3]);
  assert.equal(act(state, { type: 'hold', die: 0 }).ok, true);
  assert.equal(act(state, { type: 'hold', die: 1 }).ok, true);
  rollExactly(state, [6, 6, 6]);
  assert.deepEqual(state.turn.dice, [6, 6, 6, 6, 6], 'gehaltene Würfel bleiben, die anderen werden neu gewürfelt');
  rollExactly(state, [1, 1, 1]);
  assert.equal(act(state, { type: 'roll' }).error, 'Kein Wurf mehr übrig.');

  const other = state.players.find((p) => p.id !== first.id);
  assert.equal(applyAction(state, other.id, { type: 'roll' }).error, 'Du bist nicht dran.');

  assert.equal(act(state, { type: 'score', cat: 'sixes' }).ok, true);
  assert.equal(first.scores.sixes, 12);
  assert.equal(cur(state).id, other.id);
  assert.equal(state.turn.rollsUsed, 0);

  rollExactly(state, [1, 2, 3, 4, 5]);
  assert.equal(act(state, { type: 'score', cat: 'largeStraight' }).ok, true);
  assert.equal(cur(state).id, first.id);
  rollExactly(state, [1, 2, 3, 4, 5]);
  assert.equal(act(state, { type: 'score', cat: 'sixes' }).error, 'Dieses Feld ist schon belegt.');
});

test('Alle Würfel gehalten: kein weiterer Wurf nötig', () => {
  const state = setup(['Anna']);
  rollExactly(state, [1, 2, 3, 4, 5]);
  for (let i = 0; i < 5; i += 1) act(state, { type: 'hold', die: i });
  assert.equal(act(state, { type: 'roll' }).error, 'Alle Würfel sind festgehalten.');
});

test('Weiterer Kniffel: 50 Bonuspunkte und Joker', () => {
  const state = setup(['Anna']);
  const anna = cur(state);
  anna.scores.kniffel = 50;
  rollExactly(state, [2, 2, 2, 2, 2]);
  assert.equal(jokerActive(anna, state.turn.dice), true);
  assert.equal(potentialScore(anna, 'largeStraight', state.turn.dice), 40);
  assert.equal(potentialScore(anna, 'sixes', state.turn.dice), 30);
  assert.equal(act(state, { type: 'score', cat: 'fullHouse' }).ok, true);
  assert.equal(anna.scores.fullHouse, 25);
  assert.equal(anna.kniffelBonus, 50);
  assert.equal(totals(anna).total, 125);
});

test('Gestrichener Kniffel: später kein Bonus und kein Joker', () => {
  const state = setup(['Anna']);
  const anna = cur(state);
  anna.scores.kniffel = 0;
  rollExactly(state, [2, 2, 2, 2, 2]);
  assert.equal(jokerActive(anna, state.turn.dice), false);
  assert.equal(potentialScore(anna, 'largeStraight', state.turn.dice), 0);
  act(state, { type: 'score', cat: 'twos' });
  assert.equal(anna.scores.twos, 10);
  assert.equal(anna.kniffelBonus, 0);
});

test('Erster Kniffel wird normal eingetragen', () => {
  const state = setup(['Anna']);
  const anna = cur(state);
  rollExactly(state, [3, 3, 3, 3, 3]);
  assert.equal(jokerActive(anna, state.turn.dice), false);
  act(state, { type: 'score', cat: 'kniffel' });
  assert.equal(anna.scores.kniffel, 50);
  assert.equal(anna.kniffelBonus, 0);
});

test('Ein Spiel endet nach 13 Runden und ermittelt alle Summen', () => {
  for (let players = 1; players <= 6; players += 1) {
    const rng = seeded(100 + players);
    const state = setup(Array.from({ length: players }, (_, i) => `S${i + 1}`), { rng });
    let turns = 0;
    while (state.phase === 'playing') {
      const player = cur(state);
      assert.equal(applyAction(state, player.id, { type: 'roll' }, rng).ok, true);
      const free = CATEGORIES.filter((c) => typeof player.scores[c.id] !== 'number');
      const best = free.reduce((a, b) => (potentialScore(player, b.id, state.turn.dice) > potentialScore(player, a.id, state.turn.dice) ? b : a));
      assert.equal(applyAction(state, player.id, { type: 'score', cat: best.id }, rng).ok, true);
      turns += 1;
      assert.ok(turns <= players * TOTAL_ROUNDS, 'Spiel muss enden');
    }
    assert.equal(turns, players * TOTAL_ROUNDS);
    assert.equal(state.phase, 'finished');
    assert.equal(state.turn, null);
    for (const player of state.players) assert.equal(filledCount(player), TOTAL_ROUNDS);
  }
});

test('Items: Startausstattung und Sicht der Mitspieler', () => {
  const state = setup(['Anna', 'Ben'], { items: true, rng: seeded(7) });
  for (const player of state.players) {
    assert.equal(player.items.length, 2);
    for (const id of player.items) assert.ok(ITEMS[id]);
  }
  const view = viewFor(state, 'token-Anna');
  const [anna, ben] = view.players;
  assert.equal(anna.mine, true);
  assert.equal(anna.items.length, 2);
  assert.equal(ben.mine, false);
  assert.equal(ben.items, null);
  assert.equal(ben.itemCount, 2);
  assert.equal(JSON.stringify(view).includes('token-'), false, 'Zugangsschlüssel dürfen nicht mitgeschickt werden');
  const spectator = viewFor(state, 'fremd');
  assert.ok(spectator.players.every((p) => !p.mine && p.items === null));
});

test('Zusatzwurf, Dreher und Wunschwürfel', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);

  anna.items = ['extra', 'flip', 'wish'];
  assert.equal(act(state, { type: 'item', item: 'flip', die: 0 }).error, 'Erst würfeln.');
  assert.equal(act(state, { type: 'item', item: 'extra' }).ok, true);
  assert.equal(state.turn.rollsMax, 4);
  assert.deepEqual(anna.items, ['flip', 'wish']);
  assert.equal(act(state, { type: 'item', item: 'flip', die: 0 }).error, 'Pro Zug nur ein Item.');
  for (let i = 0; i < 4; i += 1) rollExactly(state, [1, 2, 3, 4, 6]);
  assert.equal(act(state, { type: 'roll' }).error, 'Kein Wurf mehr übrig.');
  act(state, { type: 'score', cat: 'chance' });

  // Ben ist dran, danach wieder Anna.
  rollExactly(state, [1, 1, 1, 1, 2]);
  act(state, { type: 'score', cat: 'ones' });

  rollExactly(state, [1, 2, 3, 4, 6]);
  assert.equal(act(state, { type: 'item', item: 'flip', die: 9 }).error, 'Wähle einen Würfel.');
  assert.equal(act(state, { type: 'item', item: 'flip', die: 0 }).ok, true);
  assert.deepEqual(state.turn.dice, [6, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'sixes' });

  rollExactly(state, [1, 1, 1, 1, 2]);
  act(state, { type: 'score', cat: 'twos' });

  rollExactly(state, [1, 2, 3, 4, 6]);
  assert.equal(act(state, { type: 'item', item: 'wish', die: 4, value: 7 }).error, 'Wähle eine Zahl von 1 bis 6.');
  assert.equal(act(state, { type: 'item', item: 'wish', die: 4, value: 5 }).ok, true);
  assert.deepEqual(state.turn.dice, [1, 2, 3, 4, 5]);
  act(state, { type: 'score', cat: 'largeStraight' });
  assert.equal(anna.scores.largeStraight, 40);
  assert.deepEqual(anna.items, []);
});

test('Doppler: Zusatzpunkte getrennt, gedeckelt, ohne Einfluss auf den Bonus', () => {
  const state = setup(['Anna'], { items: true });
  const anna = cur(state);
  anna.items = ['double'];
  act(state, { type: 'item', item: 'double' });
  anna.items = ['double'];
  assert.equal(itemProblem(state, anna.id, 'double'), 'Pro Zug nur ein Item.');
  rollExactly(state, [6, 6, 6, 6, 6]);
  act(state, { type: 'score', cat: 'kniffel' });
  assert.equal(anna.scores.kniffel, 50);
  assert.equal(anna.itemPoints, 30, 'höchstens +30');

  anna.items = ['double'];
  act(state, { type: 'item', item: 'double' });
  rollExactly(state, [6, 6, 6, 1, 2]);
  act(state, { type: 'score', cat: 'sixes' });
  assert.equal(anna.scores.sixes, 18);
  assert.equal(anna.itemPoints, 48);
  assert.equal(totals(anna).upper, 18, 'der obere Teil zählt nur den echten Eintrag');
});

test('Wurfbremse, auch zusammen mit Zusatzwurf', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  const ben = state.players.find((p) => p.id !== anna.id);
  anna.items = ['brake'];
  ben.items = ['extra'];
  assert.equal(act(state, { type: 'item', item: 'brake', target: anna.id }).error, 'Du kannst dich nicht selbst treffen.');
  assert.equal(act(state, { type: 'item', item: 'brake', target: ben.id }).ok, true);
  assert.equal(ben.effects.brake, true);
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });

  assert.equal(cur(state).id, ben.id);
  assert.equal(state.turn.rollsMax, 2);
  assert.equal(state.turn.braked, true);
  assert.equal(ben.effects.brake, false, 'wirkt nur einen Zug');
  act(state, { type: 'item', item: 'extra' });
  assert.equal(state.turn.rollsMax, 3);
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'ones' });
  assert.equal(cur(state).id, ben.id);
  assert.equal(state.turn.rollsMax, 3);
});

test('Eiswürfel friert nach dem ersten Wurf einen Würfel ein', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  const ben = state.players.find((p) => p.id !== anna.id);
  anna.items = ['ice'];
  ben.items = [];
  act(state, { type: 'item', item: 'ice', target: ben.id });
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });

  assert.equal(state.turn.icePending, true);
  // Fünf Würfel, danach bestimmt der sechste Zufallswert den eingefrorenen Würfel (Index 2).
  applyAction(state, ben.id, { type: 'roll' }, rngFrom([die(5), die(5), die(1), die(5), die(5), 0.5]));
  assert.deepEqual(state.turn.frozen, [false, false, true, false, false]);
  assert.equal(state.turn.held[2], true);
  assert.equal(act(state, { type: 'hold', die: 2 }).error, 'Dieser Würfel ist eingefroren.');
  rollExactly(state, [5, 5, 5, 5]);
  assert.deepEqual(state.turn.dice, [5, 5, 1, 5, 5], 'der eingefrorene Würfel bleibt liegen');
  act(state, { type: 'score', cat: 'fives' });
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'ones' });
  assert.equal(cur(state).id, ben.id);
  assert.deepEqual(state.turn.frozen, [false, false, false, false, false]);
});

test('Fluch zieht höchstens 10 Punkte ab und nie unter 0', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  const ben = state.players.find((p) => p.id !== anna.id);
  anna.items = ['curse', 'curse'];
  ben.items = [];
  act(state, { type: 'item', item: 'curse', target: ben.id });
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });

  rollExactly(state, [1, 1, 3, 4, 6]);
  act(state, { type: 'score', cat: 'ones' });
  assert.equal(ben.scores.ones, 2);
  assert.equal(ben.itemPoints, -2);
  assert.equal(ben.effects.curse, false);

  act(state, { type: 'item', item: 'curse', target: ben.id });
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'ones' });
  rollExactly(state, [6, 6, 6, 6, 6]);
  act(state, { type: 'score', cat: 'kniffel' });
  assert.equal(ben.itemPoints, -12);
  assert.equal(totals(ben).total, 2 + 50 - 12);
});

test('Schild wehrt genau einen Angriff ab', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  const ben = state.players.find((p) => p.id !== anna.id);
  anna.items = ['shield'];
  ben.items = ['brake', 'curse'];
  act(state, { type: 'item', item: 'shield' });
  assert.equal(anna.effects.shield, true);
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });

  assert.equal(act(state, { type: 'item', item: 'brake', target: anna.id }).ok, true);
  assert.equal(anna.effects.shield, false);
  assert.equal(anna.effects.brake, false);
  assert.deepEqual(ben.items, ['curse'], 'das abgewehrte Item ist trotzdem verbraucht');
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });
  assert.equal(state.turn.rollsMax, 3);
});

test('Taschendieb klaut ein Item, aber nur wenn eins da ist', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  const ben = state.players.find((p) => p.id !== anna.id);
  anna.items = ['thief', 'extra', 'flip'];
  ben.items = [];
  assert.equal(targetProblem(state, anna.id, 'thief', ben.id), 'Ben hat kein Item.');
  assert.equal(itemProblem(state, anna.id, 'thief'), 'Dafür gibt es gerade kein Ziel.');
  ben.items = ['wish'];
  assert.equal(act(state, { type: 'item', item: 'thief', target: ben.id }).ok, true);
  assert.deepEqual(ben.items, []);
  assert.deepEqual(anna.items.sort(), ['extra', 'flip', 'wish']);
});

test('Nur ein Angriff gleichzeitig pro Ziel, fertige Spieler sind kein Ziel', () => {
  const state = setup(['Anna', 'Ben', 'Cem'], { items: true });
  const anna = cur(state);
  const others = state.players.filter((p) => p.id !== anna.id);
  assert.equal(pendingAttack(others[0]), null);
  others[0].effects.brake = true;
  assert.equal(pendingAttack(others[0]), 'brake');
  assert.equal(targetProblem(state, anna.id, 'brake', others[0].id), `Auf ${others[0].name} liegt schon ein Angriff.`);
  assert.equal(targetProblem(state, anna.id, 'ice', others[0].id), `Auf ${others[0].name} liegt schon ein Angriff.`);
  assert.equal(targetProblem(state, anna.id, 'curse', others[0].id), `Auf ${others[0].name} liegt schon ein Angriff.`);
  others[0].items = ['extra'];
  assert.equal(targetProblem(state, anna.id, 'thief', others[0].id), null, 'der Taschendieb wirkt sofort und zählt nicht dazu');
  for (const cat of CATEGORIES) others[1].scores[cat.id] = 0;
  assert.equal(targetProblem(state, anna.id, 'brake', others[1].id), `${others[1].name} hat keinen Zug mehr.`);
  assert.equal(targetProblem(state, anna.id, 'brake', 'p99'), 'Dieses Ziel gibt es nicht.');
});

test('Neue Items: fürs Streichen und zu Beginn von Runde 5 und 9, höchstens 3', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  for (const player of state.players) player.items = [];
  const order = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'threeKind', 'fourKind', 'chance'];
  const seenRounds = [];
  for (const cat of order) {
    for (let i = 0; i < 2; i += 1) {
      if (i === 0) seenRounds.push([state.round, state.players.map((p) => p.items.length)]);
      rollExactly(state, [1, 2, 3, 4, 5]);
      const player = cur(state);
      player.items = player.items.slice(0, HAND_LIMIT);
      act(state, { type: 'score', cat });
    }
  }
  const at = (round) => seenRounds.find(([r]) => r === round)[1];
  assert.deepEqual(at(1), [0, 0]);
  assert.deepEqual(at(4), [0, 0]);
  // Runde 5: Geschenk für alle. Davor wurde nichts gestrichen (1,2,3,4 zählen in ihren Feldern).
  assert.deepEqual(at(5), [1, 1]);
  // Sechser, Dreierpasch und Viererpasch sind mit 1-2-3-4-5 Streichungen: je ein Item, gedeckelt bei 3.
  assert.deepEqual(at(9), [HAND_LIMIT, HAND_LIMIT]);
  assert.deepEqual(state.giftsGiven, [5, 9]);
});

test('Spieler entfernen: Zug geht weiter, Spiel endet ohne ihn', () => {
  const rng = seeded(3);
  const state = setup(['Anna', 'Ben', 'Cem'], { rng });
  const first = cur(state);
  removePlayer(state, first.id, rng);
  assert.equal(first.removed, true);
  assert.notEqual(cur(state).id, first.id);
  let guard = 0;
  while (state.phase === 'playing' && guard < 100) {
    const player = cur(state);
    assert.equal(player.removed, false);
    applyAction(state, player.id, { type: 'roll' }, rng);
    const free = CATEGORIES.find((c) => typeof player.scores[c.id] !== 'number');
    applyAction(state, player.id, { type: 'score', cat: free.id }, rng);
    guard += 1;
  }
  assert.equal(state.phase, 'finished');
  assert.equal(guard, 2 * TOTAL_ROUNDS);
});

test('Zurück in die Lobby setzt alles zurück', () => {
  const state = setup(['Anna', 'Ben'], { items: true, rng: seeded(5) });
  removePlayer(state, state.players[1].id, seeded(1));
  backToLobby(state);
  assert.equal(state.phase, 'lobby');
  assert.equal(state.players.length, 1);
  assert.deepEqual(state.players[0].scores, {});
  assert.deepEqual(state.players[0].items, []);
  assert.equal(startGame(state, seeded(2)).ok, true);
});

test('Lobby: höchstens 6 Spieler, eindeutige Namen', () => {
  const state = createGame();
  for (let i = 0; i < 6; i += 1) assert.ok(addPlayer(state, { name: 'Phil', owner: `t${i}` }));
  assert.equal(addPlayer(state, { name: 'Zu viel', owner: 't7' }), null);
  assert.equal(new Set(state.players.map((p) => p.name)).size, 6);
  assert.equal(new Set(state.players.map((p) => p.pen)).size, 6);
  assert.equal(addPlayer(createGame(), { name: '   ', owner: 'x' }).name, 'Spieler 1');
});

test('Dauertest: zufällige Aktionen bringen das Spiel nie in einen ungültigen Zustand', () => {
  const itemIds = Object.keys(ITEMS);
  const catIds = CATEGORIES.map((c) => c.id);
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = seeded(seed * 7919);
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const count = 1 + Math.floor(rng() * 6);
    const state = setup(Array.from({ length: count }, (_, i) => `S${i + 1}`), { items: seed % 4 !== 0, rng });
    let steps = 0;
    while (state.phase === 'playing') {
      steps += 1;
      assert.ok(steps < 20000, 'Spiel muss enden');
      const player = cur(state);
      const turn = state.turn;
      const choice = rng();
      let action;
      if (choice < 0.35) action = { type: 'roll' };
      else if (choice < 0.55) action = { type: 'hold', die: Math.floor(rng() * 6) };
      else if (choice < 0.8) {
        action = { type: 'item', item: pick(itemIds), target: pick(state.players).id, die: Math.floor(rng() * 6), value: Math.floor(rng() * 8) };
      } else action = { type: 'score', cat: pick(catIds) };
      const usedBefore = turn.itemUsed;
      const handBefore = player.items.length;
      const result = applyAction(state, pick(state.players).id === player.id || rng() < 0.9 ? player.id : pick(state.players).id, action, rng);
      assert.equal(typeof result.ok, 'boolean');
      if (!result.ok) assert.equal(typeof result.error, 'string');
      if (result.ok && action.type === 'item') {
        assert.equal(usedBefore, false, 'höchstens ein Item pro Zug');
        assert.ok(player.items.length <= handBefore, 'ein gespieltes Item verlässt die Hand');
      }
      for (const p of state.players) {
        assert.ok(p.items.length <= HAND_LIMIT, 'höchstens 3 Items auf der Hand');
        for (const id of p.items) assert.ok(ITEMS[id]);
        for (const value of Object.values(p.scores)) assert.ok(Number.isInteger(value) && value >= 0 && value <= 50);
        assert.ok(Number.isFinite(totals(p).total));
      }
      if (state.turn) {
        assert.ok(state.turn.rollsUsed <= state.turn.rollsMax);
        if (state.turn.rollsUsed > 0) assert.ok(state.turn.dice.every((d) => d >= 1 && d <= 6));
        state.turn.frozen.forEach((frozen, i) => { if (frozen) assert.equal(state.turn.held[i], true); });
      }
    }
    for (const p of state.players) assert.equal(filledCount(p), TOTAL_ROUNDS);
  }
});

test('Allein am Tisch: keine Angriffs-Items und kein Schild', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const state = setup(['Anna'], { items: true, rng: seeded(seed) });
    for (const id of state.players[0].items) assert.ok(['extra', 'flip', 'wish', 'double'].includes(id), id);
  }
  const seen = new Set();
  for (let seed = 1; seed <= 200; seed += 1) {
    const state = setup(['Anna', 'Ben'], { items: true, rng: seeded(seed) });
    for (const p of state.players) for (const id of p.items) seen.add(id);
  }
  assert.equal(seen.size, Object.keys(ITEMS).length, 'zu zweit kommen alle Items vor');
});

test('Nach dem Angriff ist das Ziel wieder frei', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  const ben = state.players.find((p) => p.id !== anna.id);
  anna.items = ['brake', 'ice'];
  ben.items = [];
  act(state, { type: 'item', item: 'brake', target: ben.id });
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });
  assert.equal(pendingAttack(ben), null, 'die Wurfbremse ist mit Zugbeginn verbraucht');
  rollExactly(state, [1, 2, 3, 4, 6]);
  act(state, { type: 'score', cat: 'chance' });
  assert.equal(act(state, { type: 'item', item: 'ice', target: ben.id }).ok, true);
  assert.equal(pendingAttack(ben), 'ice');
});

test('Unsinnige Eingaben von außen ändern den Spielstand nicht', () => {
  const state = setup(['Anna', 'Ben'], { items: true });
  const anna = cur(state);
  rollExactly(state, [1, 2, 3, 4, 6]);
  const before = JSON.stringify(state);
  for (const cat of ['constructor', '__proto__', 'toString', '', null, undefined, 7, {}]) {
    assert.equal(act(state, { type: 'score', cat }).ok, false);
  }
  for (const item of ['constructor', '__proto__', 'nix', null, 3]) {
    assert.equal(act(state, { type: 'item', item, target: anna.id, die: 0, value: 1 }).ok, false);
  }
  assert.equal(act(state, { type: 'hold', die: '0' }).ok, false);
  assert.equal(act(state, null).ok, false);
  assert.equal(act(state, { type: 'toString' }).ok, false);
  assert.equal(JSON.stringify(state), before);
});
