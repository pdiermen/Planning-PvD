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
    projectName: string;
    projectCodes: string[];
    jqlFilter: string;
    worklogName: string;
    worklogJql: string;
}

export async function getProjectConfigsFromSheet(): Promise<ProjectConfig[]> {
    logger.info('Start ophalen van project configuraties uit Google Sheet...');
    try {
        const data = await getGoogleSheetsData('Projects!A1:E');
        if (!data || data.length === 0) {
            logger.warn('Geen project configuraties gevonden in Google Sheet');
            return [];
        }

        // Log de headers
        logger.info(`Headers gevonden: ${data[0].join(', ')}`);

        // Skip de header rij
        const rows = data.slice(1);
        
        const configs = rows.map(row => {
            const projectName = row[0] || '';
            const projectCodes = (row[1] || '').split(',').map((code: string) => code.trim());
            const jqlFilter = row[2] || '';
            const worklogName = row[3] || '';
            const worklogJql = row[4] || '';

            logger.info(`Project configuratie gevonden: ${projectName}`);

            if (!projectName || projectCodes.length === 0) {
                logger.warn(`Ongeldige project configuratie gevonden: ${projectName}`);
                return null;
            }

            return {
                projectName,
                projectCodes,
                jqlFilter,
                worklogName,
                worklogJql
            };
        }).filter((config): config is ProjectConfig => config !== null);

        logger.info(`Aantal project configuraties gevonden: ${configs.length}`);
        return configs;
    } catch (error) {
        logger.error(`Error bij ophalen van project configuraties uit Google Sheet: ${error instanceof Error ? error.message : error}`);
        throw error;
    }
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
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      logger.error(`Geen data gevonden in ${range}`);
      throw new Error(`Geen data gevonden in ${range}`);
    }

    // Valideer de verplichte kolommen op basis van de tab
    const headerRow = rows[0];
    if (range.startsWith('Employees!')) {
      const nameIndex = headerRow.findIndex(header => header === 'Naam');
      const effectiveHoursIndex = headerRow.findIndex(header => header === 'Effectieve uren');
      
      if (nameIndex === -1 || effectiveHoursIndex === -1) {
        const missingColumns = [];
        if (nameIndex === -1) missingColumns.push('Naam');
        if (effectiveHoursIndex === -1) missingColumns.push('Effectieve uren');
        
        if (missingColumns.length > 0) {
          logger.error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
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
          logger.error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
          throw new Error(`Verplichte kolommen ontbreken in ${range}: ${missingColumns.join(', ')}`);
        }
      }
    }

    logger.info(`${rows.length} rijen gevonden in ${range}`);
    return rows;
  } catch (error) {
    logger.error(`Error bij ophalen van ${range} data: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

export async function getSprintCapacityFromSheet(googleSheetsData: (string | null)[][] | null): Promise<SprintCapacity[]> {
    try {
        logger.info('Start ophalen van sprint capaciteit uit Google Sheet...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: 'Employees!A1:H', // Inclusief header rij
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            logger.error('Geen data gevonden in Google Sheet');
            throw new Error('Geen data gevonden in Google Sheet');
        }

        // Log de eerste paar rijen voor debugging
        logger.info('Eerste 3 rijen uit Google Sheet:');
        for (let i = 0; i < Math.min(3, rows.length); i++) {
            logger.info(`Rij ${i + 1}: ${JSON.stringify(rows[i])}`);
        }

        // Vind de juiste kolom indices
        const headers = rows[0];
        const employeeIndex = headers.findIndex((h: string) => h === 'Naam');
        const hoursIndex = headers.findIndex((h: string) => h === 'Effectieve uren');
        const projectIndex = headers.findIndex((h: string) => h === 'Project');

        if (employeeIndex === -1 || hoursIndex === -1) {
            logger.error('Verplichte kolommen niet gevonden in Google Sheet');
            throw new Error('Verplichte kolommen niet gevonden in Google Sheet');
        }

        logger.info(`Gevonden kolom indices - Naam: ${employeeIndex}, Effectieve uren: ${hoursIndex}, Project: ${projectIndex}`);

        const capacities: SprintCapacity[] = [];
        // Begin vanaf rij 1 (na de header)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const employee = row[employeeIndex];
            const effectiveHours = row[hoursIndex];
            const projects = projectIndex !== -1 ? row[projectIndex] : '';

            if (employee && effectiveHours) {
                const hours = parseFloat(effectiveHours.toString());
                if (!isNaN(hours)) {
                    logger.info(`Verwerken van medewerker ${employee} met ${hours} effectieve uren voor projecten: ${projects || 'geen specifieke projecten'}`);
                    
                    // Genereer capaciteiten voor elke sprint
                    for (let sprintNumber = 1; sprintNumber <= 50; sprintNumber++) {
                        // Als er geen specifieke projecten zijn opgegeven, voeg dan een algemene capaciteit toe
                        if (!projects || projects === '') {
                            capacities.push({
                                employee,
                                sprint: sprintNumber.toString(),
                                capacity: hours * 2, // 2 weken per sprint
                                project: ''
                            });
                        } else {
                            // Verwerk de specifieke projecten voor deze regel
                            const projectList = projects.toString().split(',').map((p: string) => p.trim());
                            projectList.forEach((project: string) => {
                                if (project) { // Alleen toevoegen als er een project is opgegeven
                                    capacities.push({
                                        employee,
                                        sprint: sprintNumber.toString(),
                                        capacity: hours * 2, // 2 weken per sprint
                                        project: project
                                    });
                                }
                            });
                        }
                    }
                } else {
                    logger.warn(`Ongeldige effectieve uren voor medewerker ${employee}: ${effectiveHours}`);
                }
            } else {
                logger.warn(`Ongeldige rij gevonden: ${JSON.stringify(row)}`);
            }
        }

        // Log de gevonden capaciteiten voor debugging
        const uniqueEmployees = new Set(capacities.map(c => c.employee));
        logger.info(`Aantal unieke medewerkers: ${uniqueEmployees.size}`);
        uniqueEmployees.forEach(emp => {
            const empCapacities = capacities.filter(c => c.employee === emp);
            const projects = new Set(empCapacities.map(c => c.project));
            const totalCapacity = empCapacities.reduce((sum, c) => sum + c.capacity, 0);
            logger.info(`Medewerker ${emp} heeft ${empCapacities.length} capaciteiten voor projecten: ${Array.from(projects).join(', ')}`);
            logger.info(`Totale capaciteit voor ${emp}: ${totalCapacity} uren`);
        });

        logger.info(`${capacities.length} sprint capaciteiten gevonden in Google Sheet`);
        return capacities;
    } catch (error: any) {
        logger.error(`Error bij ophalen van sprint capaciteit uit Google Sheet: ${error.message}`);
        throw error;
    }
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