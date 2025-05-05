import type { Issue, PlanningResult, EfficiencyData, WorkLog, SprintCapacity } from '../types.js';

export function generateEfficiencyTable(efficiencyData: EfficiencyData[]): string {
    let html = '<table class="table table-striped">';
    html += '<thead><tr><th>Medewerker</th><th>Gewerkt (uren)</th><th>Geschat (uren)</th><th>Efficiency (%)</th></tr></thead>';
    html += '<tbody>';

    for (const data of efficiencyData) {
        html += `<tr>
            <td>${data.assignee}</td>
            <td>${data.loggedHours.toFixed(2)}</td>
            <td>${data.estimatedHours.toFixed(2)}</td>
            <td>${data.efficiency.toFixed(2)}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    return html;
}

export function generateSprintHoursTable(planning: PlanningResult, sprintNames: Map<string, string>): string {
    let html = '<table class="table table-striped">';
    html += '<thead><tr><th>Sprint</th><th>Uren</th><th>Issues</th></tr></thead>';
    html += '<tbody>';

    for (const sprint of planning.sprints) {
        const sprintName = sprintNames.get(sprint.sprint) || sprint.sprint;
        const hours = planning.sprintHours[sprint.sprint].reduce((sum: number, item: { hours: number }) => sum + item.hours, 0);
        const issueCount = planning.sprintHours[sprint.sprint].length;

        html += `<tr>
            <td>${sprintName}</td>
            <td>${hours.toFixed(2)}</td>
            <td>${issueCount}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    return html;
}

export function generateIssuesTable(issues: Issue[], planning: PlanningResult, sprintNames: Map<string, string>): string {
    let html = '<table class="table table-striped">';
    html += '<thead><tr><th>Key</th><th>Summary</th><th>Assignee</th><th>Sprint</th><th>Uren</th></tr></thead>';
    html += '<tbody>';

    for (const issue of issues) {
        const plannedIssue = planning.plannedIssues.find(pi => pi.issue.key === issue.key);
        const sprintName = plannedIssue ? sprintNames.get(plannedIssue.sprint) || plannedIssue.sprint : 'Unplanned';
        const hours = (issue.fields?.timeestimate || 0) / 3600;
        const assignee = typeof issue.fields?.assignee === 'object' ? issue.fields.assignee?.displayName : issue.fields?.assignee || 'Unassigned';

        html += `<tr>
            <td>${issue.key}</td>
            <td>${issue.fields?.summary || ''}</td>
            <td>${assignee}</td>
            <td>${sprintName}</td>
            <td>${hours.toFixed(2)}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    return html;
}

export function generateTotalWorklogsTable(worklogs: WorkLog[]): string {
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

    let html = '<table class="table table-striped">';
    html += '<thead><tr><th>Medewerker</th><th>Categorie</th><th>Uren</th></tr></thead>';
    html += '<tbody>';

    for (const [employee, categories] of totalHoursByEmployeeAndCategory) {
        for (const [category, hours] of categories) {
            html += `<tr>
                <td>${employee}</td>
                <td>${category}</td>
                <td>${hours.toFixed(2)}</td>
            </tr>`;
        }
    }

    html += '</tbody></table>';
    return html;
}

export function generatePlanningTable(planning: PlanningResult, sprintNames: Map<string, string>): string {
    let html = '<table class="table table-striped">';
    html += '<thead><tr><th>Sprint</th><th>Medewerker</th><th>Issue</th><th>Uren</th></tr></thead>';
    html += '<tbody>';

    for (const sprint of planning.sprints) {
        const sprintName = sprintNames.get(sprint.sprint) || sprint.sprint;
        const assignments = planning.sprintAssignments[sprint.sprint];

        for (const assignment of Object.values(assignments)) {
            const assignee = typeof assignment[0].fields?.assignee === 'object' ? 
                assignment[0].fields.assignee?.displayName : 
                assignment[0].fields?.assignee || 'Unassigned';

            html += `<tr>
                <td>${sprintName}</td>
                <td>${assignee}</td>
                <td>${assignment[0].key} - ${assignment[0].fields?.summary || ''}</td>
                <td>${(assignment[0].fields?.timeestimate || 0) / 3600}</td>
            </tr>`;
        }
    }

    html += '</tbody></table>';
    return html;
} 