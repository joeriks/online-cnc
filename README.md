# Spånsim

Simulator för hobby-CNC med GRBL. Gränssnittet är på engelska som standard och kan växlas till svenska (EN/SV uppe till höger). Utöver verkstadstemat finns ett alternativt tema i Frutiger Aero-stil (väljaren bredvid språket).

Simulator for hobby CNC machines running GRBL – English by default, Swedish selectable. Klistra in eller öppna ett G-kodsprogram, välj maskin, verktyg och material, och se hur fräsningen går – innan du kör på riktigt.

**Online:** https://joeriks.github.io/online-cnc/

**Snabbast offline:** öppna `spansim.html` direkt i webbläsaren (dubbelklicka). Filen innehåller allt – ingen server eller installation behövs, och den fungerar offline (bara typsnitten hämtas från nätet).

Utveckling:

```
npm install
npm run dev          # utvecklingsserver
npm test             # enhetstester (node:test)
npm run build        # statisk sajt i dist/
npm run build:single # allt i en enda HTML-fil i dist-single/ (kopieras till spansim.html)
```

## Vad som simuleras

**Styrningen (GRBL 1.1)**
- G-kodstolk med GRBL:s modalgrupper och felkoder (`error:20`, `error:22`, `error:33`, `error:34` …). Ett fel stoppar programmet där avsändaren skulle ha stannat.
- G0/G1/G2/G3 (IJK och R, helix), G17–G19, G20/G21, G90/G91, G93/G94, G4, G10 L2/L20, G28/G30, G53, G54–G59, G92, G43.1, M0/M1/M2/M30, M3/M4/M5, M6 T#.
- Bågar delas upp i raka segment exakt som `mc_arc` med `$12` (arc tolerance).
- Rörelseplanerare som `planner.c`: positioner avrundas till hela steg (`$100–$102`), hastighet och acceleration begränsas per axel (`$110–$112`, `$120–$122`), hörnfart enligt junction deviation (`$11`), lookahead begränsad till planeringsbufferten (15 block på en Uno), och synkpunkter (M3/M5, S-byte, G4, M6) som stannar maskinen.
- Seriell överföring: korta segment kan svälta bufferten så att maskinen hackar.
- Mjuka gränser (`$20`) ger ALARM:2 när raden planeras, upp till en full buffert innan maskinen når dit. Hårda gränser (`$21`) ger ALARM:1. Utan gränslägen kör vagnen i ändstoppet och tappar steg.
- Spindelns uppvarvningstid (GRBL väntar inte), PWM-begränsning mot `$30`/`$31`, och handöverfräsar där S ignoreras.

**Fräsningen**
- Materialet modelleras som en höjdkarta där verktygets profil (pinn-, kul-, V- och hörnradiefräs) stämplas längs banan.
- Skärfysik per banavsnitt: faktiskt ingrepp (ae/ap) från den borttagna volymen, spåntjocklek med spåntunning, specifik skärkraft enligt Kienzle, spindeleffekt mot tillgänglig effekt vid aktuellt varvtal, skärkraft, verktygets utböjning som konsolbalk plus ramens styvhet, och böjspänning mot brottgräns.
- Konsekvenser: verktyget kan gå av, spindeln kan tvärstanna, och stegmotorer kan tappa steg så att resten av detaljen hamnar förskjuten.
- Varje varning har ett konkret åtgärdsförslag med siffror (nytt skärdjup, sidsteg, matning, varvtal, utstick eller säker Z-höjd) framräknat ur samma fysikmodell.
- Åtgärder med **Tillämpa**-knapp skriver om G-koden direkt (med ångra): byt matning, dela upp djupa varv i fler grundare, sätt varvtal, lägg in G4 efter M3, höj säkerhetshöjden, lägg in lyft före G0 genom material, eller korta verktygets utstick. Fungerar för absoluta program i mm (G90/G21).
- Fastsättning: spännjärn, skruvar i spillkanten, skruvstäd, dubbelhäftande tejp, målartejp + CA-lim och vakuumbord jämförs för varje program. Fixturer placeras automatiskt fritt från banan, kollisioner (även G0 på för låg säkerhetshöjd) och detaljer som skärs loss utan att hållas fast upptäcks, och hållkraften jämförs med skärkraften.
- Resultatläget visar bara den färdiga detaljen, utan maskin, spindel och banor – genomfrästa hål blir riktiga hål.
- Varningar för tunna/tjocka spån (brännmärken, smältande plast, påkladdning i aluminium), för hög skärhastighet, G0 genom material, skaft i materialet, nedstick med icke centrumskärande verktyg, fräsning i offerskivan med mera – med konkreta förslag på ändrad F eller S.

## Struktur

| Fil | Innehåll |
| --- | --- |
| `src/core/gcode.js` | G-kodstolk och bågsegmentering |
| `src/core/planner.js` | Rörelseplanerare, trapetsprofiler |
| `src/core/heightmap.js` | Materialmodell |
| `src/core/physics.js` | Skärfysik och rekommenderade skärdata |
| `src/core/rewrite.js` | Automatiska G-kodändringar för Tillämpa-knapparna |
| `src/core/workholding.js` | Fastsättning: placering, kollisioner, lösa detaljer, hållkraft |
| `src/core/simulate.js` | Kör allt och samlar varningar |
| `src/core/library.js` | Maskiner, verktyg och material |
| `src/core/examples.js` | Exempelprogram |
| `src/view/` | 3D-vy (Three.js) och diagram |
| `src/ui/` | Editor, inställningar och analyspanel |
| `src/i18n.js` | Översättningar (engelska/svenska) |

Materialdata och maskinvärden är typiska uppskattningar för hobbyutrustning. Justera dem under Maskin, Verktyg och Material så att de stämmer med din maskin.
