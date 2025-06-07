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

// Helper functie om de eerste beschikbare sprint te vinden
export function findFirstAvailableSprint(issue: Issue, planningResult: PlanningResult): string {
    const issueKey = issue.key;
    const assignee = issue.fields?.assignee?.displayName || 'Unassigned';
    const dueDate = issue.fields?.duedate;
    const issueHours = (issue.fields?.timeestimate || 0) / 3600;

    // Verzamel alle sprints uit sprintCapacity
    const sprintNames = [...new Set(planningResult.sprintCapacity.map(c => c.sprint))]
        .sort((a, b) => parseInt(a) - parseInt(b));

    // Bepaal vanaf welke sprint we moeten zoeken
    let startFromIndex = 0;
    if (dueDate) {
        const dueDateObj = new Date(dueDate);
        // Vind de sprint waar de due date in valt
        startFromIndex = planningResult.sprints.findIndex(s => {
            if (!s.startDate) return false;
            const sprintStartDate = new Date(s.startDate);
            const sprintEndDate = new Date(sprintStartDate);
            sprintEndDate.setDate(sprintStartDate.getDate() + 14); // Sprint duurt 2 weken
            return dueDateObj >= sprintStartDate && dueDateObj <= sprintEndDate;
        });
        if (startFromIndex === -1) {
            // Als de due date niet in een sprint valt, zoek de eerste sprint na de due date
            startFromIndex = planningResult.sprints.findIndex(s => {
                if (!s.startDate) return false;
                const sprintStartDate = new Date(s.startDate);
                return sprintStartDate >= dueDateObj;
            });
        }
        if (startFromIndex === -1) {
            startFromIndex = 0;
        }
    }

    // Zoek de eerste sprint met voldoende capaciteit
    for (let i = startFromIndex; i < sprintNames.length; i++) {
        const sprintName = sprintNames[i];
        const availableCapacity = getAvailableCapacity(sprintName, assignee, planningResult);

        // Check of er voorgangers zijn in deze of latere sprints
        const predecessors = getPredecessors(issue);
        const hasPredecessorsInCurrentOrLaterSprint = predecessors.some(predecessorKey => {
            const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (!predecessor) return false;
            const predecessorSprintIndex = sprintNames.indexOf(predecessor.sprint);
            return predecessorSprintIndex >= i;
        });

        if (hasPredecessorsInCurrentOrLaterSprint) {
            continue;
        }

        if (availableCapacity >= issueHours) {
            return sprintName;
        } else {
            // Controleer of er nog latere sprints zijn
            if (i < sprintNames.length - 1) {
                continue; // Ga door naar de volgende sprint
            }
        }
    }

    // Als een issue in sprint 100 wordt geplaatst, moeten ook de opvolgers in sprint 100
    const successors = getSuccessors(issue);
    if (successors.length > 0) {
        successors.forEach(successorKey => {
            const successor = planningResult.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor && successor.sprint !== '100') {
                successor.sprint = '100';
            }
        });
    }

    return '100';
}

// Helper functie om de beschikbare capaciteit te berekenen
function getAvailableCapacity(sprintName: string, assignee: string, planningResult: PlanningResult): number {
    // Speciale behandeling voor Peter van Diermen en Unassigned
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        const totalSprintCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName)
            .reduce((sum, c) => sum + c.capacity, 0);
        const plannedIssuesHours = planningResult.plannedIssues
            .filter(pi => pi.sprint === sprintName)
            .reduce((sum, pi) => sum + (pi.issue.fields?.timeestimate || 0) / 3600, 0);
        
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

    // Combineer alle groepen in de juiste volgorde
    return [
        ...sortByPriority(predecessorIssues),
        ...sortByPriority(issuesWithPredecessors),
        ...sortByPriority(successorIssues),
        ...sortByPriority(issuesWithDueDate),
        ...sortByPriority(issuesWithoutDueDate)
    ];
}

interface EmployeeCapacity {
    name: string;
    capacity: number;
}

async function getEmployeeCapacitiesFromSheet(googleSheetsData: (string | null)[][] | null): Promise<EmployeeCapacity[]> {
    if (!googleSheetsData || googleSheetsData.length === 0) {
        logger.error('Geen Google Sheets data beschikbaar');
        return [];
    }

    const employeeCapacities: EmployeeCapacity[] = [];
    const headerRow = googleSheetsData[0];
    
    if (!headerRow || !Array.isArray(headerRow)) {
        logger.error('Ongeldige header rij in Google Sheets data');
        return [];
    }

    // Log de header rij om te zien welke kolommen beschikbaar zijn
    logger.info('Beschikbare kolommen in header rij:');
    headerRow.forEach((header, index) => {
        logger.info(`Kolom ${index + 1}: ${header}`);
    });

    // Zoek de kolom indices
    const nameIndex = headerRow.findIndex(header => header?.toLowerCase().includes('naam'));
    const effectiveHoursIndex = headerRow.findIndex(header => header?.toLowerCase().includes('effectieve uren'));

    if (nameIndex === -1 || effectiveHoursIndex === -1) {
        logger.error(`Verplichte kolommen niet gevonden in Google Sheets data. Gezocht naar 'naam' en 'effectieve uren'`);
        logger.error(`Gevonden kolommen: ${headerRow.join(', ')}`);
        return [];
    }

    logger.info(`Gevonden kolom 'naam' op index ${nameIndex + 1}`);
    logger.info(`Gevonden kolom 'effectieve uren' op index ${effectiveHoursIndex + 1}`);

    // Verwerk de data rijen
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row || !Array.isArray(row)) continue;

        const name = row[nameIndex];
        const weeklyCapacity = parseFloat(row[effectiveHoursIndex] || '0');

        if (name && !isNaN(weeklyCapacity)) {
            logger.info(`Medewerker gevonden: ${name} met ${weeklyCapacity} effectieve uren per week`);
            employeeCapacities.push({
                name: name.toString(),
                capacity: weeklyCapacity * 2 // Sprint capaciteit is 2 weken
            });
        }
    }

    return employeeCapacities;
}

// Functie om de beschikbare capaciteit voor een sprint te berekenen
function calculateSprintCapacity(
    sprintNumber: string,
    sprintDates: { [key: string]: { start: Date; end: Date } },
    currentDate: Date,
    sprintCapacity: number
): number {
    const sprint = sprintDates[sprintNumber];
    if (!sprint) return 0;

    // Als het de huidige sprint is, bereken dan de resterende werkdagen
    if (currentDate >= sprint.start && currentDate <= sprint.end) {
        const remainingWorkDays = getWorkDaysBetween(currentDate, sprint.end);
        return (sprintCapacity / 10) * remainingWorkDays; // Verdeel sprint capaciteit over werkdagen
    }

    // Voor toekomstige sprints, gebruik de volledige sprint capaciteit
    return sprintCapacity;
}

// Functie om te controleren of een issue in een sprint past
function checkSprintCapacity(
    issue: Issue,
    sprint: string,
    sprintDates: { [key: string]: { start: Date; end: Date } },
    currentDate: Date,
    employeeCapacities: EmployeeCapacity[],
    sprintCapacities: SprintCapacity[]
): { canFit: boolean; reason: string } {
    // Gebruik timeestimate (resterende uren) in plaats van timeoriginalestimate
    const issueHours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
    const assignee = issue.fields?.assignee?.displayName || 'Unassigned';
    
    logger.info(`\nControle capaciteit voor issue ${issue.key}:`);
    logger.info(`- Medewerker: ${assignee}`);
    logger.info(`- Aantal uren: ${issueHours}`);
    logger.info(`- Due date: ${issue.fields?.duedate || 'Geen'}`);
    logger.info(`- Beoogde sprint: ${sprint}`);

    // Haal de beschikbare capaciteit op uit de sprintCapacity array
    const sprintCapacityEntry = sprintCapacities.find(
        cap => cap.sprint === sprint && cap.employee === assignee
    );
    
    if (!sprintCapacityEntry) {
        return { 
            canFit: false, 
            reason: `Geen capaciteit gevonden voor medewerker ${assignee} in sprint ${sprint}` 
        };
    }
    
    logger.info(`Beschikbare capaciteit in sprint: ${sprintCapacityEntry.availableCapacity} uur`);
    
    // Voor Peter van Diermen of Unassigned: controleer alleen resterende sprint capaciteit
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        if (sprintCapacityEntry.availableCapacity >= issueHours) {
            return { 
                canFit: true, 
                reason: `Voldoende resterende sprint capaciteit (${sprintCapacityEntry.availableCapacity} uur beschikbaar voor ${issueHours} uur)` 
            };
        } else {
            return { 
                canFit: false, 
                reason: `Onvoldoende resterende sprint capaciteit (${sprintCapacityEntry.availableCapacity} uur beschikbaar voor ${issueHours} uur)` 
            };
        }
    }
    
    // Voor overige medewerkers: controleer zowel medewerker als sprint capaciteit
    const employeeCapacity = employeeCapacities.find(emp => emp.name === assignee);
    if (!employeeCapacity) {
        return { 
            canFit: false, 
            reason: `Geen capaciteit gevonden voor medewerker ${assignee}` 
        };
    }
    
    logger.info(`Beschikbare medewerker capaciteit: ${employeeCapacity.capacity} uur`);
    
    if (employeeCapacity.capacity >= issueHours && sprintCapacityEntry.availableCapacity >= issueHours) {
        return { 
            canFit: true, 
            reason: `Voldoende medewerker en sprint capaciteit (${employeeCapacity.capacity} uur medewerker, ${sprintCapacityEntry.availableCapacity} uur sprint beschikbaar voor ${issueHours} uur)` 
        };
    } else {
        return { 
            canFit: false, 
            reason: `Onvoldoende capaciteit (${employeeCapacity.capacity} uur medewerker, ${sprintCapacityEntry.availableCapacity} uur sprint beschikbaar voor ${issueHours} uur)` 
        };
    }
}

// Functie om een issue te plannen
function planIssue(
    issue: Issue,
    sprint: string,
    sprintDates: { [key: string]: { start: Date; end: Date } },
    currentDate: Date,
    employeeCapacities: EmployeeCapacity[],
    sprintCapacities: SprintCapacity[]
): { success: boolean; reason: string } {
    // Controleer eerst de voorgangers/opvolgers regels
    const planningResult: PlanningResult = {
        sprints: sprintCapacities,
        plannedIssues: [], // Dit wordt later gevuld
        sprintHours: {},
        issues: [], // Vereist veld
        sprintAssignments: {}, // Vereist veld
        sprintCapacity: sprintCapacities,
        employeeSprintUsedHours: {}, // Vereist veld
        currentSprint: sprint, // Vereist veld
        capacityFactor: 1 // Vereist veld
    };

    // Valideer voorgangers
    if (!validatePredecessorSprintOrder(issue, sprint, planningResult)) {
        return { 
            success: false, 
            reason: `Issue kan niet worden gepland omdat voorgangers nog niet zijn gepland of in een latere sprint zitten` 
        };
    }

    // Valideer opvolgers
    if (!validateIssueSprintOrder(issue, sprint, planningResult)) {
        return { 
            success: false, 
            reason: `Issue kan niet worden gepland omdat opvolgers al in een eerdere sprint zijn gepland` 
        };
    }

    // Controleer de capaciteit
    const capacityCheck = checkSprintCapacity(issue, sprint, sprintDates, currentDate, employeeCapacities, sprintCapacities);
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

    logger.info(`\nBereken planning voor project ${projectConfig.project}`);


    // Haal sprint capaciteiten op uit Google Sheets
    const sprintCapacities = await getSprintCapacityFromSheet(googleSheetsData);
    logger.info(`Aantal gevonden sprint capaciteiten: ${sprintCapacities.length}`);

    // Bepaal de project start datum
    const projectStartDate = projectConfig.sprintStartDate || new Date('2025-05-26');
    projectStartDate.setHours(0, 0, 0, 0);
    logger.info(`Project start datum: ${projectStartDate.toLocaleDateString('nl-NL')}`);

    // Bereken huidige datum
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);
    logger.info(`Huidige datum: ${currentDate.toLocaleDateString('nl-NL')}`);

    // Bereken aantal dagen tussen project start en huidige datum
    const daysBetween = Math.floor((currentDate.getTime() - projectStartDate.getTime()) / (1000 * 60 * 60 * 24));
    logger.info(`Aantal dagen tussen project start en huidige datum: ${daysBetween}`);

    // Bepaal sprint index op basis van huidige datum
    const sprintIndex = Math.floor(daysBetween / 14) + 1;
    logger.info(`Sprint index: ${sprintIndex}`);

    // Genereer sprint datums voor een jaar vooruit (26 sprints)
    const sprintDates: { [key: string]: { start: Date; end: Date } } = {};
    for (let i = 0; i < 26; i++) {
        const sprintNumber = sprintIndex + i;
        const startDate = new Date(projectStartDate);
        startDate.setDate(startDate.getDate() + (sprintNumber - 1) * 14);
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 13);
        
        sprintDates[sprintNumber.toString()] = {
            start: startDate,
            end: endDate
        };
        logger.info(`Sprint ${sprintNumber}: ${startDate.toLocaleDateString('nl-NL')} - ${endDate.toLocaleDateString('nl-NL')}`);
    }

    // Haal beschikbare capaciteit per medewerker op
    const employeeCapacities = await getEmployeeCapacitiesFromSheet(googleSheetsData);
    logger.info('\nBeschikbare capaciteit per medewerker:');
    for (const emp of employeeCapacities) {
        logger.info(`${emp.name}: ${emp.capacity} uur`);
    }

    // Bereken totale beschikbare capaciteit
    const totalCapacity = employeeCapacities.reduce((sum: number, emp: EmployeeCapacity) => sum + emp.capacity, 0);
    logger.info(`Totale beschikbare capaciteit: ${totalCapacity} uur`);

    

    // Plan issues op basis van beschikbare capaciteit
    const plannedIssues: PlannedIssue[] = [];
    const employeeSprintUsedHours: { [key: string]: { [key: string]: number } } = {};
    const sprintHours: { [key: string]: { [key: string]: number } } = {};

    // Sorteer issues op basis van key, alleen als key bestaat
    const sortedIssues = [...issues].filter(issue => issue && issue.key).sort((a, b) => a.key.localeCompare(b.key));

    for (const issue of sortedIssues) {
        const assignee = issue.fields?.assignee?.displayName || 'Unassigned';
        const issueHours = issue.fields?.timeoriginalestimate ? issue.fields.timeoriginalestimate / 3600 : 0;
        const dueDateStr = issue.fields?.duedate;
        let startSprintIndex = sprintIndex;

        // Bepaal de eerste sprint op basis van due date
        if (dueDateStr) {
            const dueDate = new Date(dueDateStr);
            dueDate.setHours(0, 0, 0, 0); // Reset tijd naar middernacht voor correcte vergelijking
            
            // Bereken het aantal dagen tussen project start en due date
            const daysToDueDate = Math.floor((dueDate.getTime() - projectStartDate.getTime()) / (1000 * 60 * 60 * 24));
            
            // Bereken de sprint index op basis van de due date
            startSprintIndex = Math.floor(daysToDueDate / 14) + 1;
            
            logger.info(`Due date ${dueDateStr} valt in sprint ${startSprintIndex}`);
        }

        logger.info(`\n[DEBUG] Issue details voor ${issue.key}:`);
        logger.info(`[DEBUG] - Toegewezen medewerker: ${assignee}`);
        logger.info(`[DEBUG] - Aantal uren: ${issueHours}`);
        logger.info(`[DEBUG] - Due date: ${dueDateStr || 'Geen'}`);
        
        // Probeer het issue in te plannen vanaf de juiste sprint
        let planned = false;
        for (let i = 0; i < 26; i++) {
            const sprintNumber = startSprintIndex + i;
            const sprintName = sprintNumber.toString();
            
            logger.info(`\nBeoogde sprint: ${sprintName}`);
            
            // Controleer of het issue past in de sprint
            logger.info(`[DEBUG] employeeCapacities voor ${assignee}: ${JSON.stringify(employeeCapacities, null, 2)}`);
            logger.info(`[DEBUG] sprintCapacities voor sprint ${sprintName}: ${JSON.stringify(sprintCapacities.filter(cap => cap.sprint === sprintName && cap.employee === assignee), null, 2)}`);
            const result = planIssue(issue, sprintName, sprintDates, currentDate, employeeCapacities, sprintCapacities);
            
            if (result.success) {
                logger.info(`Reden voor plannen: ${result.reason}`);
                plannedIssues.push({
                    issue,
                    sprint: sprintName,
                    hours: issueHours,
                    assignee,
                    key: issue.key
                });
                
                // Update gebruikte uren voor de medewerker
                if (!employeeSprintUsedHours[assignee]) {
                    employeeSprintUsedHours[assignee] = {};
                }
                employeeSprintUsedHours[assignee][sprintName] = (employeeSprintUsedHours[assignee][sprintName] || 0) + issueHours;
                
                // Update sprintHours
                if (!sprintHours[sprintName]) {
                    sprintHours[sprintName] = {};
                }
                sprintHours[sprintName][assignee] = (sprintHours[sprintName][assignee] || 0) + issueHours;
                
                // Update sprintCapacity
                const sprintCapacityIndex = sprintCapacities.findIndex(
                    cap => cap.sprint === sprintName && cap.employee === assignee
                );
                if (sprintCapacityIndex !== -1) {
                    sprintCapacities[sprintCapacityIndex].availableCapacity -= issueHours;
                }
                
                logger.info(`Issue ${issue.key} succesvol ingepland in sprint ${sprintName}`);
                planned = true;
                break;
            } else {
                logger.info(`Reden voor niet plannen: ${result.reason}`);
            }
        }

        if (!planned) {
            logger.info(`\nIssue ${issue.key} kon niet worden ingepland in de beschikbare sprints, wordt in fallback sprint geplaatst`);
            plannedIssues.push({
                issue,
                sprint: '100',
                hours: issueHours,
                assignee,
                key: issue.key
            });
            
            // Update sprintHours voor fallback sprint
            if (!sprintHours['100']) {
                sprintHours['100'] = {};
            }
            sprintHours['100'][assignee] = (sprintHours['100'][assignee] || 0) + issueHours;
        }
    }

    return {
        sprintHours,
        plannedIssues,
        issues,
        sprints: sprintCapacities,
        sprintAssignments: {},
        sprintCapacity: sprintCapacities,
        employeeSprintUsedHours,
        currentSprint: sprintIndex.toString(),
        capacityFactor: 1
    };
}
