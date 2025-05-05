import type { SprintCapacity } from '../types.js';

export async function getSprintCapacityFromSheet(googleSheetsData: (string | null)[][] | null): Promise<SprintCapacity[]> {
    if (!googleSheetsData) return [];

    const capacities: SprintCapacity[] = [];
    const headers = googleSheetsData[0] as string[];
    const employeeIndex = headers.indexOf('Employee');
    const sprintIndex = headers.indexOf('Sprint');
    const capacityIndex = headers.indexOf('Capacity');
    const projectIndex = headers.indexOf('Project');

    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row) continue;

        const employee = row[employeeIndex] as string;
        const sprint = row[sprintIndex] as string;
        const capacity = parseFloat(row[capacityIndex] as string) || 0;
        const project = row[projectIndex] as string | undefined;

        if (employee && sprint && !isNaN(capacity)) {
            capacities.push({
                employee,
                sprint,
                capacity,
                project
            });
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