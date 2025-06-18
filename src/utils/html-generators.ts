import type { Issue, PlanningResult, EfficiencyData, WorkLog, SprintCapacity, ProjectConfig } from '../types.js';
import logger from '../logger.js';
import { getAssigneeName } from './assignee.js';
import { getGoogleSheetsData } from '../google-sheets.js';

//export function generateEfficiencyTable(efficiencyData: EfficiencyData[]): string {
//    let html = '<table class="table table-striped">';
//    html += '<thead><tr><th>Medewerker</th><th>Gewerkt (uren)</th><th>Geschat (uren)</th><th>Efficiency (%)</th></tr></thead>';
//    html += '<tbody>';

//    for (const data of efficiencyData) {
//        html += `<tr>
//            <td>${data.assignee}</td>
//            <td>${data.loggedHours.toFixed(2)}</td>
//            <td>${data.estimatedHours.toFixed(2)}</td>
//            <td>${data.efficiency.toFixed(2)}</td>
//        </tr>`;
//    }

//    html += '</tbody></table>';
//    return html;
//}

export async function generateSprintHoursTable(planning: PlanningResult): Promise<string> {
    const sprintNames = new Map<string, string>();
    const projectEmployees = new Map<string, Set<string>>();
    const projectConfigs = new Map<string, ProjectConfig>();

    // Verzamel alle project configuraties
    if (planning.projectConfigs) {
        for (const config of planning.projectConfigs) {
            const projectName = config.project.toUpperCase();
            projectConfigs.set(projectName, config);
        }
    }

    // Vul de projectEmployees map met de medewerkers uit de Employees tab
    
    // Haal alle medewerkers op uit de Employees tab
    const employees = await getGoogleSheetsData('Employees!A1:H');
    if (!employees) {
        logger.error('Geen medewerkers gevonden in de Employees tab');
        return '';
    }

    // Haal de kolomnamen op uit de eerste rij
    const headers = employees[0];
    const nameIndex = headers.findIndex((h: string) => h.toLowerCase() === 'naam');
    const projectIndex = headers.findIndex((h: string) => h.toLowerCase() === 'project');
    
    if (nameIndex === -1 || projectIndex === -1) {
        logger.error('Kan de Naam of Project kolom niet vinden in de Employees tab');
        return '';
    }

    // Verzamel alle beschikbare sprints per project
    const projectSprints = new Map<string, Set<string>>();
    const projectEmployeeSets = new Map<string, Set<string>>();

    // Initialiseer de maps voor elk project uit de project configuraties
    for (const [projectName, config] of projectConfigs) {
        projectSprints.set(projectName.toLowerCase(), new Set<string>());
        projectEmployeeSets.set(projectName.toLowerCase(), new Set<string>());
    }

    // Verzamel sprints en medewerkers per project uit de planned issues
    for (const plannedIssue of planning.plannedIssues) {
        const { sprint, assignee, issue, project } = plannedIssue;
        
        if (project) {
            // Voeg sprint toe aan het project
            const sprints = projectSprints.get(project.toLowerCase());
            if (sprints) {
                sprints.add(sprint);
            }

            // Voeg medewerker toe aan het project
            const employees = projectEmployeeSets.get(project.toLowerCase());
            if (employees && assignee) {
                employees.add(assignee);
            }
        }
    }

    // Voeg medewerkers toe aan hun toegewezen projecten uit de Employees tab
    for (let i = 1; i < employees.length; i++) {
        const row = employees[i];
        const employee = row[nameIndex] as string;
        const project = (row[projectIndex] as string)?.toLowerCase().trim();
        
        if (employee && 
            employee.toLowerCase() !== 'peter van diermen' && 
            employee.toLowerCase() !== 'unassigned' && 
            project && 
            !project.includes(',')) {
            
            // Zoek het bijbehorende project in de project configuraties
            const matchingProject = Array.from(projectConfigs.keys()).find(p => 
                p.toLowerCase() === project.toLowerCase()
            );

            if (matchingProject) {
                const employeeSet = projectEmployeeSets.get(matchingProject.toLowerCase());
                if (employeeSet) {
                    employeeSet.add(employee);
                }
            }
        }
    }

    // Log de informatie per project
    for (const [projectName, config] of projectConfigs) {
        const sprints = projectSprints.get(projectName.toLowerCase());
        const employees = projectEmployeeSets.get(projectName.toLowerCase());
        
   }

    // Kopieer de verzamelde medewerkers naar de projectEmployees map
    projectEmployeeSets.forEach((employees, project) => {
        projectEmployees.set(project, new Set(employees));
    });


    // Verzamel alle beschikbare sprints
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


    // Verzamel alle medewerkers die issues hebben
    const employeesWithIssues = new Set<string>();
    for (const plannedIssue of planning.plannedIssues) {
        employeesWithIssues.add(plannedIssue.assignee);
    }

    // Combineer de sets om unieke medewerkers te krijgen
    const allEmployees = new Set<string>();
    projectEmployees.forEach(employees => {
        employees.forEach(employee => allEmployees.add(employee));
    });
    employeesWithIssues.forEach(employee => allEmployees.add(employee));

    const employeeData: { [key: string]: { [key: string]: { available: number; planned: number; remaining: number } } } = {};

    // Initialiseer employeeData voor alle unieke medewerkers
    for (const employee of allEmployees) {
        employeeData[employee] = {};
        // Initialiseer voor elke sprint
        for (const sprint of availableSprintNames) {
            employeeData[employee][sprint] = {
                available: 0,
                planned: 0,
                remaining: 0
            };
        }
    }

    // Verwerk sprint capaciteit
    if (planning.sprintCapacity) {
        for (const capacity of planning.sprintCapacity) {
            if (capacity.project && capacity.project !== '') {
                // Peter van Diermen en Unassigned moeten altijd 0 uur capaciteit hebben
                const available = (capacity.employee === 'Peter van Diermen' || capacity.employee === 'Unassigned') ? 0 : capacity.capacity;
                if (employeeData[capacity.employee] && employeeData[capacity.employee][capacity.sprint]) {
                    employeeData[capacity.employee][capacity.sprint].available = available;
                    employeeData[capacity.employee][capacity.sprint].remaining = available;
                }
            }
        }
    }

    // Bereken geplande uren per sprint en medewerker
    for (const plannedIssue of planning.plannedIssues) {
        const { sprint, assignee, hours } = plannedIssue;
        if (employeeData[assignee] && employeeData[assignee][sprint]) {
            employeeData[assignee][sprint].planned += hours;
            employeeData[assignee][sprint].remaining = employeeData[assignee][sprint].available - employeeData[assignee][sprint].planned;
        }
    }

    let html = '<table class="table table-striped table-bordered" style="width: 100%;">';
    html += '<thead><tr class="table-dark text-dark">';
    html += '<th style="width: 10%;">Sprint</th>';
    html += '<th style="width: 15%;">Medewerker</th>';
    html += '<th style="width: 15%;">Effectieve uren</th>';
    html += '<th style="width: 15%;">Geplande uren</th>';
    html += '<th style="width: 35%;">Geplande issues</th>';
    html += '<th style="width: 10%;">Resterende tijd</th>';
    html += '</tr></thead>';
    html += '<tbody>';

    // Voor elke sprint
    for (const sprint of availableSprintNames) {
        const sprintName = sprintNames.get(sprint) || sprint;
        let sprintTotalAvailable = 0;
        let sprintTotalPlanned = 0;
        let sprintTotalRemaining = 0;
        let sprintTotalIssues = 0;

        // Bepaal het project voor deze sprint op basis van de issues
        const sprintIssues = planning.plannedIssues.filter(pi => pi.sprint === sprint);
        const sprintProjectName = sprintIssues.length > 0 ? sprintIssues[0].project?.toLowerCase() || '' : '';
        
        
        // Haal alle actieve medewerkers op voor dit project
        const activeEmployees = projectEmployees.get(sprintProjectName) || new Set<string>();

        // Voor elke medewerker in het project
        for (const employee of activeEmployees) {
            const data = employeeData[employee]?.[sprint] || {
                available: 0,
                planned: 0,
                remaining: 0
            };
            const plannedIssues = planning.plannedIssues.filter(pi => 
                pi.sprint === sprint && 
                getAssigneeName(pi.issue.fields?.assignee) === employee &&
                pi.project?.toLowerCase() === sprintProjectName // Gebruik projectnaam uit planning en vergelijk case-insensitive
            );
            
            // Update totalen voor alle medewerkers
            sprintTotalAvailable += data.available;
            sprintTotalPlanned += data.planned;
            sprintTotalRemaining += data.remaining;
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
                    <td>${sprintName}</td>
                    <td>${employee}</td>
                    <td style="text-align: center;">${data.available.toFixed(1)}</td>
                    <td style="text-align: center;">${data.planned.toFixed(1)}</td>
                    <td>${formattedIssues}</td>
                    <td style="text-align: center;">${data.remaining.toFixed(1)}</td>
                </tr>
            `;
        }

        // Voeg een rij toe met de totalen voor deze sprint
        html += `
            <tr class="table-secondary">
                <td><strong>${sprintName}</strong></td>
                <td><strong>Totaal</strong></td>
                <td style="text-align: center;"><strong>${sprintTotalAvailable.toFixed(1)}</strong></td>
                <td style="text-align: center;"><strong>${sprintTotalPlanned.toFixed(1)}</strong></td>
                <td><strong>${sprintTotalIssues} issues</strong></td>
                <td style="text-align: center;"><strong>${sprintTotalRemaining.toFixed(1)}</strong></td>
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

            if (assignment && assignment.length > 0) {
                html += `
                <tr>
                    <td>${sprintName}</td>
                    <td>${assignee}</td>
                    <td>${assignment[0].key} - ${assignment[0].fields?.summary || ''}</td>
                    <td>${((assignment[0].fields?.timeestimate || 0) / 3600).toFixed(1)}</td>
                </tr>`;
            }
        }
    }

    html += '</tbody></table>';
    return html;
}