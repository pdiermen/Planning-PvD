import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { SprintCapacity } from './types.js';

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
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
        logger.log('Start ophalen van worklog configuraties uit Google Sheet...');
        
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

        logger.log(`${configs.length} worklog configuraties gevonden in Google Sheet`);
        return configs;
    } catch (error: any) {
        logger.error(`Error bij ophalen van worklog configuraties uit Google Sheet: ${error.message}`);
        throw error;
    }
}

export async function getGoogleSheetsData(range: string) {
  try {
    logger.log(`Start ophalen van ${range} data...`);
    
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

    logger.log(`${rows.length} rijen gevonden in ${range}`);
    return rows;
  } catch (error) {
    logger.error(`Error bij ophalen van ${range} data: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

export async function getSprintCapacityFromSheet(): Promise<SprintCapacity[]> {
    try {
        logger.log('Start ophalen van sprint capaciteit uit Google Sheet...');
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
            range: 'Employees!A2:H', // Pas dit aan naar het juiste bereik in je sheet
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            logger.error('Geen data gevonden in Google Sheet');
            throw new Error('Geen data gevonden in Google Sheet');
        }

        const capacities: SprintCapacity[] = [];
        rows.forEach((row, index) => {
            const [col1, col2, employee, col4, col5, col6, effectiveHours, projects] = row;
            if (employee && effectiveHours) {
                const hours = parseFloat(effectiveHours.toString());
                if (!isNaN(hours)) {
                    // Genereer capaciteiten voor elke sprint
                    for (let sprintNumber = 1; sprintNumber <= 5; sprintNumber++) {
                        if (!projects || projects === '') {
                            capacities.push({
                                employee,
                                sprint: sprintNumber.toString(),
                                capacity: hours * 2, // 2 weken per sprint
                                project: ''
                            });
                        } else {
                            const projectList = projects.toString().split(',').map((p: string) => p.trim());
                            projectList.forEach((project: string) => {
                                capacities.push({
                                    employee,
                                    sprint: sprintNumber.toString(),
                                    capacity: hours * 2, // 2 weken per sprint
                                    project: project
                                });
                            });
                        }
                    }
                }
            }
        });

        logger.log(`${capacities.length} sprint capaciteiten gevonden in Google Sheet`);
        return capacities;
    } catch (error: any) {
        logger.error(`Error bij ophalen van sprint capaciteit uit Google Sheet: ${error.message}`);
        throw error;
    }
} 