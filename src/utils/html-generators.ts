import type { Issue, PlanningResult, EfficiencyData, WorkLog, SprintCapacity } from '../types.js';

function getAssigneeName(assignee: any): string {
    if (!assignee) return 'Unassigned';
    if (typeof assignee === 'string') return assignee;
    return assignee.displayName || 'Unassigned';
}

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
    if (!planning.sprintHours) {
        return '<p>Geen sprint uren beschikbaar</p>';
    }

    // Filter sprints waar issues in zijn gepland
    const availableSprintNames = Object.keys(planning.sprintHours)
        .filter(sprint => {
            // Check of er issues zijn gepland in deze sprint
            const hasPlannedIssues = planning.plannedIssues.some(pi => pi.sprint === sprint);
            // Check of er daadwerkelijk issues zijn gepland voor deze sprint
            const plannedIssuesInSprint = planning.plannedIssues.filter(pi => pi.sprint === sprint);
            return hasPlannedIssues && plannedIssuesInSprint.length > 0;
        })
        .sort((a, b) => parseInt(a) - parseInt(b));

    const employeeData: { [key: string]: { [key: string]: { available: number; planned: number; remaining: number } } } = {};

    // Verwerk sprint capaciteit alleen voor actieve medewerkers op het project
    if (planning.sprintCapacity) {
        for (const capacity of planning.sprintCapacity) {
            // Alleen capaciteiten voor het specifieke project meenemen
            if (capacity.project && capacity.project !== '') {
                if (!employeeData[capacity.employee]) {
                    employeeData[capacity.employee] = {};
                }
                if (!employeeData[capacity.employee][capacity.sprint]) {
                    employeeData[capacity.employee][capacity.sprint] = {
                        available: capacity.capacity,
                        planned: 0,
                        remaining: capacity.capacity
                    };
                }
            }
        }
    }

    // Verwerk gebruikte uren alleen voor actieve medewerkers
    if (planning.employeeSprintUsedHours) {
        for (const [employee, sprintData] of Object.entries(planning.employeeSprintUsedHours)) {
            // Alleen uren van actieve medewerkers tonen
            if (employeeData[employee]) {
                for (const [sprint, hours] of Object.entries(sprintData)) {
                    if (!employeeData[employee][sprint]) {
                        employeeData[employee][sprint] = {
                            available: 0,
                            planned: hours,
                            remaining: -hours
                        };
                    } else {
                        employeeData[employee][sprint].planned = hours;
                        employeeData[employee][sprint].remaining = employeeData[employee][sprint].available - hours;
                    }
                }
            }
        }
    }

    let html = '<table class="table table-striped table-bordered">';
    html += '<thead><tr class="table-dark text-dark"><th>Sprint</th><th>Medewerker</th><th>Effectieve uren</th><th>Geplande uren</th><th>Geplande issues</th><th>Resterende tijd</th></tr></thead><tbody>';

    for (const sprint of availableSprintNames) {
        let sprintTotalAvailable = 0;
        let sprintTotalPlanned = 0;
        let sprintTotalRemaining = 0;
        let sprintTotalIssues = 0;

        // Toon alle actieve medewerkers
        for (const [employee, sprintData] of Object.entries(employeeData)) {
            const data = sprintData[sprint];
            if (data) {
                const plannedIssues = planning.plannedIssues.filter(pi => 
                    pi.sprint === sprint && 
                    getAssigneeName(pi.issue.fields?.assignee) === employee
                );
                
                sprintTotalAvailable += data.available;
                sprintTotalPlanned += data.planned;
                sprintTotalRemaining += data.remaining;
                sprintTotalIssues += plannedIssues.length;

                html += `
                    <tr>
                        <td>${sprint}</td>
                        <td>${employee}</td>
                        <td>${data.available.toFixed(1)}</td>
                        <td>${data.planned.toFixed(1)}</td>
                        <td>${plannedIssues.map(pi => `${pi.issue.key} (${pi.hours.toFixed(1)} uur)`).join('<br>')}</td>
                        <td>${data.remaining.toFixed(1)}</td>
                    </tr>
                `;
            }
        }

        // Voeg totaalregel toe voor de sprint
        html += `
            <tr class="table-dark">
                <td><strong>${sprint} Totaal</strong></td>
                <td></td>
                <td><strong>${sprintTotalAvailable.toFixed(1)}</strong></td>
                <td><strong>${sprintTotalPlanned.toFixed(1)}</strong></td>
                <td><strong>${sprintTotalIssues}</strong></td>
                <td><strong>${sprintTotalRemaining.toFixed(1)}</strong></td>
            </tr>
        `;
    }

    html += '</tbody></table>';
    return html;
}

export function generateIssuesTable(issues: Issue[], planning: PlanningResult, sprintNames: Map<string, string>): string {
    let html = '<table class="table table-striped">';
    html += '<thead><tr><th>Key</th><th>Summary</th><th>Assignee</th><th>Sprint</th><th>Uren</th><th>Opvolgers</th><th>Status</th></tr></thead>';
    html += '<tbody>';

    for (const issue of issues) {
        const plannedIssue = planning.plannedIssues.find(pi => pi.issue.key === issue.key);
        const sprintName = plannedIssue ? sprintNames.get(plannedIssue.sprint) || plannedIssue.sprint : 'Unplanned';
        const hours = (issue.fields?.timeestimate || 0) / 3600;
        const assignee = typeof issue.fields?.assignee === 'object' ? issue.fields.assignee?.displayName : issue.fields?.assignee || 'Unassigned';
        
        // Haal opvolgers op via issuelinks
        const successors = issue.fields?.issuelinks
            ?.filter(link => 
                (link.type.name === 'Blocks' || link.type.name === 'Depends On') && 
                link.outwardIssue?.key === issue.key
            )
            .map(link => link.outwardIssue?.key)
            .filter((key): key is string => key !== undefined) || [];

        const successorIssues = successors.map(key => {
            const successorIssue = issues.find(i => i.key === key);
            const successorPlanned = planning.plannedIssues.find(pi => pi.issue.key === key);
            const successorSprint = successorPlanned ? sprintNames.get(successorPlanned.sprint) || successorPlanned.sprint : 'Unplanned';
            
            // Controleer of opvolger in dezelfde sprint staat
            const sameSprintWarning = successorPlanned && plannedIssue && successorPlanned.sprint === plannedIssue.sprint 
                ? '<span class="badge bg-warning">Zelfde sprint als voorganger</span>' 
                : '';
            
            return `<div>${key} (${successorSprint}) ${sameSprintWarning}</div>`;
        }).join('');

        // Bepaal status voor waarschuwingen
        let statusHtml = '';
        if (successors.length > 0) {
            const hasSameSprintSuccessor = successors.some(key => {
                const successorPlanned = planning.plannedIssues.find(pi => pi.issue.key === key);
                return successorPlanned && plannedIssue && successorPlanned.sprint === plannedIssue.sprint;
            });
            
            if (hasSameSprintSuccessor) {
                statusHtml = '<span class="badge bg-warning">Opvolger inzelfde sprint</span>';
            }
        }

        html += `<tr>
            <td>${issue.key}</td>
            <td>${issue.fields?.summary || ''}</td>
            <td>${assignee}</td>
            <td>${sprintName}</td>
            <td>${hours.toFixed(1)}</td>
            <td>${successorIssues || 'Geen'}</td>
            <td>${statusHtml}</td>
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
                <td>${((assignment[0].fields?.timeestimate || 0) / 3600).toFixed(1)}</td>
            </tr>`;
        }
    }

    html += '</tbody></table>';
    return html;
} 