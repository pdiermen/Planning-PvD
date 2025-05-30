import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import logger from './logger.js';
import { SprintCapacity, Issue, PlanningResult } from './types.js';
import { JWT } from 'google-auth-library';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: join(__dirname, '../.env.local') });

// Check required environment variables
const requiredEnvVars = ['GOOGLE_SHEETS_CLIENT_EMAIL', 'GOOGLE_SHEETS_PRIVATE_KEY', 'GOOGLE_SHEETS_SPREADSHEET_ID'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        const error = new Error(`Missing required environment variable: ${envVar}`);
        logger.error(error.message);
        throw error;
    }
}

// Configureer Google Sheets API
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

export interface ProjectConfig {
    project: string;
    codes: string[];
    jqlFilter: string;
    worklogName: string;
    worklogJql: string;
    sprintStartDate: Date | null;
}

// Helper functie om een Nederlandse datum (d-m-y) te parsen
function parseDutchDate(dateStr: string): Date | null {
    // Verwijder eventuele spaties en splits op streepjes
    const parts = dateStr.trim().split('-');
    if (parts.length !== 3) return null;
    
    const [day, month, year] = parts.map(part => parseInt(part, 10));
    
    // Valideer de waarden
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (day < 1 || day > 31) return null;
    if (month < 1 || month > 12) return null;
    if (year < 1000 || year > 9999) return null;
    
    const date = new Date(year, month - 1, day);
    return isNaN(date.getTime()) ? null : date;
}

export function getProjectConfigsFromSheet(googleSheetsData: (string | null)[][] | null): ProjectConfig[] {
    if (!googleSheetsData || googleSheetsData.length === 0) {
        logger.error('Geen data beschikbaar uit Google Sheet');
        return [];
    }
    logger.info(`Start ophalen van project configuraties uit Google Sheet...`);
    const headerRow = googleSheetsData[0];
    const projectIndex = headerRow.findIndex(h => h?.toLowerCase() === 'project');
    const codesIndex = headerRow.findIndex(h => h?.toLowerCase() === 'codes');
    const jqlFilterIndex = headerRow.findIndex(h => h?.toLowerCase() === 'jql filter');
    const worklogIndex = headerRow.findIndex(h => h?.toLowerCase() === 'worklog');
    const worklogJqlIndex = headerRow.findIndex(h => h?.toLowerCase() === 'worklog jql');
    const sprintStartDateIndex = headerRow.findIndex(h => h?.toLowerCase() === 'sprint datum');

    const configs: ProjectConfig[] = [];
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row) continue;
        const project = row[projectIndex]?.toString() || '';
        const codes = row[codesIndex]?.toString().split(',').map(c => c.trim()).filter(Boolean) || [];
        const jqlFilter = row[jqlFilterIndex]?.toString() || '';
        const worklogName = row[worklogIndex]?.toString() || '';
        const worklogJql = row[worklogJqlIndex]?.toString() || '';
        let sprintStartDate: Date | null = null;
        if (sprintStartDateIndex !== -1 && row[sprintStartDateIndex]) {
            const dateStr = row[sprintStartDateIndex].toString();
            // Probeer eerst Nederlands formaat te parsen
            const dutchParsed = parseDutchDate(dateStr);
            if (dutchParsed) {
                sprintStartDate = dutchParsed;
            } else {
                // Als Nederlands formaat niet lukt, probeer ISO formaat
                const parsed = new Date(dateStr);
                if (!isNaN(parsed.getTime())) {
                    sprintStartDate = parsed;
                } else {
                    logger.warn(`Ongeldige sprint startdatum voor project ${project}: ${dateStr}`);
                }
            }
        }
        configs.push({
            project,
            codes,
            jqlFilter,
            worklogName,
            worklogJql,
            sprintStartDate
        });
    }
    logger.info(`Aantal project configuraties gevonden: ${configs.length}`);
    return configs;
}

export interface WorklogConfig {
    worklogName: string;
    columnName: string;
    issues: string[];
}

export async function getWorklogConfigsFromSheet(): Promise<WorklogConfig[]> {
    try {
        logger.info('Start ophalen van worklog configuraties uit Google Sheet...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: 'Worklogs!A2:C', // Aangepast naar A2:C om ook de issues kolom op te halen
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            logger.error('Geen worklog configuraties gevonden in Google Sheet');
            throw new Error('Geen worklog configuraties gevonden in Google Sheet');
        }

        const configs: WorklogConfig[] = [];
        rows.forEach((row, index) => {
            const [worklogName, columnName, issues] = row;
            if (worklogName && columnName) {
                configs.push({
                    worklogName,
                    columnName,
                    issues: issues ? issues.split(',').map((issue: string) => issue.trim()) : []
                });
            }
        });

        logger.info(`${configs.length} worklog configuraties gevonden in Google Sheet`);
        return configs;
    } catch (error: any) {
        logger.error(`Error bij ophalen van worklog configuraties uit Google Sheet: ${error.message}`);
        throw error;
    }
}

export async function getGoogleSheetsData(range: string) {
  try {
    logger.info(`Start ophalen van ${range} data...`);
    logger.info(`Spreadsheet ID: ${process.env.GOOGLE_SHEETS_SPREADSHEET_ID}`);
    logger.info(`Client Email: ${process.env.GOOGLE_SHEETS_CLIENT_EMAIL}`);
    
    // Pas de range aan voor Employees sheet om voldoende kolommen op te halen
    let adjustedRange = range;
    if (range.startsWith('Employees!')) {
      adjustedRange = 'Employees!A1:H'; // Alle kolommen ophalen voor Employees sheet
    }
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: adjustedRange,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      logger.error(`Geen data gevonden in ${range}`);
      throw new Error(`Geen data gevonden in ${range}`);
    }

    // Valideer de verplichte kolommen op basis van de tab
    const headerRow = rows[0];
    logger.info(`Headers gevonden: ${JSON.stringify(headerRow)}`);
    
    if (range.startsWith('Employees!')) {
      const nameIndex = headerRow.findIndex(header => header?.toLowerCase() === 'naam');
      const effectiveHoursIndex = headerRow.findIndex(header => header?.toLowerCase() === 'effectieve uren');
      const projectIndex = headerRow.findIndex(header => header?.toLowerCase() === 'project');
      
      logger.info(`Naam index: ${nameIndex}, Effectieve uren index: ${effectiveHoursIndex}, Project index: ${projectIndex}`);
      
      if (nameIndex === -1 || effectiveHoursIndex === -1 || projectIndex === -1) {
        const missingColumns = [];
        if (nameIndex === -1) missingColumns.push('Naam');
        if (effectiveHoursIndex === -1) missingColumns.push('Effectieve uren');
        if (projectIndex === -1) missingColumns.push('Project');
        
        if (missingColumns.length > 0) {
          logger.error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
          throw new Error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
        }
      }
    } else if (range.startsWith('Projects!')) {
      const projectIndex = headerRow.findIndex(header => header === 'Project');
      const codesIndex = headerRow.findIndex(header => header === 'Codes');
      
      logger.info(`Project index: ${projectIndex}, Codes index: ${codesIndex}`);
      
      if (projectIndex === -1 || codesIndex === -1) {
        const missingColumns = [];
        if (projectIndex === -1) missingColumns.push('Project');
        if (codesIndex === -1) missingColumns.push('Codes');
        
        if (missingColumns.length > 0) {
          logger.error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
          throw new Error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
        }
      }
    }

    logger.info(`${rows.length} rijen gevonden in ${range}`);
    return rows;
  } catch (error) {
    logger.error(`Error bij ophalen van ${range} data: ${error instanceof Error ? error.message : error}`);
    if (error instanceof Error) {
      logger.error(`Stack trace: ${error.stack}`);
    }
    throw error;
  }
}

export async function getSprintCapacityFromSheet(googleSheetsData: (string | null)[][] | null): Promise<SprintCapacity[]> {
    if (!googleSheetsData || googleSheetsData.length === 0) {
        logger.error('Geen Google Sheets data beschikbaar');
        return [];
    }

    const sprintCapacities: SprintCapacity[] = [];
    const headerRow = googleSheetsData[0];
    
    // Controleer of de headerRow bestaat en een array is
    if (!headerRow || !Array.isArray(headerRow)) {
        logger.error('Ongeldige header rij in Google Sheets data');
        return [];
    }

    // Log de header rij voor debugging
    logger.info(`Header rij: ${JSON.stringify(headerRow)}`);

    // Zoek de kolom indices
    const nameIndex = headerRow.findIndex(header => header?.toLowerCase() === 'naam');
    const effectiveHoursIndex = headerRow.findIndex(header => header?.toLowerCase() === 'effectieve uren');
    const projectIndex = headerRow.findIndex(header => header?.toLowerCase() === 'project');

    // Log de gevonden indices voor debugging
    logger.info(`Kolom indices - Naam: ${nameIndex}, Effectieve uren: ${effectiveHoursIndex}, Project: ${projectIndex}`);

    if (nameIndex === -1 || effectiveHoursIndex === -1 || projectIndex === -1) {
        logger.error('Verplichte kolommen niet gevonden in Google Sheets data');
        return [];
    }

    // Haal project configuraties op voor sprint startdatums
    const projectSheetsData = await getGoogleSheetsData('Projects!A1:F');
    const projectConfigs = getProjectConfigsFromSheet(projectSheetsData);
    const currentDate = new Date();

    // Log de gevonden project configuraties
    logger.info('Gevonden project configuraties:');
    projectConfigs.forEach(config => {
        logger.info(`- Project: ${config.project}, Sprint startdatum: ${config.sprintStartDate?.toISOString() || 'geen'}`);
    });

    // Verwerk de data rijen
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row || !Array.isArray(row)) continue;

        const employeeName = row[nameIndex];
        const effectiveHoursStr = row[effectiveHoursIndex];
        const projectsStr = row[projectIndex];


        // Controleer of we geldige data hebben
        if (!employeeName || !effectiveHoursStr) {
            logger.warn(`Ongeldige data voor medewerker: ${employeeName || 'onbekend'}`);
            continue;
        }

        const effectiveHours = parseFloat(effectiveHoursStr.toString());
        
        // Debug logging voor geparsede waarden
        logger.info(`Geparsede waarden:`);
        logger.info(`- Effectieve uren: ${effectiveHours}`);
        
        if (isNaN(effectiveHours)) {
            logger.warn(`Ongeldige numerieke waarden voor medewerker ${employeeName}`);
            continue;
        }

        const projects = projectsStr ? projectsStr.toString().split(',').map(p => p.trim()) : [];

        // Genereer capaciteiten voor 100 sprints om er zeker van te zijn dat er genoeg sprints zijn
        for (let sprintNumber = 1; sprintNumber <= 100; sprintNumber++) {
            if (projects.length === 0 || projects[0] === '') {
                sprintCapacities.push({
                    employee: employeeName,
                    sprint: sprintNumber.toString(),
                    capacity: effectiveHours * 2, // 2 weken per sprint
                    project: '',
                    availableCapacity: effectiveHours * 2, // Standaard gelijk aan de volledige capaciteit
                    startDate: undefined
                });
            } else {
                projects.forEach(project => {
                    // Zoek de project configuratie voor dit project
                    const projectConfig = projectConfigs.find(c => c.project === project);
                    let capacity = effectiveHours * 2; // Standaard 2 weken per sprint
                    let availableCapacity = capacity;

                    if (projectConfig?.sprintStartDate) {
                        const sprintStartDate = projectConfig.sprintStartDate;
                        const sprintDuration = 14; // 2 weken per sprint
                        
                        // Bereken de start- en einddatum van deze sprint
                        const sprintStart = new Date(sprintStartDate);
                        sprintStart.setDate(sprintStartDate.getDate() + ((sprintNumber - 1) * sprintDuration));
                        
                        const sprintEnd = new Date(sprintStart);
                        sprintEnd.setDate(sprintStart.getDate() + sprintDuration - 1);
                        
                        // Controleer of dit de huidige sprint is
                        if (currentDate >= sprintStart && currentDate <= sprintEnd) {
                            // Bereken het aantal resterende werkdagen (inclusief vandaag)
                            const remainingWorkDays = getWorkDaysBetween(currentDate, sprintEnd);
                            const totalWorkDaysInSprint = 10; // 2 weken = 10 werkdagen
                            const capacityFactor = remainingWorkDays / totalWorkDaysInSprint;
                            
                            capacity = effectiveHours * 2 * capacityFactor;
                            availableCapacity = capacity;
                            
                            logger.info(`Aangepaste capaciteit voor sprint ${sprintNumber} (${project}):`);
                            logger.info(`- Sprint startdatum: ${sprintStart.toISOString()}`);
                            logger.info(`- Sprint einddatum: ${sprintEnd.toISOString()}`);
                            logger.info(`- Huidige datum: ${currentDate.toISOString()}`);
                            logger.info(`- Resterende werkdagen: ${remainingWorkDays}`);
                            logger.info(`- Capaciteitsfactor: ${capacityFactor}`);
                            logger.info(`- Aangepaste capaciteit: ${capacity}`);
                        }

                        sprintCapacities.push({
                            employee: employeeName,
                            sprint: sprintNumber.toString(),
                            capacity: capacity,
                            project: project,
                            availableCapacity: availableCapacity,
                            startDate: sprintStart.toISOString()
                        });
                    } else {
                        sprintCapacities.push({
                            employee: employeeName,
                            sprint: sprintNumber.toString(),
                            capacity: capacity,
                            project: project,
                            availableCapacity: availableCapacity,
                            startDate: undefined
                        });
                    }
                });
            }
        }
    }

    logger.info(`Gevonden sprint capaciteiten: ${sprintCapacities.length}`);
    return sprintCapacities;
}

// Helper functie om werkdagen tussen twee datums te berekenen
function getWorkDaysBetween(startDate: Date, endDate: Date): number {
    let workDays = 0;
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = zondag, 6 = zaterdag
            workDays++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return workDays;
}

export async function writePlanningAndIssuesToSheet(projectName: string, planning: PlanningResult, issues: Issue[]): Promise<void> {
    try {
        const auth = new JWT({
            email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
            key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

        if (!spreadsheetId) {
            throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is niet geconfigureerd');
        }

        // Maak de tab naam veilig voor gebruik in Google Sheets, maar behoud spaties
        const safeProjectName = projectName.replace(/[^a-zA-Z0-9\s]/g, '');
        const planningRange = `Planning ${safeProjectName}!A1:Z1000`;
        const issuesRange = `Issues ${safeProjectName}!A1:Z1000`;

        // Maak de tabs eerst leeg
        await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: planningRange
        });

        // Wacht 1 seconde om quota te respecteren
        await new Promise(resolve => setTimeout(resolve, 1000));

        await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: issuesRange
        });

        // Wacht nog een seconde
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Bereid de planning data voor
        const planningData = [
            ['Planning Overzicht'],
            ['Sprint', 'Medewerker', 'Capaciteit', 'Gebruikt', 'Beschikbaar']
        ];

        // Verzamel alle sprints waar issues op gepland zijn
        const plannedSprints = new Set<string>();
        planning.plannedIssues.forEach(plannedIssue => {
            if (plannedIssue.sprint) {
                plannedSprints.add(plannedIssue.sprint);
            }
        });

        // Groepeer de capaciteiten per sprint
        const sprintCapacities = new Map<string, SprintCapacity[]>();
        planning.sprintCapacity.forEach(capacity => {
            // Alleen capaciteiten toevoegen voor sprints waar issues op gepland zijn
            if (plannedSprints.has(capacity.sprint)) {
                if (!sprintCapacities.has(capacity.sprint)) {
                    sprintCapacities.set(capacity.sprint, []);
                }
                sprintCapacities.get(capacity.sprint)?.push(capacity);
            }
        });

        // Sorteer de sprints numeriek
        const sortedSprints = Array.from(sprintCapacities.keys()).sort((a, b) => Number(a) - Number(b));

        // Voeg planning data toe per sprint
        sortedSprints.forEach(sprint => {
            const capacities = sprintCapacities.get(sprint) || [];
            let sprintTotalCapacity = 0;
            let sprintTotalUsed = 0;
            let sprintTotalAvailable = 0;

            capacities.forEach(capacity => {
                const usedHours = planning.employeeSprintUsedHours[capacity.employee]?.[capacity.sprint] || 0;
                const available = capacity.capacity - usedHours;
                planningData.push([
                    capacity.sprint,
                    capacity.employee,
                    capacity.capacity.toFixed(1).replace('.', ','),
                    usedHours.toFixed(1).replace('.', ','),
                    available.toFixed(1).replace('.', ',')
                ]);

                sprintTotalCapacity += capacity.capacity;
                sprintTotalUsed += usedHours;
                sprintTotalAvailable += available;
            });

            // Voeg totaalregel toe voor deze sprint
            planningData.push([
                sprint,
                'TOTAAL',
                sprintTotalCapacity.toFixed(1).replace('.', ','),
                sprintTotalUsed.toFixed(1).replace('.', ','),
                sprintTotalAvailable.toFixed(1).replace('.', ',')
            ]);

            // Voeg een lege rij toe tussen sprints voor betere leesbaarheid
            planningData.push([]);
        });

        // Bereid de issues data voor
        const issuesData = [
            ['Issues Overzicht'],
            ['Key', 'Samenvatting', 'Status', 'Sprint', 'Toegewezen aan', 'Uren']
        ];

        issues.forEach(issue => {
            const plannedIssue = planning.plannedIssues.find(pi => pi.issue.key === issue.key);
            issuesData.push([
                issue.key,
                issue.fields?.summary || '',
                issue.fields?.status?.name || '',
                plannedIssue?.sprint || 'Niet gepland',
                getAssigneeName(issue.fields?.assignee),
                ((issue.fields?.timeestimate || 0) / 3600).toFixed(1).replace('.', ',')
            ]);
        });

        // Schrijf de planning data naar de sheet
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: planningRange,
            valueInputOption: 'RAW',
            requestBody: {
                values: planningData
            }
        });

        // Wacht 1 seconde om quota te respecteren
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Schrijf de issues data naar de sheet
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: issuesRange,
            valueInputOption: 'RAW',
            requestBody: {
                values: issuesData
            }
        });

        logger.info(`Planning en issues voor project ${projectName} succesvol geschreven naar Google Sheet`);
    } catch (error) {
        logger.error(`Error bij schrijven van planning en issues voor project ${projectName} naar Google Sheet: ${error}`);
        throw error;
    }
}

// Helper functie om het sheet ID op te halen
async function getSheetId(sheetName: string): Promise<number> {
    const response = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID
    });
    
    const sheet = response.data.sheets?.find(s => s.properties?.title === sheetName);
    if (!sheet?.properties?.sheetId) {
        throw new Error(`Sheet ${sheetName} niet gevonden`);
    }
    
    return sheet.properties.sheetId;
}

// Helper functies voor het verwerken van issues
function sortIssues(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
        // Eerst op sprint nummer
        const sprintA = Number(a.fields?.customfield_10020) || 0;
        const sprintB = Number(b.fields?.customfield_10020) || 0;
        if (sprintA !== sprintB) return sprintA - sprintB;

        // Dan op prioriteit
        const priorityA = a.fields?.priority?.name || 'Lowest';
        const priorityB = b.fields?.priority?.name || 'Lowest';
        if (priorityA !== priorityB) return priorityA.localeCompare(priorityB);

        // Tenslotte op issue key
        return a.key.localeCompare(b.key);
    });
}

function getPredecessors(issue: Issue): string[] {
    return issue.fields?.issuelinks
        ?.filter(link => 
            link.type.name === 'Predecessor' && 
            link.type.outward === 'has as a predecessor' &&
            link.outwardIssue?.key &&
            link.outwardIssue.fields?.status?.name !== 'Closed'
        )
        .map(link => link.outwardIssue!.key) || [];
}

function getSuccessors(issue: Issue): string[] {
    return issue.fields?.issuelinks
        ?.filter(link => 
            link.type.name === 'Predecessor' && 
            link.type.inward === 'is a predecessor of' &&
            link.inwardIssue?.key &&
            link.inwardIssue.fields?.status?.name !== 'Closed'
        )
        .map(link => link.inwardIssue!.key) || [];
}

function getAssigneeName(assignee: any): string {
    if (!assignee) return 'Unassigned';
    return assignee.displayName || 'Unassigned';
}

// Error handling voor Google Sheets API
process.on('unhandledRejection', (reason: unknown) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    if (reason instanceof Error) {
        logger.error(`Stack trace: ${reason.stack}`);
    }
});

process.on('uncaughtException', (error: Error) => {
    logger.error(`Unhandled Exception: ${error.message}`);
    logger.error(`Stack trace: ${error.stack}`);
    process.exit(1);
}); 