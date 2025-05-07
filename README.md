# Planning Dashboard

Een dashboard voor het beheren en visualiseren van project planningen.

## Functionaliteiten

- Project planning overzicht met 50 sprints
- Automatische planning van issues op basis van beschikbare capaciteit
- Fallback naar sprint 100 voor niet-geplande issues
- Filtering van medewerkers per project
- Voorganger-opvolger relaties in planning

## Vereisten

- Node.js v20 of hoger
- NPM
- Jira API toegang
- Google Sheets API toegang

## Installatie

1. Clone de repository:
```bash
git clone https://github.com/pdiermen/Planning-PvD.git
cd Planning-PvD
```

2. Installeer dependencies:
```bash
npm install
```

3. Maak een `.env.local` bestand aan in de root van het project met de volgende variabelen:
```
JIRA_HOST=your-jira-domain
JIRA_USERNAME=your-jira-email
JIRA_API_TOKEN=your-jira-api-token
GOOGLE_SHEETS_CLIENT_EMAIL=your-google-service-account-email
GOOGLE_SHEETS_PRIVATE_KEY=your-google-service-account-private-key
GOOGLE_SHEETS_SPREADSHEET_ID=your-google-sheet-id
```

## Gebruik

Start de development server:
```bash
npm run dev
```

De applicatie is nu beschikbaar op `http://localhost:3001`

## Planning Functionaliteit

### Sprint Capaciteit
- Elke medewerker heeft een vaste capaciteit per sprint
- Capaciteit wordt berekend op basis van effectieve uren
- Ondersteuning voor 50 sprints
- Project-specifieke capaciteit per medewerker

### Issue Planning
- Automatische planning van issues op basis van:
  - Beschikbare sprint capaciteit
  - Voorganger-opvolger relaties
  - Project-specifieke medewerker filtering
- Issues zonder voorgangers worden in de eerste beschikbare sprint gepland
- Issues met voorgangers worden na de laatste voorganger gepland
- Niet-geplande issues worden in sprint 100 geplaatst

### Project Filtering
- Medewerkers worden gefilterd op basis van project
- Alleen actieve medewerkers per project worden getoond
- Capaciteit wordt per project berekend

### Planning Overzicht
- Toont per sprint:
  - Beschikbare capaciteit
  - Gebruikte uren
  - Geplande issues
  - Resterende tijd
- Per medewerker:
  - Sprint capaciteit
  - Geplande uren
  - Geplande issues

## Google Sheets Configuratie

Het project gebruikt twee Google Sheets:
1. Projects sheet - Bevat project configuraties
2. Employees sheet - Bevat medewerker informatie en sprint capaciteiten

## Licentie

Dit project is privé en niet openbaar beschikbaar. 