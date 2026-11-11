// Spielt im echten Browser eine komplette Partie mit mehreren Geräten durch.
// Braucht die devDependencies (npm install) und einen installierten Chrome.
//   node tests/e2e.mjs            Bilder landen in tests/shots/
//   CHROME=/pfad/zu/chrome SHOTS=/tmp/bilder node tests/e2e.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import mqtt from 'mqtt';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS || path.join(root, 'tests', 'shots');
const WEB_PORT = 8123;
const RELAY_PORTS = [9123, 9124];
const RELAYS = RELAY_PORTS.map((port) => `ws://localhost:${port}`).join(',');
const BASE = `http://localhost:${WEB_PORT}/?relay=${RELAYS}`;
fs.mkdirSync(shots, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const web = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(WEB_PORT, '127.0.0.1');

// Lokale Vermittler anstelle der öffentlichen. Lassen sich einzeln abschalten.
async function startBroker(port) {
  const broker = await Aedes.createBroker();
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => broker.handle(createWebSocketStream(socket), req));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    async stop() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => broker.close(resolve));
    },
  };
}
const brokers = [];
for (const port of RELAY_PORTS) brokers.push(await startBroker(port));

// Ein Fremder, der beim Vermittler alles mitliest.
const overheard = [];
const lurker = mqtt.connect(`ws://127.0.0.1:${RELAY_PORTS[0]}`);
lurker.on('connect', () => lurker.subscribe('#'));
lurker.on('message', (topic, payload) => overheard.push({ topic, text: payload.toString('latin1'), size: payload.length }));

const problems = [];
const check = (ok, text) => {
  if (!ok) problems.push(text);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--no-proxy-server'],
});

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 860 };

function watch(page, label) {
  page.on('pageerror', (err) => problems.push(`${label}: Seitenfehler ${err.message}`));
  page.on('console', (msg) => {
    // Abgeschaltete Vermittler meldet der Browser selbst als Fehler, das gehört zum Test.
    if (msg.type() === 'error' && !/WebSocket|ERR_CONNECTION/.test(msg.text())) problems.push(`${label}: Konsole ${msg.text()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());
  page.label = label;
  return page;
}

async function device(label, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'de-DE' });
  return watch(await context.newPage(), label);
}

const view = (page) => page.evaluate(() => window.__kniffel.view);
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const untilView = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 20000 });

async function join(page, link, name) {
  await page.goto(link);
  await page.fill('#f-name', name);
  await page.click('[data-form="enter"] button[type="submit"]');
  await untilView(page, () => window.__kniffel.view && window.__kniffel.view.players.some((p) => p.mine));
}

// Wer gerade dran ist: die Seite, auf der der aktuelle Spieler „mine“ ist.
async function actorPage(pages) {
  for (const page of pages) {
    const v = await view(page);
    if (v && v.phase === 'playing' && v.players[v.current].mine) return page;
  }
  return null;
}

const used = new Set();
async function tryItem(page) {
  // Nach jedem Klick zeichnet die Seite neu, deshalb immer frisch über den Selektor greifen.
  const count = (await page.$$('.card[data-item]')).length;
  for (let slot = 0; slot < count; slot += 1) {
    const selector = `.card[data-key="item-${slot}"]`;
    if (!(await page.$(selector))) break;
    const id = await page.getAttribute(selector, 'data-item');
    await page.click(selector);
    await page.waitForSelector('#sheet[open]');
    if (await page.$('#sheet .why:not(.targets .why)') && !(await page.$('#sheet [data-act^="use"]:not([disabled])'))) {
      await page.click('#sheet [data-act="close"]');
      continue;
    }
    if (await page.$('#sheet [data-act="use-target"]:not([disabled])')) {
      if (!used.has(`shot-${id}`) && id === 'brake') await shot(page, '05-item-ziel');
      await page.click('#sheet [data-act="use-target"]:not([disabled])');
    } else if (await page.$('#sheet [data-act="use-die"]')) {
      await page.click('#sheet [data-act="use-die"]');
      if (id === 'wish') {
        await page.waitForSelector('#sheet [data-act="use-value"]');
        await page.click('#sheet [data-act="use-value"]');
      }
    } else if (await page.$('#sheet [data-act="use"]')) {
      await page.click('#sheet [data-act="use"]');
    } else {
      await page.click('#sheet [data-act="close"]');
      continue;
    }
    used.add(`shot-${id}`);
    used.add(id);
    await page.waitForFunction(() => !document.querySelector('#sheet[open]'));
    await untilView(page, () => window.__kniffel.view.turn && window.__kniffel.view.turn.itemUsed);
    return id;
  }
  return null;
}

async function playTurn(pages, turnNo, { wantItems }) {
  const page = await actorPage(pages);
  if (!page) throw new Error('Niemand ist dran.');
  const before = await view(page);
  const actor = before.players[before.current];

  await page.click('[data-act="roll"]');
  await untilView(page, () => window.__kniffel.view.turn.rollsUsed === 1);

  if (wantItems && turnNo % 2 === 0) await tryItem(page);

  // Einmal halten und nachwürfeln, sofern noch ein Wurf übrig ist.
  const holdable = await page.$$('.tray button.die:not(.held)');
  if (holdable.length >= 2 && (await page.$('[data-act="roll"]:not([disabled])'))) {
    const heldBefore = (await view(page)).turn.held.filter(Boolean).length;
    for (let k = 1; k <= 2; k += 1) {
      await page.click('.tray button.die:not(.held)');
      await untilView(page, (n) => window.__kniffel.view.turn.held.filter(Boolean).length >= n, heldBefore + k);
    }
    if ((await page.$$('.tray .die.held')).length < 2) problems.push(`Zug ${turnNo}: gehaltene Würfel sind nicht markiert`);
    if (turnNo === 3) await shot(page, '03-zug-gehalten');
    await page.click('[data-act="roll"]');
    await untilView(page, () => window.__kniffel.view.turn.rollsUsed >= 2);
  }

  // Das Feld mit den meisten Punkten eintragen.
  const picks = await page.$$eval('.pick', (els) => els.map((el) => ({ cat: el.dataset.cat, points: Number(el.textContent) })));
  if (picks.length === 0) throw new Error(`${page.label}: keine freien Felder sichtbar`);
  const best = picks.reduce((a, b) => (b.points > a.points ? b : a));
  await page.click(`.pick[data-cat="${best.cat}"]`);
  await page.waitForSelector('.confirmbar');
  if (turnNo === 3) await shot(page, '04-eintrag-bestaetigen');
  await page.click('[data-act="score"]');
  await untilView(page, ([pid, cat]) => {
    const v = window.__kniffel.view;
    return typeof v.players.find((p) => p.id === pid).scores[cat] === 'number';
  }, [actor.id, best.cat]);
  return { page, actor: actor.id, cat: best.cat };
}

try {
  // ---------- Lobby ----------
  let host = await device('Phil (Gastgeber, Handy)', PHONE);
  await host.goto(BASE);
  await host.waitForSelector('.hero');
  await host.waitForTimeout(900);
  await shot(host, '01-start');
  await host.fill('#f-name', 'Phil');
  await host.click('[data-form="create"] button[type="submit"]');
  await untilView(host, () => window.__kniffel.view && window.__kniffel.view.phase === 'lobby');
  const link = host.url();
  check(/[?&]r=[A-Z2-9]{5}/.test(link), `Raum erstellt (${link})`);

  const anna = await device('Anna (Desktop)', DESKTOP);
  const ben = await device('Ben (Handy)', PHONE);
  await join(anna, link, 'Anna');
  await join(ben, link, 'Ben');
  await untilView(host, () => window.__kniffel.view.players.length === 3);

  await host.fill('[data-form="addlocal"] input', 'Oma Erna');
  await host.click('[data-form="addlocal"] button');
  await untilView(ben, () => window.__kniffel.view.players.length === 4);
  check((await view(host)).players.filter((p) => p.mine).length === 2, 'Zwei Spieler am Gerät des Gastgebers');

  // Umbenennen in der Lobby
  await ben.fill('input[data-rename]', 'Benjamin');
  await ben.press('input[data-rename]', 'Enter');
  await untilView(host, () => window.__kniffel.view.players.some((p) => p.name === 'Benjamin'));
  check(true, 'Umbenennen kommt beim Gastgeber an');
  await shot(host, '02-lobby');

  check(!(await anna.$('[data-act="start"]')), 'Nur der Gastgeber kann starten');
  await host.click('[data-act="start"]');
  const pages = [host, anna, ben];
  for (const page of pages) await untilView(page, () => window.__kniffel.view.phase === 'playing');
  const start = await view(host);
  check(start.players.every((p) => p.itemCount === 2), 'Alle starten mit zwei Items');
  check((await view(anna)).players.filter((p) => !p.mine).every((p) => p.items === null), 'Fremde Items bleiben verdeckt');

  // ---------- Partie ----------
  let turnNo = 0;
  let spectator = null;
  while ((await view(host)).phase === 'playing') {
    turnNo += 1;
    await playTurn(pages, turnNo, { wantItems: true });

    if (turnNo === 5) {
      await shot(anna, '07-desktop');
      // Mitspieler lädt mitten im Spiel neu und landet wieder auf seinem Platz.
      const mineBefore = (await view(ben)).players.find((p) => p.mine);
      await ben.reload();
      await untilView(ben, () => window.__kniffel.view && window.__kniffel.view.players.some((p) => p.mine));
      const mineAfter = (await view(ben)).players.find((p) => p.mine);
      check(mineAfter.id === mineBefore.id && JSON.stringify(mineAfter.scores) === JSON.stringify(mineBefore.scores), 'Mitspieler ist nach dem Neuladen wieder auf seinem Platz');
    }
    if (turnNo === 9) {
      // Gastgeber lädt neu: Spielstand bleibt, die anderen verbinden sich wieder.
      const beforeReload = JSON.stringify((await view(anna)).players.map((p) => p.scores));
      await host.reload();
      await untilView(host, () => window.__kniffel.view && window.__kniffel.view.phase === 'playing');
      await untilView(host, () => window.__kniffel.view.players.every((p) => p.connected));
      const afterReload = JSON.stringify((await view(host)).players.map((p) => p.scores));
      check(beforeReload === afterReload, 'Spielstand übersteht das Neuladen des Gastgebers');
    }
    if (turnNo === 12) {
      spectator = await device('Zuschauer (Handy)', PHONE);
      await spectator.goto(link);
      await spectator.fill('#f-name', 'Spät dran');
      await spectator.click('[data-form="enter"] button[type="submit"]');
      await untilView(spectator, () => window.__kniffel.view && window.__kniffel.view.phase === 'playing');
      check((await view(spectator)).players.every((p) => !p.mine), 'Wer mitten im Spiel dazukommt, schaut zu');
      check(Boolean(await spectator.$('.notice')), 'Zuschauer sieht den Hinweis');
    }
    if (turnNo === 20) await shot(ben, '08-mitte-handy');
  }

  check(turnNo === 4 * 13, `Partie zu Ende nach ${turnNo} Zügen`);
  for (const page of pages) await untilView(page, () => window.__kniffel.view.phase === 'finished');
  const finals = [];
  for (const page of pages) {
    const v = await view(page);
    finals.push(JSON.stringify(v.players.map((p) => [p.name, p.scores, p.kniffelBonus, p.itemPoints])));
  }
  check(finals.every((f) => f === finals[0]), 'Alle Geräte zeigen denselben Endstand');
  check(used.size > 0, `Items über die Oberfläche eingesetzt: ${[...used].filter((id) => !id.startsWith('shot-')).join(', ')}`);
  await host.waitForTimeout(400);
  await shot(host, '09-ende-handy');
  await shot(anna, '10-ende-desktop');

  // Regeln-Dialog
  await anna.click('[data-act="rules"]');
  await anna.waitForSelector('#sheet[open]');
  await shot(anna, '11-regeln');
  await anna.click('#sheet [data-act="close"]');

  // Neue Runde
  await host.click('[data-act="again"]');
  for (const page of pages) await untilView(page, () => window.__kniffel.view.phase === 'lobby');
  check((await view(ben)).players.length === 4, 'Nach dem Spiel sind alle wieder in der Lobby');

  // ---------- Wunschwürfel und Taschendieb gezielt ----------
  await host.click('[data-act="start"]');
  for (const page of pages) await untilView(page, () => window.__kniffel.view.phase === 'playing');
  const room = new URL(link).searchParams.get('r');
  // Der Gastgeber führt den Spielstand: gezielt Items verteilen und neu laden.
  await host.evaluate((key) => {
    const record = JSON.parse(localStorage.getItem(key));
    const state = record.state;
    state.players.forEach((player, index) => {
      player.items = index === state.current ? ['wish', 'thief'] : ['flip'];
      player.effects = { shield: false, brake: false, ice: false, curse: false };
    });
    localStorage.setItem(key, JSON.stringify(record));
  }, `kniffel:room:${room}`);
  await host.reload();
  await untilView(host, () => window.__kniffel.view && window.__kniffel.view.phase === 'playing');
  // Alle sehen die neu verteilten Hände: zwei Items beim Spieler am Zug, eins bei den anderen.
  for (const page of pages) {
    await untilView(page, () => {
      const v = window.__kniffel.view;
      return v.players.every((p, index) => p.itemCount === (index === v.current ? 2 : 1));
    });
  }

  let page = await actorPage(pages);
  const wisher = (await view(page)).players[(await view(page)).current].id;
  await page.click('[data-act="roll"]');
  await untilView(page, () => window.__kniffel.view.turn.rollsUsed === 1);
  const diceBefore = (await view(page)).turn.dice;
  await page.click('.card[data-item="wish"]');
  await page.waitForSelector('#sheet [data-act="use-die"]');
  await page.click('#sheet [data-act="use-die"][data-die="0"]');
  await page.waitForSelector('#sheet [data-act="use-value"]');
  await shot(page, '06-item-wunsch');
  const wanted = diceBefore[0] === 6 ? 1 : 6;
  await page.click(`#sheet [data-act="use-value"][data-die="${wanted - 1}"]`);
  await untilView(page, (value) => window.__kniffel.view.turn.dice[0] === value, wanted);
  const afterWish = await view(page);
  check(afterWish.turn.dice.slice(1).join() === diceBefore.slice(1).join(), 'Wunschwürfel ändert genau einen Würfel');
  check(!afterWish.players[afterWish.current].items.includes('wish'), 'Wunschwürfel ist verbraucht');
  // Zweites Item im selben Zug geht nicht.
  await page.click('.card[data-item="thief"]');
  await page.waitForSelector('#sheet .why');
  check((await page.textContent('#sheet .why')).includes('nur ein Item'), 'Zweites Item im selben Zug wird abgelehnt');
  await page.click('#sheet [data-act="close"]');
  const options = await page.$$eval('.pick', (els) => els.map((el) => ({ cat: el.dataset.cat, points: Number(el.textContent) })));
  await page.click(`.pick[data-cat="${options.reduce((a, b) => (b.points > a.points ? b : a)).cat}"]`);
  await page.click('[data-act="score"]');
  await untilView(page, (pid) => window.__kniffel.view.players[window.__kniffel.view.current].id !== pid, wisher);

  for (let k = 0; k < 3; k += 1) await playTurn(pages, 100 + k, { wantItems: false });
  page = await actorPage(pages);
  let now = await view(page);
  check(now.players[now.current].id === wisher, 'Nach einer Runde ist derselbe Spieler wieder dran');
  const victim = now.players.find((p) => !p.mine && p.itemCount > 0);
  const handBefore = now.players[now.current].items;
  await page.click('.card[data-item="thief"]');
  await page.waitForSelector('#sheet [data-act="use-target"]');
  await page.click(`#sheet [data-act="use-target"][data-pid="${victim.id}"]`);
  await untilView(page, ([pid, count]) => window.__kniffel.view.players.find((p) => p.id === pid).itemCount === count, [victim.id, victim.itemCount - 1]);
  now = await view(page);
  const handAfter = now.players[now.current].items;
  // Der Dieb ist verbraucht, dafür liegt ein Item des Ziels auf der Hand.
  check(!handAfter.includes('thief') && handAfter.length === handBefore.length, 'Taschendieb bringt ein Item des Ziels auf die eigene Hand');
  const victimPage = [anna, ben].find((candidate) => candidate !== page);
  let victimSaw = false;
  for (const candidate of pages) {
    const v = await view(candidate);
    if (v.players.some((p) => p.mine && p.id === victim.id)) {
      await candidate.waitForSelector('.toast', { timeout: 5000 });
      victimSaw = (await candidate.textContent('.toast')).includes('klaut');
    }
  }
  check(victimSaw, 'Das Ziel bekommt einen Hinweis');
  void victimPage;

  for (const candidate of [host, anna, ben]) {
    const fits = await candidate.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    check(fits, `${candidate.label}: nichts ragt seitlich aus dem Bild`);
  }

  // ---------- Sonderfälle ----------
  const gone = (candidate) => candidate.waitForFunction(() => window.__kniffel && window.__kniffel.screen === 'gone', null, { timeout: 20000 });
  const seated = (candidate) => untilView(candidate, () => window.__kniffel && window.__kniffel.view && window.__kniffel.view.players.some((p) => p.mine));

  // Der Gastgeber öffnet den Raum versehentlich ein zweites Mal.
  const scoresBefore = JSON.stringify((await view(host)).players.map((p) => p.scores));
  const hostTwin = watch(await host.context().newPage(), 'Gastgeber, zweiter Tab');
  await hostTwin.goto(link);
  await gone(hostTwin);
  check(!(await hostTwin.$('[data-act="roll"]')), 'Zweiter Tab des Gastgebers kann nicht ins Spiel eingreifen');
  await hostTwin.close();
  check(JSON.stringify((await view(host)).players.map((p) => p.scores)) === scoresBefore, 'Spielstand bleibt dabei unverändert');

  // Ein Mitspieler öffnet den Link in einem zweiten Tab: Der neue Tab übernimmt.
  const benTwin = watch(await ben.context().newPage(), 'Ben, zweiter Tab');
  await benTwin.goto(link);
  await seated(benTwin);
  await gone(ben);
  check(true, 'Zweiter Tab eines Mitspielers löst den ersten ab');
  await Promise.all([ben.waitForEvent('load'), ben.click('[data-act="reload"]')]);
  await seated(ben);
  await gone(benTwin);
  await benTwin.close();
  check(true, 'Der erste Tab kann wieder übernehmen');

  // Der Gastgeber ist eine Weile weg (Seite zu, Handy gesperrt) und kommt zurück.
  const hostContext = host.context();
  await host.close();
  await anna.waitForFunction(() => window.__kniffel.net !== 'online', null, { timeout: 40000 });
  await anna.waitForSelector('.notice.warn');
  check(true, 'Mitspieler sehen, dass die Verbindung zum Gastgeber fehlt');
  host = watch(await hostContext.newPage(), 'Phil (Gastgeber, Handy)');
  pages[0] = host;
  await host.goto(link);
  await untilView(host, () => window.__kniffel.view && window.__kniffel.view.phase === 'playing');
  for (const candidate of [anna, ben]) {
    await candidate.waitForFunction(() => window.__kniffel.net === 'online', null, { timeout: 40000 });
  }
  await untilView(host, () => window.__kniffel.view.players.every((p) => p.connected));
  check(JSON.stringify((await view(host)).players.map((p) => p.scores)) === scoresBefore, 'Nach der Pause steht der alte Spielstand wieder');
  await playTurn(pages, 300, { wantItems: false });
  check(true, 'Danach geht das Spiel normal weiter');

  // Ein Vermittler fällt aus: Das Spiel läuft über den anderen weiter.
  const upOn = (candidate) => candidate.evaluate(() => window.__kniffel.relays.up);
  check((await upOn(host)) === 2 && (await upOn(anna)) === 2, 'Alle Geräte hängen an beiden Vermittlern');
  await brokers[0].stop();
  for (const candidate of pages) await candidate.waitForFunction(() => window.__kniffel.relays.up === 1, null, { timeout: 20000 });
  await playTurn(pages, 301, { wantItems: false });
  await playTurn(pages, 302, { wantItems: false });
  check((await view(host)).players.every((p) => p.connected), 'Fällt ein Vermittler aus, läuft das Spiel über den anderen weiter');

  // Beide fallen aus: Alle sehen einen Hinweis, danach geht es von selbst weiter.
  await brokers[1].stop();
  for (const candidate of pages) await candidate.waitForSelector('.notice.warn', { timeout: 20000 });
  check((await host.textContent('.notice.warn')).includes('niemand beitreten'), 'Ohne Vermittler sieht der Gastgeber, dass niemand mitspielen kann');
  await shot(host, '14-keine-verbindung');
  brokers[0] = await startBroker(RELAY_PORTS[0]);
  brokers[1] = await startBroker(RELAY_PORTS[1]);
  for (const candidate of pages) await candidate.waitForFunction(() => window.__kniffel.net === 'online', null, { timeout: 40000 });
  await untilView(host, () => window.__kniffel.view.players.every((p) => p.connected));
  await playTurn(pages, 303, { wantItems: false });
  check(true, 'Nach dem Ausfall geht das Spiel von selbst weiter');

  // Falscher Raumcode: Es gibt keinen Gastgeber, und das steht auch da.
  const lost = await device('Falscher Code', PHONE);
  await lost.goto(`${BASE}&r=ZZZZZ`);
  await lost.fill('#f-name', 'Irrläufer');
  await lost.click('[data-form="enter"] button[type="submit"]');
  await lost.waitForFunction(() => window.__kniffel.net === 'host-offline', null, { timeout: 20000 });
  check((await lost.textContent('.panel')).includes('Gastgeber nicht erreichbar'), 'Falscher Raumcode: Hinweis statt endlosem Warten');
  await shot(lost, '15-kein-gastgeber');
  await lost.context().close();

  // Was ein Fremder beim Vermittler mitlesen konnte.
  const leaked = overheard.filter((m) => /Anna|Benjamin|Oma Erna|players|scores/.test(m.text) || m.topic.includes(room) || m.topic.toLowerCase().includes(room.toLowerCase()));
  check(overheard.length > 200 && leaked.length === 0, `Mitgelesen: ${overheard.length} Nachrichten, keine davon lesbar`);
  const stateSizes = overheard.filter((m) => m.topic.endsWith('/g')).map((m) => m.size);
  console.log(`     Spielstand-Nachrichten: ${stateSizes.length}, im Mittel ${Math.round(stateSizes.reduce((a, b) => a + b, 0) / stateSizes.length)} Bytes, größte ${Math.max(...stateSizes)} Bytes`);

  // ---------- Sechs Spieler an einem kleinen Handy ----------
  const small = await device('Sechs an einem Gerät', { width: 360, height: 740 });
  await small.goto(BASE);
  await small.waitForSelector('.hero');
  await small.waitForTimeout(900);
  await shot(small, '01-start');
  await small.fill('#f-name', 'Maximilian');
  await small.click('[data-form="create"] button[type="submit"]');
  await untilView(small, () => window.__kniffel.view && window.__kniffel.view.phase === 'lobby');
  for (const name of ['Zoe', 'Alexandra', 'Tim', 'Charlotte', 'Jo']) {
    await small.fill('[data-form="addlocal"] input', name);
    await small.click('[data-form="addlocal"] button');
    await untilView(small, (n) => window.__kniffel.view.players.some((p) => p.name === n), name);
  }
  check(!(await small.$('[data-form="addlocal"]')), 'Bei sechs Spielern ist der Tisch voll');
  await small.click('[data-act="start"]');
  await untilView(small, () => window.__kniffel.view.phase === 'playing');
  for (let k = 0; k < 14; k += 1) await playTurn([small], 200 + k, { wantItems: k % 3 === 0 });
  await small.click('[data-act="roll"]');
  await untilView(small, () => window.__kniffel.view.turn.rollsUsed === 1);
  await small.evaluate(() => scrollTo(0, 0));
  await small.waitForTimeout(700);
  await shot(small, '12-sechs-oben');
  await small.evaluate(() => document.querySelector('.block').scrollIntoView());
  await small.waitForTimeout(200);
  await shot(small, '13-sechs-block');
  check(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Sechs Spalten passen auf ein 360 Pixel breites Handy');
} catch (err) {
  problems.push(`Abbruch: ${err.stack || err}`);
} finally {
  await browser.close();
  web.close();
  lurker.end(true);
  for (const broker of brokers) await broker.stop().catch(() => {});
}

if (problems.length) {
  console.log(`\n${problems.length} Problem(e):`);
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log('\nAlles in Ordnung.');
process.exit(0);
