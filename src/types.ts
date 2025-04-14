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
    };
    outwardIssue?: {
        key: string;
    };
}

export interface Sprint {
    id: string;
    self: string;
    state: string;
    name: string;
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
    projectName: string;
    projectCodes: string[];
    jqlFilter: string;
    worklogName: string;
    worklogJql: string;
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