# Blackbird 2.08: Bewegungsclips vorbereiten und nativ importieren

Das optionale Profil **`blackbird-2.08-motion-v1`** verbindet die vorhandene Graphkonvertierung mit einer begrenzten TXA-Korrektur und der Prüfung des anschließenden nativen ANM-Imports. Es akzeptiert ausschließlich den durch Originalprüfsummen gebundenen aktiven Blackbird-2.08-Bestand. Die ursprüngliche Mod und ihre Quelldateien bleiben erhalten.

Der vollständige Produktablauf hat einen echten nativen Import unter Workbench **1.30.164014.27** durchlaufen. Zwölf Kandidaten und zwölf Originalkontrollen wurden neu importiert; alle zwölf Kandidaten bestanden die Prüfung, Finalisierung und anschließende Integritätskontrolle. Die zugehörigen GUI-Aktionen und der nachfolgende aufgezeichnete Produktsichttest bestanden ebenfalls. Die Nutzerbewertung lautet **„absolut glatt, weder zuckler noch ruckler“**. Der abschließend neu finalisierte Bestand ist in allen 168 Laufzeitdateien bytegleich mit dem getesteten Paket. Diese begrenzte Abnahme gilt für den beobachteten Ablauf und den festen Build; eine erfolgreiche Modellvorschau oder allgemeine Fehlerfreiheit wird daraus nicht abgeleitet. Einzelheiten stehen in [Validierung](validation.md).

## Unterstützter Bestand

| Bestandteil | Behandlung |
|---|---|
| 37 aktive ASI-Zuweisungen | Vollständige Zuordnung sowie sämtliche 37 ANM- und 37 TXA-Originaldigests werden geprüft. |
| 12 Clips mit bewegtem Root | Begrenzte Root-/Pelvis-Umrechnung, anschließend verpflichtender nativer Import. |
| 25 Clips mit konstantem Root | ANMs und TXAs werden unverändert übernommen. |
| 19 der unveränderten TXAs | Die bekannten Originale enthalten eine zusätzliche schließende Klammer. Ihr exakter Digest erlaubt die unveränderte Übernahme; die Dateien werden weder repariert noch im Importbatch neu gebaut. |

Die zwölf Kandidaten sind `CalmRun`, `Run`, `Fly`, `FlyGlide`, `FlyLeft`, `FlyRight`, `FlyStart`, `FlyLand`, `FlyTorpedo4`, `FlyTorpedo5`, `FlyTorpedo6` und `FlyTorpedoOpen`.

Die strukturelle Regel verlangt die nachgewiesene Hierarchie mit 64 Bones, bekannte Root-Rotation und Skalierungen, Pelvis als einzigen direkten Root-Child und vollständige, übereinstimmende Root-/Pelvis-Keylayouts. Sie erhält den Anfangswert und korrigiert Root-Verschiebung samt Gegenversatz am Pelvis. Alle anderen Textinhalte bleiben erhalten. Das ist keine allgemeine Achsenregel für beliebige Tiere oder Skeletons.

Neue Clips, geänderte Belegungen, fehlende Quelldateien und andere Originaldigests werden abgelehnt. Auch eine bereits umgerechnete TXA mit entfernter Berichtdatei passt nicht mehr zur Originalbindung. Die reine Transformation ist nicht idempotent; die feste Originalprüfung verhindert ihre erneute Anwendung im Produktablauf. Es gibt keinen Force-Schalter und keinen vom Nutzer austauschbaren Kontroll-Hash über GUI oder CLI.

## Voraussetzungen

- Node.js **22 oder neuer**; zusätzliche npm-Pakete sind nicht nötig.
- Entpacktes Originalprojekt mit allen direkt benötigten Graph-, Template-, Instanz-, Modell- und Clipressourcen. Das Werkzeug enthält keine Originalmoddateien und entpackt keine PBOs.
- Die separate **DayZ Experimental Workbench 1.30.164014.27** und passende Experimental-Spieldaten.
- Eine passende nutzereigene `.gproj`-Vorlage mit `GameProjectClass`, einem `Configurations`-Block und genau einer PC-Konfiguration. Der Kloner ersetzt deren unterstützte `FileSystem`-Mounts strukturell und setzt die Skeleton-Registry für die Importkopie.
- Eine nutzereigene `skeletons.anim.xml`-Registry mit dem passenden unveränderten Amsel-Skeleton. Gemeint ist die Registry, auf die das Workbench-Projekt verweist; eine beliebige einzelne Skeleton-Datei ersetzt diese Anforderung nicht. Externe XML-Entities werden abgelehnt.
- Ein vorhandener Ordner mit den passenden Experimental-Spieldaten, der als zusätzlicher Workbench-Root verwendet werden kann. Der Konverter lädt oder extrahiert diese Daten nicht.
- Drei neue getrennte Ausgabeordner außerhalb des Originalprojekts. Vorhandene Ziele werden nicht überschrieben. Überlappende Verzeichnisse und Links werden abgelehnt; die Importstufen lehnen außerdem Hardlinks ab.

Die native Kontrollreferenz ist fest an **Build 1.30.164014.27** und die ausgewiesenen Originalquellen gebunden. Kontroll-ANMs müssen deren attestierte SHA-256-Werte treffen. Abweichende Ergebnisse, etwa durch einen anderen Importerbuild oder andere Importeinstellungen, werden nicht automatisch akzeptiert. Das Werkzeug prüft Dateien und ihre Herkunftsbindung; ein Dateizeitstempel oder eine Versionsangabe beweist keinen ausgeführten Editorimport.

## Drei Ordnerstände

| Ordner | Inhalt und Status |
|---|---|
| `PREPARED` | Konvertierte Graphressourcen, zwölf korrigierte TXAs, alte ANMs als Platzhalter, unveränderliche Berichte. `awaiting-native-import`; noch nicht für den Spieltest vorgesehen. |
| `IMPORT_WORK` | Separate Kopie, `native-import.gproj`, zwölf Kandidaten und zwölf Originalkontrollen mit getrennten Ressourcenidentitäten. Nur hier findet der ausgewiesene Workbench-Rebuild statt. |
| `VERIFIED` | Neue Kopie nach erneuter vollständiger Prüfung. Die zwölf Kandidaten-ANMs ersetzen die Platzhalter; korrigierte TXAs bleiben dabei. `ready-for-isolated-runtime-test`; Sichtprüfung noch offen. |

`PREPARED` bleibt während aller späteren Schritte unverändert. Die Importkopie ist zusätzlich an den SHA-256-Digest seines vollständigen Manifests gebunden. `finalize-import` prüft alles erneut und übernimmt keine beliebigen Änderungen aus dem Importordner. Die Kontrollen und Hilfsressourcen des Imports gehören nicht zur finalen Modausgabe.

## Mit der Oberfläche

1. `Start-AnimGraphMigration.cmd` oder `npm run gui` starten und die angezeigte lokale Adresse öffnen.
2. Quellordner, virtuellen Workspace-Pfad und einen neuen Zielordner für `PREPARED` eintragen. Unter **Animationsdateien** das Blackbird-Profil wählen.
3. **Quelle prüfen**, danach **Konvertieren**. Der Bericht nennt zwölf vorbereitete Bewegungsclips und den noch ausstehenden nativen Import. **Ziel prüfen** bestätigt die Integrität dieser Vorbereitung.
4. Unter **Native Bewegungsclips importieren** einen neuen Import-Arbeitsordner eintragen. Die Vorlagenfelder für Projektvorlage, Skeleton-Registry und Experimental-Spieldaten ausfüllen. **Importkopie vorbereiten** wählen.
5. Die im Bericht genannte `native-import.gproj` aus `IMPORT_WORK` in der passenden Experimental Workbench öffnen. Einen leeren Animation Editor öffnen und **Tools → Rebuild Animations** wählen. Ausschließlich den ausgewiesenen Importbereich `AGMNativeImport` mit `candidate` und `control` auswählen: zusammen 24 TXAs, je zwölf pro Gruppe. Nicht das gesamte kopierte Modprojekt neu bauen oder dessen Graphen neu speichern. Dieser Rebuild setzt keine geöffnete Modellvorschau voraus.
6. **Editorimport prüfen** wählen. Eine fehlende, abweichende oder unvollständige Kontrolle beendet den Vorgang mit einem Fehler.
7. Einen weiteren neuen Ordner unter **Neue geprüfte Ausgabe** eintragen und **Geprüfte Ausgabe erstellen** wählen. Die Importprüfung läuft erneut. Die separate Prüfung der finalen Ausgabe kontrolliert anschließend diesen neuen Ordner.
8. Erst aus `VERIFIED` einen isolierten Spieltest vorbereiten. Die Anwendung erstellt kein PBO und veröffentlicht keine Mod.

Im Importarbeitsbaum dürfen die vorgesehenen ANMs und ausdrücklich unterstützte zusätzliche Importmetadaten entstehen. Native Formatierungs- oder Kommentaränderungen an den ausgewiesenen `.anm.meta`-Dateien werden nur bei identischer geparster Struktur akzeptiert und im Bericht erfasst. Andere Änderungen werden nicht stillschweigend als Importnebenwirkung übernommen. Logs und ergänzende Prüfnotizen außerhalb der manifestierten Projektbäume sichern.

## Mit der Kommandozeile

Die folgenden Pfade sind allgemeine Beispiele. Quelldateien, Vorlage, Registry und Spieldaten müssen bereits vorhanden sein; die drei Ausgabeordner dürfen noch nicht existieren. Im Repositoryordner ausführen:

```powershell
npm start -- inspect --root "H:\DayZProjects\BlackbirdLegacy" --workspace "AmbientBlackbird/anims/animgraph/blackbird.aw" --asset-profile blackbird-2.08-motion-v1
npm start -- convert --root "H:\DayZProjects\BlackbirdLegacy" --workspace "AmbientBlackbird/anims/animgraph/blackbird.aw" --asset-profile blackbird-2.08-motion-v1 --output "H:\DayZProjects\Blackbird130_Prepared"
npm start -- verify --root "H:\DayZProjects\Blackbird130_Prepared"
npm start -- prepare-import --root "H:\DayZProjects\Blackbird130_Prepared" --output "H:\DayZProjects\Blackbird130_Import" --project-template "H:\DayZProjects\Experimental\dayz.gproj" --skeleton-definitions "H:\DayZProjects\Experimental\skeletons.anim.xml" --game-root "H:\DayZProjects\Experimental\GameData"
```

Jetzt den tatsächlichen Workbench-Import durchführen: `Blackbird130_Import/native-import.gproj` öffnen, im leeren Animation Editor **Tools → Rebuild Animations** wählen und ausschließlich `root/AGMNativeImport` mit seinen zwölf Kandidaten und zwölf Kontrollen neu importieren. Die CLI hat die ANMs bis zu diesem Punkt nicht erzeugt. Danach:

```powershell
npm start -- verify-import --root "H:\DayZProjects\Blackbird130_Prepared" --import-root "H:\DayZProjects\Blackbird130_Import"
npm start -- finalize-import --root "H:\DayZProjects\Blackbird130_Prepared" --import-root "H:\DayZProjects\Blackbird130_Import" --output "H:\DayZProjects\Blackbird130_Verified"
npm start -- verify --root "H:\DayZProjects\Blackbird130_Verified"
```

Die gemeinsamen API-Felder heißen `projectTemplate`, `skeletonDefinitions`, `gameRoot` und `importRoot`; die CLI schreibt sie wie gezeigt als `--project-template`, `--skeleton-definitions`, `--game-root` und `--import-root`. Alle drei Vorlagen-/Spieldatenfelder sind für `prepare-import` erforderlich.

## Was die Prüfung bestätigt

Die Importprüfung bindet Original-TXA, Original-ANM, korrigierte TXA, native Kontrolle und Kandidat aneinander. Sie kontrolliert Containerstruktur, Bone-Reihenfolge, Framezahlen, FPS-Metadaten, unveränderte Rotations-/Skalierungsdaten einschließlich ihrer Quantisierung und die begrenzte Root-/Pelvis-Umrechnung. Ein übergebener Erfolgsstatus oder vom Aufrufer behaupteter Kontroll-Digest genügt nicht.

Die Root-/Pelvis-Translationsparameter `minT` und `rangeT` des Kandidaten müssen exakt den Float32-Minima und -Spannweiten der gebundenen korrigierten TXA entsprechen. Erst danach wird die Fehlertoleranz berechnet. Eine frei vergrößerte Range oder eine abweichende Importerquantisierung führt zum Abbruch.

Die 62 anderen Bones müssen gegenüber der gleichzeitig nativ importierten Kontrolle in Header und Daten bytegleich sein. Die Root-Kurve muss der umgerechneten nativen Kontrollkurve innerhalb der festgelegten Quantisierungsgrenze entsprechen; Pelvis wird gegen die korrigierten Quellwerte geprüft. Native Optimierung der Kontrolle kann gegenüber der ausgelieferten ANM Daten verändern. Daher bedeutet Kandidat/Kontrolle-Bytegleichheit keine allgemeine Bytegleichheit gegenüber der alten Auslieferung.

Die Berichte liegen in `PREPARED` unter `.animgraph-migration/assets.json` und den gewöhnlichen Report-/Manifestdateien. `IMPORT_WORK` besitzt ein eigenes `.animgraph-native-import/manifest.json`; `VERIFIED` ergänzt `.animgraph-migration/native-import.json`. Diese nutzerbezogenen Berichte können Animationswerte enthalten und gehören nicht in das öffentliche Repository. Dort stehen ausschließlich eigener Werkzeugcode, synthetische Testfälle sowie Referenzkennungen und Prüfsummen.

`nativeImportValidated: true` bestätigt diese Dateiprüfung. `runtimeTestEligible: true` erlaubt den nächsten isolierten Test. `runtimeValidation: not-validated` bleibt bis zur gesonderten Bewertung des Spielverhaltens bestehen. Keine dieser Angaben bescheinigt sichtbare Modellanimation, perfekten Bodenkontakt, alle Übergänge oder fehlerfreie Netzwerk-/Scriptsteuerung.
