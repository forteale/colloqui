# SlotBook — prenotazione colloqui

Versione senza Supabase: tutto gira su **Netlify** (pagine statiche + una Netlify Function) e i dati stanno in **Netlify Blobs**, lo storage integrato del sito. Niente progetti che vanno in pausa, niente database esterni da riattivare.

## Struttura

```
public/backoffice.html        area riservata (eventi, prenotazioni, utenti, export Excel)
public/form.html              form pubblico per i genitori (?e=slug-evento)
netlify/functions/api.mjs     API /api/* (dati su Netlify Blobs)
netlify.toml                  configurazione Netlify
package.json                  dipendenza @netlify/blobs
```

## Messa online (una volta sola)

1. Carica il contenuto di questa cartella nel repo GitHub (es. `forteale/colloqui`, sostituendo i vecchi file).
2. Su Netlify: **Add new project → Import an existing project → GitHub →** scegli il repo.
   Le impostazioni di build vengono lette da `netlify.toml` (publish `public`, functions `netlify/functions`): non serve toccare nulla.
3. Apri `https://<nome-sito>.netlify.app/backoffice.html`.
   Al **primo accesso** la pagina chiede di creare l'account admin (password di almeno 8 caratteri).
   Fatto questo, il setup si chiude e da lì in poi c'è solo il login.
4. (Facoltativo) Disattiva GitHub Pages sul repo: la versione Pages non funziona più senza Supabase.

## Uso

- **Nuovo evento** → nome, slug, data, gruppi di classi con orari e durata slot, eventuali campi extra.
- **Copia link** → `https://<nome-sito>.netlify.app/form.html?e=<slug>` da mandare su WhatsApp.
- **Prenotazioni** → elenco, eliminazione (lo slot torna libero), export Excel.
- **Utenti** (solo admin) → crea altri account; ognuno vede solo i propri eventi.
- Click sul tuo nome in alto → cambio password.

## Note tecniche

- Lo slot viene occupato con una scrittura atomica (`onlyIfNew`): due famiglie che confermano lo stesso orario nello stesso istante non possono finire entrambe prenotate.
- Il form pubblico vede solo quali orari sono occupati, mai i nomi delle altre famiglie. Unica eccezione: chi digita cognome+classe di una prenotazione esistente vede quella prenotazione, per poterla modificare (come prima).
- Password salvate con hash scrypt; sessione firmata con HMAC (durata 12 ore). Il segreto viene generato e salvato nello store al primo avvio; in alternativa puoi impostare la variabile d'ambiente `SLOTBOOK_SECRET`.
- I dati sono nello store Blobs `slotbook` del sito: li vedi da Netlify → progetto → **Blobs**.
- Costi: sul piano Free i crediti si consumano per i deploy di produzione e, in misura minima, per le chiamate alle function. Per i colloqui di una o due classi l'uso è trascurabile.

## Prova in locale

```
npm install
npx netlify dev
```

La cartella `archivio/` contiene le versioni precedenti (Apps Script e Supabase), non usate dal sito.
