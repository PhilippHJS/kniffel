// Verbindung zwischen den Browsern (WebRTC über PeerJS).
//
// Der Gastgeber meldet sich mit einer festen Kennung an, die sich aus dem
// Raumcode ergibt. Alle anderen verbinden sich direkt mit ihm. Beide Seiten
// prüfen in einem festen Takt, ob die Verbindung noch steht, und bauen sie
// sonst von selbst wieder auf.

const ID_PREFIX = 'kniffel-raum-';
const TICK_MS = 2000;
const SILENCE_MS = 12000;
const CONNECT_PATIENCE_MS = 9000;

export function hostPeerId(room) {
  return `${ID_PREFIX}${String(room).toLowerCase()}`;
}

function makePeer(id, options) {
  const Peer = globalThis.Peer;
  if (!Peer) throw new Error('PeerJS fehlt');
  return id ? new Peer(id, options) : new Peer(options);
}

function quiet(fn) {
  try {
    fn();
  } catch {
    // Verbindung war schon zu.
  }
}

// ---------- Gastgeber ----------

export function createHost({ room, options = {}, onOpen, onMessage, onClose, onStatus }) {
  let peer = null;
  let stopped = false;
  let status = '';
  let idClashes = 0;
  const conns = new Map(); // Verbindung -> Zeitpunkt des letzten Lebenszeichens

  function setStatus(next) {
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  function drop(conn) {
    if (!conns.delete(conn)) return;
    quiet(() => conn.close());
    onClose(conn);
  }

  function wire(conn) {
    conn.on('open', () => {
      if (stopped) return;
      conns.set(conn, Date.now());
      onOpen(conn);
    });
    conn.on('data', (data) => {
      if (!conns.has(conn)) return;
      conns.set(conn, Date.now());
      onMessage(conn, data);
    });
    conn.on('close', () => drop(conn));
    conn.on('error', () => drop(conn));
  }

  function open() {
    let mine;
    try {
      mine = makePeer(hostPeerId(room), options);
    } catch {
      setStatus('unsupported');
      return;
    }
    peer = mine;
    mine.on('open', () => {
      if (mine !== peer) return;
      idClashes = 0;
      setStatus('online');
    });
    mine.on('connection', (conn) => {
      if (mine === peer) wire(conn);
    });
    mine.on('disconnected', () => {
      if (mine === peer && !stopped) setStatus('reconnecting');
    });
    mine.on('error', (err) => {
      if (mine !== peer || stopped) return;
      if (err.type === 'unavailable-id') {
        // Direkt nach dem Neuladen ist die Kennung oft noch ein paar Sekunden belegt.
        idClashes += 1;
        setStatus(idClashes >= 5 ? 'taken' : 'connecting');
      } else if (err.type === 'browser-incompatible') {
        setStatus('unsupported');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setStatus('reconnecting');
      }
    });
  }

  function tick() {
    if (stopped || status === 'unsupported') return;
    const now = Date.now();
    for (const [conn, seen] of conns) {
      if (now - seen > SILENCE_MS + 4000) drop(conn);
    }
    if (!peer || peer.destroyed) {
      open();
      return;
    }
    if (peer.disconnected) {
      quiet(() => peer.reconnect());
    } else if (peer.open) {
      setStatus('online');
    }
  }

  setStatus('connecting');
  open();
  const timer = setInterval(tick, TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    send(conn, message) {
      if (conn.open) quiet(() => conn.send(message));
    },
    close(conn) {
      drop(conn);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      for (const conn of [...conns.keys()]) quiet(() => conn.close());
      conns.clear();
      if (peer) quiet(() => peer.destroy());
    },
  };
}

// ---------- Mitspieler ----------

export function createClient({ room, options = {}, onReady, onMessage, onStatus }) {
  let peer = null;
  let conn = null;
  let stopped = false;
  let status = '';
  let lastHeard = 0;
  let connectStarted = 0;
  let retryAfter = 0;
  let failedTries = 0;

  function setStatus(next) {
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  function connect() {
    connectStarted = Date.now();
    const mine = peer.connect(hostPeerId(room), { reliable: true, serialization: 'json' });
    conn = mine;
    mine.on('open', () => {
      if (mine !== conn || stopped) return;
      lastHeard = Date.now();
      failedTries = 0;
      setStatus('online');
      onReady();
    });
    mine.on('data', (data) => {
      if (mine !== conn || stopped) return;
      lastHeard = Date.now();
      if (data && data.t === 'pong') return;
      onMessage(data);
    });
    const lost = () => {
      if (mine !== conn) return;
      conn = null;
      if (!stopped && status === 'online') setStatus('reconnecting');
    };
    mine.on('close', lost);
    mine.on('error', lost);
  }

  function open() {
    let mine;
    try {
      mine = makePeer(null, options);
    } catch {
      setStatus('unsupported');
      return;
    }
    peer = mine;
    mine.on('open', () => {
      // Auch nach einer erneuten Anmeldung beim Vermittlungsdienst: nur neu
      // verbinden, wenn die Verbindung zum Gastgeber wirklich fehlt.
      if (mine === peer && !stopped) tick();
    });
    mine.on('error', (err) => {
      if (mine !== peer || stopped) return;
      if (err.type === 'peer-unavailable') {
        // Der Gastgeber ist beim Vermittlungsdienst gerade nicht angemeldet.
        if (conn && !conn.open) giveUpOn(conn);
        retryAfter = Date.now() + 3000;
        setStatus('host-offline');
      } else if (err.type === 'browser-incompatible') {
        setStatus('unsupported');
      }
    });
  }

  function giveUpOn(current) {
    quiet(() => current.close());
    if (conn === current) conn = null;
  }

  function tick() {
    if (stopped || status === 'unsupported') return;
    const now = Date.now();
    if (!peer || peer.destroyed) {
      open();
      return;
    }
    if (peer.disconnected) {
      quiet(() => peer.reconnect());
      return;
    }
    if (!peer.open) return;

    if (conn && conn.open) {
      if (now - lastHeard > SILENCE_MS) {
        giveUpOn(conn);
        setStatus('reconnecting');
      } else {
        quiet(() => conn.send({ t: 'ping' }));
      }
      return;
    }
    if (conn && now - connectStarted < CONNECT_PATIENCE_MS) return;
    if (now < retryAfter) return;

    if (conn) {
      // Der Verbindungsaufbau hängt, zum Beispiel hinter einer strengen Firewall.
      giveUpOn(conn);
      failedTries += 1;
      if (failedTries >= 2) setStatus('stuck');
      if (failedTries % 3 === 0) {
        quiet(() => peer.destroy());
        peer = null;
        return;
      }
    }
    connect();
  }

  setStatus('connecting');
  open();
  const timer = setInterval(tick, TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    send(message) {
      if (conn && conn.open) {
        quiet(() => conn.send(message));
        return true;
      }
      return false;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (conn) quiet(() => conn.close());
      if (peer) quiet(() => peer.destroy());
    },
  };
}
