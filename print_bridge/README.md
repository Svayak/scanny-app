# Utskriftsbrygga för Scanny

Bryggan körs på verkstadens Windows-dator, den där Brother QL-810Wc sitter i USB. Den hämtar etiketter från Scanny och skriver ut dem genom **den skrivarkö som redan finns i Windows**, med Brothers egen drivrutin.

Chrome-utskriften ändras inte. Ingen drivrutin byts ut.

Etiketten är DK-11209, 62 × 29 mm, samma innehåll som i Scanny: produktnamn, artikelnummer och streckkod.

## Så hänger det ihop

1. Någon tar emot gods i Scanny (Addera) eller trycker **Skriv ut etikett** på surfplattan.
2. Scanny lägger ett jobb i en kö för just den verkstaden.
3. Det här programmet frågar Scanny ungefär var tredje sekund och skriver ut väntande etiketter.
4. Manuell utskrift via Chrome finns kvar som reserv, på samma sätt som idag.

Automatisk utskrift är av tills ni slår på den under Inställningar. Verkstäder som inte gör det påverkas inte.

## Manuell utskrift i Chrome

Så här skriver ni ut etiketter idag, och så fortsätter det att fungera:

- Knappen **Etikett** på lagret öppnar samma utskriftsdialog som tidigare.
- Ni väljer QL-810Wc i dialogen. Brothers drivrutin ligger kvar.
- Bryggan anropar inte WinUSB och rör inte skrivarens standardinställningar. Varje automatisk utskrift får pappersstorlek 62 × 29 mm och skala 100 % bara för det jobbet.

Om bryggan är avstängd, offline eller om ett jobb inte kan köas skrivs inget automatiskt. Inleveransen sparas ändå, och ni kan skriva ut via Chrome.

## 1. Installera Python

På verkstadsdatorn:

1. Hämta Python 3.11 eller nyare för Windows (64-bit) från [python.org](https://www.python.org/downloads/windows/).
2. I installationsprogrammet, kryssa i **Add python.exe to PATH**.
3. Öppna Kommandotolken och kontrollera:

```bat
py -3 --version
```

Ni ska se ett versionsnummer, till exempel `Python 3.12.x`.

## 2. Lägg bryggan på datorn

Kopiera mappen `print_bridge` till till exempel `C:\Scanny\print_bridge`. Den ska innehålla `bridge.py`, `run-bridge.bat` och `requirements.txt`.

## 3. Installera beroenden

```bat
cd /d C:\Scanny\print_bridge
py -3 -m pip install -r requirements.txt
```

Det installerar bland annat Pillow, python-barcode och pywin32. pywin32 används för att skicka bilden till Windows-kön. USB-drivrutinen ändras inte.

## 4. Kontrollera skrivaren

QL-810Wc ska sitta kvar i USB, med Brothers drivrutin som redan används av Chrome.

1. Öppna **Inställningar → Bluetooth och enheter → Skrivare och skannrar**.
2. Skrivaren ska finnas i listan. Namnet innehåller oftast `QL-810W`.
3. Skriv ut en testsida från Windows om ni vill bekräfta att kön lever. Det är samma kö som Chrome använder.

Rör inte drivrutinen. Installera inget annat USB-läge.

Lämna `printer_name` tomt i konfigurationen om det bara finns en QL-810W. Då väljs den automatiskt. Finns flera, skriv det exakta namnet från listan ovan.

## 5. Hämta bryggnyckeln i Scanny

På en inloggad administratör, i Scanny:

1. Öppna **Admin → Inställningar**.
2. Under **Automatisk etikettskrivare**, klicka **Skapa bryggnyckel**.
3. Kopiera nyckeln direkt. Den visas bara en gång. Behöver ni en ny, använd **Rotera nyckel**. Den gamla slutar då fungera.
4. Kryssa i **Aktivera automatisk utskrift**.

Nyckeln är en hemlighet, som ett lösenord. Lägg den inte i mejl eller i git. Filen `config.json` ska bara finnas på verkstadsdatorn.

## 6. Konfiguration

Kopiera `config.example.json` till `config.json` i samma mapp och fyll i:

```json
{
  "base_url": "https://scanny.se",
  "bridge_key": "klistra-in-nyckeln-här",
  "backend": "windows",
  "printer_name": "",
  "poll_seconds": 3
}
```

- `base_url` är adressen till Scanny, utan snedstreck på slutet.
- `bridge_key` är nyckeln från inställningarna.
- `backend` ska vara `windows` på verkstadsdatorn.
- `printer_name` kan vara tomt (då söks `QL-810W`) eller det exakta könamnet.
- `poll_seconds` är hur ofta kön läses. 3 sekunder är lagom.

## 7. Prova

Starta bryggan:

```bat
cd /d C:\Scanny\print_bridge
py -3 bridge.py
```

Fönstret ska säga att den lyssnar mot Scanny. I Scanny, under samma inställningskort, ska det inom någon minut stå **Brygga: online**.

Två sätt att prova papper:

- **Testutskrift** i inställningarna. Det kräver att bryggan är online.
- Eller, utan att blanda in Scanny, en lokal testsida till samma kö:

```bat
py -3 bridge.py --local-test
```

En etikett med texten Testetikett och streckkoden SCANNY ska komma ut i 62 × 29 mm. Kommer den ut, och en vanlig Chrome-utskrift fortfarande går att göra efteråt, är installationen rätt.

När ni tar emot en artikel (läget **Addera**) köas en etikett av sig själv, så länge bryggan är online. Knappen **Etikett** skriver fortfarande ut via Chrome. Knappen **Skriv ut etikett** syns bara när automatisk utskrift är på och skickar till bryggan.

## 8. Starta automatiskt

Bryggan ska gå när verkstadens användare är inloggad, så att skrivarkön finns.

1. Öppna **Aktivitetsschemaläggaren** (Task Scheduler).
2. Välj **Skapa aktivitet…** (Create Task), inte den enkla guiden.
3. Fliken **Allmänt**: namn `Scanny utskriftsbrygga`. Välj **Kör endast när användaren är inloggad**.
4. Fliken **Utlösare**: **Ny…** → **Vid inloggning** → den användare som skriver ut.
5. Fliken **Åtgärder**: **Ny…** → **Starta ett program**.
   - Program: `C:\Scanny\print_bridge\run-bridge.bat`
   - Starta i: `C:\Scanny\print_bridge`
6. Fliken **Inställningar**: kryssa i **Om aktiviteten misslyckas, starta om varje** 1 minut, upp till 3 gånger.
7. Spara och högerklicka aktiviteten → **Kör** för att prova.

`run-bridge.bat` ligger kvar med ett fönster så ni ser om något strular. Loggen skrivs också till `bridge.log` i samma mapp. Nyckeln skrivs inte i loggen.

## Felsökning

| Vad ni ser | Vad ni gör |
| --- | --- |
| `bridge_key saknas` | Fyll i nyckeln i `config.json`. |
| 401 i loggen | Nyckeln är fel eller återkallad. Skapa en ny under Inställningar och klistra in den. Starta om bryggan. |
| `Automatisk utskrift är avstängd` | Kryssa i **Aktivera automatisk utskrift** och spara genom kryssrutan. |
| Brygga: offline | Fönstret eller aktiviteten körs inte, eller datorn når inte `https://scanny.se`. Öppna adressen i Chrome på samma dator. |
| Hittade ingen QL-810W | Skrivaren syns inte i Windows. Sätt i USB-kabeln och kontrollera Brothers drivrutin. Sätt `printer_name` om namnet är annorlunda. |
| Flera skrivare matchar | Sätt `printer_name` till det exakta namnet. |
| `pywin32 saknas` | Kör `py -3 -m pip install -r requirements.txt` igen. |
| Testutskrift säger att bryggan är offline | Starta `bridge.py` först, vänta tills status säger online, prova sedan igen. |
| Etiketten är fel storlek | Rullen ska vara DK-11209, 62 × 29 mm. Automatiska jobb är alltid den storleken. |
| Chrome-dialogen fungerar inte | Drivrutinen ska vara Brothers, samma som innan. Bryggan byter den inte. Starta om datorn om kön hakat upp sig, och prova Windows egen testsida. |

Jobb som ligger kvar i kön i mer än 24 timmar skrivs inte ut.

## Linux och Raspberry Pi

Verkstadsdatorn ska använda avsnitten ovan. På en Linux-dator eller en Raspberry Pi kan samma `bridge.py` köras med `backend` satt till `linux` och skrivaren som `printer`, till exempel `file:///dev/usb/lp0`. Då används biblioteket brother_ql mot enhetens vanliga USB-skrivare. Installera då även `requirements-linux.txt`. Det är inte vägen på Windows-datorn där Chrome skriver ut.
