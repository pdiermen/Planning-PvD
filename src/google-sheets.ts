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
        if (!project) continue;

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
        const auth = new JWT({
            email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
            key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

        if (!spreadsheetId) {
            throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is niet geconfigureerd');
        }

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return null;
        }

        const headerRow = rows[0];
        if (!headerRow || !Array.isArray(headerRow)) {
            throw new Error('Ongeldige header rij in Google Sheets data');
        }

        if (range.startsWith('Employees!')) {
            const nameIndex = headerRow.findIndex(header => header?.toLowerCase() === 'naam');
            const effectiveHoursIndex = headerRow.findIndex(header => header?.toLowerCase() === 'effectieve uren');
            const projectIndex = headerRow.findIndex(header => header?.toLowerCase() === 'project');
            
            if (nameIndex === -1 || effectiveHoursIndex === -1 || projectIndex === -1) {
                const missingColumns = [];
                if (nameIndex === -1) missingColumns.push('Naam');
                if (effectiveHoursIndex === -1) missingColumns.push('Effectieve uren');
                if (projectIndex === -1) missingColumns.push('Project');
                
                if (missingColumns.length > 0) {
                    throw new Error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
                }
            }
        } else if (range.startsWith('Projects!')) {
            const projectIndex = headerRow.findIndex(header => header === 'Project');
            const codesIndex = headerRow.findIndex(header => header === 'Codes');
            
            if (projectIndex === -1 || codesIndex === -1) {
                const missingColumns = [];
                if (projectIndex === -1) missingColumns.push('Project');
                if (codesIndex === -1) missingColumns.push('Codes');
                
                if (missingColumns.length > 0) {
                    throw new Error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
                }
            }
        }

        return rows;
    } catch (error) {
        logger.error(`Error bij ophalen van ${range} data: ${error instanceof Error ? error.message : error}`);
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
    
    if (!headerRow || !Array.isArray(headerRow)) {
        logger.error('Ongeldige header rij in Google Sheets data');
        return [];
    }

    const nameIndex = headerRow.findIndex(header => header?.toLowerCase() === 'naam');
    const effectiveHoursIndex = headerRow.findIndex(header => header?.toLowerCase() === 'effectieve uren');
    const projectIndex = headerRow.findIndex(header => header?.toLowerCase() === 'project');

    if (nameIndex === -1 || effectiveHoursIndex === -1 || projectIndex === -1) {
        logger.error('Verplichte kolommen niet gevonden in Google Sheets data');
        return [];
    }

    // Haal project configuraties op voor sprint startdatums
    const projectSheetsData = await getGoogleSheetsData('Projects!A1:F');
    const projectConfigs = getProjectConfigsFromSheet(projectSheetsData);
    const currentDate = new Date();

    // Verwerk de data rijen voor individuele capaciteiten
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row || !Array.isArray(row)) continue;

        const employeeName = row[nameIndex]?.toString() || 'Unassigned';
        const effectiveHoursStr = row[effectiveHoursIndex];
        const projectsStr = row[projectIndex] || '';
        const effectiveHours = parseFloat(effectiveHoursStr?.toString() || '0');
        const projects = projectsStr ? projectsStr.toString().split(',').map(p => p.trim()) : [];

        // Log de capaciteit per medewerker zoals uit de sheet gelezen
        logger.info(`Medewerker: ${employeeName}, Effectieve uren: ${effectiveHours}, Projecten: ${projects.join(', ')}`);

        // Maak capaciteiten aan voor alle sprints
        for (let sprintNumber = 1; sprintNumber <= 100; sprintNumber++) {
            let capacity = effectiveHours * 2; // Standaard 2 weken per sprint
            let availableCapacity = capacity;
            let startDate: string | undefined;

            // Bepaal de sprint startdatum op basis van project configuratie
            for (const config of projectConfigs) {
                if (config.sprintStartDate && config.project === projects[0]) {
                    const sprintStart = new Date(config.sprintStartDate);
                    sprintStart.setDate(sprintStart.getDate() + ((sprintNumber - 1) * 14));
                    const sprintEnd = new Date(sprintStart);
                    sprintEnd.setDate(sprintStart.getDate() + 13);

                    // Voor sprints die al zijn begonnen maar nog niet zijn afgelopen: bereken beschikbare capaciteit op basis van resterende werkdagen
                    if (currentDate >= sprintStart && currentDate <= sprintEnd) {
                        const remainingWorkDays = getWorkDaysBetween(currentDate, sprintEnd);
                        const totalWorkDaysInSprint = 10; // 2 weken = 10 werkdagen
                        const capacityFactor = remainingWorkDays / totalWorkDaysInSprint;
                        const originalCapacity = effectiveHours * 2;
                        // Behoud de volledige capaciteit, maar reduceer alleen de beschikbare capaciteit
                        capacity = originalCapacity;
                        availableCapacity = Math.round(originalCapacity * capacityFactor);
                    } else if (currentDate > sprintEnd) {
                        // Voor sprints die al zijn afgelopen: geen beschikbare capaciteit
                        const originalCapacity = effectiveHours * 2;
                        capacity = originalCapacity;
                        availableCapacity = 0;
                    }

                    startDate = sprintStart.toISOString();
                    break; // Stop na het vinden van de juiste project configuratie
                }
            }

            // Voeg de capaciteit toe voor elk project
            if (projects.length === 0 || projects[0] === '') {
                sprintCapacities.push({
                    employee: employeeName,
                    sprint: sprintNumber.toString(),
                    capacity: capacity,
                    project: '',
                    availableCapacity: availableCapacity,
                    startDate: startDate
                });
            } else {
                projects.forEach(project => {
                    // Bereken capaciteitsfactor per project op basis van de sprint datums van dat project
                    let projectCapacity = effectiveHours * 2;
                    let projectAvailableCapacity = projectCapacity;
                    let projectStartDate: string | undefined;

                    // Zoek de project configuratie voor dit specifieke project
                    const projectConfig = projectConfigs.find(config => config.project === project);
                    if (projectConfig && projectConfig.sprintStartDate) {
                        const sprintStart = new Date(projectConfig.sprintStartDate);
                        sprintStart.setDate(sprintStart.getDate() + ((sprintNumber - 1) * 14));
                        const sprintEnd = new Date(sprintStart);
                        sprintEnd.setDate(sprintStart.getDate() + 13);

                        // Voor sprints die al zijn begonnen maar nog niet zijn afgelopen: bereken beschikbare capaciteit op basis van resterende werkdagen
                        if (currentDate >= sprintStart && currentDate <= sprintEnd) {
                            const remainingWorkDays = getWorkDaysBetween(currentDate, sprintEnd);
                            const totalWorkDaysInSprint = 10; // 2 weken = 10 werkdagen
                            const capacityFactor = remainingWorkDays / totalWorkDaysInSprint;
                            const originalCapacity = effectiveHours * 2;
                            // Behoud de volledige capaciteit, maar reduceer alleen de beschikbare capaciteit
                            projectCapacity = originalCapacity;
                            projectAvailableCapacity = Math.round(originalCapacity * capacityFactor);
                        } else if (currentDate > sprintEnd) {
                            // Voor sprints die al zijn afgelopen: geen beschikbare capaciteit
                            const originalCapacity = effectiveHours * 2;
                            projectCapacity = originalCapacity;
                            projectAvailableCapacity = 0;
                        }

                        projectStartDate = sprintStart.toISOString();
                    }

                    sprintCapacities.push({
                        employee: employeeName,
                        sprint: sprintNumber.toString(),
                        capacity: projectCapacity,
                        project: project,
                        availableCapacity: projectAvailableCapacity,
                        startDate: projectStartDate
                    });
                });
            }
        }
    }

    logger.info(`Gevonden sprint capaciteiten: ${sprintCapacities.length}`);
    return sprintCapacities;
}

// Helper functie om werkdagen tussen twee datums te berekenen
export function getWorkDaysBetween(startDate: Date, endDate: Date): number {
    let workDays = 0;
    const currentDate = new Date(startDate);
    
    // Tel de huidige datum altijd mee als werkdag
    workDays++;
    
    // Tel de resterende dagen
    while (currentDate < endDate) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = zondag, 6 = zaterdag
            workDays++;
        }
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
            ['Sprint', 'Project', 'Medewerker', 'Capaciteit', 'Gebruikt', 'Beschikbaar']
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
            // Alleen capaciteiten toevoegen voor sprints waar issues op gepland zijn EN voor het specifieke project
            if (plannedSprints.has(capacity.sprint) && capacity.project === projectName) {
                if (!sprintCapacities.has(capacity.sprint)) {
                    sprintCapacities.set(capacity.sprint, []);
                }
                sprintCapacities.get(capacity.sprint)?.push(capacity);
            }
        });

        // Voeg de planning data toe
        for (const [sprint, capacities] of sprintCapacities) {
            capacities.forEach(capacity => {
                // Zet effectieve uren op 0 voor Peter van Diermen en Unassigned
                let effectiveHours = capacity.capacity;
                let usedHours = capacity.capacity - capacity.availableCapacity;
                let availableHours = capacity.availableCapacity;

                if (capacity.employee === 'Peter van Diermen' || capacity.employee === 'Unassigned') {
                    effectiveHours = 0;
                    usedHours = 0;
                    availableHours = 0;
                }

                planningData.push([
                    sprint,
                    capacity.project,
                    capacity.employee,
                    effectiveHours.toString(),
                    usedHours.toString(),
                    availableHours.toString()
                ]);
            });
        }

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

        // Bereid de issues data voor
        const issuesData = [
            ['Issues Overzicht'],
            ['Issue', 'Project', 'Titel', 'Sprint', 'Medewerker', 'Geschatte uren', 'Status']
        ];

        // Voeg de issues data toe
        issues.forEach(issue => {
            const plannedIssue = planning.plannedIssues.find(pi => pi.issue.key === issue.key);
            const projectKey = issue.key.split('-')[0]; // Haal project key uit issue key
            issuesData.push([
                issue.key,
                projectKey,
                issue.fields?.summary || '',
                plannedIssue?.sprint || '',
                issue.fields?.assignee?.displayName || 'Unassigned',
                issue.fields?.timeoriginalestimate ? (issue.fields.timeoriginalestimate / 3600).toString() : '0',
                issue.fields?.status?.name || ''
            ]);
        });

        // Schrijf de issues data naar de sheet
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: issuesRange,
            valueInputOption: 'RAW',
            requestBody: {
                values: issuesData
            }
        });

    } catch (error) {
        logger.error(`Fout bij schrijven naar Google Sheets: ${error}`);
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