import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { SprintCapacity, Issue, PlanningResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

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

export async function writePlanningAndIssuesToSheet(
    projectName: string,
    planningData: PlanningResult,
    issuesData: Issue[]
): Promise<void> {
    try {
        logger.info(`Start schrijven van planning en issues voor project ${projectName} naar Google Sheet...`);

        // Maak de planning tab leeg
        const planningRange = `Planning ${projectName}!A1`;
        await sheets.spreadsheets.values.clear({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: planningRange
        });

        // Maak de issues tab leeg
        const issuesRange = `Issues ${projectName}!A1`;
        await sheets.spreadsheets.values.clear({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: issuesRange
        });

        // Genereer huidige datum in Nederlands formaat
        const currentDate = new Date().toLocaleDateString('nl-NL', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        // === PLANNING TAB ===
        // Verzamel alle unieke sprintnummers en medewerkers
        const allSprints = Object.keys(planningData.sprintHours).sort((a, b) => parseInt(a) - parseInt(b));
        const allEmployees = Object.keys(planningData.employeeSprintUsedHours).sort();

        // Bouw de planning-rijen per sprint, per medewerker
        const planningRows: any[] = [];
        let totalRowIndices: number[] = []; // Bewaar de indices van totaalregels
        let currentRowIndex = 2; // Start na de header rij

        for (const sprint of allSprints) {
            let sprintTotalAvailable = 0;
            let sprintTotalPlanned = 0;
            let sprintTotalRemaining = 0;
            let sprintTotalIssues = 0;
            const employeeRows: any[] = [];

            // Verzamel alle medewerkers die in deze sprint uren hebben
            const employeesInSprint = allEmployees.filter(emp => planningData.employeeSprintUsedHours[emp][sprint] !== undefined);
            employeesInSprint.sort();

            for (const employee of employeesInSprint) {
                const availableHours = planningData.sprintCapacity.find(
                    (sc) => sc.employee === employee && sc.sprint === sprint
                )?.capacity || 0;
                const plannedHours = planningData.employeeSprintUsedHours[employee][sprint] || 0;
                const plannedIssues = planningData.plannedIssues.filter(
                    (pi) => pi.assignee === employee && pi.sprint === sprint
                );
                const remaining = availableHours - plannedHours;

                sprintTotalAvailable += availableHours;
                sprintTotalPlanned += plannedHours;
                sprintTotalRemaining += remaining;
                sprintTotalIssues += plannedIssues.length;

                employeeRows.push([
                    parseInt(sprint),
                    employee,
                    availableHours,
                    plannedHours,
                    plannedIssues.map((pi) => `${pi.issue.key} (${pi.hours.toFixed(1)} uur)`).join(', '),
                    remaining
                ]);
                currentRowIndex++;
            }

            // Voeg alle medewerkers toe voor deze sprint
            planningRows.push(...employeeRows);
            
            // Voeg totaalregel toe voor deze sprint
            planningRows.push([
                parseInt(sprint),
                'Totaal',
                sprintTotalAvailable,
                sprintTotalPlanned,
                sprintTotalIssues.toString(),
                sprintTotalRemaining
            ]);
            totalRowIndices.push(currentRowIndex);
            currentRowIndex++;
        }

        // Bouw de uiteindelijke values-array voor Google Sheets
        const planningValues = [
            [`Datum: ${currentDate}`],
            ['Sprint', 'Medewerker', 'Beschikbare uren', 'Geplande uren', 'Geplande issues', 'Resterende tijd'],
            ...planningRows
        ];

        // Schrijf de planning data
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: planningRange,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: planningValues
            }
        });

        // === ISSUES TAB ===
        const issuesValues = [
            [`Datum: ${currentDate}`],
            ['Issue', 'Samenvatting', 'Status', 'Prioriteit', 'Toegewezen aan', 'Uren', 'Sprint', 'Opvolgers'],
            ...issuesData.map((issue) => {
                const plannedIssue = planningData.plannedIssues.find((pi) => pi.issue.key === issue.key);
                const sprintName = plannedIssue ? plannedIssue.sprint : 'Niet gepland';
                const hours = (issue.fields?.timeestimate || 0) / 3600; // Als nummer
                const successors = issue.fields?.issuelinks
                    ?.filter((link) => 
                        (link.type.name === 'Blocks' || link.type.name === 'Depends On') && 
                        link.outwardIssue?.key === issue.key
                    )
                    .map((link) => link.outwardIssue?.key)
                    .join(', ') || 'Geen';

                return [
                    issue.key,
                    issue.fields?.summary || '',
                    issue.fields?.status?.name || '',
                    issue.fields?.priority?.name || 'Lowest',
                    issue.fields?.assignee?.displayName || 'Unassigned',
                    hours,
                    sprintName === 'Niet gepland' ? sprintName : parseInt(sprintName), // Sprint als nummer indien mogelijk
                    successors
                ];
            })
        ];

        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: issuesRange,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: issuesValues
            }
        });

        // Pas de celformattering toe voor beide tabs
        const requests = [
            // Planning tab header
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Planning ${projectName}`),
                        startRowIndex: 1,
                        endRowIndex: 2,
                        startColumnIndex: 0,
                        endColumnIndex: 6
                    },
                    cell: {
                        userEnteredFormat: {
                            textFormat: { bold: true },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(textFormat,horizontalAlignment)'
                }
            },
            // Planning tab nummerieke kolommen
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Planning ${projectName}`),
                        startRowIndex: 2,
                        startColumnIndex: 0,
                        endColumnIndex: 1
                    },
                    cell: {
                        userEnteredFormat: {
                            numberFormat: { type: 'NUMBER', pattern: '0' },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
                }
            },
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Planning ${projectName}`),
                        startRowIndex: 2,
                        startColumnIndex: 2,
                        endColumnIndex: 4
                    },
                    cell: {
                        userEnteredFormat: {
                            numberFormat: { type: 'NUMBER', pattern: '0.0' },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
                }
            },
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Planning ${projectName}`),
                        startRowIndex: 2,
                        startColumnIndex: 5,
                        endColumnIndex: 6
                    },
                    cell: {
                        userEnteredFormat: {
                            numberFormat: { type: 'NUMBER', pattern: '0.0' },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
                }
            },
            // Issues tab header
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Issues ${projectName}`),
                        startRowIndex: 1,
                        endRowIndex: 2,
                        startColumnIndex: 0,
                        endColumnIndex: 8
                    },
                    cell: {
                        userEnteredFormat: {
                            textFormat: { bold: true },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(textFormat,horizontalAlignment)'
                }
            },
            // Issues tab nummerieke kolommen (Uren en Sprint)
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Issues ${projectName}`),
                        startRowIndex: 2,
                        startColumnIndex: 5,
                        endColumnIndex: 6
                    },
                    cell: {
                        userEnteredFormat: {
                            numberFormat: { type: 'NUMBER', pattern: '0.0' },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
                }
            },
            {
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Issues ${projectName}`),
                        startRowIndex: 2,
                        startColumnIndex: 6,
                        endColumnIndex: 7
                    },
                    cell: {
                        userEnteredFormat: {
                            numberFormat: { type: 'NUMBER', pattern: '0' },
                            horizontalAlignment: 'CENTER'
                        }
                    },
                    fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
                }
            }
        ];

        // Voeg de totaalregel formattering toe voor de planning tab
        for (const rowIndex of totalRowIndices) {
            requests.push({
                repeatCell: {
                    range: {
                        sheetId: await getSheetId(`Planning ${projectName}`),
                        startRowIndex: rowIndex,
                        endRowIndex: rowIndex + 1,
                        startColumnIndex: 0,
                        endColumnIndex: 6
                    },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                            textFormat: { bold: true },
                            horizontalAlignment: 'CENTER'
                        } as any // Type assertion om de TypeScript error te omzeilen
                    },
                    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
                }
            });
        }

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            requestBody: {
                requests
            }
        });

        logger.info(`Planning en issues voor project ${projectName} succesvol geschreven naar Google Sheet`);
    } catch (error) {
        logger.error(`Error bij schrijven van planning en issues voor project ${projectName} naar Google Sheet: ${error instanceof Error ? error.message : error}`);
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