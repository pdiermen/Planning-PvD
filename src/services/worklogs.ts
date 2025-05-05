import type { WorkLog } from '../types.js';
import { getWorkLogs } from '../jira.js';

export async function loadWorklogs(startDate: Date, endDate: Date, projectKey: string): Promise<WorkLog[]> {
    try {
        const worklogs = await getWorkLogs(startDate, endDate, projectKey);
        return worklogs;
    } catch (error) {
        console.error('Error loading worklogs:', error);
        return [];
    }
}

export function getTotalWorklogsByEmployeeAndCategory(worklogs: WorkLog[]): Map<string, Map<string, number>> {
    const totalHoursByEmployeeAndCategory = new Map<string, Map<string, number>>();

    for (const worklog of worklogs) {
        const author = typeof worklog.author === 'object' ? worklog.author.displayName : worklog.author;
        const category = worklog.category || 'Uncategorized';
        const hours = worklog.timeSpentSeconds / 3600;

        if (!totalHoursByEmployeeAndCategory.has(author)) {
            totalHoursByEmployeeAndCategory.set(author, new Map<string, number>());
        }

        const employeeCategories = totalHoursByEmployeeAndCategory.get(author)!;
        const currentHours = employeeCategories.get(category) || 0;
        employeeCategories.set(category, currentHours + hours);
    }

    return totalHoursByEmployeeAndCategory;
} 