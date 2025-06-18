import type { Issue, PlanningResult, PlannedIssue, IssueLink, EfficiencyData, ProjectConfig, WorklogConfig, WorkLog, SprintCapacity, SprintDates, EmployeeCapacity, SprintPlanning, EmployeePlanning } from '../types.js';
import { getSprintCapacityFromSheet } from '../google-sheets.js';
import logger from '../logger.js';
import { getSuccessors, getPredecessors } from '../utils/jira-helpers.js';
import { getAssigneeName } from '../utils/assignee.js';
import { getProjectConfigsFromSheet } from '../google-sheets.js';
import { calculateCurrentSprint } from '../utils/date-utils.js';
import { getAllLinkedIssues } from '../jira.js';
import { getGoogleSheetsData } from '../google-sheets.js';

// Definieer de volgorde van statussen
export const STATUS_ORDER: Record<string, number> = {
    'Resolved': 0,
    'In Review': 1,
    'Ready for testing': 2,
    'Open': 3,
    'Reopend': 4,
    'Registered': 5,
    'Waiting': 6,
    'In Progress': 7,
    'Testing': 8
};

// Helper functie om te valideren of de planning voldoet aan de volgorde-eisen
const validatePlanningOrder = async (planning: PlanningResult): Promise<boolean> => {
    let isValid = true;
    const processedIssues = new Set<string>();

    // Functie om een issue en zijn gerelateerde issues te verplaatsen
    const moveIssueAndRelated = async (issue: PlannedIssue, newSprint: string) => {
        if (processedIssues.has(issue.issue.key)) return;
        processedIssues.add(issue.issue.key);

        // Controleer of het issue al in de juiste sprint staat
        if (issue.sprint === newSprint) {
            logger.info(`Issue ${issue.issue.key} staat al in sprint ${newSprint}, overslaan...`);
            return;
        }

        // Als het issue naar sprint 100 gaat, verplaats dan ook alle opvolgers naar sprint 100
        if (newSprint === '100') {
            const successors = getSuccessors(issue.issue);
            for (const successorKey of successors) {
                const successor = planning.plannedIssues.find(pi => pi.issue.key === successorKey);
                if (successor && !processedIssues.has(successorKey)) {
                    logger.info(`Opvolger ${successorKey} wordt verplaatst naar sprint 100`);
                    await moveIssueAndRelated(successor, '100');
                }
            }
        }

        // Sla de oude sprint en uren op
        const oldSprint = issue.sprint;
        const issueHours = issue.hours;

        // Verwijder de uren uit de oude sprint
        if (planning.sprintHours[oldSprint]?.[issue.assignee]) {
            planning.sprintHours[oldSprint][issue.assignee] -= issueHours;
        }
        if (planning.employeeSprintUsedHours[issue.assignee]?.[oldSprint]) {
            planning.employeeSprintUsedHours[issue.assignee][oldSprint] -= issueHours;
        }

        // Verwijder het issue uit de oude sprint assignments
        if (planning.sprintAssignments[oldSprint]?.[issue.assignee]) {
            planning.sprintAssignments[oldSprint][issue.assignee] = 
                planning.sprintAssignments[oldSprint][issue.assignee].filter(i => i.key !== issue.issue.key);
        }

        // Gebruik planIssue om het issue te verplaatsen
        const projectConfig = planning.projectConfigs?.[0];
        if (!projectConfig) {
            logger.error('Geen project configuratie gevonden');
            return;
        }

        const result = await planIssue(
            issue.issue,
            newSprint,
            planning.sprints.reduce((acc, s) => {
                if (s.startDate) {
                    const startDate = new Date(s.startDate);
                    const endDate = new Date(startDate);
                    endDate.setDate(startDate.getDate() + 13); // Sprint duurt 14 dagen
                    acc[s.sprint] = { start: startDate, end: endDate };
                }
                return acc;
            }, {} as { [key: string]: { start: Date; end: Date } }),
            new Date(),
            planning.sprintCapacity.map(sc => ({
                employee: sc.employee,
                capacity: sc.capacity,
                project: sc.project
            })),
            planning.sprintCapacity,
            planning,
            projectConfig
        );

        if (!result.success) {
            logger.error(`Kon issue ${issue.issue.key} niet verplaatsen naar sprint ${newSprint}: ${result.reason}`);
            // Herstel de oude sprint als het verplaatsen mislukt
            if (planning.sprintHours[oldSprint]?.[issue.assignee]) {
                planning.sprintHours[oldSprint][issue.assignee] += issueHours;
            }
            if (planning.employeeSprintUsedHours[issue.assignee]?.[oldSprint]) {
                planning.employeeSprintUsedHours[issue.assignee][oldSprint] += issueHours;
            }
            if (planning.sprintAssignments[oldSprint]?.[issue.assignee]) {
                planning.sprintAssignments[oldSprint][issue.assignee].push(issue.issue);
            }
            return;
        }

        // Update het issue object met de nieuwe sprint
        issue.sprint = newSprint;

        // Verplaats voorgangers naar een eerdere sprint
        const predecessors = getPredecessors(issue.issue);
        for (const predecessorKey of predecessors) {
            const predecessor = planning.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (predecessor && !processedIssues.has(predecessorKey)) {
                const predecessorSprintIndex = planning.sprints.findIndex(s => s.sprint === predecessor.sprint);
                const newSprintIndex = planning.sprints.findIndex(s => s.sprint === newSprint);
                if (predecessorSprintIndex >= newSprintIndex) {
                    const earlierSprint = planning.sprints[newSprintIndex - 1]?.sprint || '100';
                    logger.info(`Voorganger ${predecessorKey} wordt verplaatst naar sprint ${earlierSprint}`);
                    await moveIssueAndRelated(predecessor, earlierSprint);
                }
            }
        }

        // Verplaats opvolgers naar een latere sprint
        const successors = getSuccessors(issue.issue);
        for (const successorKey of successors) {
            const successor = planning.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor && !processedIssues.has(successorKey)) {
                const successorSprintIndex = planning.sprints.findIndex(s => s.sprint === successor.sprint);
                const newSprintIndex = planning.sprints.findIndex(s => s.sprint === newSprint);
                if (successorSprintIndex <= newSprintIndex) {
                    const laterSprint = planning.sprints[newSprintIndex + 1]?.sprint || '100';
                    logger.info(`Opvolger ${successorKey} wordt verplaatst naar sprint ${laterSprint}`);
                    await moveIssueAndRelated(successor, laterSprint);
                }
            }
        }
    };

    // Bepaal de huidige sprint
    const currentDate = new Date();
    const currentSprintIndex = findSprintIndexForDate(currentDate, planning.sprintCapacity);
    const currentSprintName = currentSprintIndex !== -1 ? planning.sprintCapacity[currentSprintIndex].sprint : null;

    // Valideer alle issues
    for (const plannedIssue of planning.plannedIssues) {
        const issue = plannedIssue.issue;
        
        // Valideer due date
        const dueDate = issue.fields?.duedate ? new Date(issue.fields.duedate) : null;
        if (dueDate) {
            const sprintName = plannedIssue.sprint;
            const sprint = planning.sprints.find(s => s.sprint === sprintName);
            if (sprint?.startDate) {
                const sprintStartDate = new Date(sprint.startDate);
                const sprintEndDate = new Date(sprintStartDate);
                sprintEndDate.setDate(sprintStartDate.getDate() + 14); // Sprint duurt 2 weken

                // Bepaal de huidige sprint
                const currentDate = new Date();
                const currentSprintIndex = findSprintIndexForDate(currentDate, planning.sprintCapacity);
                const currentSprintName = currentSprintIndex !== -1 ? planning.sprintCapacity[currentSprintIndex].sprint : null;

                // Als de due date voor de sprint start, moet het issue in een eerdere sprint
                // MAAR alleen als het niet de huidige sprint is
                if (dueDate < sprintStartDate && sprintName !== currentSprintName) {
                    logger.info(`\nFout: Issue ${issue.key} heeft een due date (${dueDate.toISOString()}) voor sprint ${sprintName} (${sprintStartDate.toISOString()})`);
                    
                    // Vind de eerste sprint die na de due date start
                    const sprintIndex = planning.sprints.findIndex(s => {
                        const startDate = new Date(s.startDate || '');
                        return startDate >= dueDate;
                    });
                    
                    if (sprintIndex !== -1) {
                        const newSprint = planning.sprints[sprintIndex].sprint;
                        // Controleer of het issue al in de juiste sprint staat
                        if (plannedIssue.sprint !== newSprint) {
                            logger.info(`Issue ${issue.key} wordt verplaatst naar sprint ${newSprint}`);
                            await moveIssueAndRelated(plannedIssue, newSprint);
                            isValid = false;
                        }
                    }
                }
            }
        }

        // Valideer voorgangers
        const predecessors = getPredecessors(issue);
        for (const predecessorKey of predecessors) {
            const predecessor = planning.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (predecessor) {
                const issueSprintIndex = planning.sprints.findIndex(s => s.sprint === plannedIssue.sprint);
                const predecessorSprintIndex = planning.sprints.findIndex(s => s.sprint === predecessor.sprint);
                
                // Als de voorganger in sprint 100 zit, moet het issue ook in sprint 100
                if (predecessor.sprint === '100' && plannedIssue.sprint !== '100') {
                    logger.info(`\nFout: Voorganger ${predecessorKey} is in sprint 100, maar ${issue.key} is in sprint ${plannedIssue.sprint}`);
                    logger.info(`Issue ${issue.key} wordt verplaatst naar sprint 100`);
                    await moveIssueAndRelated(plannedIssue, '100');
                    isValid = false;
                }
                // Als de voorganger in een latere sprint zit, probeer te plannen vanaf de eerste sprint na de voorganger
                else if (predecessorSprintIndex > issueSprintIndex) {
                    logger.info(`\nFout: Voorganger ${predecessorKey} is in sprint ${predecessor.sprint}, maar ${issue.key} is in sprint ${plannedIssue.sprint}`);
                    
                    // Vind de eerste sprint na de voorganger
                    const nextSprintIndex = predecessorSprintIndex + 1;
                    if (nextSprintIndex < planning.sprints.length) {
                        const nextSprint = planning.sprints[nextSprintIndex].sprint;
                        logger.info(`Proberen issue ${issue.key} te plannen vanaf sprint ${nextSprint}`);
                        
                        // Gebruik findFirstAvailableSprint om een geschikte sprint te vinden
                        const newSprint = await findFirstAvailableSprint(issue, planning, currentDate);
                        if (newSprint) {
                            logger.info(`Issue ${issue.key} wordt verplaatst naar sprint ${newSprint}`);
                            await moveIssueAndRelated(plannedIssue, newSprint);
                            isValid = false;
                        }
                    } else {
                        // Als er geen sprint na de voorganger is, gebruik sprint 100
                        logger.info(`Issue ${issue.key} wordt verplaatst naar sprint 100`);
                        await moveIssueAndRelated(plannedIssue, '100');
                        isValid = false;
                    }
                }
            }
        }

        // Valideer opvolgers
        const successors = getSuccessors(issue);
        for (const successorKey of successors) {
            const successor = planning.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor) {
                const issueSprintIndex = planning.sprints.findIndex(s => s.sprint === plannedIssue.sprint);
                const successorSprintIndex = planning.sprints.findIndex(s => s.sprint === successor.sprint);
                
                // Als de opvolger in dezelfde sprint of een eerdere sprint staat dan het issue
                if (successorSprintIndex <= issueSprintIndex) {
                    logger.info(`\nFout: Opvolger ${successorKey} is gepland in sprint ${successor.sprint} terwijl ${issue.key} in sprint ${plannedIssue.sprint} zit`);
                    
                    // Verplaats de opvolger naar een latere sprint
                    const newSprintIndex = issueSprintIndex + 1;
                    if (newSprintIndex < planning.sprints.length) {
                        const newSprint = planning.sprints[newSprintIndex].sprint;
                        logger.info(`Opvolger ${successorKey} wordt verplaatst naar sprint ${newSprint}`);
                        await moveIssueAndRelated(successor, newSprint);
                        isValid = false;
                    }
                }
            }
        }
    }

    return isValid;
};

// Helper functie om te controleren of een issue een opvolger is
function isSuccessor(issue: Issue): boolean {
    return issue.fields?.issuelinks?.some(link => 
        (link.type.name === 'Blocks' || 
         link.type.name === 'Depends On' || 
         (link.type.name === 'Predecessor' && link.type.inward === 'is a predecessor of')) && 
        link.inwardIssue?.key === issue.key
    ) || false;
}

// Helper functie om de sprint index te vinden voor een gegeven datum
function findSprintIndexForDate(date: Date, sprints: SprintCapacity[]): number {
    return sprints.findIndex(s => {
        if (!s.startDate) return false;
        const sprintStartDate = new Date(s.startDate);
        const sprintEndDate = new Date(sprintStartDate);
        sprintEndDate.setDate(sprintStartDate.getDate() + 14); // Sprint duurt 2 weken (14 dagen, inclusief begin- en einddatum)
        return date >= sprintStartDate && date <= sprintEndDate;
    });
}

// Helper functie om de eerste sprint na een datum te vinden
function findFirstSprintAfterDate(date: Date, sprints: SprintCapacity[]): number {
    // Sorteer de sprints op sprint nummer
    const sortedSprints = [...sprints].sort((a, b) => parseInt(a.sprint) - parseInt(b.sprint));

    return sortedSprints.findIndex(s => {
        if (!s.startDate) return false;
        const sprintStartDate = new Date(s.startDate);
        // Zet de tijd op 00:00:00
        sprintStartDate.setHours(0, 0, 0, 0);
        return sprintStartDate > date;
    });
}

// Helper functie om de eerste beschikbare sprint te vinden
export async function findFirstAvailableSprint(
    issue: Issue,
    planningResult: PlanningResult,
    currentDate: Date
): Promise<string> {
    const issueKey = issue.key;
    const assignee = getAssigneeName(issue.fields?.assignee);
    const dueDate = issue.fields?.duedate;
    const issueHours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
    const project = issue.fields?.project?.key || '';

    // Extra logging voor EET-6464
    if (issueKey === 'EET-6464') {
        logger.info(`\n=== START PLANNEN EET-6464 ===`);
        logger.info(`Assignee: ${assignee}`);
        logger.info(`Due date: ${dueDate}`);
        logger.info(`Issue uren: ${issueHours}`);
        logger.info(`Project: ${project}`);
    }

    // Verzamel alle sprints uit sprintCapacity
    const sprintNames = [...new Set(planningResult.sprintCapacity.map(c => c.sprint))]
        .sort((a, b) => parseInt(a) - parseInt(b));

    // Bepaal de start sprint op basis van due date of huidige datum
    let startFromIndex = 0;
    if (dueDate) {
        const dueDateObj = new Date(dueDate);
        const dueDateSprintIndex = findSprintIndexForDate(dueDateObj, planningResult.sprintCapacity);
        if (dueDateSprintIndex !== -1) {
            startFromIndex = dueDateSprintIndex;
        }
    } else {
        const currentSprintIndex = findSprintIndexForDate(currentDate, planningResult.sprintCapacity);
        if (currentSprintIndex !== -1) {
            startFromIndex = currentSprintIndex;
        }
    }

    if (issueKey === 'EET-6464') {
        logger.info(`Start index: ${startFromIndex}`);
    }

    // Zoek de eerste sprint met voldoende capaciteit vanaf de berekende start sprint
    for (let i = startFromIndex; i < sprintNames.length; i++) {
        const sprintName = sprintNames[i];
        
        // Extra logging voor EET-6464
        if (issueKey === 'EET-6464') {
            logger.info(`\nProberen sprint ${sprintName} (index ${i})`);
        }
        
        // Sprint 100 is alleen beschikbaar als laatste optie
        if (sprintName === '100') {
            if (issueKey === 'EET-6464') {
                logger.info(`Sprint 100 wordt overgeslagen`);
            }
            continue;
        }

        // Controleer of er voorgangers zijn die in deze of latere sprint zijn gepland
        const predecessors = getPredecessors(issue);
        const hasPredecessorsInLaterSprints = predecessors.some(predKey => {
            const predIssue = planningResult.plannedIssues.find(pi => pi.issue.key === predKey);
            if (!predIssue) return false;
            const predSprintIndex = sprintNames.indexOf(predIssue.sprint);
            return predSprintIndex >= i;
        });

        if (hasPredecessorsInLaterSprints) {
            if (issueKey === 'EET-6464') {
                logger.info(`Voorgangers gevonden in deze of latere sprint, volgende sprint proberen`);
            }
            continue;
        }

        // Controleer capaciteit
        const { canFit, reason } = checkSprintCapacity(
            issue,
            sprintName,
            planningResult.sprintDates,
            currentDate,
            planningResult.employeeCapacities,
            planningResult.sprintCapacity,
            planningResult.projectConfigs || [],
            planningResult.plannedIssues || []
        );

        if (canFit) {
            if (issueKey === 'EET-6464') {
                logger.info(`Issue kan worden gepland in sprint ${sprintName}`);
            }
            return sprintName;
        } else if (issueKey === 'EET-6464') {
            logger.info(`Onvoldoende capaciteit in sprint ${sprintName}: ${reason}`);
            logger.info(`Proberen volgende sprint...`);
        }
    }

    // Als er geen geschikte sprint is gevonden, gebruik sprint 100
    if (issueKey === 'EET-6464') {
        logger.info(`Geen geschikte sprint gevonden, gebruik sprint 100`);
    }
    return '100';
}

// Helper functie om de beschikbare capaciteit te berekenen
function getAvailableCapacity(sprintName: string, assignee: string, planningResult: PlanningResult): number {
    // Speciale behandeling voor Peter van Diermen en Unassigned
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        // Bereken de totale sprint capaciteit
        const totalSprintCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .reduce((sum, c) => sum + c.capacity, 0);

        // Bereken alle geplande uren in deze sprint
        const plannedIssuesHours = planningResult.plannedIssues
            .filter(pi => pi.sprint === sprintName)
            .reduce((sum, pi) => sum + (pi.issue.fields?.timeestimate || 0) / 3600, 0);

        // Trek de uren van de geplande issues af van de beschikbare sprint capaciteit
        return totalSprintCapacity - plannedIssuesHours;
    }

    // Voor andere medewerkers: controleer zowel individuele als totale sprint capaciteit
    // Bereken de individuele capaciteit van de medewerker
    const employeeCapacity = planningResult.sprintCapacity
        .find(c => c.sprint === sprintName && c.employee === assignee)?.capacity || 0;

    // Bereken de gebruikte uren van de medewerker
    const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;

    // Bereken de totale sprint capaciteit
    const totalSprintCapacity = planningResult.sprintCapacity
        .filter(c => c.sprint === sprintName)
        .reduce((sum, c) => sum + c.capacity, 0);

    // Bereken de uren van de al ingeplande issues in deze sprint
    const plannedIssuesHours = planningResult.plannedIssues
        .filter(pi => pi.sprint === sprintName)
        .reduce((sum, pi) => sum + (pi.issue.fields?.timeestimate || 0) / 3600, 0);

    const individualAvailable = employeeCapacity - usedHours;
    const sprintAvailable = totalSprintCapacity - plannedIssuesHours;

    // Gebruik het minimum van individuele en sprint capaciteit
    return Math.min(individualAvailable, sprintAvailable);
}

// Helper functie om alle opvolgers in de keten te vinden
const getAllSuccessorsInChain = (issue: Issue, allIssues: Issue[]): Set<string> => {
    const successors = new Set<string>();
    const directSuccessors = getSuccessors(issue);
    
    for (const successorKey of directSuccessors) {
        successors.add(successorKey);
        const successor = allIssues.find(i => i.key === successorKey);
        if (successor) {
            const chainSuccessors = getAllSuccessorsInChain(successor, allIssues);
            chainSuccessors.forEach(s => successors.add(s));
        }
    }
    
    return successors;
};

// Helper functie om alle voorgangers in de keten te vinden
const getAllPredecessorsInChain = (issue: Issue, allIssues: Issue[]): Set<string> => {
    const predecessors = new Set<string>();
    const directPredecessors = getPredecessors(issue);
    
    for (const predecessorKey of directPredecessors) {
        predecessors.add(predecessorKey);
        const predecessor = allIssues.find(i => i.key === predecessorKey);
        if (predecessor) {
            const chainPredecessors = getAllPredecessorsInChain(predecessor, allIssues);
            chainPredecessors.forEach(p => predecessors.add(p));
        }
    }
    
    return predecessors;
};

// Helper functie om te controleren of een issue in een eerdere sprint zit dan zijn opvolgers
const validateIssueSprintOrder = (issue: Issue, sprintName: string, planningResult: PlanningResult): boolean => {
    const successors = getSuccessors(issue);
    const issueSprintIndex = planningResult.sprints.findIndex(s => s.sprint === sprintName);
    
    logger.info(`\nValidatie sprint volgorde voor issue ${issue.key}:`);
    logger.info(`- Sprint index: ${issueSprintIndex}`);
    
    // Als er opvolgers zijn, moet het issue in een eerdere sprint komen
    if (successors.length > 0) {
        // Vind de eerste sprint van de opvolgers
        let firstSuccessorSprintIndex = planningResult.sprints.length;
        for (const successorKey of successors) {
            const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor) {
                const successorSprintIndex = planningResult.sprints.findIndex(s => s.sprint === successor.sprint);
                if (successorSprintIndex < firstSuccessorSprintIndex) {
                    firstSuccessorSprintIndex = successorSprintIndex;
                }
            }
        }
        
        // Als er al opvolgers gepland zijn, controleer of het issue in een eerdere sprint komt
        if (firstSuccessorSprintIndex < planningResult.sprints.length) {
            if (issueSprintIndex >= firstSuccessorSprintIndex) {
                logger.info(`- FOUT: Issue ${issue.key} kan niet in sprint ${sprintName} worden gepland omdat het opvolgers heeft in sprint ${planningResult.sprints[firstSuccessorSprintIndex].sprint}`);
                return false;
            }
        }
    }
    
    logger.info(`- OK: Issue ${issue.key} kan in sprint ${sprintName} worden gepland`);
    return true;
};

// Helper functie om te controleren of een issue opvolgers heeft die al gepland zijn
const hasPlannedSuccessors = (issue: Issue, planningResult: PlanningResult): boolean => {
    const successors = getSuccessors(issue);
    
    // Controleer of er opvolgers zijn die al gepland zijn
    const plannedSuccessors = successors.filter(successorKey => 
        planningResult.plannedIssues.some(pi => pi.issue.key === successorKey)
    );
    
    if (plannedSuccessors.length === 0) return false;
    
    // Vind de sprint index van het issue
    const plannedIssue = planningResult.plannedIssues.find(pi => pi.issue.key === issue.key);
    if (!plannedIssue) return false;
    
    const issueSprintIndex = planningResult.sprints.findIndex(s => s.sprint === plannedIssue.sprint);
    
    // Controleer of er opvolgers zijn in dezelfde of eerdere sprint
    return plannedSuccessors.some(successorKey => {
        const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
        if (!successor) return false;
        
        const successorSprintIndex = planningResult.sprints.findIndex(s => s.sprint === successor.sprint);
        return successorSprintIndex <= issueSprintIndex;
    });
};

// Helper functie om de totale uren te berekenen voor een assignee in een sprint
const calculateTotalHours = (sprintName: string, assignee: string, planningResult: PlanningResult): number => {
    return planningResult.sprintHours[sprintName]?.[assignee] || 0;
};

// Helper functie om te controleren of een issue in een latere sprint zit dan zijn voorgangers
const validatePredecessorSprintOrder = (issue: Issue, sprintName: string, planningResult: PlanningResult): boolean => {
    const predecessors = getPredecessors(issue);
    const issueSprintIndex = planningResult.sprints.findIndex(s => s.sprint === sprintName);
    
    logger.info(`\nValidatie voorganger sprint volgorde voor issue ${issue.key}:`);
    logger.info(`- Sprint index: ${issueSprintIndex}`);
    
    for (const predecessorKey of predecessors) {
        const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
        if (predecessor) {
            const predecessorSprintIndex = planningResult.sprints.findIndex(s => s.sprint === predecessor.sprint);
            logger.info(`- Voorganger ${predecessorKey} in sprint index: ${predecessorSprintIndex}`);
            
            // Controleer of het issue in dezelfde of een eerdere sprint zit dan zijn voorganger
            if (predecessorSprintIndex >= issueSprintIndex) {
                logger.info(`- FOUT: Issue ${issue.key} kan niet in sprint ${sprintName} worden gepland omdat voorganger ${predecessorKey} in sprint ${predecessor.sprint} zit`);
                return false;
            }
        }
    }
    
    logger.info(`- OK: Issue ${issue.key} kan in sprint ${sprintName} worden gepland`);
    return true;
};

// Helper functie om te controleren of de volgorde van plannen correct is
const validatePlanningSequence = (issues: Issue[], plannedIssues: PlannedIssue[]): boolean => {
    logger.info('\nValidatie planning volgorde:');
    let isValid = true;
    
    // Maak een map van issue key naar sprint index voor snelle lookup
    const sprintIndexMap = new Map<string, number>();
    plannedIssues.forEach(pi => {
        const sprintIndex = pi.sprint === '100' ? Number.MAX_SAFE_INTEGER : parseInt(pi.sprint);
        sprintIndexMap.set(pi.issue.key, sprintIndex);
    });
    
    // Controleer voor elk issue of zijn voorgangers in eerdere sprints zitten
    for (const issue of issues) {
        const issueSprintIndex = sprintIndexMap.get(issue.key);
        if (issueSprintIndex === undefined) continue; // Skip ongeplande issues
        
        const predecessors = getPredecessors(issue);
        for (const predecessorKey of predecessors) {
            const predecessorSprintIndex = sprintIndexMap.get(predecessorKey);
            if (predecessorSprintIndex === undefined) continue; // Skip ongeplande voorgangers
            
            if (predecessorSprintIndex >= issueSprintIndex) {
                logger.info(`\nFOUT: Issue ${issue.key} is gepland in sprint ${issueSprintIndex} terwijl voorganger ${predecessorKey} in sprint ${predecessorSprintIndex} zit`);
                isValid = false;
            }
        }
    }
    
    if (isValid) {
        logger.info('Planning volgorde is correct: alle voorgangers komen voor hun opvolgers');
    }
    
    return isValid;
};

// Helper functie om de due date van een issue te krijgen
const getDueDate = (issue: Issue): Date | null => {
    if (!issue.fields?.duedate) return null;
    return new Date(issue.fields.duedate);
};

// Helper functie om due dates te vergelijken
const compareDueDates = (a: Issue, b: Issue): number => {
    const aDueDate = getDueDate(a);
    const bDueDate = getDueDate(b);

    // Als beide issues een due date hebben
    if (aDueDate && bDueDate) {
        return aDueDate.getTime() - bDueDate.getTime();
    }

    // Als alleen issue a een due date heeft
    if (aDueDate) return -1;

    // Als alleen issue b een due date heeft
    if (bDueDate) return 1;

    // Als geen van beide een due date heeft, sorteer op basis van status en prioriteit
    const aStatus = a.fields?.status?.name || '';
    const bStatus = b.fields?.status?.name || '';

    if (STATUS_ORDER[aStatus] !== STATUS_ORDER[bStatus]) {
        return STATUS_ORDER[aStatus] - STATUS_ORDER[bStatus];
    }

    // Als de status gelijk is, sorteer op basis van prioriteit
    const priorityOrder: Record<string, number> = {
        'Highest': 0,
        'High': 1,
        'Medium': 2,
        'Low': 3,
        'Lowest': 4
    };

    const aPriority = a.fields?.priority?.name || '';
    const bPriority = b.fields?.priority?.name || '';

    return priorityOrder[aPriority] - priorityOrder[bPriority];
};

// Helper functie om te controleren of een datum een werkdag is (ma-vr)
function isWorkDay(date: Date): boolean {
    const day = date.getDay();
    return day !== 0 && day !== 6; // 0 = zondag, 6 = zaterdag
}

// Helper functie om het aantal werkdagen tussen twee datums te berekenen
function getWorkDaysBetween(startDate: Date, endDate: Date): number {
    let workDays = 0;
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
        if (isWorkDay(currentDate)) {
            workDays++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return workDays;
}

function sortIssuesByRelationsAndDueDates(issues: Issue[]): Issue[] {
    // Helper functie om issues binnen een groep op prioriteit te sorteren
    const sortByPriority = (group: Issue[]): Issue[] => {
        const priorityOrder: Record<string, number> = {
            'Highest': 0,
            'High': 1,
            'Medium': 2,
            'Low': 3,
            'Lowest': 4
        };

        return group.sort((a, b) => {
            const priorityA = a.fields?.priority?.name || 'Lowest';
            const priorityB = b.fields?.priority?.name || 'Lowest';
            return (priorityOrder[priorityA] || 999) - (priorityOrder[priorityB] || 999);
        });
    };

    // Helper functie om issues op basis van hun relaties te sorteren
    const sortByRelations = (group: Issue[]): Issue[] => {
        const result: Issue[] = [];
        const processed = new Set<string>();

        // Functie om een issue en zijn voorgangers toe te voegen
        const addIssueAndPredecessors = (issue: Issue) => {
            if (processed.has(issue.key)) return;
            
            // Voeg eerst alle voorgangers toe
            const predecessors = getPredecessors(issue);
            for (const predecessorKey of predecessors) {
                const predecessor = group.find(i => i.key === predecessorKey);
                if (predecessor) {
                    addIssueAndPredecessors(predecessor);
                }
            }
            
            // Voeg dan het issue zelf toe
            result.push(issue);
            processed.add(issue.key);
        };

        // Verwerk alle issues
        for (const issue of group) {
            addIssueAndPredecessors(issue);
        }

        return result;
    };

    // Groep 1: Issues die voorganger zijn van andere issues
    const predecessorIssues = issues.filter(issue => {
        const successors = getSuccessors(issue);
        return successors.length > 0;
    });

    // Groep 2: Issues met voorgangers
    const issuesWithPredecessors = issues.filter(issue => {
        const predecessors = getPredecessors(issue);
        return predecessors.length > 0;
    });

    // Groep 3: Issues die opvolgers zijn (en nog niet als voorganger zijn gepland)
    const successorIssues = issues.filter(issue => {
        const predecessors = getPredecessors(issue);
        return predecessors.length === 0 && getSuccessors(issue).length > 0;
    });

    // Groep 4: Issues zonder voorgangers/opvolgers maar met due date
    const issuesWithDueDate = issues.filter(issue => {
        const predecessors = getPredecessors(issue);
        const successors = getSuccessors(issue);
        return predecessors.length === 0 && successors.length === 0 && issue.fields?.duedate;
    });

    // Groep 5: Issues zonder voorgangers/opvolgers en zonder due date
    const issuesWithoutDueDate = issues.filter(issue => {
        const predecessors = getPredecessors(issue);
        const successors = getSuccessors(issue);
        return predecessors.length === 0 && successors.length === 0 && !issue.fields?.duedate;
    });

    // Combineer alle groepen in de juiste volgorde
    return [
        ...sortByRelations(sortByPriority(predecessorIssues)),
        ...sortByRelations(sortByPriority(issuesWithPredecessors)),
        ...sortByRelations(sortByPriority(successorIssues)),
        ...sortByPriority(issuesWithDueDate),
        ...sortByPriority(issuesWithoutDueDate)
    ];
}

async function getEmployeeCapacitiesFromSheet(googleSheetsData: (string | null)[][] | null): Promise<EmployeeCapacity[]> {
    if (!googleSheetsData) return [];

    const employeeCapacities: EmployeeCapacity[] = [];
    const project = googleSheetsData[0]?.[0] || '';

    // Start vanaf rij 2 (index 1) om de header over te slaan
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row || !row[0] || !row[1]) continue;

        const employee = row[0].toString();
        const capacity = parseFloat(row[1].toString());

        if (!isNaN(capacity)) {
            employeeCapacities.push({
                employee,
                capacity,
                project
            });
        }
    }

    return employeeCapacities;
}

// Functie om de beschikbare capaciteit voor een sprint te berekenen
function calculateSprintCapacity(
    sprint: string,
    sprintDates: Record<string, { start: Date; end: Date }>,
    currentDate: Date,
    sprintCapacities: SprintCapacity[],
    plannedIssues: PlannedIssue[],
    projectKey?: string,
    projectConfigs: ProjectConfig[] = []
): number {
    const sprintDate = sprintDates[sprint];
    if (!sprintDate) {
        return 0;
    }

    const sprintStart = new Date(sprintDate.start);
    const sprintEnd = new Date(sprintDate.end);

    // Als de sprint al voorbij is, return 0
    if (currentDate > sprintEnd) {
        return 0;
    }

    // Vind de projectnaam voor de projectKey
    let projectName: string | undefined;
    if (projectKey) {
        const projectConfig = projectConfigs.find(pc => pc.codes.includes(projectKey));
        if (projectConfig) {
            projectName = projectConfig.project;
        }
    }

    // Debug logging
    logger.info(`\nDebug capaciteit voor sprint ${sprint} en project ${projectName || projectKey}:`);
    logger.info(`Beschikbare capaciteiten:`);
    sprintCapacities.forEach(sc => {
        if (sc.sprint === sprint) {
            logger.info(`- Sprint: ${sc.sprint}, Project: ${sc.project}, Employee: ${sc.employee}, Capacity: ${sc.capacity}`);
        }
    });

    // Filter op juiste project indien projectKey is meegegeven
    let filteredCapacities = sprintCapacities.filter(sc => sc.sprint === sprint);
    if (projectName) {
        filteredCapacities = filteredCapacities.filter(sc => sc.project === projectName);
    }

    // Bereken de totale capaciteit voor deze sprint en project
    let totalCapacity = 0;
    let usedCapacity = 0;

    // Bereken gebruikte capaciteit uit plannedIssues
    for (const plannedIssue of plannedIssues) {
        if (plannedIssue.sprint === sprint) {
            // Alleen issues van het juiste project meetellen
            if (!projectKey || plannedIssue.issue.fields?.project?.key === projectKey) {
                const hours = plannedIssue.issue.fields?.timeestimate ? plannedIssue.issue.fields.timeestimate / 3600 : 0;
                usedCapacity += hours;
            }
        }
    }

    // Bereken beschikbare capaciteit uit filteredCapacities
    for (const sc of filteredCapacities) {
        totalCapacity += sc.capacity;
    }

    // Als de sprint nog moet beginnen, return beschikbare capaciteit
    if (currentDate < sprintStart) {
        return Math.max(0, totalCapacity - usedCapacity);
    }

    // Voor de huidige sprint: return direct de beschikbare capaciteit
    // De capaciteiten uit de sheet zijn al aangepast voor de resterende werkdagen
    return Math.max(0, totalCapacity - usedCapacity);
}

// Functie om een nieuwe sprint aan te maken als deze nog niet bestaat
async function ensureSprintExists(
    sprintNumber: string,
    sprintCapacities: SprintCapacity[],
    projectConfigs: ProjectConfig[],
    currentDate: Date
): Promise<void> {
    // Controleer of de sprint al bestaat
    const sprintExists = sprintCapacities.some(sc => sc.sprint === sprintNumber);
    if (sprintExists) return;

    // Bepaal de sprint datums en project
    let sprintStartDate: Date | undefined;
    let sprintEndDate: Date | undefined;
    let projectName = '';

    // Bepaal de sprint startdatum op basis van project configuratie
    for (const config of projectConfigs) {
        if (config.sprintStartDate) {
            sprintStartDate = new Date(config.sprintStartDate);
            sprintStartDate.setDate(sprintStartDate.getDate() + ((parseInt(sprintNumber) - 1) * 14));
            sprintEndDate = new Date(sprintStartDate);
            sprintEndDate.setDate(sprintStartDate.getDate() + 13);
            projectName = config.project;
            break;
        }
    }

    if (!sprintStartDate || !sprintEndDate) {
        logger.error(`Kon geen start- en einddatum bepalen voor sprint ${sprintNumber}`);
        return;
    }

    // Log sprint informatie
    logger.info('\n=== NIEUWE SPRINT AANGEMAAKT ===');
    logger.info(`Project: ${projectName}`);
    logger.info(`Sprint: ${sprintNumber}`);
    logger.info(`Startdatum: ${sprintStartDate.toLocaleDateString('nl-NL')}`);
    logger.info(`Einddatum: ${sprintEndDate.toLocaleDateString('nl-NL')}`);
    logger.info('\nMedewerkers:');

    // Maak nieuwe capaciteiten aan voor deze sprint
    let totalSprintCapacity = 0;

    // Gebruik de capaciteiten die al uit de Google Sheets zijn gehaald
    const employeeCapacities = sprintCapacities.filter(sc => sc.project === projectName);
    if (employeeCapacities.length === 0) {
        logger.error(`Geen capaciteiten gevonden voor project ${projectName}`);
        return;
    }

    // Voeg capaciteiten toe voor elke medewerker
    employeeCapacities.forEach(employeeCapacity => {
        let capacity = employeeCapacity.capacity;

        // Voor de huidige sprint: bereken capaciteit op basis van resterende werkdagen
        if (currentDate >= sprintStartDate && currentDate <= sprintEndDate) {
            const remainingWorkDays = getWorkDaysBetween(currentDate, sprintEndDate);
            const totalWorkDaysInSprint = getWorkDaysBetween(sprintStartDate, sprintEndDate);
            const capacityFactor = remainingWorkDays / totalWorkDaysInSprint;
            capacity = Math.round(capacity * capacityFactor);
        }

        // Log medewerker informatie
        logger.info(`- ${employeeCapacity.employee}: ${capacity} uur`);
        totalSprintCapacity += capacity;

        // Voeg de nieuwe sprint capaciteit toe
        sprintCapacities.push({
            employee: employeeCapacity.employee,
            sprint: sprintNumber,
            capacity,
            project: employeeCapacity.project,
            availableCapacity: capacity,
            startDate: sprintStartDate.toISOString()
        });
    });

    logger.info(`\nTotale sprintcapaciteit: ${totalSprintCapacity} uur`);
    logger.info('================================\n');
}

// Pas de checkSprintCapacity functie aan om zowel individuele als totale sprint capaciteit te controleren voor andere medewerkers.
function checkSprintCapacity(
    issue: Issue,
    sprint: string,
    sprintDates: Record<string, { start: Date; end: Date }>,
    currentDate: Date,
    employeeCapacities: EmployeeCapacity[],
    sprintCapacities: SprintCapacity[],
    projectConfigs: ProjectConfig[],
    plannedIssues: PlannedIssue[]
): { canFit: boolean; reason: string } {
    const hours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
    const assignee = getAssigneeName(issue.fields?.assignee);
    const projectKey = issue.fields?.project?.key || '';

    // Vind het project configuratie
    const projectConfig = projectConfigs.find(pc => pc.codes.includes(projectKey));
    if (!projectConfig) {
        return {
            canFit: false,
            reason: `Geen project configuratie gevonden voor project ${projectKey}`
        };
    }

    // Log de project mapping
    logger.info(`\nProject mapping voor ${issue.key}:`);
    logger.info(`- Project key: ${projectKey}`);
    logger.info(`- Project naam: ${projectConfig.project}`);

    // Bereken beschikbare sprint capaciteit (totaal)
    const availableSprintCapacity = calculateSprintCapacity(
        sprint,
        sprintDates,
        currentDate,
        sprintCapacities,
        plannedIssues,
        projectKey,
        projectConfigs
    );

    // Voor Peter van Diermen of Unassigned: alleen totale sprint capaciteit checken
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        if (hours > availableSprintCapacity) {
            return {
                canFit: false,
                reason: `Niet genoeg sprint capaciteit (${availableSprintCapacity} uur beschikbaar voor ${hours} uur van ${assignee})`
            };
        }
        return { canFit: true, reason: '' };
    }

    // Bereken individuele capaciteit
    let employeeCapacity = 0;
    let employeeUsedHours = 0;

    // Vind de capaciteit voor deze medewerker in deze sprint
    const employeeSprintCapacity = sprintCapacities.find(
        sc => sc.sprint === sprint && 
        sc.project === projectConfig.project && 
        sc.employee === assignee
    );

    if (employeeSprintCapacity) {
        employeeCapacity = employeeSprintCapacity.capacity;
    }

    // Bereken gebruikte uren voor deze medewerker in deze sprint
    for (const plannedIssue of plannedIssues) {
        if (plannedIssue.sprint === sprint) {
            const plannedAssignee = getAssigneeName(plannedIssue.issue.fields?.assignee);
            if (plannedAssignee === assignee) {
                const plannedHours = plannedIssue.issue.fields?.timeestimate ? plannedIssue.issue.fields.timeestimate / 3600 : 0;
                employeeUsedHours += plannedHours;
            }
        }
    }

    // Log de capaciteit check
    logger.info(`\nCapaciteit check voor ${issue.key} in sprint ${sprint}:`);
    logger.info(`- Sprint capaciteit: ${availableSprintCapacity} uur`);
    logger.info(`- Individuele capaciteit: ${employeeCapacity} uur (${employeeCapacity} totaal, ${employeeUsedHours} gebruikt)`);
    logger.info(`- Benodigde uren: ${hours} uur`);

    // Controleer of er genoeg individuele capaciteit is
    if (hours > (employeeCapacity - employeeUsedHours)) {
        return {
            canFit: false,
            reason: `Niet genoeg individuele capaciteit voor ${assignee} in sprint ${sprint}`
        };
    }

    // Controleer of er genoeg sprint capaciteit is
    if (hours > availableSprintCapacity) {
        return {
            canFit: false,
            reason: `Niet genoeg sprint capaciteit in sprint ${sprint}`
        };
    }

    return { canFit: true, reason: '' };
}

// Functie om een issue te plannen
function planIssue(
    issue: Issue,
    sprint: string,
    sprintDates: { [key: string]: { start: Date; end: Date } },
    currentDate: Date,
    employeeCapacities: EmployeeCapacity[],
    sprintCapacities: SprintCapacity[],
    existingPlanning: PlanningResult,
    projectConfig: ProjectConfig
): { success: boolean; reason: string } {
    // Gebruik de bestaande planning voor validatie
    const planningResult: PlanningResult = {
        sprints: sprintCapacities,
        plannedIssues: existingPlanning.plannedIssues || [], // Gebruik bestaande planning
        sprintHours: existingPlanning.sprintHours || {},
        issues: existingPlanning.issues || [],
        sprintAssignments: existingPlanning.sprintAssignments || {},
        sprintCapacity: sprintCapacities,
        employeeSprintUsedHours: existingPlanning.employeeSprintUsedHours || {},
        currentSprint: sprint,
        capacityFactor: 1,
        projectConfigs: existingPlanning.projectConfigs || [],
        sprintDates: existingPlanning.sprintDates || {},
        employeeCapacities: existingPlanning.employeeCapacities || [],
        sprintPlanning: existingPlanning.sprintPlanning || [] // Gebruik bestaande planning
    };

    // Controleer eerst of er voorgangers zijn die al gepland zijn
    const predecessors = getPredecessors(issue);
    const plannedPredecessors = predecessors.filter(predecessorKey => 
        planningResult.plannedIssues.some(pi => pi.issue.key === predecessorKey)
    );

    // Als er voorgangers zijn die al gepland zijn, controleer of ze in eerdere sprints zitten
    if (plannedPredecessors.length > 0) {
        const issueSprintIndex = planningResult.sprints.findIndex(s => s.sprint === sprint);
        for (const predecessorKey of plannedPredecessors) {
            const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (predecessor) {
                const predecessorSprintIndex = planningResult.sprints.findIndex(s => s.sprint === predecessor.sprint);
                if (predecessorSprintIndex >= issueSprintIndex) {
                    return { 
                        success: false, 
                        reason: `Issue kan niet worden gepland omdat voorganger ${predecessorKey} in sprint ${predecessor.sprint} zit` 
                    };
                }
            }
        }
    }

    // Controleer of er opvolgers zijn die al gepland zijn
    const successors = getSuccessors(issue);
    const plannedSuccessors = successors.filter(successorKey => 
        planningResult.plannedIssues.some(pi => pi.issue.key === successorKey)
    );

    // Als er opvolgers zijn die al gepland zijn, controleer of ze in latere sprints zitten
    if (plannedSuccessors.length > 0) {
        const issueSprintIndex = planningResult.sprints.findIndex(s => s.sprint === sprint);
        for (const successorKey of plannedSuccessors) {
            const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor) {
                const successorSprintIndex = planningResult.sprints.findIndex(s => s.sprint === successor.sprint);
                if (successorSprintIndex <= issueSprintIndex) {
                    return { 
                        success: false, 
                        reason: `Issue kan niet worden gepland omdat opvolger ${successorKey} in sprint ${successor.sprint} zit` 
                    };
                }
            }
        }
    }

    // Controleer de capaciteit
    const capacityCheck = checkSprintCapacity(
        issue,
        sprint,
        sprintDates,
        currentDate,
        employeeCapacities,
        sprintCapacities,
        planningResult.projectConfigs || [],
        existingPlanning.plannedIssues || []
    );
    if (!capacityCheck.canFit) {
        return { success: false, reason: capacityCheck.reason };
    }

    // Als alle validaties slagen, plan het issue
    return { success: true, reason: 'Issue succesvol gepland' };
}

export async function calculatePlanning(
    projectConfig: ProjectConfig,
    issues: Issue[],
    googleSheetsData: any
): Promise<PlanningResult> {
    // Controleer of projectConfig een geldig ProjectConfig object is
    if (!projectConfig || typeof projectConfig !== 'object' || !projectConfig.project) {
        logger.error(`Ongeldige project configuratie: ${JSON.stringify(projectConfig)}`);
        throw new Error('Ongeldige project configuratie');
    }

    logger.info(`\n=== PLANNING BEREKENING VOOR PROJECT ${projectConfig.project} ===`);

    // Haal alle project configuraties op uit Google Sheets
    const projectSheetsData = await getGoogleSheetsData('Projects!A1:F');
    const allProjectConfigs = getProjectConfigsFromSheet(projectSheetsData);
    logger.info(`Gevonden project configuraties: ${allProjectConfigs.map(pc => pc.project).join(', ')}`);

    // Voor het project "Klantprojecten", haal eerst alle AMP issues op die niet gepland hoeven te worden
    let issuesToPlan = [...issues];

    // Haal sprint capaciteiten op uit Google Sheets
    const sprintCapacities = await getSprintCapacityFromSheet(googleSheetsData);
    const uniqueSprints = [...new Set(sprintCapacities.map(sc => sc.sprint))];
    logger.info(`Beschikbare sprints: ${uniqueSprints.join(', ')}`);

    // Bepaal de project start datum
    const projectStartDate = projectConfig.sprintStartDate || new Date('2025-05-26');
    projectStartDate.setHours(0, 0, 0, 0);
    logger.info(`Project start datum: ${projectStartDate.toLocaleDateString('nl-NL')}\n`);

    // Bereken sprint datums
    const sprintDates: { [key: string]: { start: Date; end: Date } } = {};
    for (let i = 1; i <= 100; i++) {
        const sprintStartDate = new Date(projectStartDate);
        sprintStartDate.setDate(projectStartDate.getDate() + ((i - 1) * 14));
        const sprintEndDate = new Date(sprintStartDate);
        sprintEndDate.setDate(sprintStartDate.getDate() + 13);
        sprintDates[i.toString()] = {
            start: sprintStartDate,
            end: sprintEndDate
        };
    }

    // Update sprint capaciteiten met de juiste startdatums
    sprintCapacities.forEach(capacity => {
        const sprintNumber = parseInt(capacity.sprint);
        if (sprintDates[sprintNumber]) {
            capacity.startDate = sprintDates[sprintNumber].start.toISOString();
        }
    });

    // Bereken huidige datum
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);
    logger.info(`Huidige datum: ${currentDate.toLocaleDateString('nl-NL')}\n`);

    // Bereken aantal dagen tussen project start en huidige datum
    const daysBetween = Math.floor((currentDate.getTime() - projectStartDate.getTime()) / (1000 * 60 * 60 * 24));
    logger.info(`Aantal dagen tussen project start en huidige datum: ${daysBetween}\n`);

    // Bepaal sprint index op basis van huidige datum
    const sprintIndex = Math.floor(daysBetween / 14) + 1;
    logger.info(`Huidige sprint index: ${sprintIndex}\n`);

    // Sorteer issues op basis van relaties en due dates
    const sortedIssues = sortIssuesByRelationsAndDueDates(issuesToPlan);
    logger.info(`Aantal issues om te plannen: ${sortedIssues.length}\n`);

    // Initialiseer planning resultaat
    const planningResult: PlanningResult = {
        sprintHours: {},
        plannedIssues: [],
        issues: sortedIssues,
        sprints: sprintCapacities,
        sprintAssignments: {},
        sprintCapacity: sprintCapacities,
        employeeSprintUsedHours: {},
        currentSprint: sprintIndex.toString(),
        capacityFactor: 1,
        projectConfigs: allProjectConfigs,
        sprintDates: sprintDates,
        employeeCapacities: await getEmployeeCapacitiesFromSheet(googleSheetsData),
        sprintPlanning: []
    };

    logger.info('=== START PLANNEN ISSUES ===\n');

    // Plan elk issue
    for (const issue of sortedIssues) {
        // Controleer eerst of het issue al gepland is
        const existingPlanning = planningResult.plannedIssues.find(pi => pi.issue.key === issue.key);
        if (existingPlanning) {
            continue;
        }

        const sprint = await findFirstAvailableSprint(issue, planningResult, currentDate);
        if (sprint) {
            const assignee = getAssigneeName(issue.fields?.assignee);
            const hours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;

            // Gebruik planIssue voor validatie en capaciteit
            const result = planIssue(
                issue,
                sprint,
                sprintDates,
                currentDate,
                sprintCapacities.map(sc => ({ employee: sc.employee, capacity: sc.capacity, project: sc.project })),
                sprintCapacities,
                planningResult,
                projectConfig
            );
            if (!result.success) {
                logger.warn(`Issue ${issue.key} kan niet gepland worden: ${result.reason}`);
                continue;
            }

            // Voeg toe aan plannedIssues
            planningResult.plannedIssues.push({
                issue,
                sprint,
                hours,
                assignee,
                key: issue.key,
                project: projectConfig.project
            });

            // Voeg toe aan sprintAssignments
            if (!planningResult.sprintAssignments[sprint]) {
                planningResult.sprintAssignments[sprint] = {};
            }
            if (!planningResult.sprintAssignments[sprint][assignee]) {
                planningResult.sprintAssignments[sprint][assignee] = [];
            }
            planningResult.sprintAssignments[sprint][assignee].push(issue);

            // Update sprintHours
            if (!planningResult.sprintHours[sprint]) {
                planningResult.sprintHours[sprint] = {};
            }
            if (!planningResult.sprintHours[sprint][assignee]) {
                planningResult.sprintHours[sprint][assignee] = 0;
            }
            planningResult.sprintHours[sprint][assignee] += hours;

            // Update employeeSprintUsedHours (voor backward compatibility)
            if (!planningResult.employeeSprintUsedHours[assignee]) {
                planningResult.employeeSprintUsedHours[assignee] = {};
            }
            if (!planningResult.employeeSprintUsedHours[assignee][sprint]) {
                planningResult.employeeSprintUsedHours[assignee][sprint] = 0;
            }
            planningResult.employeeSprintUsedHours[assignee][sprint] += hours;
        } else {
            logger.warn(`Kon geen sprint vinden voor issue ${issue.key}`);
        }
    }

    logger.info('=== EINDE PLANNING BEREKENING ===\n');

    // Maak de planning
    const finalPlanningResult = await planning(
        sprintCapacities,
        allProjectConfigs,
        currentDate
    );

    // Combineer de resultaten
    planningResult.sprintPlanning = finalPlanningResult.sprintPlanning;

    return planningResult;
}

// Functie om de planning te maken
export async function planning(
    sprintCapacity: SprintCapacity[],
    projectConfigs: ProjectConfig[],
    currentDate: Date
): Promise<PlanningResult> {
    // Maak een kopie van de sprint capaciteiten
    const planningResult: PlanningResult = {
        sprintHours: {},
        plannedIssues: [],
        issues: [],
        sprints: sprintCapacity,
        sprintAssignments: {},
        sprintCapacity: sprintCapacity,
        employeeSprintUsedHours: {},
        currentSprint: '1',
        capacityFactor: 1,
        projectConfigs: projectConfigs,
        sprintDates: {},
        employeeCapacities: [],
        sprintPlanning: []
    };

    // Bepaal de sprint nummers
    const sprintNumbers = [...new Set(sprintCapacity.map(sc => sc.sprint))].sort((a, b) => parseInt(a) - parseInt(b));

    // Zorg ervoor dat alle benodigde sprints bestaan
    for (const sprintNumber of sprintNumbers) {
        if (!sprintCapacity.some(sc => sc.sprint === sprintNumber)) {
            logger.info(`Sprint ${sprintNumber} bestaat niet, deze wordt aangemaakt`);
            await ensureSprintExists(
                sprintNumber,
                planningResult.sprintCapacity,
                projectConfigs,
                currentDate
            );
        }
    }

    // Bepaal de sprint datums
    const sprintDates = new Map<string, { start: Date; end: Date }>();
    for (const config of projectConfigs) {
        if (config.sprintStartDate) {
            const startDate = new Date(config.sprintStartDate);
            for (const sprintNumber of sprintNumbers) {
                const sprintStart = new Date(startDate);
                sprintStart.setDate(sprintStart.getDate() + ((parseInt(sprintNumber) - 1) * 14));
                const sprintEnd = new Date(sprintStart);
                sprintEnd.setDate(sprintStart.getDate() + 13);
                sprintDates.set(sprintNumber, { start: sprintStart, end: sprintEnd });
                planningResult.sprintDates[sprintNumber] = { start: sprintStart, end: sprintEnd };
            }
            break;
        }
    }

    // Bepaal de sprint planning
    for (const sprintNumber of sprintNumbers) {
        const sprintDate = sprintDates.get(sprintNumber);
        if (!sprintDate) {
            logger.error(`Geen datums gevonden voor sprint ${sprintNumber}`);
            continue;
        }

        const sprintPlanning: SprintPlanning = {
            sprint: sprintNumber,
            startDate: sprintDate.start.toISOString(),
            endDate: sprintDate.end.toISOString(),
            employeePlanning: []
        };

        // Bepaal de planning per medewerker
        const employeeCapacities = planningResult.sprintCapacity.filter(sc => sc.sprint === sprintNumber);
        for (const capacity of employeeCapacities) {
            const employeePlanning: EmployeePlanning = {
                employee: capacity.employee,
                capacity: capacity.capacity,
                availableCapacity: capacity.availableCapacity,
                project: capacity.project
            };
            sprintPlanning.employeePlanning.push(employeePlanning);
        }

        planningResult.sprintPlanning.push(sprintPlanning);
    }

    return planningResult;
}