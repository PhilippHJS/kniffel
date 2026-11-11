// Verbindung zwischen den Geräten.
//
// Die Geräte reden nicht direkt miteinander, sondern über öffentliche
// Vermittlungsdienste (MQTT-Broker). Jedes Gerät verbindet sich mit allen
// Diensten gleichzeitig, jede Nachricht geht über alle, die gerade erreichbar
// sind. Fällt einer aus, merkt das Spiel davon nichts.
//
// Die Dienste sind öffentlich, deshalb ist alles Ende-zu-Ende verschlüsselt:
//   - Aus dem Raumcode entstehen ein Raumschlüssel und der Name des Kanals.
//     Wer den Code nicht kennt, findet den Raum nicht und kann nichts lesen.
//   - Jeder Mitspieler handelt mit dem Gastgeber zusätzlich einen eigenen
//     Schlüssel aus (ECDH). Darüber laufen seine Eingaben und das, was nur er
//     sehen darf (seine Items). Mitspieler können sich so nicht füreinander
//     ausgeben.

export const DEFAULT_RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const TICK_MS = 2000;
const PING_MS = 5000;
const ALIVE_MS = 15000; // so lange gilt die Gegenseite ohne Lebenszeichen noch als verbunden
const PATIENCE_MS = 10000; // so lange warten wir beim ersten Verbindungsaufbau
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const PUB_BYTES = 65;

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const random = (count) => crypto.getRandomValues(new Uint8Array(count));

export function supported() {
  return Boolean(globalThis.mqtt && globalThis.crypto && crypto.subtle && typeof WebSocket === 'function');
}

// ---------- Verschlüsselung ----------

async function roomSecrets(room) {
  const base = await crypto.subtle.importKey('raw', enc.encode(`kniffel:${room}`), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('kniffel-raum-v1'), iterations: 150000 },
    base,
    74 * 8,
  ));
  return {
    key: await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']),
    mix: bits.slice(32, 64),
    topic: `kniffel1/${toHex(bits.slice(64, 74))}`,
  };
}

async function fingerprint(pub) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', pub))).slice(0, 24);
}

// Schlüsselpaar eines Geräts. `saved` ist die gespeicherte Form vom letzten Besuch.
async function makeIdentity(saved) {
  let me = null;
  if (saved && saved.priv && typeof saved.pub === 'string') {
    try {
      me = {
        priv: await crypto.subtle.importKey('jwk', saved.priv, EC, false, ['deriveBits']),
        pub: fromB64(saved.pub),
        saved,
      };
    } catch {
      me = null;
    }
  }
  if (!me) {
    const keys = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    me = {
      priv: keys.privateKey,
      pub,
      saved: { priv: await crypto.subtle.exportKey('jwk', keys.privateKey), pub: toB64(pub) },
      fresh: true,
    };
  }
  me.id = await fingerprint(me.pub);
  return me;
}

async function pairKey(myPriv, theirPub, mix) {
  const pub = await crypto.subtle.importKey('raw', theirPub, EC, false, []);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, myPriv, 256));
  const raw = await crypto.subtle.digest('SHA-256', concat(bits, mix));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// `label` bindet die Nachricht an ihren Kanal, damit sie woanders nicht gilt.
// Der Inhalt wird sofort beim Aufruf eingefroren, verschlüsselt wird danach.
async function seal(key, label, value) {
  const iv = random(12);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(label) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return concat(iv, new Uint8Array(data));
}

async function unseal(key, label, bytes) {
  if (bytes.length < 12 + 16 + 2) return null;
  try {
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(label) },
      key,
      bytes.subarray(12),
    );
    const value = JSON.parse(dec.decode(data));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// ---------- Vermittler ----------

function checksum(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Hält die Verbindung zu allen Vermittlern. Dieselbe Nachricht kommt über
// mehrere Wege an und wird hier nur einmal weitergereicht.
function createRelay({ urls, topics, onMessage, onChange }) {
  const seen = new Map();
  const clients = urls.map((url) => {
    const client = globalThis.mqtt.connect(url, {
      clientId: `kn${toHex(random(8))}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      queueQoSZero: false,
      resubscribe: false,
    });
    client.on('connect', () => {
      client.subscribe(topics, { qos: 0 });
      onChange();
    });
    client.on('close', onChange);
    client.on('error', () => {});
    client.on('message', (topic, payload) => {
      const bytes = new Uint8Array(payload);
      const key = `${topic}|${bytes.length}|${checksum(bytes)}`;
      if (seen.has(key)) return;
      const now = Date.now();
      seen.set(key, now);
      if (seen.size > 600) {
        for (const [old, at] of seen) {
          if (now - at < 30000 && seen.size <= 300) break;
          seen.delete(old);
        }
      }
      onMessage(topic, bytes);
    });
    return client;
  });
  return {
    total: urls.length,
    up: () => clients.filter((client) => client.connected).length,
    publish(topic, bytes) {
      for (const client of clients) {
        if (client.connected) client.publish(topic, bytes, { qos: 0 });
      }
    },
    stop() {
      for (const client of clients) {
        try {
          client.end(true);
        } catch {
          // war schon zu
        }
      }
    },
  };
}

// Gemeinsames Gerüst: Start, Takt und Status für Gastgeber und Mitspieler.
function createLink({ room, urls, topicsFor, setup, onPacket, onTick, statusOf, onStatus }) {
  const link = { relay: null, secrets: null, stopped: false, everUp: false, upSince: 0, started: Date.now() };
  let incoming = Promise.resolve();
  let outgoing = Promise.resolve();
  let reported = '';
  let failed = !supported();

  function report() {
    if (link.stopped) return;
    const up = link.relay ? link.relay.up() : 0;
    const total = link.relay ? link.relay.total : urls.length;
    let status;
    if (failed) status = 'unsupported';
    else if (up === 0) status = link.everUp ? 'reconnecting' : Date.now() - link.started > PATIENCE_MS ? 'stuck' : 'connecting';
    else status = statusOf();
    const text = `${status}|${up}|${total}`;
    if (text === reported) return;
    reported = text;
    onStatus(status, { up, total });
  }

  // Nachrichten werden nacheinander verschickt, in der Reihenfolge der Aufrufe.
  link.post = (topic, pending) => {
    outgoing = outgoing.then(async () => {
      const bytes = await pending;
      if (!link.stopped && link.relay) link.relay.publish(topic, bytes);
    }).catch(() => {});
  };

  function tick() {
    if (link.stopped || !link.relay) return;
    onTick(Date.now());
    report();
  }
  link.report = report;

  let timer = null;
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };

  (async () => {
    if (failed) return;
    link.secrets = await roomSecrets(room);
    await setup(link);
    if (link.stopped) return;
    link.relay = createRelay({
      urls,
      topics: topicsFor(link),
      onMessage(topic, bytes) {
        incoming = incoming.then(() => onPacket(topic.slice(link.secrets.topic.length + 1), bytes)).catch(() => {});
      },
      onChange() {
        const up = link.relay ? link.relay.up() : 0;
        if (up > 0 && !link.upSince) link.upSince = Date.now();
        if (up > 0) link.everUp = true;
        if (up === 0) link.upSince = 0;
        tick();
      },
    });
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', onVisible);
  })().catch(() => {
    failed = true;
  }).finally(report);

  link.stop = () => {
    link.stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    if (link.relay) link.relay.stop();
  };
  report();
  return link;
}

// ---------- Gastgeber ----------

export function createHost({ room, urls = DEFAULT_RELAYS, onStatus, onHello, onMessage, onStale, onPresence }) {
  const guests = new Map(); // Kennung -> { key, sid, lastN, seen, nagged }
  let me = null;
  let version = 0;
  let lastCast = 0;
  let lastBeacon = 0;
  let beaconTimer = null;
  let presence = '';
  let wasUp = false;

  const ownerOf = (id) => `g:${id}`;
  const idOf = (owner) => String(owner).slice(2);
  const alive = (guest) => Boolean(guest && guest.sid && Date.now() - guest.seen < ALIVE_MS);
  const presenceNow = () => [...guests].filter(([, guest]) => alive(guest)).map(([id]) => id).sort().join(',');

  function beacon() {
    if (!me || !link.relay || link.relay.up() === 0) return;
    lastBeacon = Date.now();
    link.post(`${link.secrets.topic}/b`, seal(link.secrets.key, 'b', { p: me.saved.pub, at: lastBeacon, v: version }));
  }

  function beaconSoon() {
    if (Date.now() - lastBeacon > 700) beacon();
    else if (!beaconTimer) {
      beaconTimer = setTimeout(() => {
        beaconTimer = null;
        beacon();
      }, 700);
    }
  }

  function tell(id, guest, msg) {
    link.post(`${link.secrets.topic}/s/${id}`, seal(guest.key, `s/${id}`, msg));
  }

  function accept(id, guest, body) {
    const msg = body.m;
    if (!Number.isFinite(body.n) || body.n <= guest.lastN) return;
    if (typeof body.sid !== 'string' || !msg || typeof msg !== 'object') return;
    guest.lastN = body.n;
    const now = Date.now();

    if (msg.t === 'hello') {
      // Derselbe Mitspieler in einem zweiten Tab: Der neue Tab übernimmt.
      if (guest.sid && guest.sid !== body.sid) tell(id, guest, { t: 'bye', sid: guest.sid });
      guest.sid = body.sid;
      guest.seen = now;
      presence = presenceNow();
      onHello(ownerOf(id), msg);
      return;
    }
    if (guest.sid !== body.sid) {
      // Unbekannte Sitzung: entweder ein abgelöster Tab oder wir kennen ihn noch nicht.
      if (now - (guest.nagged || 0) > 2000) {
        guest.nagged = now;
        tell(id, guest, guest.sid ? { t: 'bye', sid: body.sid } : { t: 'who' });
      }
      return;
    }
    guest.seen = now;
    if (msg.t === 'ping') {
      tell(id, guest, { t: 'pong', v: version });
      if (msg.have !== version && now - lastCast > 2500) onStale();
    } else if (msg.t === 'sync') {
      onStale();
    } else {
      onMessage(ownerOf(id), msg);
    }
  }

  async function onPacket(channel, bytes) {
    if (channel === 'q') {
      beaconSoon();
      return;
    }
    if (!channel.startsWith('c/') || bytes.length <= PUB_BYTES) return;
    const id = channel.slice(2);
    let guest = guests.get(id);
    if (!guest) {
      if (guests.size >= 80) return;
      const pub = bytes.slice(0, PUB_BYTES);
      if ((await fingerprint(pub)) !== id) return;
      let key;
      try {
        key = await pairKey(me.priv, pub, link.secrets.mix);
      } catch {
        return;
      }
      const first = await unseal(key, channel, bytes.subarray(PUB_BYTES));
      if (!first) return;
      guest = { key, sid: null, lastN: 0, seen: 0, nagged: 0 };
      guests.set(id, guest);
      accept(id, guest, first);
      return;
    }
    const body = await unseal(guest.key, channel, bytes.subarray(PUB_BYTES));
    if (body) accept(id, guest, body);
  }

  const link = createLink({
    room,
    urls,
    onStatus,
    async setup() {
      me = await makeIdentity(null);
    },
    topicsFor: (self) => [`${self.secrets.topic}/q`, `${self.secrets.topic}/c/+`],
    onPacket,
    statusOf: () => 'online',
    onTick(now) {
      const up = link.relay.up() > 0;
      if ((up && !wasUp) || now - lastBeacon > 8000) beacon();
      wasUp = up;
      const current = presenceNow();
      if (current !== presence) {
        presence = current;
        onPresence();
      }
    },
  });

  return {
    isOnline: (owner) => alive(guests.get(idOf(owner))),
    // Schickt allen den Spielstand: `shared` an den ganzen Raum, dazu jedem
    // Mitspieler einzeln das, was nur er sehen darf.
    broadcast(shared, privateFor) {
      if (!me || !link.relay) return;
      version += 1;
      lastCast = Date.now();
      link.post(`${link.secrets.topic}/g`, seal(link.secrets.key, 'g', { h: me.id, v: version, s: shared }));
      for (const [id, guest] of guests) {
        if (!guest.sid || lastCast - guest.seen > 90000) continue;
        tell(id, guest, { t: 'you', v: version, ...privateFor(ownerOf(id)) });
      }
    },
    sendTo(owner, msg) {
      const id = idOf(owner);
      const guest = guests.get(id);
      if (guest && link.relay) tell(id, guest, msg);
    },
    stop: () => link.stop(),
  };
}

// ---------- Mitspieler ----------

export function createGuest({ room, urls = DEFAULT_RELAYS, name, saved, onIdentity, onStatus, onView, onError, onReplaced }) {
  const sid = toHex(random(8));
  let me = null;
  let host = null; // { id, pub, key }
  let newestBeacon = 0;
  let heardHost = 0;
  let shared = null;
  let sharedV = 0;
  let mine = null;
  let mineV = 0;
  let shownV = 0;
  let hostV = 0;
  let everShown = false;
  let lastN = 0;
  let lastAsk = 0;
  let lastPing = 0;
  let lastHello = 0;
  let lastSync = 0;
  let behindSince = 0;

  function send(msg) {
    if (!host || !link.relay || link.relay.up() === 0) return false;
    lastN = Math.max(Date.now(), lastN + 1);
    const channel = `c/${me.id}`;
    const sealed = seal(host.key, channel, { n: lastN, sid, m: msg });
    link.post(`${link.secrets.topic}/${channel}`, sealed.then((bytes) => concat(me.pub, bytes)));
    return true;
  }

  function hello() {
    lastHello = Date.now();
    send({ t: 'hello', name });
  }

  function show() {
    if (!shared || !mine || sharedV !== mineV || sharedV === shownV) return;
    shownV = sharedV;
    everShown = true;
    const view = shared;
    const ids = Array.isArray(mine.mine) ? mine.mine : [];
    for (const player of view.players) {
      player.mine = ids.includes(player.id);
      player.items = player.mine ? (mine.items && mine.items[player.id]) || [] : null;
    }
    onView(view);
  }

  async function onPacket(channel, bytes) {
    if (channel === 'b') {
      const info = await unseal(link.secrets.key, 'b', bytes);
      if (!info || typeof info.p !== 'string' || !Number.isFinite(info.at) || info.at < newestBeacon) return;
      newestBeacon = info.at;
      heardHost = Date.now();
      if (!host || host.pub !== info.p) {
        // Neuer Gastgeber-Schlüssel: Er hat die Seite neu geladen (oder wir sind neu hier).
        const pub = fromB64(info.p);
        host = { id: await fingerprint(pub), pub: info.p, key: await pairKey(me.priv, pub, link.secrets.mix) };
        shared = null;
        mine = null;
        sharedV = 0;
        mineV = 0;
        shownV = 0;
        hostV = 0;
        hello();
      }
      hostV = Math.max(hostV, Number(info.v) || 0);
      link.report();
      return;
    }
    if (!host) return;
    if (channel === 'g') {
      const state = await unseal(link.secrets.key, 'g', bytes);
      if (!state || state.h !== host.id || !(state.v > sharedV) || !state.s || !Array.isArray(state.s.players)) return;
      shared = state.s;
      sharedV = state.v;
      heardHost = Date.now();
      show();
      return;
    }
    if (channel !== `s/${me.id}`) return;
    const msg = await unseal(host.key, channel, bytes);
    if (!msg) return;
    heardHost = Date.now();
    if (msg.t === 'you') {
      if (msg.v > mineV) {
        mine = msg;
        mineV = msg.v;
        show();
      }
    } else if (msg.t === 'pong') {
      hostV = Math.max(hostV, Number(msg.v) || 0);
    } else if (msg.t === 'who') {
      if (Date.now() - lastHello > 1500) hello();
    } else if (msg.t === 'err') {
      onError(String(msg.text));
    } else if (msg.t === 'bye' && msg.sid === sid) {
      link.stop();
      onReplaced();
    }
    link.report();
  }

  const link = createLink({
    room,
    urls,
    onStatus,
    async setup() {
      me = await makeIdentity(saved);
      if (me.fresh) onIdentity(me.saved);
    },
    topicsFor: (self) => [`${self.secrets.topic}/b`, `${self.secrets.topic}/g`, `${self.secrets.topic}/s/${me.id}`],
    onPacket,
    statusOf() {
      const now = Date.now();
      if (!host) return now - link.upSince > 7000 ? 'host-offline' : 'connecting';
      if (now - heardHost > ALIVE_MS) return 'host-offline';
      return everShown ? 'online' : 'connecting';
    },
    onTick(now) {
      if (link.relay.up() === 0) return;
      // Gastgeber unbekannt oder verstummt: nachfragen, wer den Raum gerade führt.
      if ((!host || now - heardHost > 6000) && now - lastAsk > 2500) {
        lastAsk = now;
        link.post(`${link.secrets.topic}/q`, Promise.resolve(random(8)));
      }
      if (!host) return;
      if (!mine && now - lastHello > 3000) hello();
      if (now - lastPing > PING_MS) {
        lastPing = now;
        send({ t: 'ping', have: shownV });
      }
      // Wir wissen von einem neueren Stand, haben ihn aber nicht vollständig bekommen.
      const behind = Math.max(sharedV, mineV, hostV) > shownV;
      if (!behind) behindSince = 0;
      else if (!behindSince) behindSince = now;
      else if (now - behindSince > 1500 && now - lastSync > 3000) {
        lastSync = now;
        send({ t: 'sync' });
      }
    },
  });

  return { send, stop: () => link.stop() };
}
