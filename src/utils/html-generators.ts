import type { Issue, PlanningResult, EfficiencyData, WorkLog, SprintCapacity } from '../types.js';
import logger from '../logger.js';
import { getAssigneeName } from './assignee.js';

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
    logger.info('generateSprintHoursTable wordt aangeroepen');
    
    if (!planning.sprintHours) {
        logger.info('Geen sprint uren beschikbaar');
        return '<p>Geen sprint uren beschikbaar</p>';
    }

    // Log alle unieke assignees in plannedIssues
    const uniqueAssignees = [...new Set(planning.plannedIssues.map(pi => pi.assignee))];
    logger.info(`Unieke assignees in plannedIssues: ${JSON.stringify(uniqueAssignees)}`);

    logger.info(`Planning data: ${JSON.stringify({
        sprintHours: planning.sprintHours,
        plannedIssues: planning.plannedIssues.map(pi => ({
            key: pi.issue.key,
            sprint: pi.sprint,
            assignee: pi.assignee,
            hours: pi.hours
        }))
    })}`);

    // Verzamel alle beschikbare sprints uit sprintHours en sprintCapacity
    const availableSprints = new Set<string>();
    
    // Voeg sprints toe uit sprintHours
    if (planning.sprintHours) {
        Object.keys(planning.sprintHours).forEach(sprint => availableSprints.add(sprint));
    }
    
    // Voeg sprints toe uit sprintCapacity
    if (planning.sprintCapacity) {
        planning.sprintCapacity.forEach(capacity => availableSprints.add(capacity.sprint));
    }

    // Filter sprints waar issues in zijn gepland
    const availableSprintNames = Array.from(availableSprints)
        .filter(sprint => {
            // Check of er issues zijn gepland in deze sprint
            const hasPlannedIssues = planning.plannedIssues.some(pi => pi.sprint === sprint);
            // Check of er daadwerkelijk issues zijn gepland voor deze sprint
            const plannedIssuesInSprint = planning.plannedIssues.filter(pi => pi.sprint === sprint);
            return hasPlannedIssues && plannedIssuesInSprint.length > 0;
        })
        .sort((a, b) => parseInt(a) - parseInt(b));

    logger.info(`Beschikbare sprints: ${JSON.stringify(availableSprintNames)}`);

    // Verzamel eerst alle actieve medewerkers per project
    const activeEmployees = new Set<string>();
    const projectEmployees = new Map<string, Set<string>>(); // Map van project naar set van medewerkers

    if (planning.sprintCapacity) {
        for (const capacity of planning.sprintCapacity) {
            if (capacity.project && capacity.project !== '') {
                activeEmployees.add(capacity.employee);
                
                // Voeg medewerker toe aan project
                if (!projectEmployees.has(capacity.project)) {
                    projectEmployees.set(capacity.project, new Set<string>());
                }
                projectEmployees.get(capacity.project)?.add(capacity.employee);
            }
        }
    }

    // Verzamel alle medewerkers die issues hebben
    const employeesWithIssues = new Set<string>();
    for (const plannedIssue of planning.plannedIssues) {
        employeesWithIssues.add(plannedIssue.assignee);
    }

    // Combineer de sets om unieke medewerkers te krijgen
    const allEmployees = new Set([...activeEmployees, ...employeesWithIssues]);
    logger.info(`Alle unieke medewerkers: ${Array.from(allEmployees).join(', ')}`);

    const employeeData: { [key: string]: { [key: string]: { available: number; planned: number; remaining: number } } } = {};

    // Initialiseer employeeData voor alle unieke medewerkers
    for (const employee of allEmployees) {
        employeeData[employee] = {};
    }

    // Verwerk sprint capaciteit
    if (planning.sprintCapacity) {
        for (const capacity of planning.sprintCapacity) {
            if (capacity.project && capacity.project !== '') {
                if (!employeeData[capacity.employee][capacity.sprint]) {
                    // Zet effectieve uren op 0 voor Peter van Diermen en Unassigned
                    const available = (capacity.employee === 'Peter van Diermen' || capacity.employee === 'Unassigned') ? 0 : capacity.capacity;
                    employeeData[capacity.employee][capacity.sprint] = {
                        available: available,
                        planned: 0,
                        remaining: available
                    };
                }
            }
        }
    }

    // Bereken geplande uren per sprint en medewerker
    for (const plannedIssue of planning.plannedIssues) {
        const { sprint, assignee, hours } = plannedIssue;
        if (!employeeData[assignee][sprint]) {
            employeeData[assignee][sprint] = {
                available: 0,
                planned: 0,
                remaining: 0
            };
        }
        employeeData[assignee][sprint].planned += hours;
        employeeData[assignee][sprint].remaining = employeeData[assignee][sprint].available - employeeData[assignee][sprint].planned;
    }

    let html = '<table class="table table-striped table-bordered" style="width: 100%;">';
    html += '<thead><tr class="table-dark text-dark">';
    html += '<th style="width: 10%;">Sprint</th>';
    html += '<th style="width: 15%;">Medewerker</th>';
    html += '<th style="width: 15%; text-align: center;">Effectieve uren</th>';
    html += '<th style="width: 15%; text-align: center;">Geplande uren</th>';
    html += '<th style="width: 35%;">Geplande issues</th>';
    html += '<th style="width: 10%; text-align: center;">Resterende tijd</th>';
    html += '</tr></thead><tbody>';

    for (const sprint of availableSprintNames) {
        let sprintTotalAvailable = 0;
        let sprintTotalPlanned = 0;
        let sprintTotalRemaining = 0;
        let sprintTotalIssues = 0;

        // Bepaal het project voor deze sprint
        const sprintProject = planning.sprintCapacity?.find(c => c.sprint === sprint)?.project || '';
        const sprintEmployees = sprintProject ? projectEmployees.get(sprintProject) || new Set<string>() : new Set<string>();

        // Toon alleen medewerkers die bij het project horen of issues hebben
        for (const employee of allEmployees) {
            // Toon de medewerker alleen als ze bij het project horen of issues hebben in deze sprint
            const hasIssuesInSprint = planning.plannedIssues.some(pi => 
                pi.sprint === sprint && 
                getAssigneeName(pi.issue.fields?.assignee) === employee
            );
            
            if (!sprintEmployees.has(employee) && !hasIssuesInSprint) continue;

            const data = employeeData[employee][sprint];
            if (data) {
                const plannedIssues = planning.plannedIssues.filter(pi => 
                    pi.sprint === sprint && 
                    getAssigneeName(pi.issue.fields?.assignee) === employee
                );
                
                // Update totalen alleen als het geen Peter van Diermen of Unassigned is
                if (employee !== 'Peter van Diermen' && employee !== 'Unassigned') {
                    sprintTotalAvailable += data.available;
                    sprintTotalPlanned += data.planned;
                    sprintTotalRemaining += data.remaining;
                }
                sprintTotalIssues += plannedIssues.length;

                // Format de geplande issues met rode tekst voor issues die te laat zijn ingepland
                const formattedIssues = plannedIssues.map(pi => {
                    const issueDueDate = pi.issue.fields?.duedate ? new Date(pi.issue.fields.duedate) : null;
                    const sprintInfo = planning.sprints.find(s => s.sprint === sprint);
                    const sprintStartDate = sprintInfo?.startDate ? new Date(sprintInfo.startDate) : null;
                    const isOverdue = issueDueDate && sprintStartDate && issueDueDate < sprintStartDate;
                    const issueText = `${pi.issue.key} (${pi.hours.toFixed(1)} uur)`;
                    return isOverdue ? `<span style="color: red !important;">${issueText}</span>` : issueText;
                }).join('<br>');

                html += `
                    <tr>
                        <td style="width: 10%;">${sprint}</td>
                        <td style="width: 15%;">${employee}</td>
                        <td style="width: 15%; text-align: center;">${data.available.toFixed(1)}</td>
                        <td style="width: 15%; text-align: center;">${data.planned.toFixed(1)}</td>
                        <td style="width: 35%;">${formattedIssues}</td>
                        <td style="width: 10%; text-align: center;">${data.remaining.toFixed(1)}</td>
                    </tr>
                `;
            }
        }

        // Voeg totaalregel toe voor de sprint
        html += `
            <tr class="table-dark">
                <td style="width: 10%;"><strong>${sprint} Totaal</strong></td>
                <td style="width: 15%;"></td>
                <td style="width: 15%; text-align: center;"><strong>${sprintTotalAvailable.toFixed(1)}</strong></td>
                <td style="width: 15%; text-align: center;"><strong>${sprintTotalPlanned.toFixed(1)}</strong></td>
                <td style="width: 35%;"><strong>${sprintTotalIssues}</strong></td>
                <td style="width: 10%; text-align: center;"><strong>${sprintTotalRemaining.toFixed(1)}</strong></td>
            </tr>
        `;
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