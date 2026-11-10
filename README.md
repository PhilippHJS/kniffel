# Kniffel

Kniffel im Browser für bis zu sechs Spieler, jeder am eigenen Gerät und ohne Anmeldung. Auf Wunsch mit Items, die man für sich oder gegen andere einsetzt.

## So wird gespielt

1. Seite öffnen, Namen eingeben, **Raum erstellen**.
2. Den Einladungslink an alle schicken, die mitspielen sollen.
3. Wenn alle am Tisch sitzen, startet der Gastgeber das Spiel.

Das Gerät des Gastgebers führt den Spielstand. Seine Seite muss offen bleiben, bis das Spiel vorbei ist. Wer neu lädt oder kurz die Verbindung verliert, landet wieder auf seinem Platz. Mehrere Spieler können sich auch ein Gerät teilen.

## Regeln

Gespielt wird der klassische Block: 13 Felder, bis zu drei Würfe pro Zug, 35 Bonuspunkte ab 63 Punkten im oberen Teil. Jeder weitere Kniffel bringt 50 Zusatzpunkte und darf mit dem Höchstwert in ein freies Feld, sofern im Kniffel-Feld schon 50 stehen.

## Items

In der Lobby abschaltbar. Jeder startet mit zwei Items. In Runde 5 und 9 bekommen alle ein weiteres, dazu gibt es eins für jedes gestrichene Feld. Höchstens drei auf der Hand, höchstens eins pro Zug, die Items der anderen sind verdeckt.

| Für dich | Wirkung |
|---|---|
| Zusatzwurf | ein Wurf mehr in diesem Zug |
| Dreher | dreht einen Würfel auf die Gegenseite (1↔6, 2↔5, 3↔4) |
| Wunschwürfel | stellt einen Würfel auf eine Zahl nach Wahl |
| Doppler | der Eintrag zählt doppelt, höchstens +30 |
| Schild | wehrt den nächsten Angriff ab |

| Gegen andere | Wirkung |
|---|---|
| Wurfbremse | das Ziel hat im nächsten Zug einen Wurf weniger |
| Eiswürfel | beim Ziel friert nach dem ersten Wurf ein zufälliger Würfel fest |
| Fluch | der nächste Eintrag des Ziels zählt 10 Punkte weniger |
| Taschendieb | klaut dem Ziel ein zufälliges Item |

Auf jedem Spieler kann nur ein Angriff gleichzeitig liegen.

## Technik

Eine statische Seite ohne Server und ohne Build-Schritt.

- `js/game.js`: Regeln, Wertung und Items, ohne Browser-Abhängigkeiten
- `js/net.js`: Verbindung zwischen den Browsern
- `js/app.js`: Oberfläche und Steuerung
- `css/style.css`: Gestaltung

Die Browser verbinden sich direkt miteinander (WebRTC über [PeerJS](https://peerjs.com)). Für den Verbindungsaufbau nutzt die Seite den öffentlichen, kostenlosen PeerJS-Dienst samt dessen Standard-Servern. Dieser Dienst und die Mitspieler sehen dabei die IP-Adressen der Beteiligten. Der Spielstand selbst liegt nur im Browser des Gastgebers.

## Entwickeln

```
npm install
npm test            # Regeln und Items
npm run test:e2e    # komplette Partie in mehreren Browsern, braucht Chrome
```

Zum Ausprobieren reicht ein beliebiger statischer Server im Projektordner, zum Beispiel `python3 -m http.server`.

## Fremde Bestandteile

- PeerJS, MIT-Lizenz (`vendor/`)
- Schriften Barlow Semi Condensed und Kalam, SIL Open Font License (`fonts/`)
