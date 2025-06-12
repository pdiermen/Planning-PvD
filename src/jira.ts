import axios from 'axios';
import type { Issue, IssueLink, WorkLog, WorkLogsResponse, EfficiencyData } from './types.js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { WorkLogsResponse as OldWorkLogsResponse, EfficiencyTable } from './types.js';
import { getSprintCapacityFromSheet, ProjectConfig, getProjectConfigsFromSheet, getGoogleSheetsData } from './google-sheets.js';
import { format } from 'date-fns';
import { SprintCapacity } from './types.js';
import JiraApi from 'jira-client';
import Table from 'cli-table3';
import { GoogleSpreadsheet } from 'google-spreadsheet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const JIRA_DOMAIN = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Check required environment variables
if (!JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_DOMAIN) {
    throw new Error('Missing required environment variables: JIRA_EMAIL, JIRA_API_TOKEN, or JIRA_DOMAIN');
}

// Create Jira client
export const jiraClient = axios.create({
    baseURL: `https://${process.env.JIRA_HOST}/rest/api/2`,
    auth: {
        username: process.env.JIRA_USERNAME!,
        password: process.env.JIRA_API_TOKEN!
    },
    headers: {
        'Accept': 'application/json'
    }
});

// Error handler voor Axios requests
jiraClient.interceptors.response.use(
    response => response,
    error => {
        if (error.response) {
            // De server heeft een response gestuurd met een status code buiten het 2xx bereik
            logger.error(`Jira API Error Response: ${JSON.stringify({
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            }, null, 2)}`);
        } else if (error.request) {
            // De request is gemaakt maar er is geen response ontvangen
            logger.error(`Jira API Error Request: ${JSON.stringify(error.request, null, 2)}`);
        } else {
            // Er is iets misgegaan bij het opzetten van de request
            logger.error(`Jira API Error: ${error.message}`);
        }
        
        // Gooi een nieuwe error met meer details
        const enhancedError = new Error(`Jira API Error: ${error.message}`);
        (enhancedError as any).status = error.response?.status;
        (enhancedError as any).data = error.response?.data;
        return Promise.reject(enhancedError);
    }
);

export function isEETIssue(issue: Issue): boolean {
  return issue.key.startsWith('EET-');
}

export function formatTime(seconds: number | undefined): string {
  if (!seconds) return '-';
  const hours = (seconds / 3600).toFixed(1); // deel door 3600 (60 min * 60 sec) en rond af op 1 decimaal
  return hours;
}

// Cache voor actieve issues
let activeIssuesCache: { issues: Issue[]; timestamp: number } | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minuten

export async function getActiveIssues(): Promise<Issue[]> {
    logger.info('\n=== START OPHALEN ACTIEVE ISSUES ===');
    
    // Haal project configuraties op
    const projectSheetsData = await getGoogleSheetsData('Projects!A1:F');
    const projectConfigs = getProjectConfigsFromSheet(projectSheetsData);
    
    logger.info('Gevonden project configuraties:');
    projectConfigs.forEach(config => {
        logger.info(`- Project: ${config.project}`);
        logger.info(`  - Codes: ${config.codes.join(', ')}`);
        logger.info(`  - JQL Filter: ${config.jqlFilter || 'Geen'}`);
    });
    
    // Combineer alle project configuraties in één JQL query
    const jql = projectConfigs.map(config => {
        const projectFilter = config.codes.map(code => `project = ${code}`).join(' OR ');
        let query = `(${projectFilter})`;
        if (config.jqlFilter) {
            query += ` AND ${config.jqlFilter}`;
        }
        return query;
    }).join(' OR ');
    
    logger.info(`\nGebruikte JQL query: ${jql}`);
    
    try {
        logger.info('[DEBUG] Start ophalen van actieve issues...');
        const startAt = 0;
        const maxResults = 100;
        
        // Log de JQL query voor debugging
        logger.info(`[DEBUG] JQL query: ${jql}`);
        
        const response = await jiraClient.get('/search', {
            params: {
                jql,
                startAt,
                maxResults,
//                fields: ['summary', 'status', 'assignee', 'issuelinks', 'timeoriginalestimate', 'customfield_10020', 'project', 'priority', 'created', 'worklog', 'duedate'].join(','),
//                expand: 'changelog,renderedFields'
                  expand: 'changelog,issuelinks',
                  fields: [
                    'summary',
                    'status',
                    'assignee',
                    'timeestimate',
                    'customfield_10020', // Sprint field
                    'issuelinks',
                    'duedate'
                ]
            }
        });

        logger.info('[DEBUG] API response ontvangen');
        if (response.data.issues.length > 0) {
            const firstIssue = response.data.issues[0];
            logger.info(`[DEBUG] Eerste issue key: ${firstIssue.key}`);
            logger.info(`[DEBUG] Eerste issue fields: ${JSON.stringify(firstIssue.fields, null, 2)}`);
            logger.info(`[DEBUG] Due date van eerste issue: ${firstIssue.fields?.duedate}`);
            logger.info(`[DEBUG] Aantal issues met due date: ${response.data.issues.filter((issue: Issue) => issue.fields?.duedate).length}`);
        }
        
        logger.info('=== EINDE OPHALEN ACTIEVE ISSUES ===\n');
        
        return response.data.issues;
    } catch (error) {
        logger.error(`Error bij ophalen van actieve issues: ${error}`);
        throw error;
    }
}

export async function getWorkLogs(projectKey: string, startDate: string, endDate: string, jqlFilter?: string): Promise<WorkLog[]> {
    try {
        // Basis JQL query
        let jql = `project = ${projectKey} AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}"`;
        if (jqlFilter) {
            jql += ` AND ${jqlFilter}`;
        }
        logger.info(`Volledige JQL Query voor Worklogs: ${jql}`);
        
        const response = await jiraClient.get('/search', {
            params: {
                jql,
                fields: [
                    'summary',
                    'status',
                    'assignee',
                    'priority',
                    'worklog'
                ].join(','),
                maxResults: 100
            }
        });
        
        const worklogs: WorkLog[] = [];
        
        for (const issue of response.data.issues) {
            const issueWorklogs = issue.fields.worklog?.worklogs || [];
            
            for (const log of issueWorklogs) {
                const logDate = new Date(log.started);
                const start = new Date(startDate);
                const end = new Date(endDate);
                
                if (logDate >= start && logDate <= end) {
                    worklogs.push({
                        issueKey: issue.key,
                        issueSummary: issue.fields.summary,
                        issueStatus: issue.fields.status.name,
                        issueAssignee: issue.fields.assignee?.displayName || 'Onbekend',
                        issuePriority: issue.fields.priority?.name || 'Lowest',
                        author: typeof log.author === 'string' ? log.author : log.author.displayName,
                        timeSpentSeconds: log.timeSpentSeconds,
                        started: log.started,
                        comment: log.comment
                    });
                }
            }
        }
        
        logger.info(`Totaal aantal worklogs gevonden: ${worklogs.length}`);
        return worklogs;
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
        throw error;
    }
}

export async function getSprintName(issue: Issue): Promise<string> {
    try {
        logger.info(`Ophalen sprint naam voor issue ${issue.key}`);
        
        if (!issue.fields?.customfield_10020 || issue.fields.customfield_10020.length === 0) {
            logger.info(`Geen sprint gevonden voor issue ${issue.key}`);
            return 'Niet gepland';
        }
        
        // Neem de eerste actieve sprint
        const activeSprint = issue.fields.customfield_10020.find(sprint => sprint.state === 'active');
        if (activeSprint) {
            logger.info(`Actieve sprint gevonden voor issue ${issue.key}: ${activeSprint.name}`);
            return activeSprint.name;
        }
        
        // Als er geen actieve sprint is, neem de eerste sprint
        const sprint = issue.fields.customfield_10020[0];
        logger.info(`Geen actieve sprint gevonden voor issue ${issue.key}, gebruik eerste sprint: ${sprint.name}`);
        return sprint.name;
    } catch (error) {
        logger.error(`Error bij ophalen sprint naam voor issue ${issue.key}: ${error}`);
        return 'Niet gepland';
    }
}

interface PriorityOrder {
    [key: string]: number;
}

export async function getSprintCapacity(): Promise<SprintCapacity[]> {
    try {
        logger.info('Start ophalen van sprint capaciteit...');
        
        // Haal de capaciteit op uit Google Sheets
        const sheetCapacities = await getSprintCapacityFromSheet(null);
        
        // Standaard capaciteit per medewerker als fallback
        const defaultCapacities: { [key: string]: number } = {
            'Peter van Diermen': 40,
            'Adit Shah': 60,
            'Bart Hermans': 16,
            'Florian de Jong': 8,
            'Milan van Dijk': 40,
            'virendra kumar': 60
        };

        // Maak een lijst van capaciteiten met standaard waarden
        const capacities: SprintCapacity[] = [];
        const maxSprints = 100;

        // Voeg alle medewerkers toe met hun standaard capaciteit
        Object.entries(defaultCapacities).forEach(([employee, capacity]) => {
            for (let i = 1; i <= maxSprints; i++) {
                // Check of er een capaciteit uit de sheet is voor deze medewerker en sprint
                const sheetCapacity = sheetCapacities.find(c => c.employee === employee && c.sprint === i.toString());
                capacities.push({
                    employee,
                    sprint: i.toString(),
                    capacity: sheetCapacity?.capacity || capacity,
                    project: 'ATLANTIS', // Standaard project voor alle capaciteiten
                    availableCapacity: sheetCapacity?.capacity || capacity
                });
            }
        });

        logger.info(`${capacities.length} sprint capaciteiten gegenereerd`);
        return capacities;
    } catch (error: any) {
        logger.error(`Error bij ophalen van sprint capaciteit: ${error.message}`);
        throw error;
    }
}

interface PlanningResult {
  issues: Issue[];
  sprints: SprintCapacity[];
  sprintAssignments: Record<string, Record<string, Issue[]>>;
  sprintHours: Record<string, Record<string, number>>;
}

export async function getPlanning(): Promise<PlanningResult> {
    try {
        logger.info('Start ophalen van planning data...');
        
        // Haal alle benodigde data parallel op
        let issues: Issue[] = [];
        let sprintCapacities: SprintCapacity[] = [];
        
        try {
            logger.info('Ophalen van actieve issues...');
            issues = await getActiveIssues();
            logger.info(`${issues.length} actieve issues gevonden`);
        } catch (error: any) {
            logger.error(`Error bij ophalen van issues: ${error.message}`);
            throw new Error(`Fout bij ophalen van issues: ${error.message}`);
        }

        try {
            logger.info('Ophalen van sprint capaciteit...');
            sprintCapacities = await getSprintCapacity();
            logger.info(`${sprintCapacities.length} sprint capaciteiten gevonden`);
        } catch (error: any) {
            logger.error(`Error bij ophalen van sprint capaciteit: ${error.message}`);
            throw new Error(`Fout bij ophalen van sprint capaciteit: ${error.message}`);
        }

        // Implementeer de rest van de getPlanning functie
        // Dit is een voorbeeld en moet worden aangepast aan de specifieke vereisten van de planning logica
        const planningResult: PlanningResult = {
            issues,
            sprints: sprintCapacities,
            sprintAssignments: {},
            sprintHours: {}
        };

        logger.info('Planning data opgehaald');
        return planningResult;
    } catch (error: any) {
        logger.error(`Error bij ophalen van planning data: ${error.message}`);
        throw error;
    }
}

function constructJqlQuery(projectConfig: ProjectConfig, startDate?: string, endDate?: string): string {
    const projectFilter = projectConfig.codes.map(code => `project = ${code}`).join(' OR ');
    let jql = `(${projectFilter}) AND status != Done`;
    
    if (startDate && endDate) {
        jql += ` AND updated >= "${startDate}" AND updated <= "${endDate}"`;
    }
    
    if (projectConfig.jqlFilter) {
        jql += ` AND ${projectConfig.jqlFilter}`;
    }
    
    jql += ` ORDER BY duedate ASC`;
    
    return jql;
}

export async function getIssuesForProject(projectConfig: ProjectConfig, startDate?: string, endDate?: string): Promise<Issue[]> {
    try {
        logger.info(`Start ophalen van issues voor project ${projectConfig.project}...`);
        const jql = constructJqlQuery(projectConfig, startDate, endDate);
        logger.info(`JQL query: ${jql}`);

        logger.info('\n=== DEBUG: START OPHALEN ISSUES ===');
        logger.info(`Project: ${projectConfig.project}`);
        logger.info(`JQL query: ${jql}`);
        logger.info(`Max results per batch: 100`);
        logger.info('');

        const allIssues: Issue[] = [];
        let startAt = 0;
        const maxResults = 100;
        let totalIssues = 0;

        while (true) {
            logger.info(`Ophalen batch vanaf index ${startAt}...`);
            
            const response = await jiraClient.get('/search', {
                params: {
                    jql,
                    startAt,
                    maxResults,
                    fields: [
                        'summary',
                        'status',
                        'assignee',
                        'timeestimate',
                        'customfield_10020', // Sprint field
                        'issuelinks',
                        'duedate'
                    ]
                }
            });

            const issues = response.data.issues;
            logger.info(`${issues.length} issues gevonden in deze batch`);
            
            if (totalIssues === 0) {
                totalIssues = response.data.total;
                logger.info(`Totaal aantal issues volgens Jira: ${totalIssues}`);
            }
            
            logger.info(`${issues.length} issues gevonden in deze batch, totaal ${totalIssues} issues volgens Jira`);
            
            allIssues.push(...issues);
            
            if (startAt + maxResults >= totalIssues) {
                break;
            }
            
            startAt += maxResults;
            logger.info('');
        }

        logger.info('Alle issues opgehaald');
        logger.info(`\nTotaal ${allIssues.length} issues opgehaald voor project ${projectConfig.project}`);
        logger.info('=== EINDE OPHALEN ISSUES ===\n');

        return allIssues;
    } catch (error) {
        logger.error(`Error bij ophalen van issues voor project ${projectConfig.project}: ${error}`);
        throw error;
    }
}

interface JiraWorkLog {
    started: string;
    timeSpentSeconds: number;
    author: string | { displayName: string };
    comment?: string;
}

export async function getWorkLogsForProject(
    startDate: Date,
    endDate: Date,
    config: ProjectConfig
): Promise<WorkLog[]> {
    const worklogs: WorkLog[] = [];
    let startAt = 0;
    const maxResults = 100;

    // Haal Google Sheets data op om te controleren welke medewerkers actief zijn op dit project
    const googleSheetsData = await getGoogleSheetsData('Employees!A1:H');
    if (!googleSheetsData) {
        logger.error('Geen Google Sheets data beschikbaar voor project medewerkers filtering');
        return worklogs;
    }

    // Haal de kolom indices op basis van de kolomnamen
    const headerRow = googleSheetsData[0];
    const nameIndex = headerRow.findIndex(header => header?.toLowerCase() === 'naam');
    const projectIndex = headerRow.findIndex(header => header?.toLowerCase() === 'project');

    if (nameIndex === -1 || projectIndex === -1) {
        logger.error('Verplichte kolommen niet gevonden in Google Sheets data');
        return worklogs;
    }

    // Maak een Set van medewerkers die actief zijn op dit project
    const projectEmployees = new Set<string>();
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        const employeeName = row[nameIndex];
        const projects = (row[projectIndex] || '').split(',').map((p: string) => p.trim());
        
        if (employeeName && projects.includes(config.project)) {
            projectEmployees.add(employeeName);
        }
    }

    logger.info(`Medewerkers actief op project ${config.project}: ${Array.from(projectEmployees).join(', ')}`);

    while (true) {
        // Bouw basis JQL query met alleen project filter
        let jql = `project in (${config.codes.join(',')})`;

        // Voeg worklog JQL filter toe als deze bestaat
        if (config.worklogJql && config.worklogJql.trim() !== '') {
            jql = `${config.worklogJql}`;
        }

        // Voeg datum filter toe
        const dateFilter = `worklogDate >= "${format(startDate, 'yyyy-MM-dd')}" AND worklogDate <= "${format(endDate, 'yyyy-MM-dd')}"`;
        jql += ` AND ${dateFilter}`;

        logger.info(`Volledige JQL Query voor Worklogs: ${jql}`);

        // Haal eerst de issues op
        const response = await jiraClient.get('/search', {
            params: {
                jql,
                startAt,
                maxResults,
                fields: ['summary', 'project', 'assignee', 'timeoriginalestimate', 'timeestimate', 'priority', 'worklog']
            }
        });

        const issues = response.data.issues || [];
        logger.info(`Aantal issues gevonden in deze batch: ${issues.length}`);

        // Haal voor elk issue de worklogs op
        for (const issue of issues) {
            try {
                // Controleer of het issue bij het juiste project hoort
                if (!config.codes.includes(issue.fields.project.key)) {
                    logger.info(`Issue ${issue.key} hoort niet bij project ${config.codes.join(',')}, wordt overgeslagen`);
                    continue;
                }

                const worklogResponse = await jiraClient.get(`/issue/${issue.key}/worklog`);
                const issueWorklogs = (worklogResponse.data.worklogs || []) as JiraWorkLog[];
                
                if (issueWorklogs.length > 0) {
                    // Filter worklogs op basis van de datum en de medewerker
                    const filteredWorklogs = issueWorklogs.filter((log: JiraWorkLog) => {
                        const logDate = new Date(log.started);
                        const authorName = typeof log.author === 'string' ? log.author : log.author.displayName;
                        return logDate >= startDate && 
                               logDate <= endDate && 
                               projectEmployees.has(authorName);
                    });

                    if (filteredWorklogs.length > 0) {
                        logger.info(`Issue ${issue.key}: ${filteredWorklogs.length} worklogs gevonden in de opgegeven periode voor actieve project medewerkers`);
                        const processedWorklogs = filteredWorklogs.map((log: JiraWorkLog) => ({
                            issueKey: issue.key,
                            issue: {
                                key: issue.key,
                                fields: {
                                    summary: issue.fields.summary,
                                    project: issue.fields.project,
                                    assignee: issue.fields.assignee,
                                    timeoriginalestimate: issue.fields.timeoriginalestimate,
                                    timeestimate: issue.fields.timeestimate,
                                    priority: issue.fields.priority
                                }
                            },
                            started: log.started,
                            timeSpentSeconds: log.timeSpentSeconds,
                            author: typeof log.author === 'string' ? log.author : log.author.displayName,
                            comment: log.comment,
                            category: 'ontwikkeling' as const
                        }));
                        
                        worklogs.push(...processedWorklogs);
                    } else {
                        logger.info(`Issue ${issue.key}: Geen worklogs gevonden in de opgegeven periode voor actieve project medewerkers`);
                    }
                } else {
                    logger.info(`Issue ${issue.key}: Geen worklogs gevonden`);
                }
            } catch (error) {
                logger.error(`Error bij ophalen worklogs voor issue ${issue.key}: ${error}`);
                // Ga door met de volgende issue
                continue;
            }
        }

        if (startAt + maxResults >= response.data.total) {
            break;
        }

        startAt += maxResults;
    }

    return worklogs;
}

export async function getWorklogsForIssues(issues: Issue[]): Promise<WorkLog[]> {
    try {
        const issueKeys = issues.map(issue => issue.key);
        const worklogIssuesJql = `key in (${issueKeys.join(',')})`;
        logger.info(`Volledige JQL Query voor Worklogs: ${worklogIssuesJql}`);
        
        const worklogs: WorkLog[] = [];
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;
        let totalIssues = 0;

        while (hasMore) {
            const response = await jiraClient.get('/search', {
                params: {
                    jql: worklogIssuesJql,
                    fields: ['worklog', 'summary', 'status', 'assignee', 'priority'],
                    startAt,
                    maxResults
                }
            });
            
            const batchIssues = response.data.issues;
            totalIssues = response.data.total;
            
            // Verwerk worklogs voor elke issue
            for (const issue of batchIssues) {
                const issueWorklogs = issue.fields.worklog?.worklogs || [];
                logger.info(`Issue ${issue.key}: ${issueWorklogs.length} worklogs gevonden`);
                
                for (const log of issueWorklogs) {
                    worklogs.push({
                        issueKey: issue.key,
                        issueSummary: issue.fields.summary,
                        issueStatus: issue.fields.status.name,
                        issueAssignee: issue.fields.assignee?.displayName || 'Onbekend',
                        issuePriority: issue.fields.priority?.name || 'Lowest',
                        author: typeof log.author === 'string' ? log.author : log.author.displayName,
                        timeSpentSeconds: log.timeSpentSeconds,
                        started: log.started,
                        comment: log.comment
                    });
                }
            }
            
            logger.info(`Aantal worklogs gevonden in deze batch: ${worklogs.length}`);
            logger.info(`Totaal aantal worklogs tot nu toe: ${worklogs.length}`);
            
            hasMore = worklogs.length < totalIssues;
            if (hasMore) {
                logger.info(`Er zijn meer resultaten beschikbaar (totaal: ${totalIssues}). Paginering nodig.`);
                startAt += maxResults;
            } else {
                logger.info(`Alle resultaten opgehaald (totaal: ${totalIssues}).`);
            }
        }
        
        return worklogs;
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
        throw error;
    }
}

export async function getIssuesWithWorklogs(startDate: string, endDate: string): Promise<Issue[]> {
    try {
        const jql = `project = EET AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}"`;
        logger.info(`Volledige JQL Query voor Issues met Worklogs: ${jql}`);
        
        const allIssues: Issue[] = [];
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;
        let totalIssues = 0;

        while (hasMore) {
            const response = await jiraClient.get('/search', {
                params: {
                    jql,
                    fields: [
                        'summary',
                        'status',
                        'assignee',
                        'issuetype',
                        'priority',
                        'timeestimate',
                        'timeoriginalestimate',
                        'issuelinks',
                        'parent',
                        'customfield_10020',
                        'worklog'
                    ].join(','),
                    startAt,
                    maxResults
                }
            });
            
            const batchIssues = response.data.issues;
            allIssues.push(...batchIssues);
            totalIssues = response.data.total;
            
            logger.info(`Aantal issues gevonden in deze batch: ${batchIssues.length}`);
            logger.info(`Totaal aantal issues tot nu toe: ${allIssues.length}`);
            logger.info(`Totaal aantal issues volgens Jira: ${totalIssues}`);
            
            hasMore = allIssues.length < totalIssues;
            if (hasMore) {
                logger.info(`Er zijn meer resultaten beschikbaar (totaal: ${totalIssues}). Paginering nodig.`);
                startAt += maxResults;
            } else {
                logger.info(`Alle resultaten opgehaald (totaal: ${totalIssues}).`);
            }
        }
        
        return allIssues;
    } catch (error) {
        logger.error(`Error bij ophalen van issues met worklogs: ${error}`);
        throw error;
    }
}

export async function getIssues(jqlFilter: string): Promise<Issue[]> {
    try {
        logger.info(`Ophalen van issues met JQL filter: ${jqlFilter}`);
        
        const response = await jiraClient.get('/search', {
            params: {
                jql: jqlFilter,
                maxResults: 1000,
                fields: [
                    'summary',
                    'status',
                    'assignee',
                    'timeestimate',
                    'customfield_10020', // Sprint field
                    'issuelinks',
                    'duedate'
                ]
            }
        });

        logger.info(`${response.data.issues.length} issues gevonden`);
        return response.data.issues;
    } catch (error) {
        logger.error(`Error bij ophalen van issues: ${error instanceof Error ? error.message : error}`);
        throw error;
    }
}

interface JiraIssue {
    key: string;
    summary: string;
    status: string;
    type: string;
    parent?: string;
}

export async function getAllLinkedIssues(issueKey: string): Promise<JiraIssue[]> {
    // Valideer de issue key
    if (!issueKey || typeof issueKey !== 'string' || !issueKey.match(/^[A-Z]+-\d+$/)) {
        throw new Error(`Ongeldige issue key: ${issueKey}. Verwacht formaat: PROJECT-123`);
    }

    const allIssues: JiraIssue[] = [];
    const processedIssues = new Set<string>();
    const issuesToProcess = [issueKey];
    const startIssueKey = issueKey; // Bewaar het start issue voor later gebruik

    logger.info(`Starting to process issues. Initial issue: ${issueKey}`);

    while (issuesToProcess.length > 0) {
        const currentIssueKey = issuesToProcess.shift()!;
        logger.info(`Processing issue: ${currentIssueKey}. Remaining issues to process: ${issuesToProcess.length}`);
        
        if (processedIssues.has(currentIssueKey)) {
            logger.info(`Skipping already processed issue: ${currentIssueKey}`);
            continue;
        }
        processedIssues.add(currentIssueKey);

        // Skip REAL-1249 zonder child issues op te halen
        if (currentIssueKey === 'REAL-1249') {
            logger.info(`Skipping REAL-1249 without fetching child issues`);
            continue;
        }

        // Haal eerst het huidige issue op om het type te bepalen
        const currentIssueResponse = await jiraClient.get(`/issue/${currentIssueKey}`, {
            params: {
                fields: ['summary', 'status', 'issuetype', 'parent'].join(',')
            }
        });
        const currentIssue = {
            key: currentIssueResponse.data.key,
            summary: currentIssueResponse.data.fields.summary,
            status: currentIssueResponse.data.fields.status.name,
            type: currentIssueResponse.data.fields.issuetype.name,
            parent: currentIssueResponse.data.fields.parent?.key
        };
        logger.info(`Current issue ${currentIssueKey} is of type: ${currentIssue.type}`);

        const jql = `issue in linkedIssues("${currentIssueKey}")`;
        logger.info(`Executing JQL query: ${jql}`);
        
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;
        let linkedIssues: JiraIssue[] = [];

        while (hasMore) {
            logger.info(`Fetching batch of issues for ${currentIssueKey}. Start at: ${startAt}, max results: ${maxResults}`);
            
            const response = await jiraClient.get('/search', {
                params: {
                    jql,
                    startAt,
                    maxResults,
                    fields: ['summary', 'status', 'issuetype', 'parent'].join(',')
                }
            });

            const batchIssues = response.data.issues.map((issue: any) => ({
                key: issue.key,
                summary: issue.fields.summary,
                status: issue.fields.status.name,
                type: issue.fields.issuetype.name,
                parent: issue.fields.parent?.key
            }));

            logger.info(`Retrieved ${batchIssues.length} issues in current batch`);
            linkedIssues.push(...batchIssues);
            
            // Controleer of er meer issues zijn
            hasMore = response.data.startAt + response.data.maxResults < response.data.total;
            startAt += maxResults;
            logger.info(`Has more issues: ${hasMore}, new startAt: ${startAt}`);
        }

        logger.info(`Found total of ${linkedIssues.length} linked issues for ${currentIssueKey}`);
        
        // Voeg alleen AMP en KAMP issues toe aan het resultaat
        const ampAndKampIssues = linkedIssues.filter(issue => issue.key.startsWith('AMP') || issue.key.startsWith('KAMP'));
        allIssues.push(...ampAndKampIssues);
        logger.info(`Added ${ampAndKampIssues.length} AMP/KAMP issues to results`);

        // Voor het start issue altijd child issues ophalen, voor andere issues alleen als het type Offerte is
        const shouldProcessChildren = currentIssueKey === startIssueKey || currentIssue.type === 'Offerte';

        if (shouldProcessChildren) {
            logger.info(`Issue ${currentIssueKey} is ${currentIssueKey === startIssueKey ? 'the start issue' : 'of type Offerte'}, will process its child issues`);
            // Alleen issues toevoegen die nog niet zijn verwerkt
            const newIssuesToProcess = linkedIssues
                .filter(issue => !processedIssues.has(issue.key))
                .map(issue => issue.key);
            issuesToProcess.push(...newIssuesToProcess);
            logger.info(`Added ${newIssuesToProcess.length} new issues to process`);
        } else {
            logger.info(`Issue ${currentIssueKey} is not the start issue and not of type Offerte (type: ${currentIssue.type}), skipping child issues`);
        }
    }

    logger.info(`Finished processing all issues. Total AMP/KAMP issues found: ${allIssues.length}`);
    return allIssues;
}