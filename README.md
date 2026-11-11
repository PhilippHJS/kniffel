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
- `js/net.js`: Verbindung zwischen den Geräten und Verschlüsselung
- `js/app.js`: Oberfläche und Steuerung
- `css/style.css`: Gestaltung

Die Geräte reden nicht direkt miteinander, sondern über vier öffentliche, kostenlose MQTT-Vermittler (EMQX, Eclipse, HiveMQ, Mosquitto). Jedes Gerät verbindet sich mit allen gleichzeitig, und jede Nachricht geht über alle, die gerade erreichbar sind. Es reicht, wenn einer funktioniert. Im Spiel zeigt der Dialog „Raum“, wie viele gerade erreichbar sind.

Weil diese Dienste öffentlich sind, ist alles Ende-zu-Ende verschlüsselt (AES-GCM). Aus dem Raumcode entstehen der Raumschlüssel und der Name des Kanals. Jeder Mitspieler handelt mit dem Gastgeber zusätzlich einen eigenen Schlüssel aus (ECDH), über den seine Eingaben und seine Items laufen. Die Vermittler sehen die IP-Adressen der Geräte und verschlüsselte Daten, aber keine Namen und keinen Spielstand. Der Spielstand selbst liegt nur im Browser des Gastgebers.

Die Vermittler sind als Testdienste gedacht und kommen ohne Garantie. Ihre Adressen stehen oben in `js/net.js` und lassen sich dort gegen einen eigenen austauschen.

## Entwickeln

```
npm install
npm test            # Regeln und Items
npm run test:e2e    # komplette Partie in mehreren Browsern über lokale Vermittler, braucht Chrome
```

Zum Ausprobieren reicht ein beliebiger statischer Server im Projektordner, zum Beispiel `python3 -m http.server`.

## Fremde Bestandteile

- MQTT.js, MIT-Lizenz (`vendor/`)
- Schriften Barlow Semi Condensed und Kalam, SIL Open Font License (`fonts/`)
