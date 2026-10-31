# Scanny

Lager, beställningar och lagerlarm för verkstäder.

## Koppla historik till användar-id

Kioskens användare har ett fast id. Nya uttag, påfyllningar, inventeringar och händelseloggar sparar `userId` tillsammans med namnet som ögonblicksbild. Äldre rader har bara namnet. Migreringen fyller i `userId` genom att matcha namnet mot användare i samma verkstad. Den ändrar inte meddelandetext, `userName` eller `actorName`, och den körs inte vid deploy.

Deploya först den rättade koden, så nya rader inte får ett trasigt id. Ta sedan bort redan felaktiga `userId` och fyll i dem på nytt. Varje steg som skriver har en torrkörning före.

```
node scripts/repair-invalid-user-ids.js
node scripts/repair-invalid-user-ids.js --apply
node scripts/backfill-user-ids.js
node scripts/backfill-user-ids.js --apply
```

Reparationen tar bara bort `userId` som inte är ett giltigt ObjectId, eller som inte pekar på en användare i samma verkstad. Namn och texter ligger kvar. Torrkörningen av backfill visar antal per samling, inklusive hur många rader som skulle skrivas.

`MONGODB_URI` måste vara satt (samma variabel som servern). Skriptet kan köras igen. Rader som redan har `userId`, eller som redan markerats som oklara, rörs inte. Träffar bara ett namn på en användare i verkstaden kopplas raden. Borttagna användare och dubblettnamn får `userId: null` och `legacyActorName` satt till namnet som stod där. De syns sedan med det sparade namnet.

Gör kopplingen innan ni byter namn på användare. Efter ett namnbyte kan gamla rader utan `userId` inte längre matchas på det nya namnet.

Samma skript fyller också i strukturerade loggfält (`activityType`, produktnamn och antal) där den gamla texten kan tolkas säkert. `msg` lämnas orörd. Torrkörningen visar hur många rader som kan tolkas. Rader som redan har `activityType` hoppas över.

Ordrar har ingen användarreferens (`name` där är produktnamnet) och lämnas orörda.

## E-post

Systemmejl (beställningar, kritiska lagerlarm, inventeringsrapporter och testmejl) skickas i den här ordningen:

1. Verkstadens egen SMTP, om både användarnamn och lösenord är ifyllda i inställningarna.
2. Central SMTP, om `SMTP_HOST`, `SMTP_USER` och `SMTP_PASSWORD` alla är satta.
3. Azure Communication Services, om `ACS_EMAIL_CONNECTION_STRING` och `EMAIL_FROM` båda är satta.
4. Ingen avsändare.

Central SMTP återanvänder samma nodemailer-väg som verkstadens SMTP. Port 587 använder STARTTLS. Port 465 är implicit TLS. Misslyckas inloggning eller anslutning mot den centrala servern skickas mejlet inte vidare till Azure. Felet syns i händelseloggen.

Avsändaren är `EMAIL_FROM` med visningsnamn `EMAIL_FROM_NAME` (standard `Scanny`). `Reply-To` sätts bara om `EMAIL_REPLY_TO` har ett värde. Den här installationen använder ingen reply-to-adress.

App settings för Google Workspace. `noreply@altitudmedia.se` är ett alias till `nils@altitudmedia.se`. Lösenordet är ett applösenord, inte kontolösenordet, och ska inte ligga i git:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=nils@altitudmedia.se
SMTP_PASSWORD=<app password>
EMAIL_FROM=noreply@altitudmedia.se
EMAIL_FROM_NAME=Scanny
```

Lämna `EMAIL_REPLY_TO` tom.
