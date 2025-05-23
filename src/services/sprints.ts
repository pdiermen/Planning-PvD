import type { SprintCapacity } from '../types.js';
import logger from '../logger.js';

export async function getSprintCapacityFromSheet(googleSheetsData: (string | null)[][] | null): Promise<SprintCapacity[]> {
    if (!googleSheetsData) {
        logger.error('Geen data ontvangen van Google Sheet');
        return [];
    }

    const capacities: SprintCapacity[] = [];
    const headers = googleSheetsData[0] as string[];
    logger.info(`Headers gevonden: ${headers.join(', ')}`);
    
    const employeeIndex = headers.indexOf('Naam');
    const hoursIndex = headers.indexOf('Effectieve uren');
    const projectIndex = headers.indexOf('Project');

    logger.info(`Kolom indices - Naam: ${employeeIndex}, Effectieve uren: ${hoursIndex}, Project: ${projectIndex}`);

    if (employeeIndex === -1 || hoursIndex === -1) {
        logger.error('Verplichte kolommen niet gevonden in Google Sheet');
        return [];
    }

    // Log de eerste paar rijen voor debugging
    logger.info('Eerste 3 rijen data:');
    for (let i = 1; i < Math.min(4, googleSheetsData.length); i++) {
        const row = googleSheetsData[i];
        if (row) {
            logger.info(`Rij ${i}: ${row.join(', ')}`);
        }
    }

    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row) continue;

        const employee = row[employeeIndex] as string;
        const effectiveHours = parseFloat(row[hoursIndex] as string) || 0;
        const projects = projectIndex !== -1 ? row[projectIndex] as string : '';

        logger.info(`Verwerken van medewerker: ${employee}, Effectieve uren: ${effectiveHours}, Projecten: ${projects}`);

        if (employee && !isNaN(effectiveHours)) {
            // Genereer capaciteiten voor elke sprint
            for (let sprintNumber = 1; sprintNumber <= 50; sprintNumber++) {
                if (!projects || projects === '') {
                    capacities.push({
                        employee,
                        sprint: sprintNumber.toString(),
                        capacity: effectiveHours * 2, // 2 weken per sprint
                        project: ''
                    });
                } else {
                    const projectList = projects.split(',').map(p => p.trim());
                    projectList.forEach(project => {
                        if (project) {
                            capacities.push({
                                employee,
                                sprint: sprintNumber.toString(),
                                capacity: effectiveHours * 2, // 2 weken per sprint
                                project
                            });
                        }
                    });
                }
            }
        }
    }

    return capacities;
}

export async function getSprintNamesFromSheet(googleSheetsData: (string | null)[][] | null): Promise<Map<string, string>> {
    const sprintNames = new Map<string, string>();
    if (!googleSheetsData) return sprintNames;

    const headers = googleSheetsData[0] as string[];
    const sprintIdIndex = headers.indexOf('Sprint ID');
    const sprintNameIndex = headers.indexOf('Sprint Name');

    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row) continue;

        const sprintId = row[sprintIdIndex] as string;
        const sprintName = row[sprintNameIndex] as string;

        if (sprintId && sprintName) {
            sprintNames.set(sprintId, sprintName);
        }
    }

    return sprintNames;
} 