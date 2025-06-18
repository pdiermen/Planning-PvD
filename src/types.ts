export interface IssueHistory {
    created: string;
    items: {
        field: string;
        toString: string;
    }[];
}

export interface IssueLink {
    type: {
        name: string;
        inward: string;
        outward: string;
    };
    inwardIssue?: {
        key: string;
        fields?: {
            status?: {
                name: string;
            };
            customfield_10020?: Sprint[];
        };
    };
    outwardIssue?: {
        key: string;
        fields?: {
            status?: {
                name: string;
            };
            customfield_10020?: Sprint[];
        };
    };
}

export interface Sprint {
    id: number;
    name: string;
    state: string;
}

export interface Issue {
    key: string;
    fields?: {
        summary?: string;
        timeestimate?: number;
        timeoriginalestimate?: number;
        status?: {
            name: string;
        };
        assignee?: {
            displayName: string;
        };
        priority?: {
            name: string;
        };
        issuetype?: {
            name: string;
        };
        project?: {
            key: string;
            name: string;
        };
        created?: string;
        resolutiondate?: string;
        issuelinks?: IssueLink[];
        parent?: {
            key: string;
        };
        customfield_10020?: Sprint[];
        worklog?: {
            worklogs: Array<{
                author: string | { displayName: string };
                timeSpentSeconds: number;
                started: string;
                comment?: string;
            }>;
        };
        duedate?: string;
    };
    changelog?: {
        histories: IssueHistory[];
    };
}

export interface WorkLog {
    id?: string;
    issueKey: string;
    timeSpentSeconds: number;
    started: string;
    author: {
        displayName: string;
    } | string;
    comment?: string;
    category?: 'ontwikkeling' | 'overig';
    issueSummary?: string;
    issueStatus?: string;
    issueAssignee?: string;
    issuePriority?: {
        name: string;
    };
}

export interface EfficiencyData {
    assignee: string;
    estimatedHours: number;
    loggedHours: number;
    efficiency: number;
    issueKeys?: string[];
    issueDetails?: {
        key: string;
        estimatedHours: number;
        loggedHours: number;
    }[];
}

export interface EfficiencyTable {
    [key: string]: {
        totalTimeSpent: number;
        totalTimeEstimate: number;
        efficiency: number;
    };
}

export interface WorkLogsSummary {
    employee: string;
    nietGewerkt: string;
    nietOpIssues: string;
    ontwikkeling: string;
    total: string;
}

export interface WorkLogsResponse {
    workLogs: WorkLog[];
    efficiencyTable: EfficiencyData[];
    workLogsSummary: Record<string, WorkLogsSummary[]>;
}

export interface ProjectConfig {
    project: string;
    codes: string[];
    jqlFilter: string;
    worklogName: string;
    worklogJql: string;
    sprintStartDate: Date | null;
}

export interface WorklogConfig {
    worklogName: string;
    columnName: string;
    issues: string[]; // Leeg betekent alle overige issues
}

export interface ProjectData {
    config: ProjectConfig;
    issues: Issue[];
    worklogs: WorkLog[];
    efficiency: EfficiencyData[];
}

export interface PlannedIssue {
    issue: Issue;
    sprint: string;
    hours: number;
    assignee: string;
    key: string;
    worklogHours?: number;
    remainingEstimate?: number;
    project: string;
}

export interface SprintCapacity {
    sprint: string;
    employee: string;
    capacity: number;
    availableCapacity: number;
    project: string;
    startDate?: string;
    totalSprintCapacity?: number;
}

export interface SprintDates {
    sprint: string;
    startDate: string;
    endDate: string;
}

export interface EmployeeCapacity {
    employee: string;
    capacity: number;
    project: string;
}

export interface SprintPlanning {
    sprint: string;
    startDate: string;
    endDate: string;
    employeePlanning: EmployeePlanning[];
}

export interface EmployeePlanning {
    employee: string;
    capacity: number;
    availableCapacity: number;
    project: string;
}

export interface PlanningResult {
    sprintHours: Record<string, Record<string, number>>;
    plannedIssues: PlannedIssue[];
    issues: Issue[];
    sprints: SprintCapacity[];
    sprintAssignments: Record<string, Record<string, Issue[]>>;
    sprintCapacity: SprintCapacity[];
    employeeSprintUsedHours: Record<string, Record<string, number>>;
    currentSprint: string;
    capacityFactor: number;
    projectConfigs?: ProjectConfig[];
    sprintDates: { [key: string]: { start: Date; end: Date } };
    employeeCapacities: EmployeeCapacity[];
    sprintPlanning: SprintPlanning[];
} 