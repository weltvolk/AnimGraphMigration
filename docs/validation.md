# Validierung und Aussagegrenzen

Eine erfolgreiche Vorbereitung bestätigt die unterstützte Dateiabbildung und ihre Integrität. Beim Blackbird-Profil folgt die gesonderte Prüfung tatsächlich nativ importierter ANMs. Sichtbare Vorschau und Spielverhalten benötigen anschließend eigene Tests. Keine dieser Ebenen wird durch eine erfolgreiche Prüfung der vorherigen Ebene ersetzt.

## Automatisierte Werkzeugtests

Die öffentliche Testsuite verwendet ausschließlich synthetische Eingaben. Sie ist ohne DayZ-Installation lauffähig:

```powershell
npm test
```

Die Prüfziele sind:

| Bereich | Zu prüfende Eigenschaft |
|---|---|
| Parser | Struktur, Tokens und unterstützte Felder werden vollständig gelesen; fehlerhafte oder unbekannte Eingaben scheitern sichtbar. |
| Graph | State- und Transition-Anzahl, Node-Verweise, Bedingungen und unterstützte Werte bleiben erhalten. |
| Template und Instanz | Jeder übertragene Slot und jede Clipzuweisung bleibt nachvollziehbar; qualifizierte Namen passen zusammen. |
| Ressourcen | Erzeugte Referenzen stimmen in Pfad und Identität mit ihren Zielen überein. |
| Dateischutz | Quelle bleibt unverändert; bestehende Ausgabe, überlappende Pfade und unsichere Linkpfade werden abgelehnt. |
| Reproduzierbarkeit | Derselbe Eingabebestand erzeugt dieselben Ressourcenidentitäten. |
| Fehlerfälle | Nicht unterstützte Konstrukte führen zu Fehlern statt zu einer unvollständigen Erfolgsausgabe. |
| Profilbindung | Nur die fest gebundenen Originalbelegungen und Digests werden akzeptiert; unbekannte oder bereits transformierte Clips scheitern. |
| TXA-Korrektur | Achsenabbildung, Root-/Pelvis-Pose, inklusive Framebereiche, ursprüngliche FPS und Byteerhalt der übrigen Inhalte werden geprüft. |
| Wiederherstellung | Original-TXA wird aus der Vorbereitung mit Prüfung beider Digests, exakter Zeilen und einer erneuten Vorwärtsrechnung rekonstruiert. |
| Native ANMs | Begrenzter SET6-Leser, gebundene Kontrollen, Bone-/Frame-/Quantisierungsprüfung und definierte Kurvenvergleiche; beschädigte oder unbekannte Konstrukte werden abgelehnt. |
| Importablauf | Vorbereitung, bearbeitbare Importkopie und finale Ausgabe bleiben getrennt; Prüfungen werden bei Finalisierung wiederholt. |
| GUI-/CLI-Schnittstelle | Optionale Profile ändern den Standardaufruf nicht. Import-Pflichtfelder, lokale Zugriffsbeschränkungen und abgelehnte Kontroll-/Force-Felder werden geprüft. |

Der GitHub-CI-Workflow ist für Windows und Linux eingerichtet; ein tatsächlicher GitHub-Lauf ist noch nicht bestätigt. Betriebssystemtests ersetzen keine Workbench-Prüfung. Ein Testziel in dieser Tabelle ist erst durch den zugehörigen bestandenen Test belegt; es ist keine Zusage für beliebige ungetestete Eingaben.

## Herkunft der Formatkenntnis

Vor Entwicklung dieses eigenständigen Werkzeugs wurde ein reales Modprojekt ausschließlich in Kopien mit der Workbench **1.30.164014.27** untersucht. Der native Legacy-Lader konnte dessen Graph nach Ergänzung fehlender Editor-Layoutdaten öffnen und ins neue Format speichern. Ein Vergleich bestätigte den Erhalt von **5 State Machines, 46 States, 136 Transitions, 41 Sources und 2 Switches** sowie weiterer geprüfter Felder. Das ist ein Nachweis für diesen untersuchten Dateisatz und diesen Editorbuild.

Die erste native Speicherung entfernte ungültige flache ASI-Einträge. Eine gezielte Korrektur benannter Gruppen/Spalten und konsistenter Referenzen erhielt anschließend **37 Clipzuweisungen**. Nach einem gesonderten Ressourcenidentitätsabgleich konnte der korrigierte Dateisatz erneut geöffnet und gespeichert werden.

Ein kleines Beispiel mit zwei Zuständen, einem Übergang und Bind Pose wurde im Editor gespeichert und nach Neustart erneut geöffnet. Beim Anlegen eines neuen Sheets stürzte der Editor zuvor zweimal ab; deshalb war allein das leere Sheet-Gerüst außerhalb des Editors ergänzt worden. Diese Herkunft darf nicht als vollständig automatischer Editor-Erstellungsdurchlauf dargestellt werden.

Die untersuchten Originalmoddateien, Editorartefakte, Protokolle und Screenshots gehören nicht zum öffentlichen Repository. Sie sind keine frei lizenzierten Fixtures. Die oben genannten Beobachtungen begründen die Formatentscheidungen, garantieren aber weder den neuen Direktkonverter noch andere Editorbuilds.

Der neue direkte Graphkonverter wurde anschließend separat gegen die vorhandene native Editorausgabe verglichen: **5.213 verglichene Skalarwerte ohne Abweichung** nach den ausdrücklich angewandten Normalisierungen für Objektidentitäten, numerische Layoutformatierung und Wahrscheinlichkeitslisten. Dazu kommen ein eigener Vergleich der 37 Template-Slots und der 37 Clipzuweisungen. Die privaten Eingabedateien wurden dabei nur gelesen und nicht in dieses Repository übernommen. Dieser Feldvergleich bestätigt die geprüfte Dateiabbildung; er beweist keine korrekte Root Motion oder fehlerfreies Verhalten im Spiel.

## Eigene Editorprüfung

1. Quelle zusätzlich sichern und Prüfsummen erfassen. In einen neuen Ausgabeordner konvertieren; das Assetprofil nur ausdrücklich für seinen passenden Originalbestand wählen.
2. Den neuen Dateisatz mit `verify` prüfen und das Ergebnis sichern.
3. Nur eine getrennte Prüf- beziehungsweise Importkopie in der Workbench mounten. Dazu passende Experimental-Spieldaten verwenden; ursprüngliche und migrierte Ressourcen nicht gleichzeitig laden. Manifestierte Vorbereitungsordner bleiben unverändert.
4. Die ausgegebene Workspace-Datei und den Graph öffnen. Exakte Meldungen, Editorbuild und beobachtetes Verhalten dokumentieren.
5. State Machines, States, Transitions, Bedingungen, Switch-Werte und Animation-Slots gegen die Quelle vergleichen.
6. Vor und nach dem nativen Speichern Clipzuweisungen und Ressourcenidentitäten vergleichen. Den gespeicherten Stand nach einem Editorneustart erneut öffnen.
7. Preview Model, Skeleton, Bone-Namen und sichtbare Clipwiedergabe prüfen. Eine laufende Timeline allein belegt keine sichtbare Modellanimation.
8. Beim Blackbird-Profil den ausgewiesenen Batch aus zwölf Kandidaten und zwölf Kontrollen nativ importieren, `verify-import` durchführen und mit `finalize-import` eine neue geprüfte Ausgabe erstellen. Die zugehörigen Pflichtparameter und Ordnerregeln stehen in [Blackbird-Profil](blackbird-profile.md).
9. Erst danach einen isolierten Spieltest mit den tatsächlich genutzten Übergängen, Root Motion, Skalierung und Bone-Abfragen durchführen. Client und Server müssen nachweislich dasselbe finalisierte Paket laden.

Die separate Anwendung **DayZ Experimental Tools** ist in den offiziellen [DayZ-1.25-Änderungen](https://forums.dayz.com/topic/259585-experimental-update-125-change-log/) dokumentiert. Der offizielle [DayZ-1.27-Changelog](https://forums.dayz.com/topic/265911-stable-update-127/?page=0) weist auf die benötigte Übereinstimmung von Workbench und Spielversion hin. Die konkreten Zielformatentscheidungen dieses Werkzeugs beruhen auf den beschriebenen lokalen 1.30-Artefakten.

## Bewegungsbasis und native Clipprüfung

Die erste reine Graphkonvertierung wurde unter echtem DayZ Experimental Server und Client **1.30.164014.27** wiedergegeben. Stand, Beinbewegungen, Flügelschlag und Torpedopose waren sichtbar, doch die unveränderten alten Animationsassets übertrugen Gehbewegung mit etwa **0,4 m/s nach oben**. Nach Nutzerangabe besitzt die ursprüngliche 1.29-Version sauberen Bodenkontakt. Ein strukturell gültiger Graph genügte hier also nicht zur Migration.

Ein abgeglichener Skeleton-Registryname beseitigte die `SkeletonRemap`-Fehlermeldung. Einfache Änderungen an Root-Attributen und ein bloßer nativer Neuimport der unveränderten TXA behoben den Höhenanstieg nicht. Daraus wurde keine pauschale Skeleton- oder Modelländerung abgeleitet.

Die anschließende gezielte Root-/Pelvis-Korrektur wurde zunächst privat untersucht und danach auf alle zwölf aktiven Clips mit bewegtem Root angewendet. Die korrigierten Quellen und unveränderten Originalkontrollen wurden tatsächlich im 1.30-Editor importiert. Die native Prüfung bestätigt:

- Vor der Toleranzberechnung müssen `minT` und `rangeT` der Root-/Pelvis-Kandidaten exakt den aus den gebundenen korrigierten TXA-Werten abgeleiteten Float32-Minima und -Spannweiten entsprechen. Die Kandidatendatei kann die zulässige Abweichung daher nicht durch eine frei gewählte Range vergrößern.
- Kandidat und Kontrolle haben identische Root-Keyzeiten. Die Kandidatenkurve entspricht der umgerechneten nativen Kontrollkurve innerhalb `2 × (sourceRangeCandidate + abs(rangeControl)) / 65535 + 0,000001`; die Kandidatenspannweite stammt aus der genannten Quellprüfung.
- Die Kandidaten-Pelviskurve entspricht den korrigierten Quellwerten innerhalb ihrer festgelegten Quantisierungsgrenze.
- Die 62 übrigen Bone-Records sind je Kandidat/Kontrolle in Header und Daten bytegleich. Root-/Pelvis-Rotation und -Skalierung einschließlich Quantisierungsheadern und Keyzahlen bleiben gegenüber der Kontrolle gleich.
- Neun Kontrollimporte unterscheiden sich durch native Optimierung von den ausgelieferten ANMs. Der Vergleich belegt daher keine unveränderten Bone-Bytes gegenüber der alten Auslieferung und keine exakte Erhaltung jedes ursprünglichen Zwischenkeys.

Die feste Kontrollreferenz des Produktes ist an **Workbench 1.30.164014.27**, Original-ANM- und Original-TXA-Digests gebunden. Eine Kontrollkurve darf nicht erst aus einer ungeprüften vom Nutzer gelieferten Datei als vertrauenswürdig deklariert werden. Andere Kontroll-Digests werden abgelehnt. Der begrenzte Vergleich bestätigt Quellenbezug und definierte Kurveneigenschaften; er bescheinigt weder einen ausgeführten Editorprozess noch sichtbare Wiedergabe.

## Vorangegangene private Sichttests

Frühe Flugvergleiche zeigten, dass dauerhaft erzwungene Testeingaben zusammen mit der ursprünglichen Bewegungssteuerung Client-Rücksprünge erzeugen konnten. Ein Lauf mit unterschiedlichen tatsächlich geladenen Probeversionen auf Client und Server wurde ausdrücklich verworfen. Diese Ergebnisse werden nicht als allgemeiner Fehler der ursprünglichen Modsteuerung behandelt.

Spätere gültige Vergleiche verwendeten denselben vollständigen Satz aus zwölf korrigierten Assets auf beiden Seiten und die ursprüngliche Steuerung ohne dauernde Testeingriffe. Beobachtet wurden kurze Flüge, Landungen und Bodenphasen. Für den Boden lautete die Nutzerbewertung **„boden super“**. Das ist eine positive Sichtbewertung dieses Teststandes.

Das danach verbliebene schnelle horizontale Zittern wurde mit verschiedenen Aktualisierungszeitpunkten der nachgeführten Diagnosekamera verglichen. Die Aktualisierung nach der Frameverarbeitung (`EOnPostFrame`) beseitigte es im jüngsten privaten Kontrolllauf, während alle zwölf Animationsassets unverändert blieben. Die Nutzerbewertung lautet **„das zittern ist weg, selten kamen ruckler, insgesamt super“**. Seltene Ruckler bleiben damit Teil der Beobachtung. Das Ergebnis beschreibt den getesteten Kameraaufbau; der Konverter erzeugt keine Änderung an Produktionskamera oder Modskripten.

Die begrenzte TXA-Korrektur, Originalbindung und getrennten Importbefehle sind inzwischen im Werkzeug implementiert. Ein eigener lesender Vergleich bestätigt, dass alle zwölf vom Produkt erzeugten TXAs **bytegenau** den eingefrorenen privaten Kandidaten entsprechen. Die synthetischen Werkzeugtests bleiben von diesen privaten Eingaben getrennt; reale Moddateien, Aufnahmen und Logs gehören nicht zum öffentlichen Repository.

## Durchgeführter Produktablauf

Die vollständige neue Pipeline `convert → prepare-import → Editorimport → verify-import → finalize-import` wurde anschließend tatsächlich mit getrennten Vorbereitungs-, Import- und finalen Ausgabeordnern durchlaufen. In Workbench **1.30.164014.27** wurde aus einem leeren Animation Editor **Tools → Rebuild Animations** verwendet und ausschließlich `AGMNativeImport` ausgewählt: zwölf Kandidaten und zwölf unveränderte Originalkontrollen, insgesamt 24 TXA-Quellen.

Alle zwölf Kandidaten bestanden die gebundene native Prüfung. Das Ergebnis meldet `nativeImportValidated: true` und `nativeImportRequired: false`. Nach erneuter Prüfung wurden die zwölf ANMs in eine neue finale Ausgabe übernommen; deren Integritätsprüfung bestätigte **172 Dateien**. Die zugehörigen GUI-Aktionen wurden ebenfalls erfolgreich ausgeführt. Die funktionierende Originalversion blieb unverändert.

Auch nach Ergänzung der exakten Float32-Quellbindung von `minT` und `rangeT` bestanden alle zwölf tatsächlichen Kandidaten erneut `verify-import`. Abweichende Quantisierungsparameter anderer Importe werden abgelehnt; die zulässige Fehlertoleranz wird dafür nicht erweitert.

Die Workbench formatierte dabei 24 Import-Metadateien neu. Diese Änderungen wurden nur nach Vergleich der vollständig gleichen geparsten Struktur akzeptiert; alte und neue Digests sind im privaten Nachweis erfasst. Daraus folgt keine Erlaubnis, beliebige zusätzliche Dateien oder geänderte Importparameter zu übernehmen.

Dieser Durchlauf bestätigt den echten nativen Produktimport und die Finalisierung. Im leeren Animation Editor wurde dadurch keine Modellvorschau geprüft. Die automatisch erzeugten Dateiberichte setzen `runtimeValidation: not-validated`; die folgende gesonderte Sichtabnahme wird dadurch nicht automatisch in diesen Berichten eingetragen.

## Begrenzte finale Produktsichtabnahme

Der anschließende Spiel- und Sichttest der finalisierten Produkt-Ausgabe unter **DayZ Experimental 1.30.164014.27** wurde mit weniger Diagnoseprotokollierung durchgeführt. Eine knapp fünfminütige Aufnahme wurde vollständig gesichert. Der Nutzer bestätigte anschließend: **„ich habe auch ein video gemacht, absolut glatt, weder zuckler noch ruckler“**.

Der abschließend unter den verschärften Prüfungen neu finalisierte Bestand stimmt in **allen 168 Laufzeitdateien bytegenau** mit dem in diesem Lauf verwendeten Paket überein. Damit liegt eine erfolgreiche begrenzte Sichtabnahme des finalen Produktbestands vor. Die Originalversion blieb unverändert.

Diese Abnahme betrifft die beobachtete Sequenz, den festen Assetbestand und den genannten Build. Sie ist kein Nachweis sämtlicher denkbarer Übergänge, Langzeit- oder Netzwerkbedingungen, anderer Mods oder anderer Importerbuilds. Die Workbench-Modellvorschau bleibt unbestätigt. Die feste Profilbindung und alle dokumentierten Abbruchbedingungen bleiben bestehen.

## Bedeutung der Statusangaben

| Status | Aussage |
|---|---|
| `assetMigration: null` | Kein Assetprofil gewählt; normale Graphkonvertierung. Daraus folgt keine Asset- oder Laufzeitfreigabe. |
| `awaiting-native-import` | TXAs vorbereitet oder Importkopie erstellt; ursprüngliche ANM-Platzhalter sind noch kein fertiges Migrationsergebnis. |
| `native-verified` | Die zwölf importierten Kandidaten und Kontrollen bestehen die feste Prüfung. Die finale Modausgabe muss noch separat erstellt werden. |
| `ready-for-isolated-runtime-test` | Neue Ausgabe nach wiederholter Importprüfung; native ANMs und korrigierte TXAs stehen zusammen bereit. |
| `runtimeValidation: not-validated` | Das Spielverhalten ist durch diese Dateioperationen noch nicht abgenommen. |

`verify` kontrolliert das jeweilige Ausgabemanifest und Ressourcenreferenzen. `verify-import` kontrolliert den vollständigen vorgesehenen nativen Import; `finalize-import` wiederholt dessen Prüfung. Ein umgeschriebenes Manifest oder eine passende Hashsumme allein ersetzt die zusätzlichen Quellen-, Struktur- und Kurvenprüfungen nicht.
