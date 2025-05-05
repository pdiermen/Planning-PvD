import type { Issue, WorkLog, EfficiencyData } from '../types.js';

export async function calculateEfficiency(issues: Issue[], worklogs: WorkLog[], startDate: Date, endDate: Date): Promise<EfficiencyData[]> {
    const efficiencyData: EfficiencyData[] = [];
    const employeeWorklogs = new Map<string, WorkLog[]>();
    const employeeIssues = new Map<string, Issue[]>();

    // Groepeer worklogs en issues per medewerker
    for (const worklog of worklogs) {
        const author = typeof worklog.author === 'object' ? worklog.author.displayName : worklog.author;
        if (!employeeWorklogs.has(author)) {
            employeeWorklogs.set(author, []);
        }
        employeeWorklogs.get(author)?.push(worklog);
    }

    for (const issue of issues) {
        const assignee = typeof issue.fields?.assignee === 'object' ? 
            issue.fields.assignee.displayName : 
            issue.fields?.assignee || 'Unassigned';
        if (!employeeIssues.has(assignee)) {
            employeeIssues.set(assignee, []);
        }
        employeeIssues.get(assignee)?.push(issue);
    }

    // Bereken efficiency per medewerker
    for (const [employee, logs] of employeeWorklogs.entries()) {
        const issues = employeeIssues.get(employee) || [];

        const totalWorkedHours = logs.reduce((sum: number, worklog: WorkLog) => {
            const worklogDate = new Date(worklog.started);
            if (worklogDate >= startDate && worklogDate <= endDate) {
                return sum + (worklog.timeSpentSeconds / 3600);
            }
            return sum;
        }, 0);

        const totalEstimatedHours = issues.reduce((sum: number, issue: Issue) => {
            return sum + ((issue.fields?.timeestimate || 0) / 3600);
        }, 0);

        const efficiency = totalEstimatedHours > 0 
            ? (totalWorkedHours / totalEstimatedHours) * 100 
            : 0;

        efficiencyData.push({
            assignee: employee,
            estimatedHours: totalEstimatedHours,
            loggedHours: totalWorkedHours,
            efficiency
        });
    }

    return efficiencyData;
} 