// Oberfläche und Steuerung. Die Regeln stehen in game.js, die Verbindung in net.js.

import {
  CATEGORIES, ITEMS, MAX_PLAYERS, HAND_LIMIT, TOTAL_ROUNDS, UPPER_BONUS_AT, UPPER_BONUS,
  DOUBLE_CAP, CURSE_PENALTY, EXTRA_KNIFFEL_BONUS,
  createGame, addPlayer, renamePlayer, removePlayer, startGame, backToLobby, applyAction,
  viewFor, totals, potentialScore, jokerActive, itemProblem, targetProblem, pendingAttack, cleanName,
} from './game.js';
import { createHost, createClient } from './net.js';

// ---------- Kleine Helfer ----------

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Speicher voll oder gesperrt: Das Spiel läuft weiter, übersteht aber kein Neuladen.
    }
  },
};
const NAME_KEY = 'kniffel:name';
const LAST_KEY = 'kniffel:last';
const roomKey = (room) => `kniffel:room:${room}`;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomBytes(count) {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return [...bytes];
}
const randomRoom = () => randomBytes(5).map((b) => ROOM_ALPHABET[b % 32]).join('');
const randomToken = () => randomBytes(16).map((b) => b.toString(16).padStart(2, '0')).join('');
function rng() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 4294967296;
}
function normalizeRoom(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{5}$/.test(code) ? code : null;
}

const query = new URLSearchParams(location.search);
// Nur für Tests auf dem eigenen Rechner: ?peer=localhost:9000 nutzt einen lokalen Vermittlungsdienst.
const devPeer = ['localhost', '127.0.0.1'].includes(location.hostname) ? query.get('peer') : null;
function peerOptions() {
  if (!devPeer) return {};
  const [host, port] = devPeer.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: false, config: { iceServers: [] } };
}
function roomUrl(room) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('r', room);
  if (devPeer) url.searchParams.set('peer', devPeer);
  return url.toString();
}
const homeUrl = () => new URL(location.pathname, location.origin).toString() + (devPeer ? `?peer=${devPeer}` : '');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- Zustand der Seite ----------

const app = {
  screen: 'home', // home | name | room | gone
  room: null,
  role: null, // host | guest
  view: null,
  net: 'connecting',
  host: null,
  client: null,
  goneText: '',
  fresh: new Set(),
  ui: { selCat: null, sheet: null, sheetHtml: '', logSeen: null, rollSeen: null, turnKey: '' },
};

// ---------- Symbole ----------

const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  extra: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>'),
  flip: svg('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>'),
  wish: svg('<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>'),
  double: svg('<text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor" stroke="none">×2</text>'),
  shield: svg('<path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"/>'),
  brake: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8"/>'),
  ice: svg('<path d="M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17"/><path d="M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5"/>'),
  thief: svg('<path d="M3 10c0-2 2-3 4.5-3 2 0 3 1 4.5 1s2.5-1 4.5-1C19 7 21 8 21 10c0 4-2.5 7-5 7-1.8 0-2.7-2-4-2s-2.2 2-4 2c-2.5 0-5-3-5-7z"/><circle cx="8" cy="11.5" r="1.3"/><circle cx="16" cy="11.5" r="1.3"/>'),
  curse: svg('<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>'),
};

function dieHtml({ value, index = null, held = false, frozen = false, clickable = false, act = 'hold', extra = '', label = '' }) {
  const classes = ['die'];
  if (!value) classes.push('blank');
  if (held) classes.push('held');
  if (frozen) classes.push('frozen');
  const pips = `<span class="pips">${'<i></i>'.repeat(9)}</span>`;
  const state = !value ? 'noch nicht gewürfelt' : `zeigt ${value}${frozen ? ', eingefroren' : held ? ', gehalten' : ''}`;
  const tag = frozen ? '<b class="tag">Eis</b>' : held ? '<b class="tag">hält</b>' : '';
  const attrs = `class="${classes.join(' ')}" data-face="${value || 0}" ${extra}`;
  if (index === null) return `<span ${attrs}>${pips}</span>`;
  const name = label || `Würfel ${index + 1} ${state}`;
  if (!clickable) return `<span ${attrs} role="img" aria-label="${name}">${pips}${tag}</span>`;
  const pressed = act === 'hold' ? ` aria-pressed="${held}"` : '';
  return `<button type="button" ${attrs} data-act="${act}" data-die="${index}" data-key="${act}-${index}"${pressed} aria-label="${name}">${pips}${tag}</button>`;
}

// ---------- Abgeleitete Angaben ----------

function context(view) {
  const mine = view.players.filter((p) => p.mine && !p.removed);
  const playing = view.phase === 'playing' && view.turn;
  const current = playing ? view.players[view.current] : null;
  const myTurn = Boolean(current && current.mine);
  const hand = myTurn ? current : mine[0] || null;
  return {
    mine,
    current,
    myTurn,
    hand,
    canScore: myTurn && view.turn.rollsUsed > 0,
    isHost: app.role === 'host',
  };
}

function netLabel() {
  const host = {
    online: 'Raum offen',
    connecting: 'Raum wird geöffnet …',
    reconnecting: 'Vermittlung nicht erreichbar',
    unsupported: 'Browser wird nicht unterstützt',
    taken: 'Raum woanders geöffnet',
  };
  const guest = {
    online: 'Verbunden',
    connecting: 'Verbinde …',
    reconnecting: 'Verbindung weg, neuer Versuch …',
    'host-offline': 'Gastgeber nicht erreichbar',
    stuck: 'Verbindung klappt nicht',
    unsupported: 'Browser wird nicht unterstützt',
  };
  return (app.role === 'host' ? host : guest)[app.net] || '';
}

// ---------- Kopfzeile ----------

function topHtml() {
  const inRoom = app.screen === 'room';
  return `
    <span class="brand">Kniffel</span>
    <div class="topright">
      ${inRoom ? `<span class="net net-${esc(app.net)}"><i></i>${esc(netLabel())}</span>` : ''}
      ${inRoom && app.view ? `<button type="button" class="chip" data-act="room" data-key="top-room">Raum ${esc(app.room)}</button>` : ''}
      <button type="button" class="chip" data-act="rules" data-key="top-rules">Regeln</button>
    </div>`;
}

// ---------- Startseite ----------

function heroHtml(sub) {
  const dice = [6, 6, 6, 6, 6].map((value, i) => dieHtml({ value, extra: `style="--i:${i}"` })).join('');
  return `
    <div class="hero">
      <div class="hero-dice" aria-hidden="true">${dice}</div>
      <h1>Kniffel</h1>
      <p class="lead">${sub}</p>
    </div>`;
}

function homeHtml() {
  const name = store.get(NAME_KEY) || '';
  const last = normalizeRoom(store.get(LAST_KEY));
  const back = last && store.get(roomKey(last))
    ? `<div class="panel plain"><p>Du warst zuletzt in Raum ${esc(last)}.</p><a class="btn" href="${esc(roomUrl(last))}">Zurück in den Raum</a></div>`
    : '';
  return `
    <section class="home">
      ${heroHtml('Würfeln mit bis zu sechs Leuten, jeder am eigenen Gerät. Wer mag, spielt mit Items.')}
      ${back}
      <form class="panel" data-form="create">
        <label for="f-name">Dein Name</label>
        <input id="f-name" name="name" maxlength="16" autocomplete="nickname" value="${esc(name)}" data-key="f-name" required>
        <button type="submit" class="btn primary">Raum erstellen</button>
      </form>
      <form class="panel plain" data-form="join">
        <label for="f-code">Du hast einen Raumcode bekommen?</label>
        <div class="row">
          <input id="f-code" name="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="z. B. K7MQ2" data-key="f-code" required>
          <button type="submit" class="btn">Beitreten</button>
        </div>
        <p class="hint">Mit einem Einladungslink brauchst du den Code nicht.</p>
      </form>
    </section>`;
}

function nameHtml() {
  return `
    <section class="home">
      ${heroHtml(`Du wurdest in Raum ${esc(app.room)} eingeladen.`)}
      <form class="panel" data-form="enter">
        <label for="f-name">Wie heißt du?</label>
        <input id="f-name" name="name" maxlength="16" autocomplete="nickname" data-key="f-name" required>
        <button type="submit" class="btn primary">Beitreten</button>
      </form>
    </section>`;
}

function waitingHtml() {
  const hints = {
    'host-offline': 'Der Gastgeber hat den Raum gerade nicht geöffnet. Sobald seine Seite wieder offen ist, geht es von selbst weiter.',
    stuck: 'Die direkte Verbindung kommt nicht zustande. Oft hilft ein anderes Netz, zum Beispiel mobile Daten statt WLAN.',
    unsupported: 'Dieser Browser kann keine direkte Verbindung aufbauen. Probier einen aktuellen Chrome, Firefox, Edge oder Safari.',
  };
  return `
    <section class="home">
      <div class="panel center">
        <h1 class="small">Raum ${esc(app.room)}</h1>
        <p class="lead">${esc(netLabel())}</p>
        ${hints[app.net] ? `<p class="hint">${hints[app.net]}</p>` : ''}
        <a class="btn" href="${esc(homeUrl())}">Zur Startseite</a>
      </div>
    </section>`;
}

function goneHtml() {
  return `
    <section class="home">
      <div class="panel center">
        <h1 class="small">Raum ${esc(app.room)}</h1>
        <p class="lead">${esc(app.goneText)}</p>
        <button type="button" class="btn primary" data-act="reload">Hier weiterspielen</button>
      </div>
    </section>`;
}

// ---------- Lobby ----------

function seatBadges(view, player) {
  const badges = [];
  if (view.hostIds && view.hostIds[0] === player.id) badges.push('<span class="badge">Gastgeber</span>');
  if (!player.connected) badges.push('<span class="badge off">nicht verbunden</span>');
  return badges.join('');
}

function lobbyHtml(view) {
  const ctx = context(view);
  const full = view.players.length >= MAX_PLAYERS;
  const link = roomUrl(app.room);
  const seats = view.players.map((p) => {
    const name = p.mine
      ? `<input class="seatname" value="${esc(p.name)}" maxlength="16" data-rename="${p.id}" data-key="rename-${p.id}" aria-label="Dein Name">`
      : `<span class="seatname">${esc(p.name)}</span>`;
    let action = '';
    if (p.mine && ctx.mine.length > 1) action = `<button type="button" class="btn small" data-act="leave" data-pid="${p.id}" data-key="leave-${p.id}">Entfernen</button>`;
    else if (!p.mine && ctx.isHost) action = `<button type="button" class="btn small" data-act="remove" data-pid="${p.id}" data-key="remove-${p.id}">Entfernen</button>`;
    return `<li class="seat pen-${p.pen}"><span class="swatch" aria-hidden="true"></span>${name}${seatBadges(view, p)}${action}</li>`;
  }).join('');

  let join = '';
  if (ctx.mine.length === 0) {
    join = full
      ? '<p class="hint">Der Raum ist voll.</p>'
      : '<button type="button" class="btn primary" data-act="sit" data-key="sit">Mitspielen</button>';
  } else if (!full) {
    join = `
      <form class="row" data-form="addlocal">
        <input name="name" maxlength="16" placeholder="Noch jemand an diesem Gerät?" aria-label="Name eines weiteren Spielers an diesem Gerät" data-key="f-addlocal" required>
        <button type="submit" class="btn">Hinzufügen</button>
      </form>`;
  }

  const items = ctx.isHost
    ? `<label class="check"><input type="checkbox" data-change="items" data-key="opt-items" ${view.options.items ? 'checked' : ''}><span>Mit Items spielen</span></label>`
    : `<p>${view.options.items ? 'Gespielt wird mit Items.' : 'Gespielt wird ohne Items.'}</p>`;

  const start = ctx.isHost
    ? `<button type="button" class="btn primary big" data-act="start" data-key="start">Spiel starten</button>
       <p class="hint center">Nach dem Start kann niemand mehr dazukommen.</p>`
    : '<p class="wait">Der Gastgeber startet das Spiel.</p>';

  return `
    <section class="lobby">
      <div class="panel invite">
        <h1 class="small">Raum <span class="code">${esc(app.room)}</span></h1>
        <label for="f-link">Schick diesen Link an alle, die mitspielen sollen.</label>
        <div class="row">
          <input id="f-link" readonly value="${esc(link)}" data-key="f-link" data-select>
          <button type="button" class="btn" data-act="copy" data-key="copy">Link kopieren</button>
        </div>
        ${navigator.share ? '<button type="button" class="btn" data-act="share" data-key="share">Link teilen</button>' : ''}
      </div>
      <div class="panel">
        <h2>Am Tisch <span class="count">${view.players.length} von ${MAX_PLAYERS}</span></h2>
        <ul class="seats">${seats}</ul>
        ${join}
      </div>
      <div class="panel">
        <h2>Spielart</h2>
        ${items}
        <button type="button" class="linkbtn" data-act="rules" data-key="lobby-rules">Regeln und Items ansehen</button>
      </div>
      ${start}
    </section>`;
}

// ---------- Spiel ----------

function turnChips(view, ctx) {
  const turn = view.turn;
  const chips = [];
  if (turn.braked) chips.push(['bad', ICONS.brake, 'Wurfbremse: ein Wurf weniger']);
  if (turn.icePending) chips.push(['bad', ICONS.ice, 'Eiswürfel: Nach dem ersten Wurf friert ein Würfel fest']);
  if (ctx.current.effects.curse) chips.push(['bad', ICONS.curse, `Fluch: ${CURSE_PENALTY} Punkte weniger`]);
  if (turn.double) chips.push(['good', ICONS.double, 'Doppler: Der Eintrag zählt doppelt']);
  if (turn.rollsUsed > 0 && jokerActive(ctx.current, turn.dice)) {
    chips.push(['good', ICONS.wish, `Weiterer Kniffel: +${EXTRA_KNIFFEL_BONUS}, jedes freie Feld zählt voll`]);
  }
  if (chips.length === 0) return '';
  return `<ul class="chips">${chips.map(([tone, icon, text]) => `<li class="${tone}">${icon}<span>${esc(text)}</span></li>`).join('')}</ul>`;
}

function trayHtml(view, ctx) {
  const turn = view.turn;
  const player = ctx.current;
  const rolled = turn.rollsUsed > 0;
  const left = turn.rollsMax - turn.rollsUsed;
  const canHold = ctx.myTurn && rolled && left > 0;
  const dice = turn.dice.map((value, i) => dieHtml({
    value: rolled ? value : 0,
    index: i,
    held: rolled && turn.held[i],
    frozen: turn.frozen[i],
    clickable: canHold && !turn.frozen[i],
  })).join('');

  const who = ctx.myTurn
    ? (ctx.mine.length > 1 ? `${esc(player.name)}, du bist dran` : 'Du bist dran')
    : `${esc(player.name)} ist dran`;
  const count = rolled ? `Wurf ${turn.rollsUsed} von ${turn.rollsMax}` : `${turn.rollsMax} Würfe`;

  let action = '';
  if (ctx.myTurn) {
    if (!rolled) {
      action = '<button type="button" class="btn primary big" data-act="roll" data-key="roll">Würfeln</button>';
    } else if (left > 0) {
      const allHeld = turn.held.every(Boolean);
      action = `
        <button type="button" class="btn primary big" data-act="roll" data-key="roll" ${allHeld ? 'disabled' : ''}>Nochmal würfeln</button>
        <p class="trayhint">${allHeld ? 'Alle Würfel bleiben liegen. Lass einen los oder trag ein Feld ein.' : `Noch ${left === 1 ? 'ein Wurf' : `${left} Würfe`}. Tippe die Würfel an, die liegen bleiben sollen.`}</p>`;
    } else {
      action = '<p class="trayhint strong">Kein Wurf mehr. Wähle ein Feld im Block.</p>';
    }
  } else if (!player.connected) {
    action = `<p class="trayhint">${esc(player.name)} ist gerade nicht verbunden.</p>`;
  }

  return `
    <section class="tray ${ctx.myTurn ? 'mine' : ''} pen-${player.pen}" aria-label="Würfel">
      <div class="trayhead">
        <h2 aria-live="polite">${who}</h2>
        <span class="rolls">${count}</span>
      </div>
      <div class="dice">${dice}</div>
      ${turnChips(view, ctx)}
      ${action}
    </section>`;
}

function rankingOf(view) {
  const rows = view.players.filter((p) => !p.removed)
    .map((p) => ({ player: p, total: totals(p).total }))
    .sort((a, b) => b.total - a.total);
  rows.forEach((row, i) => {
    row.place = i > 0 && rows[i - 1].total === row.total ? rows[i - 1].place : i + 1;
  });
  return rows;
}

function resultHtml(view, ctx) {
  const rows = rankingOf(view);
  const winners = rows.filter((row) => row.place === 1);
  let headline = 'Das Spiel ist vorbei';
  if (winners.length === 1) {
    headline = winners[0].player.mine && ctx.mine.length === 1
      ? `Du gewinnst mit ${winners[0].total} Punkten`
      : `${esc(winners[0].player.name)} gewinnt mit ${winners[0].total} Punkten`;
  } else if (winners.length > 1) {
    headline = `Gleichstand: ${winners.map((w) => esc(w.player.name)).join(' und ')} mit ${winners[0].total} Punkten`;
  }
  const list = rows.map((row) => `
    <li class="pen-${row.player.pen}">
      <span class="place">${row.place}.</span>
      <span class="who">${esc(row.player.name)}</span>
      <span class="pts">${row.total}</span>
    </li>`).join('');
  const again = ctx.isHost
    ? '<button type="button" class="btn primary big" data-act="again" data-key="again">Nochmal spielen</button>'
    : '<p class="trayhint">Der Gastgeber kann eine neue Runde starten.</p>';
  return `
    <section class="tray result" aria-label="Endstand">
      <div class="trayhead"><h2>${headline}</h2></div>
      <ol class="ranking">${list}</ol>
      ${again}
    </section>`;
}

function handHtml(view, ctx) {
  if (!view.options.items || !ctx.hand || view.phase !== 'playing') return '';
  const player = ctx.hand;
  const cards = (player.items || []).map((id, i) => `
    <button type="button" class="card ${ITEMS[id].kind}" data-act="item" data-item="${id}" data-key="item-${i}">
      ${ICONS[id]}<span>${esc(ITEMS[id].name)}</span>
    </button>`);
  while (cards.length < HAND_LIMIT) cards.push('<span class="card empty" aria-hidden="true"></span>');

  const notes = [];
  if (player.effects.shield) notes.push('Dein Schild steht und wehrt den nächsten Angriff ab.');
  const attack = pendingAttack(player);
  if (attack && !(ctx.myTurn && attack === 'curse')) notes.push(`Auf dir liegt ein Angriff: ${ITEMS[attack].name}.`);
  if (ctx.myTurn && view.turn.itemUsed) notes.push('In diesem Zug hast du schon ein Item eingesetzt.');
  if ((player.items || []).length === 0) notes.push('Neue Items gibt es in Runde 5 und 9 und für jedes gestrichene Feld.');

  return `
    <section class="hand" aria-label="Items">
      <h2>${ctx.mine.length > 1 ? `Items von ${esc(player.name)}` : 'Deine Items'}</h2>
      <div class="cards">${cards.join('')}</div>
      ${notes.map((note) => `<p class="handnote">${esc(note)}</p>`).join('')}
    </section>`;
}

function headMarks(view, player) {
  if (view.phase !== 'playing') return '';
  const marks = [];
  if (!player.connected && !player.removed) marks.push('<span class="mark off" title="nicht verbunden">weg</span>');
  if (view.options.items && !player.removed) {
    if (player.effects.shield) marks.push(`<span class="mark good" title="Schild aktiv">${ICONS.shield}</span>`);
    const attack = pendingAttack(player);
    if (attack) marks.push(`<span class="mark bad" title="${esc(ITEMS[attack].name)} wartet">${ICONS[attack]}</span>`);
    if (player.itemCount > 0) marks.push(`<span class="mark count" title="${player.itemCount} Items auf der Hand">${player.itemCount}</span>`);
  }
  return marks.join('');
}

function blockHtml(view, ctx) {
  const players = view.players;
  const sums = players.map((p) => totals(p));
  const turnId = ctx.current ? ctx.current.id : null;

  const cols = players.map((p) => `<col class="${p.id === turnId ? 'turn' : ''}${p.removed ? ' out' : ''}">`).join('');
  const head = players.map((p) => `
    <th scope="col" class="pl pen-${p.pen}${p.id === turnId ? ' turn' : ''}${p.removed ? ' out' : ''}">
      <span class="nm">${esc(p.name)}</span>
      <span class="marks">${p.mine && players.length > 1 ? '<span class="mark you">du</span>' : ''}${headMarks(view, p)}</span>
    </th>`).join('');

  const catRow = (cat) => {
    const cells = players.map((p) => {
      const value = p.scores[cat.id];
      if (typeof value === 'number') {
        const fresh = app.fresh.has(`${p.id}:${cat.id}`) ? ' fresh' : '';
        const shown = value === 0 ? '<span class="ink strike" role="img" aria-label="gestrichen">–</span>' : `<span class="ink">${value}</span>`;
        return `<td class="val pen-${p.pen}${fresh}">${shown}</td>`;
      }
      if (ctx.canScore && p.id === turnId) {
        const points = potentialScore(p, cat.id, view.turn.dice);
        const selected = app.ui.selCat === cat.id;
        return `<td class="open"><button type="button" class="pick${selected ? ' sel' : ''}${points === 0 ? ' zero' : ''}" data-act="pick" data-cat="${cat.id}" data-key="pick-${cat.id}" aria-pressed="${selected}" aria-label="${esc(cat.name)}: ${points} Punkte">${points}</button></td>`;
      }
      return '<td></td>';
    }).join('');
    return `<tr><th scope="row" title="${esc(cat.hint)}">${esc(cat.name)}</th>${cells}</tr>`;
  };

  const sumRow = (label, cell, cls = 'sum') => `<tr class="${cls}"><th scope="row">${label}</th>${players.map((p, i) => `<td class="pen-${p.pen}">${cell(sums[i], p)}</td>`).join('')}</tr>`;

  const upper = CATEGORIES.filter((c) => c.section === 'upper');
  const lower = CATEGORIES.filter((c) => c.section === 'lower');
  const upperDone = (p) => upper.every((c) => typeof p.scores[c.id] === 'number');

  const rows = [
    ...upper.map(catRow),
    sumRow('Summe oben', (s, p) => (s.bonus || upperDone(p) ? s.upper : `${s.upper}<small>/${UPPER_BONUS_AT}</small>`)),
    sumRow(`Bonus ab ${UPPER_BONUS_AT}`, (s, p) => (s.bonus ? UPPER_BONUS : upperDone(p) ? '<span class="strike">–</span>' : '')),
    ...lower.map(catRow),
  ];
  if (sums.some((s) => s.kniffelBonus)) rows.push(sumRow('Weitere Kniffel', (s) => (s.kniffelBonus ? `+${s.kniffelBonus}` : '')));
  if (sums.some((s) => s.itemPoints)) {
    rows.push(sumRow('Items', (s) => (s.itemPoints > 0 ? `+${s.itemPoints}` : s.itemPoints < 0 ? `−${Math.abs(s.itemPoints)}` : '')));
  }
  rows.push(sumRow('Gesamt', (s) => s.total, 'total'));

  const round = view.phase === 'finished' ? 'Endstand' : `Runde ${view.round} von ${TOTAL_ROUNDS}`;
  return `
    <section class="block" aria-label="Kniffelblock">
      <div class="blockhead"><span>Kniffelblock</span><span>${round}</span></div>
      <table class="sheet n${players.length}">
        <colgroup><col class="lbl">${cols}</colgroup>
        <thead><tr><td></td>${head}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </section>`;
}

function logHtml(view) {
  const entries = view.log.slice(-14).reverse();
  if (entries.length === 0) return '';
  return `
    <section class="log" aria-label="Verlauf">
      <h2>Verlauf</h2>
      <ol>${entries.map((e) => `<li class="${esc(e.tone)}">${esc(e.text)}</li>`).join('')}</ol>
    </section>`;
}

function noticeHtml(view, ctx) {
  const notes = [];
  if (app.role === 'guest' && app.net !== 'online') {
    const text = app.net === 'stuck'
      ? 'Die direkte Verbindung kommt nicht zustande. Oft hilft ein anderes Netz, zum Beispiel mobile Daten statt WLAN.'
      : 'Die Verbindung zum Gastgeber ist unterbrochen. Es geht weiter, sobald sie wieder steht.';
    notes.push(`<p class="notice warn">${text}</p>`);
  }
  if (ctx.mine.length === 0) {
    notes.push('<p class="notice">Du schaust zu. In diesem Spiel hast du keinen Platz.</p>');
  }
  return notes.join('');
}

function gameHtml(view) {
  const ctx = context(view);
  const stage = view.phase === 'finished' ? resultHtml(view, ctx) : trayHtml(view, ctx);
  return `
    <div class="table">
      <div class="play">
        ${noticeHtml(view, ctx)}
        ${stage}
        ${handHtml(view, ctx)}
      </div>
      ${blockHtml(view, ctx)}
      ${logHtml(view)}
    </div>`;
}

function confirmHtml() {
  const view = app.view;
  if (app.screen !== 'room' || !view || view.phase !== 'playing') return '';
  const ctx = context(view);
  const cat = CATEGORIES.find((c) => c.id === app.ui.selCat);
  if (!ctx.canScore || !cat) return '';
  const actor = ctx.current;
  const value = potentialScore(actor, cat.id, view.turn.dice);
  const extras = [];
  if (jokerActive(actor, view.turn.dice)) extras.push(`+${EXTRA_KNIFFEL_BONUS} für den weiteren Kniffel`);
  if (view.turn.double && value > 0) extras.push(`+${Math.min(value, DOUBLE_CAP)} durch den Doppler`);
  if (actor.effects.curse && value > 0) extras.push(`−${Math.min(CURSE_PENALTY, value)} durch den Fluch`);
  const what = value === 0 ? `${esc(cat.name)} streichen` : `${value} bei ${esc(cat.name)} eintragen`;
  return `
    <div class="confirmbar" role="group" aria-label="Eintrag bestätigen">
      <p><strong>${what}</strong>${extras.length ? `<span>${esc(extras.join(', '))}</span>` : ''}</p>
      <button type="button" class="btn" data-act="unpick" data-key="unpick">Abbrechen</button>
      <button type="button" class="btn primary" data-act="score" data-key="score">${value === 0 ? 'Streichen' : 'Eintragen'}</button>
    </div>`;
}

// ---------- Dialoge ----------

function itemSheetHtml(view, sheet) {
  const ctx = context(view);
  const item = ITEMS[sheet.item];
  const actor = ctx.hand;
  const head = `
    <div class="sheethead ${item.kind}">${ICONS[sheet.item]}<div><h2>${esc(item.name)}</h2><p class="kind">${item.kind === 'attack' ? 'Gegen andere' : 'Für dich'}</p></div></div>
    <p>${esc(item.text)}</p>`;
  const close = '<button type="button" class="btn" data-act="close" data-key="sheet-close">Schließen</button>';
  if (!actor) return `${head}<div class="sheetfoot">${close}</div>`;

  const problem = itemProblem(view, actor.id, sheet.item);
  if (problem) return `${head}<p class="why">${esc(problem)}</p><div class="sheetfoot">${close}</div>`;

  if (item.needs === 'target') {
    const targets = view.players.filter((p) => p.id !== actor.id && !p.removed).map((p) => {
      const why = targetProblem(view, actor.id, sheet.item, p.id);
      return `
        <li>
          <button type="button" class="btn target pen-${p.pen}" data-act="use-target" data-pid="${p.id}" data-key="target-${p.id}" ${why ? 'disabled' : ''}>
            <span class="swatch" aria-hidden="true"></span><span class="who">${esc(p.name)}</span>
            ${p.effects.shield ? '<span class="badge">Schild</span>' : ''}
          </button>
          ${why ? `<p class="why">${esc(why)}</p>` : ''}
        </li>`;
    }).join('');
    return `${head}<h3>Wen soll es treffen?</h3><ul class="targets">${targets}</ul><div class="sheetfoot">${close}</div>`;
  }

  if (item.needs === 'die' || item.needs === 'dieValue') {
    const dice = view.turn.dice;
    if (item.needs === 'dieValue' && Number.isInteger(sheet.die)) {
      const faces = [1, 2, 3, 4, 5, 6].map((value) => dieHtml({
        value,
        index: value - 1,
        clickable: value !== dice[sheet.die],
        act: 'use-value',
        extra: value === dice[sheet.die] ? 'data-same' : '',
        label: value === dice[sheet.die] ? `${value}, zeigt der Würfel schon` : `Auf ${value} stellen`,
      })).join('');
      return `${head}<h3>Auf welche Zahl? Der Würfel zeigt gerade ${dice[sheet.die]}.</h3><div class="dice pickdice">${faces}</div>
        <div class="sheetfoot"><button type="button" class="btn" data-act="back-die" data-key="sheet-back">Anderen Würfel wählen</button>${close}</div>`;
    }
    const pick = dice.map((value, i) => `
      <div class="pickcol">
        ${dieHtml({ value, index: i, clickable: true, act: 'use-die', label: `Würfel ${i + 1}, zeigt ${value}` })}
        ${item.needs === 'die' ? `<span class="becomes">wird ${7 - value}</span>` : ''}
      </div>`).join('');
    return `${head}<h3>Welcher Würfel?</h3><div class="dice pickdice">${pick}</div><div class="sheetfoot">${close}</div>`;
  }

  return `${head}<div class="sheetfoot">${close}<button type="button" class="btn primary" data-act="use" data-key="sheet-use">Einsetzen</button></div>`;
}

function roomSheetHtml(view) {
  const ctx = context(view);
  const link = roomUrl(app.room);
  const players = view.players.map((p) => {
    let action = '';
    if (!p.removed && view.phase !== 'finished') {
      if (p.mine && (app.role === 'guest' || ctx.mine.length > 1)) {
        action = `<button type="button" class="btn small" data-act="leave" data-pid="${p.id}" data-key="leave-${p.id}">Aussteigen</button>`;
      } else if (!p.mine && ctx.isHost) {
        action = `<button type="button" class="btn small" data-act="remove" data-pid="${p.id}" data-key="remove-${p.id}">Entfernen</button>`;
      }
    }
    return `<li class="seat pen-${p.pen}${p.removed ? ' out' : ''}"><span class="swatch" aria-hidden="true"></span><span class="seatname">${esc(p.name)}</span>${p.removed ? '<span class="badge off">ausgestiegen</span>' : seatBadges(view, p)}${action}</li>`;
  }).join('');
  return `
    <h2>Raum ${esc(app.room)}</h2>
    <label for="f-link2">Einladungslink</label>
    <div class="row">
      <input id="f-link2" readonly value="${esc(link)}" data-key="f-link2" data-select>
      <button type="button" class="btn" data-act="copy" data-key="copy2">Link kopieren</button>
    </div>
    ${view.phase === 'lobby' ? '' : '<p class="hint">Wer mitten im Spiel den Link öffnet, schaut zu. Wer schon dabei war, landet wieder auf seinem Platz.</p>'}
    <h3>Am Tisch</h3>
    <ul class="seats">${players}</ul>
    ${ctx.isHost ? '<p class="hint">Du bist Gastgeber: Dein Gerät führt den Spielstand. Lass diese Seite offen, bis das Spiel vorbei ist.</p>' : ''}
    <div class="sheetfoot"><button type="button" class="btn" data-act="close" data-key="sheet-close">Schließen</button></div>`;
}

function rulesSheetHtml() {
  const itemRows = (kind) => Object.entries(ITEMS).filter(([, item]) => item.kind === kind).map(([id, item]) => `
    <li class="${item.kind}">${ICONS[id]}<div><strong>${esc(item.name)}</strong><span>${esc(item.text)}</span></div></li>`).join('');
  const catRows = CATEGORIES.map((cat) => `<li><strong>${esc(cat.name)}</strong><span>${esc(cat.hint)}</span></li>`).join('');
  return `
    <h2>Regeln</h2>
    <p>Wer dran ist, würfelt bis zu dreimal mit fünf Würfeln und darf nach jedem Wurf beliebige Würfel liegen lassen. Danach muss ein freies Feld im Block belegt werden. Passt der Wurf nirgends, wird ein Feld gestrichen. Nach 13 Runden gewinnt die höchste Summe.</p>
    <ul class="rules">${catRows}</ul>
    <p>Ab ${UPPER_BONUS_AT} Punkten im oberen Teil gibt es ${UPPER_BONUS} Bonuspunkte. Jeder weitere Kniffel bringt ${EXTRA_KNIFFEL_BONUS} Zusatzpunkte und darf mit dem Höchstwert in ein beliebiges freies Feld, sofern im Kniffel-Feld schon 50 stehen.</p>
    <h2>Items</h2>
    <p>Jeder startet mit zwei Items. In Runde 5 und 9 bekommen alle ein weiteres, dazu gibt es eins für jedes gestrichene Feld. Mehr als ${HAND_LIMIT} passen nicht auf die Hand. Pro Zug darfst du eins einsetzen, solange du noch nichts eingetragen hast. Die Items der anderen siehst du nicht.</p>
    <h3>Für dich</h3>
    <ul class="rules items">${itemRows('self')}</ul>
    <h3>Gegen andere</h3>
    <ul class="rules items">${itemRows('attack')}</ul>
    <p>Angriffe wirken im nächsten Zug des Ziels. Auf jedem Spieler kann nur ein solcher Angriff gleichzeitig liegen. Der Taschendieb wirkt sofort.</p>
    <div class="sheetfoot"><button type="button" class="btn" data-act="close" data-key="sheet-close">Schließen</button></div>`;
}

function confirmSheetHtml(sheet) {
  return `
    <h2>${esc(sheet.title)}</h2>
    <p>${esc(sheet.text)}</p>
    <div class="sheetfoot">
      <button type="button" class="btn" data-act="close" data-key="sheet-close">Abbrechen</button>
      <button type="button" class="btn danger" data-act="confirm" data-key="sheet-confirm">${esc(sheet.yes)}</button>
    </div>`;
}

function renderSheet() {
  const dialog = $('#sheet');
  const sheet = app.ui.sheet;
  let html = '';
  if (sheet) {
    if (sheet.kind === 'rules') html = rulesSheetHtml();
    else if (sheet.kind === 'confirm') html = confirmSheetHtml(sheet);
    else if (!app.view) html = '';
    else if (sheet.kind === 'room') html = roomSheetHtml(app.view);
    else if (sheet.kind === 'item') {
      const holds = app.view.phase === 'playing' && (context(app.view).hand?.items || []).includes(sheet.item);
      html = holds ? itemSheetHtml(app.view, sheet) : '';
    }
  }
  if (!html) {
    app.ui.sheet = null;
    app.ui.sheetHtml = '';
    if (dialog.open) dialog.close();
    return;
  }
  if (app.ui.sheetHtml !== html) {
    app.ui.sheetHtml = html;
    dialog.querySelector('.sheetbody').innerHTML = html;
    const names = { rules: 'Regeln', room: `Raum ${app.room}`, confirm: sheet.title, item: sheet.item ? ITEMS[sheet.item].name : '' };
    dialog.setAttribute('aria-label', names[sheet.kind] || 'Dialog');
  }
  if (!dialog.open) dialog.showModal();
}

// ---------- Zeichnen ----------

function mainHtml() {
  if (app.screen === 'home') return homeHtml();
  if (app.screen === 'name') return nameHtml();
  if (app.screen === 'gone') return goneHtml();
  if (!app.view) return waitingHtml();
  return app.view.phase === 'lobby' ? lobbyHtml(app.view) : gameHtml(app.view);
}

function rememberFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.key) return null;
  const isInput = el.tagName === 'INPUT' && el.type !== 'checkbox' && !el.readOnly;
  return {
    key: el.dataset.key,
    value: isInput ? el.value : null,
    start: isInput ? el.selectionStart : null,
    end: isInput ? el.selectionEnd : null,
  };
}

function restoreFocus(kept) {
  if (!kept) return;
  const el = document.querySelector(`[data-key="${CSS.escape(kept.key)}"]`);
  if (!el || el.disabled) return;
  if (kept.value !== null) el.value = kept.value;
  el.focus({ preventScroll: true });
  if (kept.value !== null && kept.start !== null) {
    try {
      el.setSelectionRange(kept.start, kept.end);
    } catch {
      // Feldtyp ohne Textauswahl.
    }
  }
}

function animateRoll(view) {
  const turn = view.turn;
  const dice = [...document.querySelectorAll('.tray .dice .die')];
  const rolling = dice.map((el, i) => (turn.rollsUsed === 1 || !turn.held[i] ? el : null));
  for (const el of rolling) if (el) el.classList.add('rolling');
  let frame = 0;
  const timer = setInterval(() => {
    frame += 1;
    rolling.forEach((el, i) => {
      if (!el || !el.isConnected) return;
      el.dataset.face = frame >= 7 ? turn.dice[i] : 1 + Math.floor(Math.random() * 6);
      if (frame >= 7) el.classList.remove('rolling');
    });
    if (frame >= 7) clearInterval(timer);
  }, 55);
}

function render() {
  const kept = rememberFocus();
  const view = app.screen === 'room' ? app.view : null;
  if (view && app.ui.selCat && !(view.phase === 'playing' && context(view).canScore)) app.ui.selCat = null;

  $('#top').innerHTML = topHtml();
  $('#main').innerHTML = mainHtml();
  $('#confirm').innerHTML = confirmHtml();
  document.body.classList.toggle('has-confirm', Boolean($('#confirm').firstElementChild));
  renderSheet();
  restoreFocus(kept);

  const rollId = view && view.turn ? view.turn.rollId : null;
  if (rollId !== null) {
    if (app.ui.rollSeen !== null && rollId > app.ui.rollSeen && !reducedMotion.matches) animateRoll(view);
    app.ui.rollSeen = rollId;
  }
  app.fresh = new Set();

  const myTurn = Boolean(view && view.phase === 'playing' && context(view).myTurn);
  document.title = `${myTurn ? 'Du bist dran – ' : ''}Kniffel`;
}

let wakeLock = null;
async function keepAwake(wanted) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (wanted && !wakeLock && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } else if (!wanted && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    // Vom Gerät nicht erlaubt: Dann dunkelt der Bildschirm eben wie gewohnt ab.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake(Boolean(app.view && app.view.phase === 'playing' && app.screen === 'room'));
});

function toast(text, tone = 'info') {
  const box = $('#toasts');
  const el = document.createElement('p');
  el.className = `toast ${tone}`;
  el.textContent = text;
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), 4200);
}

function setView(view) {
  const prev = app.view;
  app.view = view;

  app.fresh = new Set();
  if (prev && prev.phase === 'playing') {
    for (const player of view.players) {
      const before = prev.players.find((p) => p.id === player.id);
      if (!before) continue;
      for (const cat of CATEGORIES) {
        if (typeof player.scores[cat.id] === 'number' && typeof before.scores[cat.id] !== 'number') {
          app.fresh.add(`${player.id}:${cat.id}`);
        }
      }
    }
  }

  const newest = view.log.length ? view.log[view.log.length - 1].n : 0;
  if (app.ui.logSeen !== null) {
    const mineIds = view.players.filter((p) => p.mine).map((p) => p.id);
    const forMe = (e) => e.notify === 'all' || (Array.isArray(e.notify) && e.notify.some((id) => mineIds.includes(id)));
    const news = view.log.filter((e) => e.n > app.ui.logSeen && forMe(e));
    for (const entry of news.slice(-3)) toast(entry.text, entry.tone);
  }
  app.ui.logSeen = Math.max(newest, app.ui.logSeen ?? 0);

  // Wer neu an die Reihe kommt, bekommt ein kurzes Zeichen.
  const ctx = context(view);
  const turnKey = view.phase === 'playing' ? `${view.current}:${Object.keys(ctx.current.scores).length}` : '';
  const myTurnStarts = Boolean(turnKey && turnKey !== app.ui.turnKey && ctx.myTurn && prev);
  const justFinished = Boolean(prev && prev.phase === 'playing' && view.phase === 'finished');
  if (myTurnStarts && navigator.vibrate) navigator.vibrate(60);
  app.ui.turnKey = turnKey;

  window.onbeforeunload = app.role === 'host' && view.phase === 'playing' ? (event) => {
    event.preventDefault();
    return '';
  } : null;

  render();
  if (myTurnStarts || justFinished) showStage();
  keepAwake(view.phase === 'playing');
}

// Holt den Würfelteller (oder den Endstand) ins Bild, falls er weggescrollt ist.
function showStage() {
  const stage = document.querySelector('.tray');
  if (!stage) return;
  const box = stage.getBoundingClientRect();
  if (box.top >= 0 && box.top < innerHeight * 0.45) return;
  window.scrollTo({ top: Math.max(0, scrollY + box.top - 12), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// ---------- Gastgeber ----------

function startHost(room, record) {
  const state = record.state;
  const token = record.token;
  const guests = new Map(); // Verbindung -> Zugangsschlüssel (oder null vor der Anmeldung)

  const ok = () => ({ ok: true });
  const fail = (error) => ({ ok: false, error });

  function refreshPresence() {
    const online = new Set([token, ...guests.values()]);
    for (const player of state.players) player.connected = online.has(player.owner);
  }

  function viewOf(owner) {
    const view = viewFor(state, owner);
    view.hostIds = state.players.filter((p) => p.owner === token).map((p) => p.id);
    return view;
  }

  function publish() {
    refreshPresence();
    store.set(roomKey(room), record);
    for (const [conn, owner] of guests) {
      if (owner) net.send(conn, { t: 'state', s: viewOf(owner) });
    }
    setView(viewOf(token));
  }

  function perform(owner, msg) {
    const isHost = owner === token;
    const own = (pid) => state.players.find((p) => p.id === pid && p.owner === owner);
    const hostOnly = () => fail('Das kann nur der Gastgeber.');
    switch (msg.t) {
      case 'act': {
        const player = own(msg.pid);
        return player ? applyAction(state, player.id, msg.a, rng) : fail('Das ist nicht dein Spieler.');
      }
      case 'add':
        if (state.phase !== 'lobby') return fail('Das Spiel läuft schon.');
        return addPlayer(state, { name: msg.name, owner }) ? ok() : fail('Der Raum ist voll.');
      case 'rename': {
        const player = own(msg.pid);
        if (!player) return fail('Das ist nicht dein Spieler.');
        return renamePlayer(state, player.id, msg.name) ? ok() : fail('Umbenennen geht nur vor dem Spiel.');
      }
      case 'leave': {
        const player = own(msg.pid);
        return player ? removePlayer(state, player.id, rng) : fail('Das ist nicht dein Spieler.');
      }
      case 'options':
        if (!isHost) return hostOnly();
        if (state.phase !== 'lobby') return fail('Das geht nur vor dem Spiel.');
        state.options.items = Boolean(msg.items);
        return ok();
      case 'start':
        return isHost ? startGame(state, rng) : hostOnly();
      case 'remove':
        return isHost ? removePlayer(state, msg.pid, rng) : hostOnly();
      case 'again':
        if (!isHost) return hostOnly();
        return state.phase === 'finished' ? backToLobby(state) : fail('Das Spiel läuft noch.');
      default:
        return fail('Unbekannte Aktion.');
    }
  }

  const net = createHost({
    room,
    options: peerOptions(),
    onStatus(status) {
      app.net = status;
      if (status === 'taken') {
        net.stop();
        showGone('Dieser Raum ist schon in einem anderen Tab oder Fenster geöffnet. Spiel dort weiter, oder schließ das andere Fenster und mach hier weiter.');
        return;
      }
      render();
    },
    onOpen(conn) {
      guests.set(conn, null);
    },
    onClose(conn) {
      const owner = guests.get(conn);
      guests.delete(conn);
      if (owner) publish();
    },
    onMessage(conn, msg) {
      if (!msg || typeof msg !== 'object' || !guests.has(conn)) return;
      if (msg.t === 'ping') {
        net.send(conn, { t: 'pong' });
        return;
      }
      if (msg.t === 'hello') {
        if (typeof msg.token !== 'string' || !/^[0-9a-f]{32}$/.test(msg.token) || msg.token === token) return;
        // Dasselbe Gerät in einem zweiten Tab: Der neue Tab übernimmt.
        for (const [other, owner] of guests) {
          if (other !== conn && owner === msg.token) {
            net.send(other, { t: 'bye', reason: 'replaced' });
            guests.set(other, null);
          }
        }
        guests.set(conn, msg.token);
        if (state.phase === 'lobby' && !state.players.some((p) => p.owner === msg.token)) {
          addPlayer(state, { name: msg.name, owner: msg.token });
        }
        publish();
        return;
      }
      const owner = guests.get(conn);
      if (!owner) return;
      const result = perform(owner, msg);
      if (result.ok) publish();
      else net.send(conn, { t: 'err', text: result.error });
    },
  });

  refreshPresence();
  setView(viewOf(token));

  return {
    send(msg) {
      const result = perform(token, msg);
      if (result.ok) publish();
      else toast(result.error, 'error');
    },
  };
}

// ---------- Mitspieler ----------

function startGuest(room, record, name) {
  const net = createClient({
    room,
    options: peerOptions(),
    onStatus(status) {
      app.net = status;
      render();
    },
    onReady() {
      net.send({ t: 'hello', token: record.token, name });
    },
    onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'state' && msg.s) setView(msg.s);
      else if (msg.t === 'err') toast(String(msg.text), 'error');
      else if (msg.t === 'bye') {
        net.stop();
        showGone('Du hast diesen Raum in einem anderen Tab oder Fenster geöffnet. Dort geht es weiter.');
      }
    },
  });
  return {
    send(msg) {
      if (!net.send(msg)) toast('Gerade keine Verbindung zum Gastgeber. Versuch es gleich nochmal.', 'error');
    },
  };
}

function showGone(text) {
  app.screen = 'gone';
  app.goneText = text;
  app.ui.sheet = null;
  window.onbeforeunload = null;
  keepAwake(false);
  render();
}

function send(msg) {
  const link = app.role === 'host' ? app.host : app.client;
  if (link) link.send(msg);
}

function act(action) {
  const view = app.view;
  if (!view || view.phase !== 'playing') return;
  const ctx = context(view);
  if (!ctx.myTurn) return;
  send({ t: 'act', pid: ctx.current.id, a: action });
}

// ---------- Raum betreten ----------

// Zwei Tabs desselben Browsers dürfen nicht beide den Spielstand führen:
// Der neue Tab fragt kurz nach, ob schon einer den Raum offen hat.
function claimHostTab(room, onFree, onTaken) {
  if (typeof BroadcastChannel !== 'function') {
    onFree();
    return;
  }
  const channel = new BroadcastChannel(`kniffel-gastgeber-${room}`);
  let hosting = false;
  let decided = false;
  channel.onmessage = (event) => {
    if (event.data === 'frage' && hosting) {
      channel.postMessage('belegt');
    } else if (event.data === 'belegt' && !decided) {
      decided = true;
      onTaken();
    }
  };
  channel.postMessage('frage');
  setTimeout(() => {
    if (decided) return;
    decided = true;
    hosting = true;
    onFree();
  }, 300);
}

function enterRoom(room) {
  app.room = room;
  store.set(LAST_KEY, room);
  const record = store.get(roomKey(room));
  if (record && record.role === 'host' && record.state && record.token) {
    app.screen = 'room';
    app.role = 'host';
    render();
    claimHostTab(room, () => {
      app.host = startHost(room, record);
    }, () => {
      showGone('Dieser Raum ist schon in einem anderen Tab oder Fenster geöffnet. Spiel dort weiter, oder schließ das andere Fenster und mach hier weiter.');
    });
    return;
  }
  const name = store.get(NAME_KEY);
  if (!name) {
    app.screen = 'name';
    render();
    return;
  }
  joinAsGuest(room, name);
}

function joinAsGuest(room, name) {
  let record = store.get(roomKey(room));
  if (!record || record.role !== 'guest' || !record.token) {
    record = { role: 'guest', token: randomToken() };
    store.set(roomKey(room), record);
  }
  app.screen = 'room';
  app.role = 'guest';
  render();
  app.client = startGuest(room, record, name);
}

function createRoom(name) {
  const room = randomRoom();
  const token = randomToken();
  const state = createGame();
  addPlayer(state, { name, owner: token });
  store.set(roomKey(room), { role: 'host', token, state });
  history.replaceState(null, '', roomUrl(room));
  enterRoom(room);
}

// ---------- Eingaben ----------

async function copyLink() {
  const link = roomUrl(app.room);
  try {
    await navigator.clipboard.writeText(link);
    toast('Link kopiert.');
  } catch {
    const field = document.querySelector('[data-select]');
    if (field) {
      field.focus();
      field.select();
    }
    toast('Kopieren ging nicht automatisch. Der Link ist markiert, du kannst ihn jetzt kopieren.');
  }
}

function openSheet(sheet) {
  app.ui.sheet = sheet;
  render();
}

function closeSheet() {
  app.ui.sheet = null;
  render();
}

function useItem(extra = {}) {
  const sheet = app.ui.sheet;
  if (!sheet || sheet.kind !== 'item') return;
  act({ type: 'item', item: sheet.item, ...extra });
  closeSheet();
}

const actions = {
  roll: () => act({ type: 'roll' }),
  hold(el) {
    const die = Number(el.dataset.die);
    const view = app.view;
    // Sofort anzeigen, der Gastgeber bestätigt gleich danach.
    if (view && view.turn && !view.turn.frozen[die]) view.turn.held[die] = !view.turn.held[die];
    act({ type: 'hold', die });
    render();
  },
  pick(el) {
    app.ui.selCat = app.ui.selCat === el.dataset.cat ? null : el.dataset.cat;
    render();
    const button = document.querySelector('[data-key="score"]');
    if (button) button.focus({ preventScroll: true });
  },
  unpick() {
    app.ui.selCat = null;
    render();
  },
  score() {
    const cat = app.ui.selCat;
    app.ui.selCat = null;
    if (cat) act({ type: 'score', cat });
    render();
  },
  item: (el) => openSheet({ kind: 'item', item: el.dataset.item, die: null }),
  use: () => useItem(),
  'use-target': (el) => useItem({ target: el.dataset.pid }),
  'use-die'(el) {
    const sheet = app.ui.sheet;
    if (!sheet || sheet.kind !== 'item') return;
    const die = Number(el.dataset.die);
    if (ITEMS[sheet.item].needs === 'dieValue') openSheet({ ...sheet, die });
    else useItem({ die });
  },
  'use-value'(el) {
    const sheet = app.ui.sheet;
    if (sheet && sheet.kind === 'item') useItem({ die: sheet.die, value: Number(el.dataset.die) + 1 });
  },
  'back-die'() {
    if (app.ui.sheet) openSheet({ ...app.ui.sheet, die: null });
  },
  room: () => openSheet({ kind: 'room' }),
  rules: () => openSheet({ kind: 'rules' }),
  close: closeSheet,
  copy: copyLink,
  share() {
    navigator.share({ title: 'Kniffel', text: 'Komm in meinen Kniffel-Raum:', url: roomUrl(app.room) }).catch(() => {});
  },
  start: () => send({ t: 'start' }),
  again: () => send({ t: 'again' }),
  sit: () => send({ t: 'add', name: store.get(NAME_KEY) || '' }),
  reload: () => location.reload(),
  remove(el) {
    const player = app.view && app.view.players.find((p) => p.id === el.dataset.pid);
    if (!player) return;
    if (app.view.phase === 'lobby') {
      send({ t: 'remove', pid: player.id });
      return;
    }
    openSheet({
      kind: 'confirm',
      title: `${player.name} entfernen?`,
      text: `${player.name} scheidet aus diesem Spiel aus und kann nicht wieder einsteigen. Die bisherigen Punkte bleiben im Block stehen.`,
      yes: 'Entfernen',
      msg: { t: 'remove', pid: player.id },
    });
  },
  leave(el) {
    const player = app.view && app.view.players.find((p) => p.id === el.dataset.pid);
    if (!player) return;
    if (app.view.phase === 'lobby') {
      send({ t: 'leave', pid: player.id });
      return;
    }
    openSheet({
      kind: 'confirm',
      title: 'Aus dem Spiel aussteigen?',
      text: `${player.name} scheidet aus diesem Spiel aus und kann nicht wieder einsteigen.`,
      yes: 'Aussteigen',
      msg: { t: 'leave', pid: player.id },
    });
  },
  confirm() {
    const sheet = app.ui.sheet;
    if (sheet && sheet.kind === 'confirm') send(sheet.msg);
    closeSheet();
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (el && !el.disabled && actions[el.dataset.act]) {
    actions[el.dataset.act](el);
    return;
  }
  const field = event.target.closest('[data-select]');
  if (field) field.select();
  // Klick neben den Dialog schließt ihn.
  if (event.target === $('#sheet')) closeSheet();
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const kind = form.dataset.form;
  if (kind === 'create' || kind === 'enter') {
    const name = cleanName(data.get('name'), 'Spieler');
    store.set(NAME_KEY, name);
    if (kind === 'create') createRoom(name);
    else joinAsGuest(app.room, name);
  } else if (kind === 'join') {
    const room = normalizeRoom(data.get('code'));
    if (!room) {
      toast('Ein Raumcode hat fünf Zeichen, zum Beispiel K7MQ2.', 'error');
      return;
    }
    location.href = roomUrl(room);
  } else if (kind === 'addlocal') {
    send({ t: 'add', name: data.get('name') });
    form.reset();
    const field = form.querySelector('input');
    if (field) field.blur();
  }
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset.change === 'items') {
    send({ t: 'options', items: el.checked });
  } else if (el.dataset.rename) {
    const name = cleanName(el.value, '');
    if (!name) {
      render();
      return;
    }
    const view = app.view;
    const mine = view ? view.players.filter((p) => p.mine) : [];
    if (mine.length && mine[0].id === el.dataset.rename) store.set(NAME_KEY, name);
    el.blur();
    send({ t: 'rename', pid: el.dataset.rename, name });
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.dataset && event.target.dataset.rename) event.target.blur();
});

$('#sheet').addEventListener('close', () => {
  if (app.ui.sheet) {
    app.ui.sheet = null;
    render();
  }
});

// Für die Browser-Tests: aktueller Stand, wie ihn diese Seite sieht.
window.__kniffel = { get view() { return app.view; }, get net() { return app.net; }, get screen() { return app.screen; } };

// ---------- Los ----------

const startRoom = normalizeRoom(query.get('r'));
if (startRoom) enterRoom(startRoom);
else render();
