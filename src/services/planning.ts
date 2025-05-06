import type { Issue, SprintCapacity, PlanningResult } from '../types.js';
import { getSprintCapacityFromSheet } from './sprints.js';
import { logger } from '../utils/logger.js';
import { getSuccessors, getPredecessors } from '../utils/jira-helpers.js';

// Status volgorde voor sortering
const STATUS_ORDER: Record<string, number> = {
    'Resolved': 0,
    'In Review': 1,
    'Open': 2,
    'Reopended': 3,
    'Reopend': 4,
    'Registered': 5,
    'Waiting': 6,
    'Testing': 7
};

// Helper functie om te valideren of de planning voldoet aan de volgorde-eisen
const validatePlanningOrder = (planning: PlanningResult): boolean => {
    let isValid = true;
    for (const plannedIssue of planning.plannedIssues) {
        const issue = plannedIssue.issue;
        const successors = getSuccessors(issue);
        
        for (const successorKey of successors) {
            const successor = planning.plannedIssues.find(pi => pi.issue.key === successorKey);
            if (successor) {
                // Controleer of de opvolger in een latere sprint is gepland
                const issueSprintIndex = planning.sprints.findIndex(s => s.sprint === plannedIssue.sprint);
                const successorSprintIndex = planning.sprints.findIndex(s => s.sprint === successor.sprint);
                
                if (successorSprintIndex <= issueSprintIndex) {
                    logger.log(`Fout: Opvolger ${successorKey} is gepland in dezelfde of eerdere sprint als ${issue.key}`);
                    // Verplaats de opvolger naar een latere sprint
                    const newSprintIndex = issueSprintIndex + 1;
                    if (newSprintIndex < planning.sprints.length) {
                        const newSprint = planning.sprints[newSprintIndex].sprint;
                        successor.sprint = newSprint;
                        logger.log(`Opvolger ${successorKey} is verplaatst naar sprint ${newSprint}`);
                        
                        // Update ook de sprintHours
                        const oldSprintHours = planning.sprintHours[successor.sprint];
                        if (oldSprintHours) {
                            const issueHours = oldSprintHours.find(h => h.issueKey === successorKey);
                            if (issueHours) {
                                // Verwijder uit oude sprint
                                planning.sprintHours[successor.sprint] = oldSprintHours.filter(h => h.issueKey !== successorKey);
                                
                                // Voeg toe aan nieuwe sprint
                                if (!planning.sprintHours[newSprint]) {
                                    planning.sprintHours[newSprint] = [];
                                }
                                planning.sprintHours[newSprint].push(issueHours);
                            }
                        }
                    } else {
                        // Als er geen latere sprint beschikbaar is, gebruik de laatste sprint
                        const lastSprint = planning.sprints[planning.sprints.length - 1].sprint;
                        successor.sprint = lastSprint;
                        logger.log(`Opvolger ${successorKey} is verplaatst naar de laatste sprint ${lastSprint}`);
                        
                        // Update ook de sprintHours
                        const oldSprintHours = planning.sprintHours[successor.sprint];
                        if (oldSprintHours) {
                            const issueHours = oldSprintHours.find(h => h.issueKey === successorKey);
                            if (issueHours) {
                                // Verwijder uit oude sprint
                                planning.sprintHours[successor.sprint] = oldSprintHours.filter(h => h.issueKey !== successorKey);
                                
                                // Voeg toe aan nieuwe sprint
                                if (!planning.sprintHours[lastSprint]) {
                                    planning.sprintHours[lastSprint] = [];
                                }
                                planning.sprintHours[lastSprint].push(issueHours);
                            }
                        }
                    }
                    isValid = false;
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
export function findFirstAvailableSprint(issue: Issue, assignee: string, startIndex: number = 0, planningResult: PlanningResult): string {
    // Check of dit een opvolger is
    const predecessors = getPredecessors(issue);
    let minStartIndex = startIndex;

    if (predecessors.length > 0) {
        // Vind de laatste sprint van de predecessors
        let lastPredecessorSprintIndex = -1;
        for (const predecessorKey of predecessors) {
            const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (predecessor) {
                const sprintIndex = planningResult.sprints.findIndex(s => s.sprint === predecessor.sprint);
                if (sprintIndex > lastPredecessorSprintIndex) {
                    lastPredecessorSprintIndex = sprintIndex;
                }
            }
        }
        
        // Begin zoeken vanaf de sprint na de laatste predecessor
        if (lastPredecessorSprintIndex !== -1) {
            minStartIndex = Math.max(startIndex, lastPredecessorSprintIndex + 1);
        }
    }

    // Zoek de eerste sprint met voldoende capaciteit, beginnend vanaf minStartIndex
    for (let i = minStartIndex; i < planningResult.sprints.length; i++) {
        const sprint = planningResult.sprints[i];
        
        // Controleer of er predecessors in deze sprint zitten
        const hasPredecessorInSprint = predecessors.some((predecessorKey: string) => {
            const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            return predecessor?.sprint === sprint.sprint;
        });
        
        if (hasPredecessorInSprint) {
            continue; // Skip deze sprint als er een predecessor in zit
        }

        // Nu controleren we de capaciteit
        const sprintCapacity = getAvailableCapacity(sprint.sprint, assignee, planningResult);
        const sprintHours = planningResult.employeeSprintUsedHours[assignee]?.[sprint.sprint] || 0;
        const issueHours = (issue.fields?.timeestimate || 0) / 3600;
        
        // Controleer of er voldoende capaciteit is
        if (sprintHours + issueHours <= sprintCapacity) {
            return sprint.sprint;
        }
    }

    // Als er geen sprint gevonden is, gebruik sprint 10
    return '10';
}

// Helper functie om beschikbare capaciteit te berekenen
const getAvailableCapacity = (sprintName: string, assignee: string, planningResult: PlanningResult): number => {
    // Voor Peter van Diermen en Unassigned, gebruik de som van beschikbare capaciteit van andere medewerkers
    if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
        // Bereken totaal beschikbare capaciteit van andere medewerkers
        const totalAvailableCapacity = planningResult.sprintCapacity
            .filter(c => c.sprint === sprintName && c.employee !== assignee)
            .reduce((total, c) => {
                // Bereken gebruikte uren voor deze medewerker
                const usedHours = planningResult.employeeSprintUsedHours[c.employee]?.[sprintName] || 0;
                return total + (c.capacity - usedHours);
            }, 0);
        
        return totalAvailableCapacity;
    }

    // Voor andere medewerkers, gebruik hun totale capaciteit
    const capacity = planningResult.sprintCapacity.find(
        (c: SprintCapacity) => c.sprint === sprintName && c.employee === assignee
    );
    if (!capacity) return 0;

    // Return de totale capaciteit, niet de beschikbare capaciteit
    return capacity.capacity;
};

// Helper functie om de displayName van een assignee te krijgen
function getAssigneeName(assignee: { displayName: string; } | string | undefined): string {
    if (!assignee) return 'Unassigned';
    if (typeof assignee === 'string') return assignee;
    return assignee.displayName;
}

export async function calculatePlanning(issues: Issue[], projectType: string, googleSheetsData: (string | null)[][] | null): Promise<PlanningResult> {
    console.log('\n=== START CALCULATE PLANNING ===');
    console.log(`Aantal issues: ${issues.length}`);
    
    
    // Verzamel sprint capaciteiten uit Google Sheets
    const sprintCapacities = await getSprintCapacityFromSheet(googleSheetsData);
    
    // Initialiseer het resultaat met de juiste structuur
    const result: PlanningResult = {
        sprintHours: {},
        plannedIssues: [],
        issues: issues,
        sprints: sprintCapacities,
        sprintAssignments: {},
        sprintCapacity: sprintCapacities,
        employeeSprintUsedHours: {}
    };

    // Verzamel unieke sprint namen en sorteer ze numeriek
    const sprintNames = new Set<string>();
    sprintCapacities.forEach((capacity: SprintCapacity) => sprintNames.add(capacity.sprint));
    result.sprints = Array.from(sprintNames)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(sprint => ({
            employee: '',
            sprint,
            capacity: 0
        }));

    console.log('\nBeschikbare sprints:');
    result.sprints.forEach(sprint => {
        console.log(`Sprint: ${sprint.sprint}`);
    });

    // Helper functie om een issue te plannen
    const planIssue = (issue: Issue, sprintName: string, assignee: string) => {
        // Gebruik timeestimate voor de planning
        const hours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
        
        // Initialiseer sprintHours voor deze sprint als die nog niet bestaat
        if (!result.sprintHours[sprintName]) {
            result.sprintHours[sprintName] = [];
        }
        
        // Voor Peter van Diermen en Unassigned, gebruik timeoriginalestimate voor weergave
        let displayHours = hours;
        if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
            displayHours = (issue.fields?.timeoriginalestimate || 0) / 3600;
        }
        
        // Voeg toe aan sprintHours met de weergave uren
        result.sprintHours[sprintName].push({
            issueKey: issue.key,
            hours: displayHours,
            issues: [issue]
        });

        // Voeg toe aan plannedIssues met de weergave uren
        result.plannedIssues.push({
            issue,
            sprint: sprintName,
            hours: displayHours,
            assignee,
            key: issue.key
        });

        // Initialiseer sprintAssignments voor deze sprint als die nog niet bestaat
        if (!result.sprintAssignments[sprintName]) {
            result.sprintAssignments[sprintName] = {};
        }
        
        // Voeg toe aan sprintAssignments
        if (!result.sprintAssignments[sprintName][assignee]) {
            result.sprintAssignments[sprintName][assignee] = [];
        }
        result.sprintAssignments[sprintName][assignee].push(issue);

        // Update employeeSprintUsedHours met de planning uren
        if (!result.employeeSprintUsedHours[assignee]) {
            result.employeeSprintUsedHours[assignee] = {};
        }
        if (!result.employeeSprintUsedHours[assignee][sprintName]) {
            result.employeeSprintUsedHours[assignee][sprintName] = 0;
        }
        result.employeeSprintUsedHours[assignee][sprintName] += hours;
    };

    // Helper functie om de sprint van het parent issue te vinden
    const findParentIssueSprint = (issue: Issue): string | undefined => {
        const predecessors = getPredecessors(issue);
        if (predecessors.length > 0) {
            const predecessor = result.plannedIssues.find(pi => pi.issue.key === predecessors[0]);
            return predecessor?.sprint;
        }
        return undefined;
    };

    // Helper functie om te controleren of een issue een opvolger is van een specifieke medewerker
    const isSuccessorOf = (issue: Issue, assigneeName: string) => {
        const predecessors = getPredecessors(issue);
        return predecessors.some((predecessorKey: string) => {
            const predecessor = result.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            return predecessor?.assignee === assigneeName;
        });
    };

    // Helper functie om te controleren of alle predecessors gepland zijn
    const areAllPredecessorsPlanned = (issue: Issue) => {
        const predecessors = getPredecessors(issue);
        return predecessors.every((predecessorKey: string) => 
            result.plannedIssues.some(pi => pi.issue.key === predecessorKey)
        );
    };

    // Helper functie om de eerste beschikbare sprint te vinden na de laatste predecessor
    const findFirstAvailableSprintAfterPredecessors = (issue: Issue, assignee: string) => {
        const predecessors = getPredecessors(issue);
        
        // Als er geen predecessors zijn, zoek dan de eerste beschikbare sprint
        if (predecessors.length === 0) {
            return findFirstAvailableSprint(issue, assignee, 0, result);
        }

        // Vind de laatste sprint van de predecessors
        let lastPredecessorSprintIndex = -1;
        for (const predecessorKey of predecessors) {
            const predecessor = result.plannedIssues.find(pi => pi.issue.key === predecessorKey);
            if (predecessor) {
                const sprintIndex = result.sprints.findIndex(s => s.sprint === predecessor.sprint);
                if (sprintIndex > lastPredecessorSprintIndex) {
                    lastPredecessorSprintIndex = sprintIndex;
                }
            }
        }

        // Als niet alle predecessors gepland zijn, return null
        if (lastPredecessorSprintIndex === -1) {
            return null;
        }

        // Zoek de eerste beschikbare sprint na de laatste predecessor
        return findFirstAvailableSprint(issue, assignee, lastPredecessorSprintIndex + 1, result);
    };

    // Helper functie om issues te sorteren op basis van projectcode, status en opvolgers
    const sortIssues = (issues: Issue[]): Issue[] => {
        console.log('\n=== START SORTEREN ISSUES ===');
        
        // Groepeer issues per projectcode
        const issuesByProject = new Map<string, Issue[]>();
        issues.forEach(issue => {
            const projectCode = issue.key.split('-')[0];
            if (!issuesByProject.has(projectCode)) {
                issuesByProject.set(projectCode, []);
            }
            issuesByProject.get(projectCode)?.push(issue);
        });


        // Sorteer issues binnen elke projectcode
        const sortedIssues: Issue[] = [];
        const processedIssues = new Set<string>();

        // Functie om een issue en zijn opvolgers te verwerken
        const processIssueAndSuccessors = (issue: Issue) => {
            if (processedIssues.has(issue.key)) {
                console.log(`Issue ${issue.key} al verwerkt, overslaan`);
                return;
            }
            
            processedIssues.add(issue.key);
            sortedIssues.push(issue);


            // Vind en verwerk alle opvolgers van dit issue
            const successors = issues.filter(i => 
                i.fields?.issuelinks?.some(link => 
                    (link.type.name === 'Blocks' || link.type.name === 'Depends On') && 
                    link.inwardIssue?.key === issue.key
                )
            );


            for (const successor of successors) {
                processIssueAndSuccessors(successor);
            }
        };

        // Verwerk issues per projectcode in de juiste volgorde
        for (const [projectCode, projectIssues] of issuesByProject) {
            console.log(`\nVerwerken van project ${projectCode}:`);
            
            // Sorteer issues binnen de projectcode op status
            const sortedProjectIssues = [...projectIssues].sort((a, b) => {
                const statusA = a.fields?.status?.name || '';
                const statusB = b.fields?.status?.name || '';
                return (STATUS_ORDER[statusA] || 999) - (STATUS_ORDER[statusB] || 999);
            });

            if (projectCode === 'EET') {
                console.log('EET issues gesorteerd op status:');
                sortedProjectIssues.forEach(issue => {
                    console.log(`${issue.key}: ${issue.fields?.status?.name}`);
                });
            }

            // Verwerk elk issue en zijn opvolgers
            for (const issue of sortedProjectIssues) {
                processIssueAndSuccessors(issue);
            }
        }

        return sortedIssues;
    };

    // Sorteer alle issues volgens de nieuwe regels
    const sortedIssues = sortIssues(issues);

    // Plan issues in drie fasen:
    // 1. Issues voor andere medewerkers
    // 2. Issues voor Peter van Diermen
    // 3. Issues voor Unassigned

    // Fase 1: Plan issues voor andere medewerkers
    const otherEmployeeIssues = sortedIssues.filter(issue => 
        issue.fields?.assignee && 
        typeof issue.fields.assignee === 'object' &&
        issue.fields.assignee.displayName !== 'Peter van Diermen' &&
        !isSuccessorOf(issue, 'Peter van Diermen') &&
        !isSuccessorOf(issue, 'Unassigned')
    );

    console.log('\n=== Start planning andere medewerkers ===');
    for (const issue of otherEmployeeIssues) {

        const assignee = typeof issue.fields?.assignee === 'object' ? 
            issue.fields.assignee.displayName : 
            'Unassigned';
        
        let sprintName: string | null = null;
        
        if (isSuccessor(issue)) {
            // Voor opvolgers, zoek eerst de sprint van het parent issue
            const predecessors = getPredecessors(issue);
            if (predecessors.length > 0) {
               // Vind de laatste sprint van de predecessors
                let lastPredecessorSprintIndex = -1;
                for (const predecessorKey of predecessors) {
                    const predecessor = result.plannedIssues.find(pi => pi.issue.key === predecessorKey);
                    if (predecessor) {
                        const sprintIndex = result.sprints.findIndex(s => s.sprint === predecessor.sprint);
                        if (sprintIndex > lastPredecessorSprintIndex) {
                            lastPredecessorSprintIndex = sprintIndex;
                        }
                    }
                }
                
                // Begin zoeken vanaf de sprint na de laatste predecessor
                if (lastPredecessorSprintIndex !== -1) {
                    sprintName = findFirstAvailableSprint(issue, assignee, lastPredecessorSprintIndex + 1, result);
               }
            }
        } else {
            // Voor niet-opvolgers, gebruik de normale planning logica
            sprintName = areAllPredecessorsPlanned(issue) ?
                findFirstAvailableSprintAfterPredecessors(issue, assignee) :
                null;
    
        }

        if (sprintName) {
            planIssue(issue, sprintName, assignee);
        }
    }

    console.log('\n=== Start planning Peter van Diermen ===');
    // Fase 2: Plan issues voor Peter van Diermen
    const peterIssues = sortedIssues.filter(issue => 
        (issue.fields?.assignee && 
         typeof issue.fields.assignee === 'object' &&
         issue.fields.assignee.displayName === 'Peter van Diermen') ||
        isSuccessorOf(issue, 'Peter van Diermen')
    );

    for (const issue of peterIssues) {

        let sprintName: string | null = null;
        
        if (isSuccessor(issue)) {
            // Voor opvolgers, zoek eerst de sprint van het parent issue
            const predecessors = getPredecessors(issue);
            if (predecessors.length > 0) {
                // Vind de laatste sprint van de predecessors
                let lastPredecessorSprintIndex = -1;
                for (const predecessorKey of predecessors) {
                    const predecessor = result.plannedIssues.find(pi => pi.issue.key === predecessorKey);
                    if (predecessor) {
                        const sprintIndex = result.sprints.findIndex(s => s.sprint === predecessor.sprint);
                        if (sprintIndex > lastPredecessorSprintIndex) {
                            lastPredecessorSprintIndex = sprintIndex;
                        }
                    }
                }
                
                // Begin zoeken vanaf de sprint na de laatste predecessor
                if (lastPredecessorSprintIndex !== -1) {
                    sprintName = findFirstAvailableSprint(issue, 'Peter van Diermen', lastPredecessorSprintIndex + 1, result);
                }
            }
        } else {
            // Voor niet-opvolgers, gebruik de normale planning logica
            sprintName = areAllPredecessorsPlanned(issue) ?
                findFirstAvailableSprintAfterPredecessors(issue, 'Peter van Diermen') :
                null;
        }

        if (sprintName) {
            planIssue(issue, sprintName, 'Peter van Diermen');
        }
    }

    // Fase 3: Plan issues voor Unassigned
    const unassignedIssues = sortedIssues.filter(issue => 
        !issue.fields?.assignee ||
        (typeof issue.fields.assignee === 'string' && issue.fields.assignee === 'Unassigned') ||
        isSuccessorOf(issue, 'Unassigned')
    );

    for (const issue of unassignedIssues) {
        let sprintName: string | null = null;
        
        if (isSuccessor(issue)) {
            // Voor opvolgers, zoek eerst de sprint van het parent issue
            const predecessors = getPredecessors(issue);
            if (predecessors.length > 0) {
                // Vind de laatste sprint van de predecessors
                let lastPredecessorSprintIndex = -1;
                for (const predecessorKey of predecessors) {
                    const predecessor = result.plannedIssues.find(pi => pi.issue.key === predecessorKey);
                    if (predecessor) {
                        const sprintIndex = result.sprints.findIndex(s => s.sprint === predecessor.sprint);
                        if (sprintIndex > lastPredecessorSprintIndex) {
                            lastPredecessorSprintIndex = sprintIndex;
                        }
                    }
                }
                
                // Begin zoeken vanaf de sprint na de laatste predecessor
                if (lastPredecessorSprintIndex !== -1) {
                    sprintName = findFirstAvailableSprint(issue, 'Unassigned', lastPredecessorSprintIndex + 1, result);
                }
            }
        } else {
            // Voor niet-opvolgers, gebruik de normale planning logica
            sprintName = areAllPredecessorsPlanned(issue) ?
                findFirstAvailableSprintAfterPredecessors(issue, 'Unassigned') :
                null;
        }

        if (sprintName) {
            planIssue(issue, sprintName, 'Unassigned');
        }
    }

    // Valideer en corrigeer de planning
    let isValid = validatePlanningOrder(result);
    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    while (!isValid && attempts < MAX_ATTEMPTS) {
        console.log(`Planning voldoet niet aan volgorde-eisen, poging ${attempts + 1} om te corrigeren...`);
        
        // Ga door alle issues heen en verplaats opvolgers die in dezelfde of eerdere sprint zitten
        for (const plannedIssue of result.plannedIssues) {
            const issue = plannedIssue.issue;
            const successors = getSuccessors(issue);
            
            for (const successorKey of successors) {
                const successor = result.plannedIssues.find(pi => pi.issue.key === successorKey);
                if (successor) {
                    const issueSprintIndex = result.sprints.findIndex(s => s.sprint === plannedIssue.sprint);
                    const successorSprintIndex = result.sprints.findIndex(s => s.sprint === successor.sprint);
                    
                    if (successorSprintIndex <= issueSprintIndex) {
                        console.log(`Corrigeer: Opvolger ${successorKey} zit in sprint ${successor.sprint}, moet na sprint ${plannedIssue.sprint}`);
                        
                        // Verwijder de oude planning
                        const assignee = successor.assignee;
                        result.employeeSprintUsedHours[assignee][successor.sprint] -= successor.hours;
                        result.sprintHours[successor.sprint] = result.sprintHours[successor.sprint]
                            .filter(sh => sh.issueKey !== successor.issue.key);
                        result.sprintAssignments[successor.sprint][assignee] = result.sprintAssignments[successor.sprint][assignee]
                            .filter(i => i.key !== successor.issue.key);
                        result.plannedIssues = result.plannedIssues.filter(pi => pi.issue.key !== successor.issue.key);
                        
                        // Plan opnieuw in een latere sprint
                        const newSprintName = findFirstAvailableSprint(successor.issue, assignee, issueSprintIndex + 1, result);
                        planIssue(successor.issue, newSprintName, assignee);
                    }
                }
            }
        }
        
        isValid = validatePlanningOrder(result);
        attempts++;
    }

    if (!isValid) {
        console.log('Waarschuwing: Planning voldoet nog steeds niet volledig aan de volgorde-eisen na maximaal aantal correctiepogingen');
    }

    return result;
} 