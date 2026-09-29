# Formatunterstützung

Der Konverter arbeitet mit einem explizit unterstützten Ausschnitt der älteren DayZ-Animationsdateien. Die Ausgabe orientiert sich an lokal untersuchten Dateien der DayZ Experimental Workbench **1.30.164014.27**. Eine vollständige offizielle Dateigrammatik liegt diesem Projekt nicht zugrunde.

Unbekannte semantische Felder und Konstrukte dürfen nicht stillschweigend entfernt werden. Bei nicht unterstützten Eingaben ist ein Abbruch mit Dateipfad und Ursache das gewünschte Verhalten. Eine Erweiterung benötigt einen synthetischen Testfall und, wenn sich die Zielformatsemantik ändert, einen getrennten Nachweis mit dem passenden Editor.

## Ressourcen und Referenzen

- Die Workspace-Auswahl erfolgt über einen virtuellen Pfad relativ zum Eingabe-Root, beispielsweise `ExampleMod/anims/bird.aw`.
- Virtuelle Modpfade bleiben erhalten. Der Konverter erzeugt für seine neuen Ressourcen deterministische Identitäten und stimmt interne Verweise darauf ab.
- Workspace, Graph und Instanz müssen auf das zugehörige Animation-Set-Template verweisen. Ein alter abweichender Workspace-Templateverweis ist ein prüfpflichtiger Befund.
- Instanzbelegung und Graph-Sources müssen dieselben qualifizierten Namen `Gruppe.Spalte.Animation` verwenden.
- Direkt verwendete Graph-, Template-, Instanz-, Clip- und Preview-Model-Dateien müssen im Eingabe-Root vorhanden sein. Weitere Abhängigkeiten innerhalb von Binärmodellen oder der Engine werden nicht automatisch aufgelöst; der Konverter ersetzt keine Vanilla-Spieldaten und importiert keine Binärmodelle.

Der Umfang wird vom ausgewählten Workspace bestimmt. Andere Legacy-Dateien im kopierten Projekt werden nicht allein durch das Kopieren zu 1.30-Dateien. Sie müssen bei Bedarf über einen eigenen unterstützten Workspace konvertiert werden.

Der CLI-Einstieg erwartet einen Legacy-Workspace, Legacy-Graphdateien und Legacy-Instanzen. Ein bereits natives Template kann dabei verwendet werden. Die Ressourcenmodule können zusätzlich bekannte native Workspace- und Instanzstrukturen lesen; daraus folgt keine Unterstützung bereits vollständig nativer oder beliebig gemischter Projekte durch den CLI-Konverter.

## Dateifamilien

| Familie | Ziel |
|---|---|
| Workspace | Native Workspace-Datei `.aw`; unterstützte Preview-Informationen bleiben erhalten. |
| Graphdefinition | `AnimSrcGraph` in `.agr`; die Graphdateiliste referenziert die ausgegebenen `.agf`. |
| Graphinhalt | `AnimSrcGraphFile` mit Sheets, State Machines, States und Transitions. |
| Template | `AnimSetTemplateSource` mit benannten Gruppen, Spalten und Animationsslots. |
| Instanz | `AnimSetInstanceSource` mit Templateverweis und qualifizierter Clipbelegung. |
| Metadaten | Passende Ressourcenidentitäten der erzeugten Dateien. |
| Optionales Blackbird-TXA-Profil | Zwölf durch Originalprüfsummen gebundene Bewegungsquellen; native ANMs entstehen durch den externen Workbench-Import. |
| Native ANM-Prüfung | Begrenzter lesender SET6-Parser und Vergleich gegen fest gebundene Original-/Kontrollquellen; keine Binärschreibfunktion. |

## Templates, Instanzen und Workspace-Felder

| Eingabe | Unterstützung |
|---|---|
| Legacy-AST | Genau ein unbenannter Gruppentyp mit `#ngroupnames 0`; deklarierte Anzahlen werden geprüft. Daraus entstehen explizit benannte Gruppe und Spalte. |
| Benannte Legacy-Gruppen oder mehrere Legacy-Gruppentypen | Werden abgelehnt. |
| Native AST | Bekannte `Groups`-/`Name`-/`Animations`-/`Columns`-Struktur; mehrere benannte Gruppen und Spalten sind möglich, sofern alle Zuordnungen eindeutig sind. |
| Slotnamen | Leere Namen, Punkte in einzelnen Namensbestandteilen, doppelte Namen und mehrdeutige unqualifizierte Zuordnungen werden abgelehnt. |
| Legacy-ASI | Eigene Instanz ohne Vererbung (`#nparents 0`); Ressourcenzuweisungen werden vollständig den Template-Slots zugeordnet. |
| Native ASI im Ressourcenmodul | Keine nichtleeren `ParentTemplates`; nur unterstützte Ressourcenzuweisungen. Doppelte oder unbekannte Slots führen zum Abbruch. Der CLI-Einstieg erwartet Legacy-Instanzen. |
| Workspace | Unterstützte Template-, Instanz-, Graph- und Preview-Model-Verweise werden gemeinsam umgeschrieben. Ein vorhandener EventTable-Verweis bleibt erhalten. |
| Preview-Metadaten | Unterstützte Model-Verweise und Objektidentitäten bleiben erhalten. Zusätzliche unbekannte Felder oder Transformationen werden abgelehnt. |
| Zusätzliche Workspace-Tests | Nichtleere `AttachmentTesting`- oder `IkTesting`-Strukturen werden abgelehnt. |

Nicht gelistete Felder sind kein Versprechen auf Unterstützung. Maßgeblich ist die ausdrückliche Abbildung im Code; unerwartete Daten müssen sichtbar scheitern.

Ressourcenpfade dürfen keine Steuerzeichen enthalten. Gequotete Strings verwenden Escape-Sequenzen; ein Legacy-Pfad mit einem mehrdeutigen einzelnen Backslash vor `n`, `r` oder `t` wird nach dem Einlesen abgelehnt. Für virtuelle Ressourcenpfade sind Vorwärtsschrägstriche die eindeutige Schreibweise.

## Graphkonstrukte

Die implementierte Graphgrammatik ist **`$AnimGraph 7`** mit den folgenden geprüften Abbildungen. Bedingungen und andere Ausdrücke werden als Strings übertragen; der Konverter führt sie nicht aus.

| Legacy-Konstrukt | Unterstützung und Abbildung |
|---|---|
| Sheets | Benannte Sheets mit geprüften Node-Referenzen. |
| `AnimNodeStateMachine` | States, deren Child-Node und Startbedingung sowie Transitions. Verschachtelung erfolgt über Node-Verweise. |
| Zeitmodus eines States | `realtime` → `Real Time`, `notime` → `Inherit`. Andere Modi werden abgelehnt. |
| State-Exitflag | `0` oder `1`. |
| Transition | From-/To-State, Dauer, Startzeit und Bedingung bleiben erhalten; `PostEval` nur `0` oder `1`. Ein leerer Legacy-Ausgangsstate wird wie im Editor als globaler Übergang ohne `FromState` ausgegeben; der Zielstate bleibt erforderlich. |
| Transition-Blending | Nur der beobachtete Blendwert `S`; `MotionVecBlend` wird wie in der untersuchten nativen Migration mit `0x33 0` ausgegeben. |
| `AnimNodeSource` | Source-Name, `loop` → `Loop`, `noloop` → `No Loop`; ein Legacy-Tagstring wird zur Tags-Liste. |
| Andere Tags | Nichtleere Tags auf States, State Machines oder Switches werden mangels belegter Abbildung abgelehnt. |
| Source-Predictions | Nur leer unterstützt. |
| `AnimNodeSwitch` | Nur Headerwerte `0 0.0`; leere oder vollständig indizierte Prozentverteilungen, deren Summe 100 ist. Erste Wahrscheinlichkeitsliste nur leer. |
| Editorposition | Die Y-Koordinate wird für das neue Layout invertiert. Fehlende Position wird als `0 0` mit Warnung ergänzt. |
| Control-Variablen | `float` und `int` mit leerer Legacy-Anmerkung, Default-, Minimal- und Maximalwert. |
| Commands | Legacy-Flag `-1` wird wie beobachtet zu `Synchronized 1`. |
| Control-Expressions | Nur leere Liste. |
| Debug-Controls | Unterstützte `#DCtrl 2`-Command-Controls ohne benannte Gruppe. |

Deklarierte Anzahlen, doppelte IDs und nicht auflösbare interne Verweise werden geprüft. Zusätzliche Node-Typen, andere Modi/Flags, nichtleere Predictions oder Expressions, unbekannte Blendwerte und unbekannte Kontrolltypen führen zum Abbruch.

Layoutdaten dienen der Editoransicht. Ein ersetzter Layoutwert ist kein Nachweis identischen Laufzeitverhaltens. Ebenso ist der übernommene native `MotionVecBlend`-Wert eine belegte Serialisierungsentscheidung für den untersuchten Fall, keine allgemeine Aussage über jede denkbare Blendsemantik.

## Optionales Blackbird-2.08-Assetprofil

`blackbird-2.08-motion-v1` ist eine ausdrücklich gewählte Erweiterung. Ohne Profil bleiben Animationsassets Kopien ihrer Eingabe. Das Profil verlangt den vollständigen bekannten Satz von **37 aktiven Zuweisungen und 74 Originaldigests**. Es transformiert zwölf TXAs mit bewegtem Root; 25 ANM-/TXA-Paare bleiben unverändert. Unter diesen unbewegten Quellen sind 19 bekannte TXAs mit einer zusätzlichen schließenden Klammer. Sie werden nur anhand ihrer exakten Originalprüfsumme unverändert übernommen und nicht repariert oder neu importiert.

| Merkmal | Grenze |
|---|---|
| TXA-Eingabe | Genau ein Animationblock, Version 1, höchstens 8 MiB, 2–10.000 Frames und ganzzahlige FPS von 1 bis 240. Der Originaldigest muss zusätzlich zur festen Profilfassung passen. |
| Skeletonstruktur | 64 eindeutige Bones; bekannte `Scene_Root/Armature/entityposition`-Elternkette; `blackbird_Pelvis_bone` als einziger direkter Root-Child. |
| Transformationsbasis | Konstanter nachgewiesener Root-Quaternion und bekannte Root-/Armature-Scales; vollständige übereinstimmende Root-/Pelvis-Keylayouts. Keine freie Rotationserkennung oder allgemeine Interpretation der Skeletonskalierung. |
| Textänderung | Ausschließlich ausgewiesene Root-/Pelvis-Translationszeilen. Anfangsframe und übrige Bytes bleiben erhalten; exakte Rückwärtsrekonstruktion und erneute Vorwärtsrechnung werden geprüft. |
| Zweitanwendung | Die Umrechnung ist nicht idempotent. Feste Originaldigests und die Ablehnung bereits migrierter Projektbestände verhindern die Zweitanwendung im Produktablauf. |
| ANM-Leser | Beobachteter `FORM/ANIM/SET6`-Aufbau mit genau einem `FPS\0`-, `HEAD`- und `DATA`-Chunk. Größen, Frame-/Keygrenzen, eindeutige Bones, endliche Quantisierungswerte und vollständige Abdeckung werden geprüft. Unbekannte Chunks und Kodierungen werden abgelehnt. |
| Native Kontrolle | Fest an die ursprünglichen Quellen und **Experimental Workbench 1.30.164014.27** gebundene Kontroll-Digests. Andere Ergebnisse oder vom Aufrufer eingereichte Vertrauensdaten werden nicht automatisch akzeptiert. |
| Kandidaten-Translationsquantisierung | Root-/Pelvis-`minT` und `rangeT` müssen exakt den aus der gebundenen korrigierten TXA abgeleiteten Float32-Minima und -Spannweiten entsprechen. Erst anschließend wird die Fehlertoleranz bestimmt; abweichende Importerparameter werden abgelehnt. |
| Native Importmetadaten | Die ausgewiesenen `.anm.meta`-Dateien dürfen nativ anders formatiert oder kommentiert werden, sofern die geparste Struktur vollständig gleich bleibt. Der Bericht erfasst beide Digests. Unbekannte zusätzliche oder semantisch geänderte Metadaten werden abgelehnt. |
| Projektvorlage | Unterstützte `GameProjectClass`-Struktur mit genau einer PC-Konfiguration. Native Importkopie erhält isolierte Mounts und die ausdrücklich angegebene Skeleton-Registry. Mehrdeutige oder nicht unterstützte Mountstrukturen werden abgelehnt. |

Neue oder veränderte aktive Clips, andere Hierarchien, abweichende Quaternions/Scales, fehlende oder unterschiedlich belegte Root-/Pelvis-Frames und unbekannte semantische Felder führen zum Abbruch. Der reine Graphkonverter behält unabhängig davon seinen oben dokumentierten Umfang. Anleitung, Pflichtparameter und getrennte Ordnerstände stehen in [Blackbird-Profil](blackbird-profile.md).

Der dokumentierte Import-/Prüf-/Finalisierungspfad wurde mit diesem Build tatsächlich ausgeführt: 24 neu importierte Quellen, zwölf geprüfte Kandidaten und eine erfolgreiche finale Integritätsprüfung. Das erweitert weder das feste Eingabeprofil noch den unterstützten Editorbuild und ersetzt keine Modellvorschau oder Sichtabnahme der Produkt-Ausgabe.

Die anschließend separat durchgeführte, begrenzte Produktsichtabnahme war erfolgreich. Sie gilt für den beobachteten Ablauf und den bytegleichen finalen Laufzeitbestand; die Workbench-Modellvorschau bleibt unbestätigt. Der genaue Umfang ist unter [Validierung](validation.md) dokumentiert.

## Grenzen

- Kein allgemeiner Konverter für sämtliche Enfusion- oder Arma-Reforger-Formate.
- Kein PBO-Entpacker, keine PBO-Erstellung und kein Workshop-Upload.
- Kein Modell-, Skeleton-, XOB-, P3D- oder Texturimport. Das begrenzte TXA-Profil ersetzt keine allgemeine Animationskonvertierung.
- Keine eigene ANM-Erzeugung und kein automatisierter oder headless ausgeführter Workbench-Import. Die nativen Kandidaten/Kontrollen müssen im passenden Editor entstehen.
- Keine automatische Behebung von Kamera-, Material-, Skalierungs- oder Bone-Problemen.
- Kein Nachweis, dass ein gültiger Graph das bisherige Spielverhalten unverändert reproduziert.
- Keine automatische Freigabe des Spielverhaltens nach bestandener Importprüfung; die finalisierte Ausgabe ist zunächst für einen isolierten Sichttest vorgesehen.
- Keine stillschweigende Interpretation unbekannter Nodes, Events, Sync-Tabellen oder anderer nicht implementierter Strukturen.

Ein Modbestand ohne eigene AnimGraph-Dateien kann nicht allein wegen einer DayZ-Versionsänderung durch dieses Werkzeug migriert werden. Scriptgesteuerte `AnimationSources` und Bone-APIs benötigen eigene Tests.

## Erweiterungen

Für neue Konstrukte bitte einen kleinen, künstlichen Legacy-Eingabesatz und die erwartete Zielstruktur verwenden. Echte Mod- und Spieldaten bleiben außerhalb des Repositories. Jede Erweiterung sollte Werteerhalt, Referenzkonsistenz, abgelehnte Mehrdeutigkeiten und einen erneuten Lauf gegen dieselbe Quelle prüfen.
