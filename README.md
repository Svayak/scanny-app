# Scanny

Lager, beställningar och lagerlarm för verkstäder.

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
