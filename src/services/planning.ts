import type { Issue, SprintCapacity, PlanningResult } from '../types.js';
import { getSprintCapacityFromSheet } from './sprints.js';

export async function calculatePlanning(issues: Issue[], projectType: string, googleSheetsData: (string | null)[][] | null): Promise<PlanningResult> {
    // Verzamel sprint capaciteiten uit Google Sheets
    const sprintCapacities = await getSprintCapacityFromSheet(googleSheetsData);
    
    // Initialiseer het resultaat object
    const result: PlanningResult = {
        sprintHours: {},
        plannedIssues: [],
        issues: issues,
        sprints: sprintCapacities,
        sprintAssignments: {},
        sprintCapacity: sprintCapacities,
        employeeSprintUsedHours: []
    };

    // Verzamel unieke sprint namen
    const sprintNames = new Set<string>();
    sprintCapacities.forEach((capacity: SprintCapacity) => sprintNames.add(capacity.sprint));
    result.sprints = Array.from(sprintNames).map(sprint => ({
        employee: '',
        sprint,
        capacity: 0
    }));

    // Initialiseer sprint capaciteiten
    result.sprints.forEach(sprint => {
        result.sprintHours[sprint.sprint] = [];
        result.sprintAssignments[sprint.sprint] = {};
    });

    // Helper functie om een issue te plannen
    const planIssue = (issue: Issue, sprintName: string, assignee: string) => {
        const hours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
        result.sprintHours[sprintName].push({
            issueKey: issue.key,
            hours: hours,
            issues: [issue]
        });
        result.plannedIssues.push({
            issue: issue,
            sprint: sprintName,
            hours: hours
        });
        if (!result.sprintAssignments[sprintName][assignee]) {
            result.sprintAssignments[sprintName][assignee] = [];
        }
        result.sprintAssignments[sprintName][assignee].push(issue);
    };

    // Helper functie om beschikbare capaciteit te berekenen
    const getAvailableCapacity = (sprintName: string, assignee: string) => {
        const capacity = sprintCapacities.find(
            (c: SprintCapacity) => c.sprint === sprintName && c.employee === assignee
        );
        if (!capacity) return 0;

        const usedHours = result.employeeSprintUsedHours.find(
            (e: { employee: string; sprintHours: { sprint: string; hours: number; issues: { key: string; hours: number }[] }[] }) => 
                e.employee === assignee
        )?.sprintHours.find(
            (s: { sprint: string; hours: number; issues: { key: string; hours: number }[] }) => 
                s.sprint === sprintName
        )?.hours || 0;

        return capacity.capacity - usedHours;
    };

    // Helper functie om de eerste beschikbare sprint te vinden
    const findFirstAvailableSprint = (issue: Issue, assignee: string, startIndex: number = 0) => {
        for (let i = startIndex; i < result.sprints.length; i++) {
            const sprint = result.sprints[i];
            const availableCapacity = getAvailableCapacity(sprint.sprint, assignee);
            if (availableCapacity >= (issue.fields?.timeestimate || 0) / 3600) {
                return sprint.sprint;
            }
        }
        return null;
    };

    // Helper functie om predecessors op te halen
    function getPredecessors(issue: Issue): { key: string; assignee: string }[] {
        const predecessors: { key: string; assignee: string }[] = [];
        if (issue.fields?.issuelinks) {
            for (const link of issue.fields.issuelinks) {
                // Controleer zowel Blocks als Depends On relaties
                if ((link.type.name === 'Blocks' || link.type.name === 'Depends On') && link.inwardIssue) {
                    const inwardIssue = link.inwardIssue as Issue;
                    const assignee = inwardIssue.fields?.assignee;
                    predecessors.push({
                        key: inwardIssue.key,
                        assignee: typeof assignee === 'object' ? 
                            assignee.displayName : 
                            assignee || 'Unassigned'
                    });
                }
            }
        }
        return predecessors;
    }

    // Helper functie om te controleren of een issue een opvolger is van een specifieke medewerker
    const isSuccessorOf = (issue: Issue, assigneeName: string) => {
        const predecessors = getPredecessors(issue);
        return predecessors.some(p => p.assignee === assigneeName);
    };

    // Helper functie om te controleren of alle predecessors gepland zijn
    const areAllPredecessorsPlanned = (issue: Issue) => {
        const predecessors = getPredecessors(issue);
        return predecessors.every(p => 
            result.plannedIssues.some(pi => pi.issue.key === p.key)
        );
    };

    // Helper functie om de eerste beschikbare sprint te vinden na de laatste predecessor
    const findFirstAvailableSprintAfterPredecessors = (issue: Issue, assignee: string) => {
        const predecessors = getPredecessors(issue);
        if (predecessors.length === 0) {
            return findFirstAvailableSprint(issue, assignee);
        }

        // Vind de laatste sprint van de predecessors
        let lastPredecessorSprintIndex = -1;
        for (const predecessor of predecessors) {
            const plannedPredecessor = result.plannedIssues.find(pi => pi.issue.key === predecessor.key);
            if (plannedPredecessor) {
                const sprintIndex = result.sprints.findIndex(s => s.sprint === plannedPredecessor.sprint);
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
        return findFirstAvailableSprint(issue, assignee, lastPredecessorSprintIndex + 1);
    };

    // Plan issues in drie fasen:
    // 1. Issues voor andere medewerkers
    // 2. Issues voor Peter van Diermen
    // 3. Issues voor Unassigned

    // Fase 1: Plan issues voor andere medewerkers
    const otherEmployeeIssues = issues.filter(issue => 
        issue.fields?.assignee && 
        typeof issue.fields.assignee === 'object' &&
        issue.fields.assignee.displayName !== 'Peter van Diermen' &&
        !isSuccessorOf(issue, 'Peter van Diermen') &&
        !isSuccessorOf(issue, 'Unassigned')
    );

    for (const issue of otherEmployeeIssues) {
        const assignee = typeof issue.fields?.assignee === 'object' ? 
            issue.fields.assignee.displayName : 
            'Unassigned';
        const sprintName = areAllPredecessorsPlanned(issue) ?
            findFirstAvailableSprintAfterPredecessors(issue, assignee) :
            null;
        if (sprintName) {
            planIssue(issue, sprintName, assignee);
        }
    }

    // Fase 2: Plan issues voor Peter van Diermen
    const peterIssues = issues.filter(issue => 
        (issue.fields?.assignee && 
         typeof issue.fields.assignee === 'object' &&
         issue.fields.assignee.displayName === 'Peter van Diermen') ||
        isSuccessorOf(issue, 'Peter van Diermen')
    );

    for (const issue of peterIssues) {
        const sprintName = areAllPredecessorsPlanned(issue) ?
            findFirstAvailableSprintAfterPredecessors(issue, 'Peter van Diermen') :
            null;
        if (sprintName) {
            planIssue(issue, sprintName, 'Peter van Diermen');
        }
    }

    // Fase 3: Plan issues voor Unassigned
    const unassignedIssues = issues.filter(issue => 
        !issue.fields?.assignee ||
        (typeof issue.fields.assignee === 'string' && issue.fields.assignee === 'Unassigned') ||
        isSuccessorOf(issue, 'Unassigned')
    );

    for (const issue of unassignedIssues) {
        const sprintName = areAllPredecessorsPlanned(issue) ?
            findFirstAvailableSprintAfterPredecessors(issue, 'Unassigned') :
            null;
        if (sprintName) {
            planIssue(issue, sprintName, 'Unassigned');
        }
    }

    return result;
} 