import type { Issue as JiraIssue, Issue, PlanningResult, PlannedIssue, IssueLink, EfficiencyData, ProjectConfig, WorklogConfig, WorkLog } from '../types.js';
import type { SprintCapacity } from '../types.js';
import { getSprintCapacityFromSheet } from '../google-sheets.js';
import logger from '../logger.js';
import { getSuccessors, getPredecessors } from '../utils/jira-helpers.js';
import { getAssigneeName } from '../utils/shared-functions.js';
import { getProjectConfigsFromSheet } from '../google-sheets.js';
import { calculateCurrentSprint } from '../utils/date-utils.js';

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
const validatePlanningOrder = (planning: PlanningResult): boolean => {
    let isValid = true;
    const processedIssues = new Set<string>();

    // Functie om een issue en zijn gerelateerde issues te verplaatsen
    const moveIssueAndRelated = (issue: PlannedIssue, newSprint: string) => {
        if (processedIssues.has(issue.issue.key)) return;
        processedIssues.add(issue.issue.key);

        // Verplaats het issue
        const oldSprint = issue.sprint;
        issue.sprint = newSprint;

        // Update sprintHours
        const oldSprintHours = planning.sprintHours[oldSprint];
        if (oldSprintHours) {
            const issueHours = oldSprintHours[issue.assignee] || 0;
            if (issueHours > 0) {
                // Verwijder uit oude sprint
                planning.sprintHours[oldSprint][issue.assignee] -= issueHours;
                
                // Voeg toe aan nieuwe sprint
                if (!planning.sprintHours[newSprint]) {
                    planning.sprintHours[newSprint] = {};
                }
                if (!planning.sprintHours[newSprint][issue.assignee]) {
                    planning.sprintHours[newSprint][issue.assignee] = 0;
                }
                planning.sprintHours[newSprint][issue.assignee] += issueHours;

                // Update employeeSprintUsedHours
                if (!planning.employeeSprintUsedHours[issue.assignee]) {
                    planning.employeeSprintUsedHours[issue.assignee] = {};
                }
                // Verwijder uit oude sprint
                planning.employeeSprintUsedHours[issue.assignee][oldSprint] -= issueHours;
                // Voeg toe aan nieuwe sprint
                if (!planning.employeeSprintUsedHours[issue.assignee][newSprint]) {
                    planning.employeeSprintUsedHours[issue.assignee][newSprint] = 0;
                }
                planning.employeeSprintUsedHours[issue.assignee][newSprint] += issueHours;
            }
        }

        // Update sprintAssignments
        if (planning.sprintAssignments[oldSprint]?.[issue.assignee]) {
            planning.sprintAssignments[oldSprint][issue.assignee] = 
                planning.sprintAssignments[oldSprint][issue.assignee].filter(i => i.key !== issue.issue.key);
        }
        if (!planning.sprintAssignments[newSprint]) {
            planning.sprintAssignments[newSprint] = {};
        }
        if (!planning.sprintAssignments[newSprint][issue.assignee]) {
            planning.sprintAssignments[newSprint][issue.assignee] = [];
        }
        planning.sprintAssignments[newSprint][issue.assignee].push(issue.issue);

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
                    moveIssueAndRelated(predecessor, earlierSprint);
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
                    moveIssueAndRelated(successor, laterSprint);
                }
            }
        }
    };

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

                // Als de due date voor de sprint start, moet het issue in een eerdere sprint
                if (dueDate < sprintStartDate) {
                    logger.info(`\nFout: Issue ${issue.key} heeft een due date (${dueDate.toISOString()}) voor sprint ${sprintName} (${sprintStartDate.toISOString()})`);
                    
                    // Vind de eerste sprint die na de due date start
                    const sprintIndex = planning.sprints.findIndex(s => {
                        const startDate = new Date(s.startDate || '');
                        return startDate >= dueDate;
                    });
                    
                    if (sprintIndex !== -1) {
                        const newSprint = planning.sprints[sprintIndex].sprint;
                        logger.info(`Issue ${issue.key} wordt verplaatst naar sprint ${newSprint}`);
                        moveIssueAndRelated(plannedIssue, newSprint);
                        isValid = false;
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
                    moveIssueAndRelated(plannedIssue, '100');
                    isValid = false;
                }
                // Als de voorganger in een latere sprint zit, moet het issue ook in die sprint
                else if (predecessorSprintIndex > issueSprintIndex) {
                    logger.info(`\nFout: Voorganger ${predecessorKey} is in sprint ${predecessor.sprint}, maar ${issue.key} is in sprint ${plannedIssue.sprint}`);
                    logger.info(`Issue ${issue.key} wordt verplaatst naar sprint ${predecessor.sprint}`);
                    moveIssueAndRelated(plannedIssue, predecessor.sprint);
                    isValid = false;
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
                        moveIssueAndRelated(successor, newSprint);
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

// Helper functie om de sprint capaciteit te controleren
const checkSprintCapacity = (sprintName: string, issue: Issue, assignee: string, planningResult: PlanningResult): boolean => {
    // Sprint 100 is de fallback sprint en heeft geen capaciteitsbeperkingen
    if (sprintName === '100') {
        return true;
    }

    const issueHours = (issue.fields?.timeestimate || 0) / 3600;
    const sprintNames = [...new Set(planningResult.sprintCapacity.map(cap => cap.sprint))]
        .sort((a, b) => parseInt(a) - parseInt(b));
    const currentSprintIndex = sprintNames.indexOf(sprintName);

    // Controleer eerst of het issue na zijn voorgangers komt
    const predecessors = getPredecessors(issue);
    for (const predecessorKey of predecessors) {
        const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
        if (predecessor) {
            const predecessorSprintIndex = sprintNames.indexOf(predecessor.sprint);
            if (predecessorSprintIndex >= currentSprintIndex) {
                return false;
            }
        }
    }

    // Voor Peter van Diermen en Unassigned, controleer alleen de totale sprintcapaciteit
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        const totalSprintCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .reduce((sum, c) => sum + c.capacity, 0);
        const plannedIssuesHours = planningResult.plannedIssues
            .filter(pi => pi.sprint === sprintName)
            .reduce((sum, pi) => sum + (pi.issue.fields?.timeestimate || 0) / 3600, 0);
        const availableCapacity = totalSprintCapacity - plannedIssuesHours;
        
        if (issueHours > availableCapacity) {
            logger.info(`${assignee} heeft niet genoeg capaciteit voor Issue ${issue.key} in sprint ${sprintName} (totale sprint capaciteit: ${totalSprintCapacity} uur, ingeplande issues: ${plannedIssuesHours} uur, beschikbare capaciteit: ${availableCapacity} uur, issue: ${issueHours} uur)`);
            return false;
        }
    } else {
        // Voor andere medewerkers: controleer individuele capaciteit
        const employeeCapacity = planningResult.sprintCapacity.find(
            c => c.sprint === sprintName && c.employee === assignee
        )?.capacity || 0;
        const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;
        const newUsedHours = usedHours + issueHours;
        
        if (newUsedHours > employeeCapacity) {
            logger.info(`${assignee} heeft niet genoeg capaciteit voor Issue ${issue.key} in sprint ${sprintName} (individuele capaciteit: ${employeeCapacity} uur, ingeplande issues: ${usedHours} uur, issue: ${issueHours} uur, newUsedHours: ${newUsedHours})`);
            return false;
        }
    }

    return true;
};

// Helper functie om de eerste beschikbare sprint te vinden
export function findFirstAvailableSprint(issue: Issue, planningResult: PlanningResult): string {
    const issueKey = issue.key;
    const assignee = issue.fields?.assignee?.displayName || 'Unassigned';
    const dueDate = issue.fields?.duedate;
    const issueHours = (issue.fields?.timeestimate || 0) / 3600;

    // Extra logging voor specifiek issue
    const isTargetIssue = issueKey === 'ATL7Q2-385';
    if (isTargetIssue) {
        logger.info(`\n[DEBUG] Plannen van issue ${issueKey}:`);
        logger.info(`- Toegewezen aan: ${assignee}`);
        logger.info(`- Due date: ${dueDate}`);
        logger.info(`- Geschatte uren: ${issueHours}`);
        logger.info(`- Sprint capaciteiten voor ${assignee}:`);
        planningResult.sprintCapacity
            .filter(c => c.employee === assignee)
            .forEach(c => logger.info(`  * Sprint ${c.sprint}: ${c.capacity} uur`));
        logger.info(`- Gebruikte uren per sprint voor ${assignee}:`);
        Object.entries(planningResult.employeeSprintUsedHours[assignee] || {})
            .forEach(([sprint, hours]) => logger.info(`  * Sprint ${sprint}: ${hours} uur`));
        logger.info(`- Sprint start datums:`);
        planningResult.sprints.forEach(s => {
            logger.info(`  * Sprint ${s.sprint}: ${s.startDate || 'geen startdatum'}`);
        });
        logger.info(`- Ingeplande issues per sprint:`);
        planningResult.plannedIssues.forEach(pi => {
            logger.info(`  * Sprint ${pi.sprint}: ${pi.issue.key} (${(pi.issue.fields?.timeestimate || 0) / 3600} uur)`);
        });
    }

    // Verzamel alle sprints
    const sprintNames = [...new Set(planningResult.sprintCapacity.map(cap => cap.sprint))]
        .sort((a, b) => parseInt(a) - parseInt(b));

    if (isTargetIssue) {
        logger.info(`- Beschikbare sprints: ${sprintNames.join(', ')}`);
    }

    // Bepaal vanaf welke sprint we moeten zoeken
    let startFromIndex = 0;
    if (dueDate) {
        const dueDateObj = new Date(dueDate);
        startFromIndex = planningResult.sprints.findIndex(s => {
            const sprintStartDate = new Date(s.startDate || '');
            return sprintStartDate >= dueDateObj;
        });
        if (startFromIndex === -1) {
            startFromIndex = 0;
        }
    }

    if (isTargetIssue) {
        logger.info(`- Start zoeken vanaf sprint index: ${startFromIndex} (sprint ${sprintNames[startFromIndex]})`);
    }

    // Zoek de eerste sprint met voldoende capaciteit
    for (let i = startFromIndex; i < sprintNames.length; i++) {
        const sprintName = sprintNames[i];
        const availableCapacity = getAvailableCapacity(sprintName, assignee, planningResult);
        
        if (isTargetIssue) {
            logger.info(`- Controleer sprint ${sprintName}:`);
            logger.info(`  * Beschikbare capaciteit: ${availableCapacity} uur`);
            logger.info(`  * Benodigde capaciteit: ${issueHours} uur`);
            logger.info(`  * Gebruikte uren in sprint: ${planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0} uur`);
        }

        // Check of er voorgangers zijn in deze of latere sprints
        const predecessors = getPredecessors(issue);
        if (isTargetIssue) {
            logger.info(`  * Voorgangers: ${predecessors.length > 0 ? predecessors.join(', ') : 'geen'}`);
        }
        const hasPredecessorsInCurrentOrLaterSprint = predecessors.some(predecessorKey => {
            const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (!predecessor) return false;
            const predecessorSprintIndex = sprintNames.indexOf(predecessor.sprint);
            if (isTargetIssue) {
                logger.info(`  * Voorganger ${predecessorKey} is gepland in sprint ${predecessor.sprint} (index ${predecessorSprintIndex})`);
            }
            return predecessorSprintIndex >= i;
        });

        if (hasPredecessorsInCurrentOrLaterSprint) {
            if (isTargetIssue) {
                logger.info(`  * Voorganger gevonden in deze of latere sprint, sla over`);
            }
            continue;
        }

        if (availableCapacity >= issueHours) {
            if (isTargetIssue) {
                logger.info(`- Voldoende capaciteit in sprint ${sprintName}`);
            }
            return sprintName;
        } else {
            if (isTargetIssue) {
                logger.info(`  * Onvoldoende capaciteit in sprint ${sprintName}`);
            }
            // Controleer of er nog latere sprints zijn
            if (i < sprintNames.length - 1) {
                continue; // Ga door naar de volgende sprint
            }
        }
    }

    if (isTargetIssue) {
        logger.info(`- Geen sprint gevonden met voldoende capaciteit, gebruik sprint 100 als fallback`);
        logger.info(`- Reden: ${dueDate ? 'Due date valt in sprint zonder startdatum' : 'Geen sprint gevonden met voldoende capaciteit'}`);
    }

    // Als een issue in sprint 100 wordt geplaatst, moeten ook de opvolgers in sprint 100
    const successors = getSuccessors(issue);
    if (successors.length > 0) {
        if (isTargetIssue) {
            logger.info(`- Issue heeft opvolgers, deze worden ook in sprint 100 gepland`);
        }
        successors.forEach(successorKey => {
            const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor && successor.sprint !== '100') {
                if (isTargetIssue) {
                    logger.info(`  * Opvolger ${successorKey} wordt verplaatst naar sprint 100`);
                }
                successor.sprint = '100';
            }
        });
    }

    return '100';
}

// Helper functie om de beschikbare capaciteit te berekenen
function getAvailableCapacity(sprintName: string, assignee: string, planningResult: PlanningResult): number {
    const isTargetIssue = assignee === 'Peter van Diermen' || assignee === 'Unassigned';
    
    if (isTargetIssue) {
        logger.info(`\n[DEBUG] Capaciteitsberekening voor ${assignee} in sprint ${sprintName}:`);
    }

    // Speciale behandeling voor Peter van Diermen en Unassigned
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        const totalSprintCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .reduce((sum, c) => sum + c.capacity, 0);
        const plannedIssuesHours = planningResult.plannedIssues
            .filter(pi => pi.sprint === sprintName)
            .reduce((sum, pi) => sum + (pi.issue.fields?.timeestimate || 0) / 3600, 0);
        
        logger.info(`[DEBUG] Gedetailleerde capaciteitsberekening voor ${assignee} in sprint ${sprintName}:`);
        logger.info(`- Totale sprint capaciteit: ${totalSprintCapacity} uur`);
        logger.info(`- Uren van ingeplande issues: ${plannedIssuesHours} uur`);
        logger.info(`- Beschikbare capaciteit: ${totalSprintCapacity - plannedIssuesHours} uur`);
        
        return totalSprintCapacity - plannedIssuesHours;
    }

    // Voor andere medewerkers: controleer zowel individuele als totale sprintcapaciteit
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
    const availableCapacity = Math.min(individualAvailable, sprintAvailable);

    if (isTargetIssue) {
        logger.info(`- Individuele capaciteit: ${employeeCapacity} uur`);
        logger.info(`- Gebruikte uren: ${usedHours} uur`);
        logger.info(`- Totale sprint capaciteit: ${totalSprintCapacity} uur`);
        logger.info(`- Uren van ingeplande issues: ${plannedIssuesHours} uur`);
        logger.info(`- Beschikbare individuele capaciteit: ${individualAvailable} uur`);
        logger.info(`- Beschikbare sprintcapaciteit: ${sprintAvailable} uur`);
        logger.info(`- Uiteindelijke beschikbare capaciteit: ${availableCapacity} uur`);
    }

    return availableCapacity;
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
            
            // Controleer of het issue in een eerdere sprint zit dan zijn voorganger
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
    // Groepeer issues op basis van hun relaties
    const issueGroups: Issue[][] = [];
    const processedIssues = new Set<string>();

    // Functie om te controleren of alle voorgangers al zijn verwerkt
    function areAllPredecessorsProcessed(issue: Issue): boolean {
        const predecessors = getPredecessors(issue);
        return predecessors.every(predKey => processedIssues.has(predKey));
    }

    // Functie om een issue en zijn voorgangers te verzamelen
    function collectIssueAndPredecessors(issue: Issue, group: Issue[]) {
        const issueKey = issue.key;
        if (processedIssues.has(issueKey)) return;
        processedIssues.add(issueKey);

        // Verzamel eerst alle voorgangers
        const predecessors = getPredecessors(issue);
        for (const predKey of predecessors) {
            const predIssue = issues.find(i => i.key === predKey);
            if (predIssue) {
                collectIssueAndPredecessors(predIssue, group);
            }
        }

        // Voeg het issue toe aan de groep
        group.push(issue);
    }

    // Verzamel eerst alle issues die voorganger zijn van een ander issue
    const predecessorIssues = new Set<string>();
    issues.forEach(issue => {
        const successors = getSuccessors(issue);
        if (successors.length > 0) {
            predecessorIssues.add(issue.key);
        }
    });

    // Verzamel eerst alle issues die voorganger zijn
    issues.forEach(issue => {
        if (predecessorIssues.has(issue.key) && !processedIssues.has(issue.key)) {
            const group: Issue[] = [];
            collectIssueAndPredecessors(issue, group);
            if (group.length > 0) {
                issueGroups.push(group);
            }
        }
    });

    // Verzamel dan issues met voorgangers, maar alleen als alle voorgangers al zijn verwerkt
    let hasNewIssues = true;
    while (hasNewIssues) {
        hasNewIssues = false;
        issues.forEach(issue => {
            if (getPredecessors(issue).length > 0 && 
                !processedIssues.has(issue.key) && 
                areAllPredecessorsProcessed(issue)) {
                const group: Issue[] = [];
                collectIssueAndPredecessors(issue, group);
                if (group.length > 0) {
                    issueGroups.push(group);
                    hasNewIssues = true;
                }
            }
        });
    }

    // Verzamel dan opvolgers die nog niet gepland zijn
    issues.forEach(issue => {
        if (getSuccessors(issue).length > 0 && !processedIssues.has(issue.key)) {
            const group: Issue[] = [];
            collectIssueAndPredecessors(issue, group);
            if (group.length > 0) {
                issueGroups.push(group);
            }
        }
    });

    // Verzamel issues zonder relaties maar met due date
    const issuesWithDueDate = issues.filter(issue => 
        !processedIssues.has(issue.key) && 
        getPredecessors(issue).length === 0 && 
        getSuccessors(issue).length === 0 && 
        issue.fields?.duedate
    );
    if (issuesWithDueDate.length > 0) {
        issueGroups.push(issuesWithDueDate);
    }

    // Verzamel issues zonder relaties en zonder due date
    const issuesWithoutDueDate = issues.filter(issue => 
        !processedIssues.has(issue.key) && 
        getPredecessors(issue).length === 0 && 
        getSuccessors(issue).length === 0 && 
        !issue.fields?.duedate
    );
    if (issuesWithoutDueDate.length > 0) {
        issueGroups.push(issuesWithoutDueDate);
    }

    // Sorteer issues binnen elke groep op prioriteit
    issueGroups.forEach(group => {
        group.sort((a, b) => {
            const priorityA = a.fields?.priority?.name || '0';
            const priorityB = b.fields?.priority?.name || '0';
            return priorityA.localeCompare(priorityB);
        });
    });

    // Log de volgorde van de issues
    logger.info('\nVolgorde van plannen:');
    issueGroups.forEach((group, index) => {
        logger.info(`\nGroep ${index + 1}:`);
        group.forEach(issue => {
            const predecessors = getPredecessors(issue);
            const successors = getSuccessors(issue);
            logger.info(`- ${issue.key} (${issue.fields?.summary}):`);
            logger.info(`  * Voorgangers: ${predecessors.length > 0 ? predecessors.join(', ') : 'geen'}`);
            logger.info(`  * Opvolgers: ${successors.length > 0 ? successors.join(', ') : 'geen'}`);
            logger.info(`  * Due date: ${issue.fields?.duedate || 'geen'}`);
            logger.info(`  * Prioriteit: ${issue.fields?.priority?.name || 'geen'}`);
        });
    });

    // Flatten de groepen tot één array
    return issueGroups.flat();
}

export async function calculatePlanning(issues: Issue[], projectType: string, googleSheetsData: (string | null)[][] | null): Promise<PlanningResult> {
    // Verzamel sprint capaciteiten uit Google Sheets
    const sprintCapacities = await getSprintCapacityFromSheet(googleSheetsData);
    
    // Filter sprint capaciteiten op basis van project type
    const filteredSprintCapacities = sprintCapacities.filter(capacity => {
        // Als er geen project is opgegeven, gebruik alle capaciteiten
        if (!projectType) {
            return true;
        }
        // Filter op basis van het project type
        return capacity.project === projectType;
    });

    // Bepaal huidige sprint
    const projectConfigs = await getProjectConfigsFromSheet(googleSheetsData);
    const projectConfig = projectConfigs.find((config: ProjectConfig) => config.project === projectType);
    
    let currentSprint = '1';
    let sprintStartDate = new Date('2025-05-15'); // Default startdatum als fallback

    if (projectConfig?.sprintStartDate) {
        const { sprintNumber, startDate } = calculateCurrentSprint(projectConfig.sprintStartDate);
        currentSprint = sprintNumber.toString();
        sprintStartDate = startDate;
    }
    
    // Initialiseer het resultaat met de juiste structuur
    const result: PlanningResult = {
        sprintHours: {},
        plannedIssues: [],
        issues: issues,
        sprints: filteredSprintCapacities,
        sprintAssignments: {},
        sprintCapacity: filteredSprintCapacities,
        employeeSprintUsedHours: {},
        currentSprint,
        capacityFactor: 1 // Standaard capaciteitsfactor is 1, omdat de aanpassing al in google-sheets.ts gebeurt
    };

    // Functie om cyclische afhankelijkheden te detecteren
    const detectCyclicDependencies = (issues: Issue[]): Set<string> => {
        const visited = new Set<string>();
        const recursionStack = new Set<string>();
        const cyclicIssues = new Set<string>();
        const cycles: string[][] = [];

        const dfs = (issueKey: string, path: string[] = []): boolean => {
            visited.add(issueKey);
            recursionStack.add(issueKey);
            path.push(issueKey);

            const issue = issues.find(i => i.key === issueKey);
            if (!issue) return false;

            const successors = getSuccessors(issue);
            for (const successorKey of successors) {
                if (!visited.has(successorKey)) {
                    if (dfs(successorKey, [...path])) {
                        cyclicIssues.add(issueKey);
                        return true;
                    }
                } else if (recursionStack.has(successorKey)) {
                    // We hebben een cyclus gevonden
                    const cycleStart = path.indexOf(successorKey);
                    const cycle = path.slice(cycleStart);
                    cycle.push(successorKey); // Voeg het startpunt toe om de cyclus te sluiten
                    cycles.push(cycle);
                    cyclicIssues.add(issueKey);
                    return true;
                }
            }

            recursionStack.delete(issueKey);
            path.pop();
            return false;
        };

        for (const issue of issues) {
            if (!visited.has(issue.key)) {
                dfs(issue.key);
            }
        }

        // Log de gevonden cycli
        if (cycles.length > 0) {
            logger.info('\nCyclische afhankelijkheden gedetecteerd:');
            cycles.forEach((cycle, index) => {
                logger.info(`Cyclus ${index + 1}: ${cycle.join(' → ')}`);
            });
            logger.info('Deze issues worden in sprint 100 geplaatst.');
        }

        return cyclicIssues;
    };

    // Detecteer cyclische afhankelijkheden
    const cyclicIssues = detectCyclicDependencies(issues);

    // Helper functie om te controleren of een issue een opvolger heeft
    const hasSuccessors = (issue: Issue): boolean => {
        return getSuccessors(issue).length > 0;
    };

    // Helper functie om te controleren of een issue een voorganger heeft
    const hasPredecessors = (issue: Issue): boolean => {
        return getPredecessors(issue).length > 0;
    };

    // Helper functie om te controleren of alle voorgangers gepland zijn
    const areAllPredecessorsPlanned = (issue: Issue): boolean => {
        const predecessors = getPredecessors(issue);
        return predecessors.every(predecessorKey => 
            result.plannedIssues.some(pi => pi.issue.key === predecessorKey)
        );
    };

    // Helper functie om een issue te plannen
    const planIssue = (issue: Issue, sprintName: string, assignee: string): boolean => {
        const issueKey = issue.key;
        const issueHours = (issue.fields?.timeestimate || 0) / 3600;

        // Controleer of het issue al gepland is
        if (result.plannedIssues.some(pi => pi.issue.key === issueKey)) {
            return true;
        }

        // Controleer capaciteit
        const availableCapacity = getAvailableCapacity(sprintName, assignee, result);
        if (availableCapacity < issueHours) {
            logger.info(`Issue ${issueKey} heeft geen capaciteit in sprint ${sprintName} voor ${assignee}`);
            return false;
        }

        // Bereken de nieuwe gebruikte uren voor deze medewerker in deze sprint
        const currentUsedHours = result.employeeSprintUsedHours[assignee]?.[sprintName] || 0;
        const newUsedHours = currentUsedHours + issueHours;

        // Voeg het issue toe aan de planning
        result.plannedIssues.push({
            issue,
            sprint: sprintName,
            hours: issueHours,
            assignee,
            key: issueKey
        });

        // Update sprintAssignments
        if (!result.sprintAssignments[sprintName]) {
            result.sprintAssignments[sprintName] = {};
        }
        if (!result.sprintAssignments[sprintName][assignee]) {
            result.sprintAssignments[sprintName][assignee] = [];
        }
        result.sprintAssignments[sprintName][assignee].push(issue);

        // Update sprintHours
        if (!result.sprintHours[sprintName]) {
            result.sprintHours[sprintName] = {};
        }
        if (!result.sprintHours[sprintName][assignee]) {
            result.sprintHours[sprintName][assignee] = 0;
        }
        result.sprintHours[sprintName][assignee] += issueHours;

        // Update employeeSprintUsedHours
        if (!result.employeeSprintUsedHours[assignee]) {
            result.employeeSprintUsedHours[assignee] = {};
        }
        if (!result.employeeSprintUsedHours[assignee][sprintName]) {
            result.employeeSprintUsedHours[assignee][sprintName] = 0;
        }
        result.employeeSprintUsedHours[assignee][sprintName] = newUsedHours;

        return true;
    };

    // Sorteer de issues op basis van relaties en due dates
    const sortedIssues = sortIssuesByRelationsAndDueDates(issues);

    // Plan eerst de issues met cyclische afhankelijkheden in sprint 100
    for (const issue of sortedIssues) {
        if (cyclicIssues.has(issue.key)) {
            const assignee = issue.fields?.assignee?.displayName || 'Unassigned';
            if (!planIssue(issue, '100', assignee)) {
                logger.info(`Issue ${issue.key} kon niet worden gepland in sprint 100`);
            }
        }
    }

    // Plan dan de rest van de issues
    for (const issue of sortedIssues) {
        // Sla issues met cyclische afhankelijkheden over
        if (cyclicIssues.has(issue.key)) {
            continue;
        }

        const assignee = issue.fields?.assignee?.displayName || 'Unassigned';
        
        // Controleer of alle voorgangers al gepland zijn
        const predecessors = getPredecessors(issue);
        const unplannedPredecessors = predecessors.filter(predKey => 
            !result.plannedIssues.some(pi => pi.issue.key === predKey)
        );

        if (unplannedPredecessors.length > 0) {
            logger.info(`Issue ${issue.key} heeft ongeplande voorgangers, probeer deze eerst te plannen`);
            continue;
        }

        // Vind de eerste beschikbare sprint
        const sprintName = findFirstAvailableSprint(issue, result);
        
        // Plan het issue
        if (!planIssue(issue, sprintName, assignee)) {
            logger.info(`Issue ${issue.key} kon niet worden gepland, opvolgers worden overgeslagen`);
        }
    }

    return result;
}
