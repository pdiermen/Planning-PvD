import type { Issue as JiraIssue, Issue, SprintCapacity, PlanningResult, PlannedIssue, IssueLink, EfficiencyData, ProjectConfig, WorklogConfig, WorkLog } from '../types.js';
import { getSprintCapacityFromSheet } from '../google-sheets.js';
import logger from '../logger.js';
import { getSuccessors, getPredecessors } from '../utils/jira-helpers.js';
import { getAssigneeName } from '../utils/shared-functions.js';
import { getProjectConfigsFromSheet } from '../google-sheets.js';

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
                        
                        // Update de sprint van het issue
                        plannedIssue.sprint = newSprint;
                        
                        // Update sprintHours
                        const oldSprintHours = planning.sprintHours[plannedIssue.sprint];
                        if (oldSprintHours) {
                            const issueHours = oldSprintHours[plannedIssue.assignee] || 0;
                            if (issueHours > 0) {
                                // Verwijder uit oude sprint
                                planning.sprintHours[plannedIssue.sprint][plannedIssue.assignee] -= issueHours;
                                
                                // Voeg toe aan nieuwe sprint
                                if (!planning.sprintHours[newSprint]) {
                                    planning.sprintHours[newSprint] = {};
                                }
                                if (!planning.sprintHours[newSprint][plannedIssue.assignee]) {
                                    planning.sprintHours[newSprint][plannedIssue.assignee] = 0;
                                }
                                planning.sprintHours[newSprint][plannedIssue.assignee] += issueHours;
                            }
                        }
                        
                        // Update sprintAssignments
                        if (planning.sprintAssignments[plannedIssue.sprint]?.[plannedIssue.assignee]) {
                            planning.sprintAssignments[plannedIssue.sprint][plannedIssue.assignee] = 
                                planning.sprintAssignments[plannedIssue.sprint][plannedIssue.assignee].filter(i => i.key !== issue.key);
                        }
                        if (!planning.sprintAssignments[newSprint]) {
                            planning.sprintAssignments[newSprint] = {};
                        }
                        if (!planning.sprintAssignments[newSprint][plannedIssue.assignee]) {
                            planning.sprintAssignments[newSprint][plannedIssue.assignee] = [];
                        }
                        planning.sprintAssignments[newSprint][plannedIssue.assignee].push(issue);
                        
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
                        
                        // Update de sprint van de opvolger
                        successor.sprint = newSprint;
                        
                        // Update sprintHours
                        const oldSprintHours = planning.sprintHours[successor.sprint];
                        if (oldSprintHours) {
                            const issueHours = oldSprintHours[successor.assignee] || 0;
                            if (issueHours > 0) {
                                // Verwijder uit oude sprint
                                planning.sprintHours[successor.sprint][successor.assignee] -= issueHours;
                                
                                // Voeg toe aan nieuwe sprint
                                if (!planning.sprintHours[newSprint]) {
                                    planning.sprintHours[newSprint] = {};
                                }
                                if (!planning.sprintHours[newSprint][successor.assignee]) {
                                    planning.sprintHours[newSprint][successor.assignee] = 0;
                                }
                                planning.sprintHours[newSprint][successor.assignee] += issueHours;
                            }
                        }
                        
                        // Update sprintAssignments
                        if (planning.sprintAssignments[successor.sprint]?.[successor.assignee]) {
                            planning.sprintAssignments[successor.sprint][successor.assignee] = 
                                planning.sprintAssignments[successor.sprint][successor.assignee].filter(i => i.key !== successorKey);
                        }
                        if (!planning.sprintAssignments[newSprint]) {
                            planning.sprintAssignments[newSprint] = {};
                        }
                        if (!planning.sprintAssignments[newSprint][successor.assignee]) {
                            planning.sprintAssignments[newSprint][successor.assignee] = [];
                        }
                        planning.sprintAssignments[newSprint][successor.assignee].push(successor.issue);
                        
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
                
                if (predecessorSprintIndex >= issueSprintIndex) {
                    logger.info(`\nFout: Voorganger ${predecessorKey} is gepland in sprint ${predecessor.sprint} terwijl ${issue.key} in sprint ${plannedIssue.sprint} zit`);
                    
                    // Verplaats het issue naar een latere sprint
                    const newSprintIndex = predecessorSprintIndex + 1;
                    if (newSprintIndex < planning.sprints.length) {
                        const newSprint = planning.sprints[newSprintIndex].sprint;
                        logger.info(`Issue ${issue.key} wordt verplaatst naar sprint ${newSprint}`);
                        
                        // Update de sprint van het issue
                        plannedIssue.sprint = newSprint;
                        
                        // Update sprintHours
                        const oldSprintHours = planning.sprintHours[plannedIssue.sprint];
                        if (oldSprintHours) {
                            const issueHours = oldSprintHours[plannedIssue.assignee] || 0;
                            if (issueHours > 0) {
                                // Verwijder uit oude sprint
                                planning.sprintHours[plannedIssue.sprint][plannedIssue.assignee] -= issueHours;
                                
                                // Voeg toe aan nieuwe sprint
                                if (!planning.sprintHours[newSprint]) {
                                    planning.sprintHours[newSprint] = {};
                                }
                                if (!planning.sprintHours[newSprint][plannedIssue.assignee]) {
                                    planning.sprintHours[newSprint][plannedIssue.assignee] = 0;
                                }
                                planning.sprintHours[newSprint][plannedIssue.assignee] += issueHours;
                            }
                        }
                        
                        // Update sprintAssignments
                        if (planning.sprintAssignments[plannedIssue.sprint]?.[plannedIssue.assignee]) {
                            planning.sprintAssignments[plannedIssue.sprint][plannedIssue.assignee] = 
                                planning.sprintAssignments[plannedIssue.sprint][plannedIssue.assignee].filter(i => i.key !== issue.key);
                        }
                        if (!planning.sprintAssignments[newSprint]) {
                            planning.sprintAssignments[newSprint] = {};
                        }
                        if (!planning.sprintAssignments[newSprint][plannedIssue.assignee]) {
                            planning.sprintAssignments[newSprint][plannedIssue.assignee] = [];
                        }
                        planning.sprintAssignments[newSprint][plannedIssue.assignee].push(issue);
                        
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

    // Voor Peter van Diermen en Unassigned, gebruik de totale sprint capaciteit
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        // Bereken totale sprint capaciteit
        const totalSprintCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .reduce((sum, c) => sum + c.capacity, 0);

        // Bereken totaal gebruikte uren in de sprint
        const totalUsedHours = Object.values(planningResult.employeeSprintUsedHours)
            .reduce((sum, sprintData) => sum + (sprintData[sprintName] || 0), 0);

        // Debug logging voor sprint capaciteiten
        logger.info('\nSprint capaciteiten details:');
        planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .forEach(c => logger.info(`- ${c.employee}: ${c.capacity} uren`));
        
        // Debug logging voor gebruikte uren per medewerker
        logger.info('\nGebruikte uren per medewerker:');
        Object.entries(planningResult.employeeSprintUsedHours)
            .forEach(([emp, sprintData]) => {
                if (sprintData[sprintName]) {
                    logger.info(`- ${emp}: ${sprintData[sprintName]} uren`);
                }
            });
        logger.info('================================\n');

        // Controleer of er nog genoeg capaciteit is
        return totalUsedHours + issueHours <= totalSprintCapacity;
    }

    // Voor andere medewerkers, gebruik hun individuele capaciteit
    const employeeCapacity = planningResult.sprintCapacity.find(
        c => c.sprint === sprintName && c.employee === assignee
    )?.capacity || 0;

    const employeeUsed = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;

    return employeeUsed + issueHours <= employeeCapacity;
};

// Helper functie om de eerste beschikbare sprint te vinden
export function findFirstAvailableSprint(issue: JiraIssue, planningResult: PlanningResult, startIndex: number = 0): string {
    const assignee = getAssigneeName(issue.fields?.assignee);
    if (!assignee) return '100'; // Fallback sprint als er geen assignee is

    const issueHours = (issue.fields?.timeestimate || 0) / 3600;
    const sprintNames = [...new Set(planningResult.sprintCapacity.map(cap => cap.sprint))]
        .sort((a, b) => parseInt(a) - parseInt(b));

    // Controleer eerst of er voorgangers zijn in sprint 100
    const predecessors = getPredecessors(issue);
    for (const predecessorKey of predecessors) {
        const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
        if (predecessor && predecessor.sprint === '100') {
            return '100';
        }
    }

    // Haal de due date van het issue op
    const dueDate = issue.fields?.duedate ? new Date(issue.fields?.duedate) : null;
    const currentDate = new Date();

    // Als het issue een due date heeft, vind eerst de sprint waar de due date in valt
    let dueDateSprintIndex = -1;
    if (dueDate) {
        for (let i = 0; i < sprintNames.length; i++) {
            const sprintName = sprintNames[i];
            const sprint = planningResult.sprints.find(s => s.sprint === sprintName);
            if (!sprint?.startDate) continue;
            
            const sprintStartDate = new Date(sprint.startDate);
            const sprintEndDate = new Date(sprintStartDate);
            sprintEndDate.setDate(sprintStartDate.getDate() + 14); // Sprint duurt 2 weken

            // Als de due date in deze sprint valt, onthoud deze sprint index
            if (dueDate >= sprintStartDate && dueDate <= sprintEndDate) {
                dueDateSprintIndex = i;
                break;
            }
        }
    }

    // Vind de sprint van de laatste voorganger
    let lastPredecessorSprintIndex = -1;

    for (const predecessorKey of predecessors) {
        const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
        if (predecessor) {
            const predecessorSprintIndex = sprintNames.indexOf(predecessor.sprint);
            if (predecessorSprintIndex > lastPredecessorSprintIndex) {
                lastPredecessorSprintIndex = predecessorSprintIndex;
            }
        }
    }

    // Als het issue een due date heeft die in het verleden ligt,
    // begin dan vanaf de huidige sprint
    let startFromIndex = startIndex;
    if (dueDate && dueDate < currentDate) {
        const currentSprintIndex = sprintNames.indexOf(planningResult.currentSprint);
        if (currentSprintIndex !== -1) {
            startFromIndex = Math.max(startFromIndex, currentSprintIndex);
        }
    }

    // Bepaal de hoogste sprint van de due date en de sprint na de laatste voorganger
    const highestSprintIndex = Math.max(
        dueDateSprintIndex !== -1 ? dueDateSprintIndex : -1,
        lastPredecessorSprintIndex !== -1 ? lastPredecessorSprintIndex + 1 : -1
    );

    // Als er een hoogste sprint is gevonden, gebruik die als startpunt
    if (highestSprintIndex !== -1) {
        startFromIndex = Math.max(startFromIndex, highestSprintIndex);
    }
    
    // Als het issue een due date heeft, zoek eerst in de sprint waar de due date in valt
    if (dueDateSprintIndex !== -1) {
        const sprintName = sprintNames[dueDateSprintIndex];
        
        // Controleer of er opvolgers zijn die al gepland zijn in deze sprint of eerder
        const successors = getSuccessors(issue);
        let canPlaceInSprint = true;
        for (const successorKey of successors) {
            const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor) {
                const successorSprintIndex = sprintNames.indexOf(successor.sprint);
                if (successorSprintIndex <= dueDateSprintIndex) {
                    canPlaceInSprint = false;
                    break;
                }
            }
        }

        if (canPlaceInSprint) {
            // Voor Peter van Diermen en Unassigned, gebruik de totale sprint capaciteit
            if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
                const totalCapacity = planningResult.sprintCapacity
                    .filter(cap => cap.sprint === sprintName)
                    .reduce((sum, cap) => sum + cap.capacity, 0);

                const usedHours = Object.values(planningResult.employeeSprintUsedHours)
                    .reduce((sum, sprintData) => sum + (sprintData[sprintName] || 0), 0);

                const availableCapacity = totalCapacity - usedHours;

                if (availableCapacity >= issueHours) {
                    return sprintName;
                }
            } else {
                const totalCapacity = planningResult.sprintCapacity
                    .filter(cap => cap.sprint === sprintName && cap.employee === assignee)
                    .reduce((sum, cap) => sum + cap.capacity, 0);

                const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;
                const availableCapacity = totalCapacity - usedHours;

                if (availableCapacity >= issueHours) {
                    return sprintName;
                }
            }
        }
        
        // Als er geen capaciteit is in de sprint waar de due date in valt,
        // of als er opvolgers zijn die al gepland zijn in deze sprint of eerder,
        // zoek dan in latere sprints
        for (let i = dueDateSprintIndex + 1; i < sprintNames.length; i++) {
            const sprintName = sprintNames[i];
            
            // Controleer of er opvolgers zijn die al gepland zijn in deze sprint of eerder
            let canPlaceInSprint = true;
            for (const successorKey of successors) {
                const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
                if (successor) {
                    const successorSprintIndex = sprintNames.indexOf(successor.sprint);
                    if (successorSprintIndex <= i) {
                        canPlaceInSprint = false;
                        break;
                    }
                }
            }

            if (canPlaceInSprint) {
                if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
                    const totalCapacity = planningResult.sprintCapacity
                        .filter(cap => cap.sprint === sprintName)
                        .reduce((sum, cap) => sum + cap.capacity, 0);

                    const usedHours = Object.values(planningResult.employeeSprintUsedHours)
                        .reduce((sum, sprintData) => sum + (sprintData[sprintName] || 0), 0);

                    const availableCapacity = totalCapacity - usedHours;

                    if (availableCapacity >= issueHours) {
                        return sprintName;
                    }
                } else {
                    const totalCapacity = planningResult.sprintCapacity
                        .filter(cap => cap.sprint === sprintName && cap.employee === assignee)
                        .reduce((sum, cap) => sum + cap.capacity, 0);

                    const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;
                    const availableCapacity = totalCapacity - usedHours;

                    if (availableCapacity >= issueHours) {
                        return sprintName;
                    }
                }
            }
        }
    } else {
        // Als het issue geen due date heeft, zoek vanaf de opgegeven index
        for (let i = startFromIndex; i < sprintNames.length; i++) {
            const sprintName = sprintNames[i];
            
            // Controleer of er opvolgers zijn die al gepland zijn in deze sprint of eerder
            const successors = getSuccessors(issue);
            let canPlaceInSprint = true;
            for (const successorKey of successors) {
                const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
                if (successor) {
                    const successorSprintIndex = sprintNames.indexOf(successor.sprint);
                    if (successorSprintIndex <= i) {
                        canPlaceInSprint = false;
                        break;
                    }
                }
            }

            if (canPlaceInSprint) {
                if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
                    const totalCapacity = planningResult.sprintCapacity
                        .filter(cap => cap.sprint === sprintName)
                        .reduce((sum, cap) => sum + cap.capacity, 0);

                    const usedHours = Object.values(planningResult.employeeSprintUsedHours)
                        .reduce((sum, sprintData) => sum + (sprintData[sprintName] || 0), 0);

                    const availableCapacity = totalCapacity - usedHours;

                    if (availableCapacity >= issueHours) {
                        return sprintName;
                    }
                } else {
                    const totalCapacity = planningResult.sprintCapacity
                        .filter(cap => cap.sprint === sprintName && cap.employee === assignee)
                        .reduce((sum, cap) => sum + cap.capacity, 0);

                    const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;
                    const availableCapacity = totalCapacity - usedHours;

                    if (availableCapacity >= issueHours) {
                        return sprintName;
                    }
                }
            }
        }
    }

    // Als we hier komen, betekent dit dat er geen sprint is met voldoende capaciteit
    // In dit geval moeten we de laatste sprint gebruiken
    return sprintNames[sprintNames.length - 1];
}

// Helper functie om de beschikbare capaciteit te berekenen
const getAvailableCapacity = (sprintName: string, assignee: string, planningResult: PlanningResult): number => {
    
    // Voor Peter van Diermen en Unassigned, gebruik de totale sprint capaciteit
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        // Bereken totale sprint capaciteit
        const totalSprintCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .reduce((sum, c) => sum + c.capacity, 0);

        // Bereken totaal gebruikte uren in de sprint
        const totalUsedHours = Object.values(planningResult.employeeSprintUsedHours)
            .reduce((sum, sprintData) => sum + (sprintData[sprintName] || 0), 0);


        return Math.round((totalSprintCapacity - totalUsedHours) * 10) / 10;
    }

    // Voor andere medewerkers, gebruik hun individuele capaciteit
    const capacity = planningResult.sprintCapacity.find(
        c => c.sprint === sprintName && c.employee === assignee
    );
    if (!capacity) {
        return 0;
    }

    const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;

    return Math.round((capacity.capacity - usedHours) * 10) / 10;
};

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

interface SprintCapacity {
    sprint: string;
    employee: string;
    capacity: number;
    availableCapacity: number;
    project: string;
    startDate?: string; // Optioneel omdat niet alle sprints een startDate hebben
}

export async function calculatePlanning(issues: Issue[], projectType: string, googleSheetsData: (string | null)[][] | null): Promise<PlanningResult> {
    // Debug logging voor alle issues
    logger.info('\nDebug: Alle issues in de planning:');
    issues.forEach(issue => {
        logger.info(`- ${issue.key}: ${issue.fields?.summary || 'Geen titel'}`);
    });

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

    // Bepaal huidige sprint en capaciteitsfactor
    const projectConfigs = await getProjectConfigsFromSheet(googleSheetsData);
    const projectConfig = projectConfigs.find((config: ProjectConfig) => config.project === projectType);
    
    let currentSprint = '1';
    let capacityFactor = 1;

    if (projectConfig?.sprintStartDate) {
        const sprintStartDate = projectConfig.sprintStartDate;
        const currentDate = new Date();
        const sprintDuration = 14; // 2 weken in dagen
        const workDaysPerSprint = 10; // 2 weken = 10 werkdagen

        // Bereken hoeveel sprints er zijn verstreken sinds de startdatum
        const totalDaysSinceStart = Math.floor((currentDate.getTime() - sprintStartDate.getTime()) / (1000 * 60 * 60 * 24));
        const completedSprints = Math.floor(totalDaysSinceStart / sprintDuration);

        // Bepaal startdatum van huidige sprint
        const currentSprintStartDate = new Date(sprintStartDate);
        currentSprintStartDate.setDate(sprintStartDate.getDate() + (completedSprints * sprintDuration));

        // Bepaal hoeveel werkdagen er nog over zijn in huidige sprint
        const workDaysInCurrentSprint = getWorkDaysBetween(currentSprintStartDate, currentDate);
        const remainingWorkDaysInSprint = workDaysPerSprint - workDaysInCurrentSprint;

        // Bereken evenredig deel van capaciteit voor huidige sprint
        capacityFactor = remainingWorkDaysInSprint / workDaysPerSprint;
        currentSprint = (completedSprints + 1).toString();

        logger.info(`\nSprint berekeningen:`);
        logger.info(`- Sprint startdatum: ${sprintStartDate.toISOString()}`);
        logger.info(`- Huidige datum: ${currentDate.toISOString()}`);
        logger.info(`- Huidige sprint: ${currentSprint}`);
        logger.info(`- Werkdagen in huidige sprint: ${workDaysInCurrentSprint}`);
        logger.info(`- Resterende werkdagen: ${remainingWorkDaysInSprint}`);
        logger.info(`- Capaciteitsfactor: ${capacityFactor.toFixed(2)}`);
    }

    // Pas de capaciteiten aan voor de huidige sprint
    const adjustedSprintCapacities = filteredSprintCapacities.map(capacity => ({
        ...capacity,
        availableCapacity: capacity.sprint === currentSprint 
            ? Math.round(capacity.capacity * capacityFactor * 10) / 10 
            : capacity.capacity
    }));
    
    // Initialiseer het resultaat met de juiste structuur
    const result: PlanningResult = {
        sprintHours: {},
        plannedIssues: [],
        issues: issues,
        sprints: adjustedSprintCapacities,
        sprintAssignments: {},
        sprintCapacity: adjustedSprintCapacities,
        employeeSprintUsedHours: {},
        currentSprint,
        capacityFactor
    };

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
            return false;
        }

        // Voeg het issue toe aan de planning
        result.plannedIssues.push({
            issue,
            sprint: sprintName,
            assignee,
            hours: issueHours,
            key: issueKey
        });

        // Update gebruikte uren
        if (!result.employeeSprintUsedHours[assignee]) {
            result.employeeSprintUsedHours[assignee] = {};
        }
        result.employeeSprintUsedHours[assignee][sprintName] = 
            (result.employeeSprintUsedHours[assignee][sprintName] || 0) + issueHours;

        // Update sprintHours alleen als er daadwerkelijk een issue wordt gepland
        if (!result.sprintHours[sprintName]) {
            result.sprintHours[sprintName] = {};
        }
        if (!result.sprintHours[sprintName][assignee]) {
            result.sprintHours[sprintName][assignee] = 0;
        }
        result.sprintHours[sprintName][assignee] += issueHours;

        return true;
    };

    // Sorteer issues op basis van relaties en due dates
    const issuesToSort = [...issues];
    const originalKeys = new Set(issuesToSort.map(issue => issue.key));

    // Sorteer issues op basis van relaties en due dates
    const sortedIssues = issuesToSort.sort((a, b) => {
        // Bepaal of issues relaties hebben
        const aHasRelations = getPredecessors(a).length > 0 || getSuccessors(a).length > 0;
        const bHasRelations = getPredecessors(b).length > 0 || getSuccessors(b).length > 0;

        // Als een issue geen relaties heeft en het andere wel, komt het issue zonder relaties eerst
        if (!aHasRelations && bHasRelations) {
            return -1;
        }
        if (aHasRelations && !bHasRelations) {
            return 1;
        }

        // Als beide issues relaties hebben, gebruik de relatie-gebaseerde sortering
        if (aHasRelations && bHasRelations) {
            const aPredecessors = getPredecessors(a);
            const bPredecessors = getPredecessors(b);
            const aSuccessors = getSuccessors(a);
            const bSuccessors = getSuccessors(b);

            // Als a een voorganger is van b
            if (aSuccessors.includes(b.key)) {
                return -1;
            }
            // Als b een voorganger is van a
            if (bSuccessors.includes(a.key)) {
                return 1;
            }
            // Als a een opvolger is van b
            if (aPredecessors.includes(b.key)) {
                return 1;
            }
            // Als b een opvolger is van a
            if (bPredecessors.includes(a.key)) {
                return -1;
            }
        }

        // Als er geen relaties zijn of als de relaties geen due date conflicten hebben,
        // sorteer op basis van due dates
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
    });

    // Verifieer dat alle issues nog steeds aanwezig zijn
    const sortedKeys = new Set(sortedIssues.map(issue => issue.key));
    const missingKeys = [...originalKeys].filter(key => !sortedKeys.has(key));
    if (missingKeys.length > 0) {
        logger.info(`\nWAARSCHUWING: Ontbrekende issues na sortering:`);
        missingKeys.forEach(key => logger.info(`- ${key}`));
    }

    // Loop door de gesorteerde issues en plan ze
    for (let i = 0; i < sortedIssues.length; i++) {
        const issue = sortedIssues[i];
        const assignee = getAssigneeName(issue.fields?.assignee);
        
        // Debug logging voor AMP-14721
        if (issue.key === 'AMP-14721') {
            logger.info(`\nDebug: Proberen AMP-14721 te plannen`);
            logger.info(`- Assignee: ${assignee}`);
            logger.info(`- Voorgangers: ${getPredecessors(issue).join(', ')}`);
            logger.info(`- Opvolgers: ${getSuccessors(issue).join(', ')}`);
            logger.info(`- Uren: ${(issue.fields?.timeestimate || 0) / 3600}`);
        }
        
        // Vind de eerste beschikbare sprint
        const sprintName = findFirstAvailableSprint(issue, result, 0);
        
        // Debug logging voor AMP-14721
        if (issue.key === 'AMP-14721') {
            logger.info(`- Gevonden sprint: ${sprintName}`);
            logger.info(`- Beschikbare capaciteit in sprint ${sprintName}: ${getAvailableCapacity(sprintName, assignee, result)}`);
        }
        
        // Plan het issue
        const planned = planIssue(issue, sprintName, assignee);
        
        // Debug logging voor AMP-14721
        if (issue.key === 'AMP-14721') {
            logger.info(`- Gepland: ${planned}`);
            if (!planned) {
                logger.info(`- Reden: Geen voldoende capaciteit in sprint ${sprintName}`);
            }
        }
    }

    // Valideer de planning volgorde
    let isValid = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!isValid && attempts < maxAttempts) {
        isValid = validatePlanningOrder(result);
        if (!isValid) {
            logger.info(`\nPoging ${attempts + 1} van ${maxAttempts} om planning volgorde te corrigeren...`);
            attempts++;
        }
    }

    if (!isValid) {
        logger.info(`\nWAARSCHUWING: Kon planning volgorde niet volledig corrigeren na ${maxAttempts} pogingen`);
    }

    return result;
}
