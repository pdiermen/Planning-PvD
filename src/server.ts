import express from 'express';
import type { Request, Response, RequestHandler, NextFunction } from 'express';
import type { Issue as JiraIssue, Issue, IssueLink, EfficiencyData, ProjectConfig, WorklogConfig, WorkLog, Sprint } from './types.js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import logger from './logger.js';
import { getActiveIssues, getWorkLogs, getPlanning, jiraClient, getIssuesForProject, getWorkLogsForProject, getIssues } from './jira.js';
import cors from 'cors';
import type { WorkLogsResponse } from './types.js';
import { JIRA_DOMAIN } from './config.js';
import axios from 'axios';
import { getProjectConfigsFromSheet, getWorklogConfigsFromSheet } from './google-sheets.js';
import { getGoogleSheetsData } from './google-sheets.js';
import { getSprintCapacity } from './jira.js';
import path from 'path';
import { findFirstAvailableSprint } from './services/planning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: join(__dirname, '../.env.local') });

// Controleer of alle benodigde environment variables aanwezig zijn
const requiredEnvVars = [
    'JIRA_HOST',
    'JIRA_USERNAME',
    'JIRA_API_TOKEN',
    'GOOGLE_SHEETS_CLIENT_EMAIL',
    'GOOGLE_SHEETS_PRIVATE_KEY',
    'GOOGLE_SHEETS_SPREADSHEET_ID'
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Ontbrekende environment variable: ${envVar}`);
        process.exit(1);
    }
}

const app = express();
const port = process.env.PORT || 3001;

if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID in environment variables');
}

if (!process.env.GOOGLE_SHEETS_CLIENT_EMAIL) {
    throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL in environment variables');
}

if (!process.env.GOOGLE_SHEETS_PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_SHEETS_PRIVATE_KEY in environment variables');
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

// Google Sheets configuratie
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const auth = new JWT({
    email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: SCOPES
});

const sheets = google.sheets({ version: 'v4', auth });

app.use(cors());
app.use(express.json());

// Configureer axios interceptors voor error handling
jiraClient.interceptors.response.use(
    response => response,
    error => {
        console.error('Jira API Error:', error.response?.data || error.message);
        return Promise.reject(new Error(error.response?.data?.errorMessages?.[0] || error.message));
    }
);

app.get('/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Stuur een event wanneer de verbinding tot stand is gekomen
    res.write('data: {"step": 0}\n\n');
});

function calculateExpectedHours(startDate: string, endDate: string, availableHoursPerWeek: number, employeeName: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let totalDays = 0;
    let currentDate = new Date(start);

    // Tel alleen weekdagen (maandag t/m vrijdag)
    while (currentDate <= end) {
        const dayOfWeek = currentDate.getDay();
        // Alleen maandag (1) t/m vrijdag (5) tellen mee
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            totalDays++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    // Bereken beschikbare uren per dag door de beschikbare uren per week te delen door 5
    const availableHoursPerDay = availableHoursPerWeek / 5;
    
    // Bereken verwachte uren door beschikbare uren per dag te vermenigvuldigen met aantal dagen
    const expectedHours = Number((totalDays * availableHoursPerDay).toFixed(1));

    return expectedHours;
}

interface IssueHistory {
    created: string;
    items: {
        field: string;
        toString: string;
    }[];
}

async function calculateEfficiency(issues: JiraIssue[], worklogs: WorkLog[], startDate: Date, endDate: Date): Promise<EfficiencyData[]> {
    logger.log('Start calculateEfficiency functie');
    
    // Haal project configuraties op uit Google Sheet
    const projectConfigs = await getProjectConfigsFromSheet();
    
    // Verzamel alle unieke projectcodes
    const projectCodes = new Set<string>();
    projectConfigs.forEach(config => {
        if (config.projectCodes && Array.isArray(config.projectCodes)) {
            config.projectCodes.forEach(code => {
                if (typeof code === 'string') {
                    projectCodes.add(code.trim());
                }
            });
        }
    });
    
    // Bouw de JQL query met projectcodes
    const projectFilter = Array.from(projectCodes).map(code => `project = ${code}`).join(' OR ');
    const jql = `(${projectFilter}) AND resolutiondate >= "${startDate.toISOString().split('T')[0]}" AND resolutiondate <= "${endDate.toISOString().split('T')[0]}" AND status = Closed ORDER BY resolutiondate DESC`;
    
    logger.log(`JQL Query voor efficiency berekening: ${jql}`);
    const allClosedIssues = await getIssues(jql);
    
    logger.log(`Aantal afgesloten issues van alle projecten: ${allClosedIssues.length}`);
    logger.log(`Aantal worklogs: ${worklogs.length}`);
    logger.log(`Periode: ${startDate.toISOString()} tot ${endDate.toISOString()}`);

    // Groepeer worklogs per medewerker
    const worklogsByEmployee = new Map<string, WorkLog[]>();
    worklogs.forEach(log => {
        const employeeName = typeof log.author === 'string' ? 
            log.author : 
            (log.author && typeof log.author === 'object' && 'displayName' in log.author ? 
                log.author.displayName : 
                'Onbekend');
        
        if (!worklogsByEmployee.has(employeeName)) {
            worklogsByEmployee.set(employeeName, []);
        }
        worklogsByEmployee.get(employeeName)?.push(log);
    });

    logger.log(`Aantal medewerkers met worklogs: ${worklogsByEmployee.size}`);

    // Bereken efficiëntie per medewerker
    const efficiencyData: EfficiencyData[] = [];
    worklogsByEmployee.forEach((employeeWorklogs, employeeName) => {
        // Filter issues voor deze medewerker
        const employeeIssues = allClosedIssues.filter((issue: JiraIssue) => 
            getAssigneeName(issue.fields?.assignee) === employeeName
        );

        // Bereken totale geschatte uren en verzamel issue details
        let totalEstimatedHours = 0;
        const issueKeys: string[] = [];
        const issueDetails: { key: string; estimatedHours: number; loggedHours: number }[] = [];

        employeeIssues.forEach(issue => {
            const issueKey = issue.key;
            issueKeys.push(issueKey);
            
            // Bereken geschatte uren voor dit issue
            const estimatedHours = issue.fields?.timeoriginalestimate 
                ? issue.fields.timeoriginalestimate / 3600 
                : 0;
            totalEstimatedHours += estimatedHours;

            // Bereken gelogde uren voor dit issue binnen de opgegeven periode
            const loggedHours = employeeWorklogs
                .filter(log => {
                    const logDate = new Date(log.started);
                    return logDate >= startDate && logDate <= endDate;
                })
                .reduce((total, log) => total + log.timeSpentSeconds / 3600, 0);

            issueDetails.push({
                key: issueKey,
                estimatedHours,
                loggedHours
            });
        });

        // Bereken totale gelogde uren
        const totalLoggedHours = issueDetails.reduce((total, detail) => total + detail.loggedHours, 0);

        // Bereken efficiëntie
        const efficiency = totalEstimatedHours > 0 ? (totalLoggedHours / totalEstimatedHours) * 100 : 0;

        efficiencyData.push({
            assignee: employeeName,
            estimatedHours: Number(totalEstimatedHours.toFixed(1)),
            loggedHours: Number(totalLoggedHours.toFixed(1)),
            efficiency: Number(efficiency.toFixed(1)),
            issueKeys: issueKeys,
            issueDetails: issueDetails
        });
    });

    logger.log(`\nEindresultaat efficiëntie berekening:`);
    efficiencyData.forEach((data: EfficiencyData) => {
        // Verwijder de logging van efficiëntie per medewerker
    });

    return efficiencyData;
}

app.get('/worklogs', (req, res) => {
    const html = `
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Worklogs & Efficiëntie Dashboard</title>
            <style>
                ${styles}
            </style>
        </head>
        <body>
            <nav class="navbar">
                <a href="/" class="navbar-brand">Planning Dashboard</a>
                <ul class="navbar-nav">
                    <li class="nav-item">
                        <a href="/" class="nav-link">Projecten</a>
                    </li>
                    <li class="nav-item">
                        <a href="/worklogs" class="nav-link active">Worklogs & Efficiëntie</a>
                    </li>
                </ul>
            </nav>
            <div class="container">
                <div class="card mb-4">
                    <div class="card-header">
                        <h2 class="mb-0">Worklogs & Efficiëntie</h2>
                    </div>
                    <div class="card-body">
                        <div class="worklogs-form">
                            <div class="row">
                                <div class="col-md-4">
                                    <label for="startDate" class="form-label">Startdatum</label>
                                    <input type="date" class="form-control" id="startDate" name="startDate">
                                </div>
                                <div class="col-md-4">
                                    <label for="endDate" class="form-label">Einddatum</label>
                                    <input type="date" class="form-control" id="endDate" name="endDate">
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label">&nbsp;</label>
                                    <button type="button" class="btn btn-primary" onclick="loadWorklogs()">Laad Worklogs</button>
                                </div>
                            </div>
                        </div>
                        <div id="worklogsContainer">
                            <div class="alert alert-info">
                                Selecteer een begin- en einddatum om de worklogs te bekijken.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <script>
                async function loadWorklogs() {
                    const startDate = document.getElementById('startDate').value;
                    const endDate = document.getElementById('endDate').value;
                    
                    if (!startDate || !endDate) {
                        alert('Selecteer een begin- en einddatum');
                        return;
                    }

                    try {
                        const response = await fetch(\`/api/worklogs?startDate=\${startDate}&endDate=\${endDate}\`);
                        if (!response.ok) {
                            throw new Error('Er is een fout opgetreden bij het ophalen van de worklogs.');
                        }
                        const html = await response.text();
                        document.getElementById('worklogsContainer').innerHTML = html;
                    } catch (error) {
                        document.getElementById('worklogsContainer').innerHTML = \`
                            <div class="alert alert-danger">
                                Er is een fout opgetreden bij het ophalen van de worklogs.
                            </div>
                        \`;
                    }
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});

app.get('/', async (req, res) => {
    try {
        // Haal project configuraties op
        const projectConfigs = await getProjectConfigsFromSheet();
        
        // Haal issues op voor elk project
        const projectIssues = new Map<string, JiraIssue[]>();
        for (const config of projectConfigs) {
            try {
                const issues = await getIssuesForProject(config);
                projectIssues.set(config.projectName, issues);
            } catch (error) {
                console.error(`Error bij ophalen issues voor project ${config.projectName}:`, error);
                projectIssues.set(config.projectName, []);
            }
        }

        // Haal Google Sheets data op
        let googleSheetsData;
        try {
            googleSheetsData = await getGoogleSheetsData('Employees!A1:H');
        } catch (error) {
            console.error('Error bij ophalen van Google Sheets data:', error);
            throw error;
        }

        // Haal sprint namen op voor alle issues
        const sprintNames = new Map<string, string>();
        for (const issues of projectIssues.values()) {
            for (const issue of issues) {
                if (issue.fields?.customfield_10020 && issue.fields.customfield_10020.length > 0) {
                    sprintNames.set(issue.key, await getSprintNameFromSprint(issue.fields.customfield_10020[0]));
                }
            }
        }

        // Bereken planning voor elk project
        const projectPlanning = new Map<string, PlanningResult>();
        for (const config of projectConfigs) {
            const issues = projectIssues.get(config.projectName) || [];
            const planning = await calculatePlanning(issues, config.projectName, googleSheetsData || []);
            projectPlanning.set(config.projectName, planning);
        }

        // Genereer HTML
        const html = await generateHtml(projectIssues, projectPlanning, googleSheetsData || [], [], sprintNames);
        res.send(html);
    } catch (error) {
        console.error('Error in root route:', error);
        res.status(500).send(`
            <div class="alert alert-danger">
                Er is een fout opgetreden bij het ophalen van de data. 
                Probeer de pagina te verversen of neem contact op met de beheerder als het probleem aanhoudt.
                <br><br>
                Error details: ${error instanceof Error ? error.message : String(error)}
            </div>
        `);
    }
});

function getPredecessors(issue: JiraIssue): string[] {
    if (!issue.fields?.issuelinks) {
        return [];
    }
    
    // Filter de links om alleen "is a predecessor of" relaties te vinden
    const predecessorLinks = issue.fields.issuelinks.filter(link => 
        link.type.name === 'is a predecessor of' && 
        link.inwardIssue && 
        typeof link.inwardIssue === 'object' &&
        'key' in link.inwardIssue &&
        'fields' in link.inwardIssue &&
        link.inwardIssue.fields?.status?.name !== 'Closed'
    );
    
    // Als er voorgangers zijn, log deze informatie
    if (predecessorLinks.length > 0) {
        console.log(`Issue ${issue.key} heeft ${predecessorLinks.length} actieve voorganger(s):`);
        predecessorLinks.forEach(link => {
            if (link.inwardIssue) {
                console.log(`  - Voorganger: ${link.inwardIssue.key}`);
            }
        });
    }
    
    return predecessorLinks
        .map(link => link.inwardIssue?.key)
        .filter((key): key is string => key !== undefined);
}

function debug(message: string) {
    console.log(`Debug: ${message}`);
}

function getSuccessors(issue: JiraIssue): string[] {
    if (!issue.fields?.issuelinks) {
        return [];
    }

    const successors = issue.fields.issuelinks
        .filter(link => {
            // Een opvolger heeft een relatie met:
            // 1. type.name === 'Predecessor'
            // 2. type.inward === 'is a predecessor of'
            // 3. status is niet 'Closed'
            const isSuccessor = link.type.name === 'Predecessor' && 
                              link.type.inward === 'is a predecessor of' &&
                              link.inwardIssue &&
                              typeof link.inwardIssue === 'object' &&
                              'key' in link.inwardIssue &&
                              'fields' in link.inwardIssue &&
                              link.inwardIssue.fields?.status?.name !== 'Closed';
            return isSuccessor;
        })
        .map(link => link.inwardIssue?.key)
        .filter((key): key is string => key !== undefined);

    return successors;
}

function formatTime(seconds: number | undefined): string {
    if (seconds === undefined || seconds === null) return '-';
    return Number((seconds / 3600).toFixed(1)).toString();
}

// Functie om issues te sorteren volgens de gewenste volgorde
function sortIssues(issues: JiraIssue[]): JiraIssue[] {
    // Definieer de volgorde van statussen
    const statusOrder: Record<string, number> = {
        'Resolved': 0,
        'In Review': 1,
        'Open': 2,
        'Reopended': 3,
        'Reopend': 4,
        'Registered': 5,
        'Waiting': 6,
        'Testing': 7
    };

    // Groepeer issues per projectcode
    const issuesByProject = new Map<string, JiraIssue[]>();
    issues.forEach(issue => {
        const projectCode = issue.key.split('-')[0];
        if (!issuesByProject.has(projectCode)) {
            issuesByProject.set(projectCode, []);
        }
        issuesByProject.get(projectCode)?.push(issue);
    });

    // Sorteer issues binnen elke projectcode
    const sortedIssues: JiraIssue[] = [];
    const processedIssues = new Set<string>();

    // Functie om een issue en zijn opvolgers te verwerken
    const processIssueAndSuccessors = (issue: JiraIssue, parentStatus?: string) => {
        if (processedIssues.has(issue.key)) return;
        
        const currentStatus = issue.fields?.status?.name || '';
        const currentStatusOrder = statusOrder[currentStatus] || 999;
        
        // Als dit een opvolger is en de parent status is hoger (slechter) dan de huidige status,
        // dan moeten we eerst alle issues met de huidige status verwerken
        if (parentStatus && statusOrder[parentStatus] > currentStatusOrder) {
            return;
        }
        
        processedIssues.add(issue.key);
        sortedIssues.push(issue);

        // Vind alle opvolgers van dit issue
        const successors = issues.filter(i => 
            i.fields?.issuelinks?.some(link => 
                (link.type.name === 'Blocks' || link.type.name === 'Depends On') && 
                link.inwardIssue?.key === issue.key
            )
        );

        // Sorteer opvolgers op status
        const sortedSuccessors = [...successors].sort((a, b) => {
            const statusA = a.fields?.status?.name || '';
            const statusB = b.fields?.status?.name || '';
            return (statusOrder[statusA] || 999) - (statusOrder[statusB] || 999);
        });

        // Verwerk opvolgers in gesorteerde volgorde
        for (const successor of sortedSuccessors) {
            processIssueAndSuccessors(successor, currentStatus);
        }
    };

    // Verwerk issues per projectcode in de juiste volgorde
    for (const [projectCode, projectIssues] of issuesByProject) {
        // Sorteer alle issues binnen de projectcode op status
        const sortedProjectIssues = [...projectIssues].sort((a, b) => {
            const statusA = a.fields?.status?.name || '';
            const statusB = b.fields?.status?.name || '';
            return (statusOrder[statusA] || 999) - (statusOrder[statusB] || 999);
        });

        // Verwerk alle issues in volgorde van status
        for (const issue of sortedProjectIssues) {
            processIssueAndSuccessors(issue);
        }
    }

    return sortedIssues;
}

interface SprintCapacity {
    employee: string;
    sprint: string;
    capacity: number;
    project?: string; // Maak project optioneel
}

interface Worklog {
    timeSpentSeconds: number;
    started: string;
    author: {
        displayName: string;
    };
}

interface PlannedIssue {
    issue: JiraIssue;
    sprint: string;
    hours: number;
    assignee: string;
    worklogHours?: number;
    remainingEstimate?: number;
    key: string;
}

interface PlanningResult {
    sprintHours: { [key: string]: Array<{ issueKey: string; hours: number; issues: Issue[] }> };
    plannedIssues: PlannedIssue[];
    issues: JiraIssue[];
    sprints: SprintCapacity[];
    sprintAssignments: { [key: string]: { [key: string]: Issue[] } };
    sprintCapacity: SprintCapacity[];
    employeeSprintUsedHours: { [key: string]: { [key: string]: number } };
}

async function getSprintCapacityFromSheet(googleSheetsData: (string | null)[][]): Promise<SprintCapacity[]> {
    if (!googleSheetsData || googleSheetsData.length === 0) {
        logger.error('Geen Google Sheets data beschikbaar');
        return [];
    }

    const sprintCapacities: SprintCapacity[] = [];
    const headerRow = googleSheetsData[0];
    
    // Controleer of de headerRow bestaat en een array is
    if (!headerRow || !Array.isArray(headerRow)) {
        logger.error('Ongeldige header rij in Google Sheets data');
        return [];
    }

    // Log de header rij voor debugging
    logger.log(`Header rij: ${JSON.stringify(headerRow)}`);

    // Zoek de kolom indices
    const nameIndex = headerRow.findIndex(header => header === 'Naam');
    const effectiveHoursIndex = headerRow.findIndex(header => header === 'Effectieve uren');
    const projectIndex = headerRow.findIndex(header => header === 'Project');

    // Log de gevonden indices voor debugging
    logger.log(`Kolom indices - Naam: ${nameIndex}, Effectieve uren: ${effectiveHoursIndex}, Project: ${projectIndex}`);

    if (nameIndex === -1 || effectiveHoursIndex === -1 || projectIndex === -1) {
        logger.error('Verplichte kolommen niet gevonden in Google Sheets data');
        return [];
    }

    // Verwerk de data rijen
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        if (!row || !Array.isArray(row)) continue;

        const employeeName = row[nameIndex];
        const effectiveHoursStr = row[effectiveHoursIndex];
        const projectsStr = row[projectIndex];

        // Controleer of we geldige data hebben
        if (!employeeName || !effectiveHoursStr) continue;

        const effectiveHours = parseFloat(effectiveHoursStr.toString());
        if (isNaN(effectiveHours)) continue;

        const projects = projectsStr ? projectsStr.toString().split(',').map(p => p.trim()) : [];

        // Genereer capaciteiten voor elke sprint
        for (let sprintNumber = 1; sprintNumber <= 5; sprintNumber++) {
            if (projects.length === 0 || projects[0] === '') {
                sprintCapacities.push({
                    employee: employeeName,
                    sprint: sprintNumber.toString(),
                    capacity: effectiveHours * 2, // 2 weken per sprint
                    project: ''
                });
            } else {
                projects.forEach(project => {
                    sprintCapacities.push({
                        employee: employeeName,
                        sprint: sprintNumber.toString(),
                        capacity: effectiveHours * 2, // 2 weken per sprint
                        project: project
                    });
                });
            }
        }
    }

    logger.log(`Gevonden sprint capaciteiten: ${sprintCapacities.length}`);
    return sprintCapacities;
}

async function calculatePlanning(issues: JiraIssue[], projectType: string, googleSheetsData: (string | null)[][] | null): Promise<PlanningResult> {
    try {
        logger.log('Start berekenen van planning...');
        
        // Sorteer de issues volgens de gewenste volgorde
        const sortedIssues = sortIssues(issues);
        
        // Haal de sprint capaciteit op uit Google Sheets
        const allSprintCapacities = await getSprintCapacityFromSheet(googleSheetsData || []);
        
        // Filter de sprint capaciteiten op basis van het project type
        const sprintCapacities = allSprintCapacities.filter(capacity => 
            capacity.project === projectType || capacity.project === ''
        );
        
        logger.log(`${sprintCapacities.length} sprint capaciteiten gevonden voor project ${projectType}`);

        // Verzamel alle sprint namen en sorteer ze numeriek
        const sprintNames = [...new Set(sprintCapacities.map((value: SprintCapacity) => value.sprint))]
            .sort((a, b) => parseInt(a) - parseInt(b));
        logger.log(`Beschikbare sprints: ${sprintNames.join(', ')}`);

        // Initialiseer de planning result
        const planningResult: PlanningResult = {
            sprintHours: {},
            plannedIssues: [],
            issues: sortedIssues,
            sprints: sprintCapacities,
            sprintAssignments: {},
            sprintCapacity: sprintCapacities,
            employeeSprintUsedHours: {}
        };

        // Functie om een issue te plannen
        const planIssue = (issue: JiraIssue, sprintName: string, assignee: string) => {
            const issueKey = issue.key;
            const issueHours = (issue.fields?.timeestimate || 0) / 3600;

            if (!planningResult.plannedIssues.some(pi => pi.issue.key === issueKey)) {
                planningResult.plannedIssues.push({
                    issue,
                    sprint: sprintName,
                    hours: issueHours,
                    assignee,
                    key: issueKey
                });

                if (!planningResult.sprintHours[sprintName]) {
                    planningResult.sprintHours[sprintName] = [];
                }
                planningResult.sprintHours[sprintName].push({
                    issueKey,
                    hours: issueHours,
                    issues: [issue]
                });

                if (!planningResult.employeeSprintUsedHours[assignee]) {
                    planningResult.employeeSprintUsedHours[assignee] = {};
                }
                if (!planningResult.employeeSprintUsedHours[assignee][sprintName]) {
                    planningResult.employeeSprintUsedHours[assignee][sprintName] = 0;
                }
                planningResult.employeeSprintUsedHours[assignee][sprintName] += issueHours;
            }
        };

        // Functie om de beschikbare capaciteit te berekenen
        const getAvailableCapacity = (sprintName: string, assignee: string) => {
            if (assignee === 'Peter van Diermen' || assignee === 'Unassigned') {
                // Bereken totale sprint capaciteit (exclusief Peter en Unassigned)
                const totalSprintCapacity = sprintCapacities
                    .filter(cap => cap.sprint === sprintName && 
                                 cap.employee !== 'Peter van Diermen' && 
                                 cap.employee !== 'Unassigned')
                    .reduce((sum, cap) => sum + cap.capacity, 0);

                // Bereken gebruikte uren door alle medewerkers
                const totalUsedHours = Object.entries(planningResult.employeeSprintUsedHours)
                    .reduce((sum, [emp, sprintData]) => {
                        return sum + (sprintData[sprintName] || 0);
                    }, 0);

                return totalSprintCapacity - totalUsedHours;
            } else {
                // Voor andere medewerkers: gebruik hun individuele capaciteit
                const sprintCapacity = sprintCapacities.find(
                    cap => cap.sprint === sprintName && cap.employee === assignee
                );
                
                if (!sprintCapacity) return 0;

                const usedHours = planningResult.employeeSprintUsedHours[assignee]?.[sprintName] || 0;
                return sprintCapacity.capacity - usedHours;
            }
        };

        // Verwijder de lokale findFirstAvailableSprint implementatie en gebruik de geïmporteerde versie
        const findFirstAvailableSprintForIssue = (issue: Issue, assignee: string, startIndex: number = 0) => {
            return findFirstAvailableSprint(issue, assignee, startIndex, planningResult);
        };

        // Functie om te controleren of een issue een opvolger is van Peter of Unassigned
        const isSuccessorOfPeterOrUnassigned = (issue: JiraIssue) => {
            const predecessors = getPredecessors(issue);
            return predecessors.some(predecessorKey => {
                const predecessor = sortedIssues.find(i => i.key === predecessorKey);
                if (!predecessor) return false;
                const assignee = getAssigneeName(predecessor.fields?.assignee);
                return assignee === 'Peter van Diermen' || assignee === 'Unassigned';
            });
        };

        // Functie om te controleren of een issue een opvolger is van Unassigned
        const isSuccessorOfUnassigned = (issue: JiraIssue) => {
            const predecessors = getPredecessors(issue);
            return predecessors.some(predecessorKey => {
                const predecessor = sortedIssues.find(i => i.key === predecessorKey);
                if (!predecessor) return false;
                const assignee = getAssigneeName(predecessor.fields?.assignee);
                return assignee === 'Unassigned';
            });
        };

        // Plan issues van andere medewerkers
        for (const issue of sortedIssues) {
            const assignee = getAssigneeName(issue.fields?.assignee);
            if (!assignee || assignee === 'Peter van Diermen' || assignee === 'Unassigned') continue;

            // Skip als het issue al gepland is
            if (planningResult.plannedIssues.some(pi => pi.issue.key === issue.key)) continue;

            // Skip als het issue een opvolger is van Peter of Unassigned
            if (isSuccessorOfPeterOrUnassigned(issue)) continue;

            const predecessors = getPredecessors(issue);

            if (predecessors.length === 0) {
                // Als er geen voorgangers zijn, plan direct in eerste beschikbare sprint
                const sprintName = findFirstAvailableSprintForIssue(issue, assignee);
                planIssue(issue, sprintName, assignee);
            } else {
                // Als er wel voorgangers zijn, volg de normale voorganger logica
                for (const predecessorKey of predecessors) {
                    const predecessor = sortedIssues.find(i => i.key === predecessorKey);
                    if (predecessor && !planningResult.plannedIssues.some(pi => pi.issue.key === predecessorKey)) {
                        const predecessorAssignee = getAssigneeName(predecessor.fields?.assignee);
                        if (predecessorAssignee) {
                            const sprintName = findFirstAvailableSprintForIssue(predecessor, predecessorAssignee);
                            planIssue(predecessor, sprintName, predecessorAssignee);
                        }
                    }
                }

                // Zoek de laatste sprint van de voorgangers
                let lastPredecessorSprintIndex = -1;
                for (const predecessorKey of predecessors) {
                    const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
                    if (predecessor) {
                        const sprintIndex = sprintNames.indexOf(predecessor.sprint);
                        if (sprintIndex > lastPredecessorSprintIndex) {
                            lastPredecessorSprintIndex = sprintIndex;
                        }
                    }
                }

                if (lastPredecessorSprintIndex >= 0) {
                    // Plan in eerste beschikbare sprint na de laatste voorganger
                    const sprintName = findFirstAvailableSprintForIssue(issue, assignee, lastPredecessorSprintIndex + 1);
                    planIssue(issue, sprintName, assignee);
                } else {
                    // Als voorgangers nog niet gepland zijn, plan in sprint 10
                    planIssue(issue, '10', assignee);
                }
            }
        }

        // Plan issues van Peter van Diermen
        for (const issue of sortedIssues) {
            const assignee = getAssigneeName(issue.fields?.assignee);
            if (!assignee || assignee !== 'Peter van Diermen') continue;

            // Skip als het issue al gepland is
            if (planningResult.plannedIssues.some(pi => pi.issue.key === issue.key)) continue;

            // Skip als het issue een opvolger is van Unassigned
            if (isSuccessorOfUnassigned(issue)) continue;

            const predecessors = getPredecessors(issue);

            if (predecessors.length === 0) {
                // Plan in eerste beschikbare sprint
                const sprintName = findFirstAvailableSprintForIssue(issue, assignee);
                planIssue(issue, sprintName, assignee);
            } else {
                // Plan eerst de voorgangers indien nodig
                for (const predecessorKey of predecessors) {
                    const predecessor = sortedIssues.find(i => i.key === predecessorKey);
                    if (predecessor && !planningResult.plannedIssues.some(pi => pi.issue.key === predecessorKey)) {
                        const predecessorAssignee = getAssigneeName(predecessor.fields?.assignee);
                        if (predecessorAssignee) {
                            const sprintName = findFirstAvailableSprintForIssue(predecessor, predecessorAssignee);
                            planIssue(predecessor, sprintName, predecessorAssignee);
                        }
                    }
                }

                // Zoek de laatste sprint van de voorgangers
                let lastPredecessorSprintIndex = -1;
                for (const predecessorKey of predecessors) {
                    const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
                    if (predecessor) {
                        const sprintIndex = sprintNames.indexOf(predecessor.sprint);
                        if (sprintIndex > lastPredecessorSprintIndex) {
                            lastPredecessorSprintIndex = sprintIndex;
                        }
                    }
                }

                if (lastPredecessorSprintIndex >= 0) {
                    // Plan in eerste beschikbare sprint na de laatste voorganger
                    const sprintName = findFirstAvailableSprintForIssue(issue, assignee, lastPredecessorSprintIndex + 1);
                    planIssue(issue, sprintName, assignee);
                } else {
                    // Als voorgangers nog niet gepland zijn, plan in sprint 10
                    planIssue(issue, '10', assignee);
                }
            }
        }

        // Plan issues van Unassigned
        for (const issue of sortedIssues) {
            const assignee = getAssigneeName(issue.fields?.assignee);
            if (!assignee || assignee !== 'Unassigned') continue;

            // Skip als het issue al gepland is
            if (planningResult.plannedIssues.some(pi => pi.issue.key === issue.key)) continue;

            const predecessors = getPredecessors(issue);

            if (predecessors.length === 0) {
                // Plan in eerste beschikbare sprint
                const sprintName = findFirstAvailableSprintForIssue(issue, assignee);
                planIssue(issue, sprintName, assignee);
            } else {
                // Plan eerst de voorgangers indien nodig
                for (const predecessorKey of predecessors) {
                    const predecessor = sortedIssues.find(i => i.key === predecessorKey);
                    if (predecessor && !planningResult.plannedIssues.some(pi => pi.issue.key === predecessorKey)) {
                        const predecessorAssignee = getAssigneeName(predecessor.fields?.assignee);
                        if (predecessorAssignee) {
                            const sprintName = findFirstAvailableSprintForIssue(predecessor, predecessorAssignee);
                            planIssue(predecessor, sprintName, predecessorAssignee);
                        }
                    }
                }

                // Zoek de laatste sprint van de voorgangers
                let lastPredecessorSprintIndex = -1;
                for (const predecessorKey of predecessors) {
                    const predecessor = planningResult.plannedIssues.find(pi => pi.issue.key === predecessorKey);
                    if (predecessor) {
                        const sprintIndex = sprintNames.indexOf(predecessor.sprint);
                        if (sprintIndex > lastPredecessorSprintIndex) {
                            lastPredecessorSprintIndex = sprintIndex;
                        }
                    }
                }

                if (lastPredecessorSprintIndex >= 0) {
                    // Plan in eerste beschikbare sprint na de laatste voorganger
                    const sprintName = findFirstAvailableSprintForIssue(issue, assignee, lastPredecessorSprintIndex + 1);
                    planIssue(issue, sprintName, assignee);
                } else {
                    // Als voorgangers nog niet gepland zijn, plan in sprint 10
                    planIssue(issue, '10', assignee);
                }
            }
        }

        logger.log('Planning succesvol berekend');
        return planningResult;
    } catch (error) {
        logger.log(`Fout bij berekenen planning: ${error}`);
        throw error;
    }
}

async function getSprintNameFromSprint(sprint: Sprint): Promise<string> {
    return sprint.name || sprint.id.toString();
}

function getPersonStats(issues: JiraIssue[]): { name: string; issueCount: number; totalRemainingTime: number }[] {
    const statsMap = new Map<string, { issueCount: number; totalRemainingTime: number }>();
    
    issues.forEach(issue => {
        const assignee = getAssigneeName(issue.fields?.assignee);
        const currentStats = statsMap.get(assignee) || { issueCount: 0, totalRemainingTime: 0 };
        
        statsMap.set(assignee, {
            issueCount: currentStats.issueCount + 1,
            totalRemainingTime: currentStats.totalRemainingTime + (issue.fields?.timeestimate || 0)
        });
    });

    return Array.from(statsMap.entries()).map(([name, stats]) => ({
        name,
        issueCount: stats.issueCount,
        totalRemainingTime: stats.totalRemainingTime
    }));
}

function getSprintHours(sprintPlanning: PlanningResult, projectType: 'atlantis' | 'subscription'): Map<string, Map<string, number>> {
    const sprintHoursMap = new Map<string, Map<string, number>>();

    // Verwerk de sprint capaciteit
    sprintPlanning.sprintCapacity.forEach(capacity => {
        const sprintNumber = capacity.sprint;
        if (!sprintHoursMap.has(sprintNumber)) {
            sprintHoursMap.set(sprintNumber, new Map<string, number>());
        }
    });

    // Verwerk de gebruikte uren
    Object.entries(sprintPlanning.employeeSprintUsedHours).forEach(([employee, sprintData]) => {
        Object.entries(sprintData).forEach(([sprintNumber, hours]) => {
            if (!sprintHoursMap.has(sprintNumber)) {
                sprintHoursMap.set(sprintNumber, new Map<string, number>());
            }
            
            const sprintHours = sprintHoursMap.get(sprintNumber)!;
            sprintHours.set(employee, hours);
        });
    });

    return sprintHoursMap;
}

function getAvailableHoursForProject(googleSheetsData: string[][] | null, projectName: string): number {
    if (!googleSheetsData) return 0;
    const totalHours = googleSheetsData.slice(1).reduce((sum, row) => {
        const projects = (row[7] || '').split(',').map(p => p.trim());
        if (projects.includes(projectName)) {
            const effectiveHours = Number((parseFloat(row[6]) || 0).toFixed(1)); // Rond effectieve uren af op 1 decimaal
            return sum + Number((effectiveHours * 2).toFixed(1)); // Rond sprint capaciteit af op 1 decimaal
        }
        return sum;
    }, 0);
    return Number(totalHours.toFixed(1)); // Rond eindtotaal af op 1 decimaal
}

async function generateHtml(
    projectIssues: Map<string, JiraIssue[]>,
    projectPlanning: Map<string, PlanningResult>,
    googleSheetsData: any[],
    worklogs: Worklog[],
    sprintNames: Map<string, string>
): Promise<string> {
    let html = `
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Planning Overzicht</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                ${styles}
                .table { font-size: 0.9rem; }
                .table th { background-color: #f8f9fa; }
                .planned { background-color: #d4edda; }
                .unplanned { background-color: #f8d7da; }
            </style>
        </head>
        <body>
            <nav class="navbar">
                <a href="/" class="navbar-brand">Planning Dashboard</a>
                <ul class="navbar-nav">
                    <li class="nav-item">
                        <a href="/" class="nav-link active">Projecten</a>
                    </li>
                    <li class="nav-item">
                        <a href="/worklogs" class="nav-link">Worklogs & Efficiëntie</a>
                    </li>
                </ul>
            </nav>
            <div class="container-fluid mt-4">
    `;

    // Genereer tabellen voor elk project
    for (const [projectName, issues] of projectIssues) {
        const planning = projectPlanning.get(projectName);
        if (!planning) continue;

        html += `
            <h2 class="mb-4">${projectName}</h2>
            <div class="row mb-4">
                <div class="col">
                    <h4>Planning Tabel</h4>
                    ${generateSprintHoursTable(planning, sprintNames)}
                </div>
            </div>
            <div class="row mb-4">
                <div class="col">
                    <h4>Issues</h4>
                    ${generateIssuesTable(issues, planning, sprintNames)}
                </div>
            </div>
        `;
    }

    html += `
            </div>
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
        </body>
        </html>
    `;

    return html;
}

function generateEfficiencyTable(efficiencyData: EfficiencyData[]): string {
    let html = `
        <h3>Efficiëntie</h3>
        <table class="table">
            <thead>
                <tr>
                    <th>Medewerker</th>
                    <th>Geschatte uren</th>
                    <th>Gelogde uren</th>
                    <th>Efficiëntie</th>
                </tr>
            </thead>
            <tbody>
    `;

    efficiencyData.forEach(data => {
        const issueKeysText = data.issueKeys && data.issueKeys.length > 0
            ? `${data.estimatedHours} (${data.issueKeys.join(', ')})`
            : data.estimatedHours;

        const issueDetailsText = data.issueDetails && data.issueDetails.length > 0
            ? data.issueDetails.map(detail => 
                `${detail.key}: ${detail.estimatedHours} uur geschat, ${detail.loggedHours} uur gelogd`
              ).join('<br>')
            : '';

        html += `
            <tr>
                <td>${data.assignee}</td>
                <td>${issueKeysText}</td>
                <td>${data.loggedHours}</td>
                <td>${data.efficiency}%</td>
            </tr>
            ${issueDetailsText ? `
            <tr>
                <td colspan="4" style="padding-left: 20px; font-size: 0.9em; color: #666;">
                    ${issueDetailsText}
                </td>
            </tr>
            ` : ''}
        `;
    });

    // Bereken totalen voor de efficiency tabel
    const totalEstimated = efficiencyData.reduce((sum, data) => sum + data.estimatedHours, 0);
    const totalLogged = efficiencyData.reduce((sum, data) => sum + data.loggedHours, 0);
    const totalEfficiency = totalEstimated > 0 ? (totalLogged / totalEstimated) * 100 : 0;

    // Voeg totaalregel toe
    html += `
        <tr class="table-dark">
            <td><strong>Totaal</strong></td>
            <td><strong>${totalEstimated.toFixed(1)}</strong></td>
            <td><strong>${totalLogged.toFixed(1)}</strong></td>
            <td><strong>${totalEfficiency.toFixed(1)}%</strong></td>
        </tr>
    `;

    html += '</tbody></table>';
    return html;
}

function generateSprintHoursTable(projectPlanning: PlanningResult, sprintNames: Map<string, string>): string {
    if (!projectPlanning.sprintHours) {
        return '<p>Geen sprint uren beschikbaar</p>';
    }

    const availableSprintNames = Object.keys(projectPlanning.sprintHours).sort((a, b) => parseInt(a) - parseInt(b));
    const employeeData: { [key: string]: { [key: string]: { available: number; planned: number; remaining: number } } } = {};

    // Verwerk sprint capaciteit alleen voor actieve medewerkers op het project
    if (projectPlanning.sprintCapacity) {
        for (const capacity of projectPlanning.sprintCapacity) {
            // Alleen capaciteiten voor het specifieke project meenemen
            if (capacity.project && capacity.project !== '') {
                if (!employeeData[capacity.employee]) {
                    employeeData[capacity.employee] = {};
                }
                if (!employeeData[capacity.employee][capacity.sprint]) {
                    employeeData[capacity.employee][capacity.sprint] = {
                        available: capacity.capacity,
                        planned: 0,
                        remaining: capacity.capacity
                    };
                }
            }
        }
    }

    // Verwerk gebruikte uren alleen voor actieve medewerkers
    if (projectPlanning.employeeSprintUsedHours) {
        for (const [employee, sprintData] of Object.entries(projectPlanning.employeeSprintUsedHours)) {
            // Alleen uren van actieve medewerkers tonen
            if (employeeData[employee]) {
                for (const [sprint, hours] of Object.entries(sprintData)) {
                    if (!employeeData[employee][sprint]) {
                        employeeData[employee][sprint] = {
                            available: 0,
                            planned: hours,
                            remaining: -hours
                        };
                    } else {
                        employeeData[employee][sprint].planned = hours;
                        employeeData[employee][sprint].remaining = employeeData[employee][sprint].available - hours;
                    }
                }
            }
        }
    }

    let html = '<table class="table table-striped table-bordered">';
    html += '<thead><tr class="table-dark text-dark"><th>Sprint</th><th>Medewerker</th><th>Beschikbare uren</th><th>Geplande uren</th><th>Geplande issues</th><th>Resterende tijd</th></tr></thead><tbody>';

    for (const sprint of availableSprintNames) {
        let sprintTotalAvailable = 0;
        let sprintTotalPlanned = 0;
        let sprintTotalRemaining = 0;
        let sprintTotalIssues = 0;

        // Alleen actieve medewerkers tonen
        for (const [employee, sprintData] of Object.entries(employeeData)) {
            const data = sprintData[sprint];
            if (data) {
                const plannedIssues = projectPlanning.plannedIssues.filter(pi => 
                    pi.sprint === sprint && 
                    getAssigneeName(pi.issue.fields?.assignee) === employee
                );
                
                sprintTotalAvailable += data.available;
                sprintTotalPlanned += data.planned;
                sprintTotalRemaining += data.remaining;
                sprintTotalIssues += plannedIssues.length;

                html += `
                    <tr>
                        <td>${sprint}</td>
                        <td>${employee}</td>
                        <td>${data.available.toFixed(1)}</td>
                        <td>${data.planned.toFixed(1)}</td>
                        <td>${plannedIssues.map(pi => `${pi.issue.key} (${pi.hours.toFixed(1)} uur)`).join('<br>')}</td>
                        <td>${data.remaining.toFixed(1)}</td>
                    </tr>
                `;
            }
        }

        // Voeg totaalregel toe voor de sprint
        html += `
            <tr class="table-dark">
                <td><strong>${sprint} Totaal</strong></td>
                <td></td>
                <td><strong>${sprintTotalAvailable.toFixed(1)}</strong></td>
                <td><strong>${sprintTotalPlanned.toFixed(1)}</strong></td>
                <td><strong>${sprintTotalIssues}</strong></td>
                <td><strong>${sprintTotalRemaining.toFixed(1)}</strong></td>
            </tr>
        `;
    }

    html += '</tbody></table>';
    return html;
}

function generateIssuesTable(issues: JiraIssue[], planning: PlanningResult, sprintNames: Map<string, string>): string {
    return `
        <div class="table-responsive">
            <table class="table table-striped table-bordered">
                <thead>
                    <tr class="table-dark text-dark">
                        <th>Issue</th>
                        <th>Samenvatting</th>
                        <th>Status</th>
                        <th>Prioriteit</th>
                        <th>Toegewezen aan</th>
                        <th>Uren</th>
                        <th>Sprint</th>
                        <th>Opvolgers</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortIssues(issues).map(issue => {
                        const successors = getSuccessors(issue);
                        const successorsHtml = successors.length > 0 
                            ? successors.map(key => `<a href="https://deventit.atlassian.net/browse/${key}" target="_blank" class="text-decoration-none">${key}</a>`).join(', ')
                            : 'Geen';
                        
                        const plannedIssue = planning.plannedIssues?.find(pi => pi.issue.key === issue.key);
                        const sprintName = plannedIssue ? sprintNames.get(plannedIssue.sprint) || plannedIssue.sprint : 'Niet gepland';
                        
                        // Markeer issues in sprint 10 als niet ingepland
                        const isPlanned = plannedIssue && plannedIssue.sprint !== '10';
                        
                        // Bereken uren met 1 decimaal
                        const hours = ((issue.fields?.timeestimate || 0) / 3600).toFixed(1);
                        
                        return `
                            <tr class="${isPlanned ? 'table-success' : ''}">
                                <td><a href="https://deventit.atlassian.net/browse/${issue.key}" target="_blank" class="text-decoration-none">${issue.key}</a></td>
                                <td>${issue.fields?.summary}</td>
                                <td>${issue.fields?.status?.name}</td>
                                <td>${issue.fields?.priority?.name || 'Lowest'}</td>
                                <td>${getAssigneeName(issue.fields?.assignee)}</td>
                                <td>${hours}</td>
                                <td>${sprintName}</td>
                                <td>${successorsHtml}</td>
                            </tr>
                        `;
                    }).join('')}
                    <tr class="table-dark">
                        <td colspan="5"><strong>Totaal</strong></td>
                        <td><strong>${((issues.reduce((sum, issue) => sum + (issue.fields?.timeestimate || 0), 0)) / 3600).toFixed(1)}</strong></td>
                        <td colspan="2"></td>
                    </tr>
                </tbody>
            </table>
        </div>
    `;
}

// Helper functie om beschikbare uren voor een specifieke medewerker op te halen
function getEmployeeAvailableHours(googleSheetsData: string[][] | null, employeeName: string): number {
    if (!googleSheetsData) return 0;
    
    const employeeRow = googleSheetsData.find(row => row[2] === employeeName);
    if (!employeeRow) return 0;
    
    const effectiveHours = parseFloat(employeeRow[6]) || 0;
    return effectiveHours * 2; // 2 weken per sprint
}

app.get('/api/worklogs', async (req: Request, res: Response) => {
    try {
        const { startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start- en einddatum zijn verplicht' });
        }

        // Haal worklog configuraties op
        const worklogConfigs = await getWorklogConfigsFromSheet();
        
        // Haal project configuraties op
        const projectConfigs = await getProjectConfigsFromSheet();
        
        // Haal alle worklogs op voor de opgegeven periode
        const workLogsByProject = new Map<string, WorkLog[]>();
        
        for (const config of projectConfigs) {
            try {
                const parsedStartDate = new Date(startDate.toString());
                const parsedEndDate = new Date(endDate.toString());
                
                const projectWorklogs = await getWorkLogsForProject(
                    config.projectCodes,
                    parsedStartDate,
                    parsedEndDate,
                    config
                );
                
                // Filter worklogs op basis van project codes
                const filteredWorklogs = projectWorklogs.filter(worklog => {
                    // Check of de issue key begint met een van de project codes
                    return config.projectCodes.some(code => worklog.issueKey.startsWith(code + '-'));
                });
                workLogsByProject.set(config.projectName, filteredWorklogs);
            } catch (error) {
                logger.error(`Error bij ophalen worklogs voor project ${config.projectName}: ${error}`);
                // Ga door met de volgende project configuratie
                continue;
            }
        }

        // Genereer HTML voor worklogs tabel
        let worklogsHtml = '';
        
        // Groepeer worklog configuraties per worklogName
        const worklogGroups = new Map<string, WorklogConfig[]>();
        worklogConfigs.forEach((config: WorklogConfig) => {
            // Normaliseer de worklogName om case-insensitive vergelijking mogelijk te maken
            const normalizedWorklogName = config.worklogName.toLowerCase().trim();
            if (!worklogGroups.has(normalizedWorklogName)) {
                worklogGroups.set(normalizedWorklogName, []);
            }
            worklogGroups.get(normalizedWorklogName)!.push(config);
        });

        // Genereer een tabel voor elke worklog groep
        let allWorklogs: WorkLog[] = [];
        let allIssues: JiraIssue[] = [];
        
        // Maak een map om de totale uren per medewerker en categorie bij te houden
        const totalHoursByEmployeeAndCategory = new Map<string, Map<string, number>>();
        
        worklogGroups.forEach((configs: WorklogConfig[], worklogName: string) => {
            // Zoek het project met deze worklogName
            const projectConfig = projectConfigs.find(config => {
                const normalizedConfigProjectName = config.projectName.toLowerCase().trim();
                const normalizedSearchProjectName = worklogName.toLowerCase().trim();
                
                // Speciale behandeling voor Subscriptions
                if (normalizedSearchProjectName === "subscriptions" && 
                    (normalizedConfigProjectName === "subscriptions" || 
                     normalizedConfigProjectName === "subscription")) {
                    return true;
                }
                
                return normalizedConfigProjectName === normalizedSearchProjectName;
            });
            
            if (!projectConfig) {
                logger.error(`Geen project configuratie gevonden voor projectName: ${worklogName}`);
                return;
            }
            
            // Verwijder dubbele projecten
            const uniqueProjectConfigs = projectConfigs.filter((config, index, self) => 
                index === self.findIndex(c => c.projectName.toLowerCase() === config.projectName.toLowerCase())
            );
            
            // Gebruik de worklogName uit de configuratie
            const projectWorklogs = workLogsByProject.get(projectConfig.projectName) || [];
            
            // Verzamel alle worklogs en issues voor de overkoepelende efficiency tabel
            allWorklogs = [...allWorklogs, ...projectWorklogs];
            
            // Verwerk worklogs voor dit project
            const uniqueEmployees = new Set<string>();
            
            projectWorklogs.forEach(worklog => {
                if (worklog.author && typeof worklog.author === 'object' && 'displayName' in worklog.author) {
                    uniqueEmployees.add(worklog.author.displayName);
                } else if (typeof worklog.author === 'string') {
                    uniqueEmployees.add(worklog.author);
                }
            });

            // Genereer de worklogs tabel
            let worklogsTable = `
                <table class="table table-striped">
                    <thead>
                        <tr>
                            <th>Medewerker</th>
                            ${configs.map(config => `<th>${config.columnName}</th>`).join('')}
                            <th>Totaal</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            // Groepeer worklogs per medewerker
            const employeeWorklogs = new Map<string, WorkLog[]>();
            projectWorklogs.forEach(log => {
                const authorName = typeof log.author === 'string' ? 
                    log.author : log.author?.displayName || 'Onbekend';
                
                if (!employeeWorklogs.has(authorName)) {
                    employeeWorklogs.set(authorName, []);
                }
                employeeWorklogs.get(authorName)!.push(log);
            });

            // Genereer rijen voor elke medewerker
            employeeWorklogs.forEach((logs, employee) => {
                // Parseer de start- en einddatum naar Date objecten
                const parsedStartDate = new Date(startDate.toString());
                const parsedEndDate = new Date(endDate.toString());

                // Controleer of de medewerker werklogs heeft in de opgegeven periode
                const heeftRelevanteWorklogs = logs.some(log => {
                    const logDate = new Date(log.started);
                    return logDate >= parsedStartDate && logDate <= parsedEndDate;
                });

                if (!heeftRelevanteWorklogs) {
                    return; // Sla medewerkers zonder relevante worklogs over
                }

                let totaal = 0;
                worklogsTable += `<tr><td>${employee}</td>`;

                // Bereken uren voor elke kolom
                configs.forEach((config, index) => {
                    let columnHours = 0;
                    
                    if (config.issues && config.issues.length > 0) {
                        // Tel eerst alle worklogs per issue bij elkaar op
                        const issueTotals = new Map<string, number>();
                        logs.forEach(log => {
                            const currentTotal = issueTotals.get(log.issueKey) || 0;
                            issueTotals.set(log.issueKey, currentTotal + log.timeSpentSeconds / 3600);
                            
                       });

                        // Tel alleen de worklogs van de specifieke issues
                        columnHours = Array.from(issueTotals.entries())
                            .filter(([issueKey]) => {
                                const isIncluded = config.issues.includes(issueKey);
                                return isIncluded;
                            })
                            .reduce((sum, [_, hours]) => sum + hours, 0);
                    } else {
                        // Voor de laatste kolom (meestal 'Ontwikkeling'), bereken het totaal van alle worklogs
                        // minus de uren die al in andere kolommen zijn verwerkt
                        
                        // Tel eerst alle worklogs per issue bij elkaar op
                        const issueTotals = new Map<string, number>();
                        logs.forEach(log => {
                            const currentTotal = issueTotals.get(log.issueKey) || 0;
                            issueTotals.set(log.issueKey, currentTotal + log.timeSpentSeconds / 3600);
                        });

                        // Bereken totaal van alle worklogs
                        const totalHours = Array.from(issueTotals.values()).reduce((sum, hours) => sum + hours, 0);

                        // Bereken hoeveel uren er al in eerdere kolommen zijn verwerkt
                        const processedHours = configs.slice(0, index).reduce((sum, prevConfig) => {
                            if (prevConfig.issues && prevConfig.issues.length > 0) {
                                const prevConfigHours = Array.from(issueTotals.entries())
                                    .filter(([issueKey]) => prevConfig.issues.includes(issueKey))
                                    .reduce((issueSum, [_, hours]) => issueSum + hours, 0);
                                return sum + prevConfigHours;
                            }
                            return sum;
                        }, 0);

                        // Bereken de resterende uren voor ontwikkeling
                        columnHours = totalHours - processedHours;
                    }

                    totaal += columnHours;
                    worklogsTable += `<td>${columnHours.toFixed(1)}</td>`;
                    
                    // Voeg de uren toe aan de totale uren per medewerker en categorie
                    if (!totalHoursByEmployeeAndCategory.has(employee)) {
                        totalHoursByEmployeeAndCategory.set(employee, new Map<string, number>());
                    }
                    const employeeCategories = totalHoursByEmployeeAndCategory.get(employee)!;
                    const currentHours = employeeCategories.get(config.columnName) || 0;
                    employeeCategories.set(config.columnName, currentHours + columnHours);
                });

                // Voeg totaal toe
                worklogsTable += `<td>${totaal.toFixed(1)}</td></tr>`;
            });

            // Bereken totaal per kolom
            const columnTotals = new Array(configs.length).fill(0);
            employeeWorklogs.forEach((logs) => {
                configs.forEach((config, index) => {
                    let columnHours = 0;
                    
                    if (config.issues && config.issues.length > 0) {
                        // Tel alleen de worklogs van de specifieke issues
                        columnHours = logs
                            .filter(log => config.issues.includes(log.issueKey))
                            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                    } else {
                        // Voor de laatste kolom (meestal 'Ontwikkeling'), bereken het totaal van alle worklogs
                        // minus de uren die al in andere kolommen zijn verwerkt
                        const totalHours = logs.reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
                        const processedHours = configs.slice(0, index).reduce((sum, prevConfig) => {
                            if (prevConfig.issues && prevConfig.issues.length > 0) {
                                return sum + logs
                                    .filter(log => prevConfig.issues.includes(log.issueKey))
                                    .reduce((logSum, log) => logSum + log.timeSpentSeconds / 3600, 0);
                            }
                            return sum;
                        }, 0);
                        columnHours = totalHours - processedHours;
                    }

                    columnTotals[index] += columnHours;
                });
            });

            // Bereken totaal van alle kolommen
            const grandTotal = columnTotals.reduce((sum, total) => sum + total, 0);

            // Voeg totaalregel toe
            worklogsTable += `
                <tr class="table-dark">
                    <td><strong>Totaal</strong></td>
                    ${columnTotals.map(total => `<td><strong>${total.toFixed(1)}</strong></td>`).join('')}
                    <td><strong>${grandTotal.toFixed(1)}</strong></td>
                </tr>
            `;

            worklogsTable += '</tbody></table>';

            // Voeg de worklogs tabel toe aan de HTML
            worklogsHtml += `
                <div class="row">
                    <div class="col-md-12">
                        <h4>Worklogs ${projectConfig.projectName}</h4>
                        ${worklogsTable}
                    </div>
                </div>
            `;
        });
        
        // Bereken efficiency over alle projecten
        const efficiencyData = await calculateEfficiency([], allWorklogs, new Date(startDate as string), new Date(endDate as string));
        
        // Genereer de overkoepelende efficiency tabel
        let efficiencyTable = `
            <div class="row">
                <div class="col-md-12">
                    <h4>Efficiëntie Overzicht</h4>
                    <table class="table table-striped">
                        <thead>
                            <tr>
                                <th>Medewerker</th>
                                <th>Geschatte uren</th>
                                <th>Gelogde uren</th>
                                <th>Efficiëntie</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        efficiencyData.forEach(data => {
            const issueKeysText = data.issueKeys && data.issueKeys.length > 0
                ? `${data.estimatedHours} (${data.issueKeys.join(', ')})`
                : data.estimatedHours;

            const issueDetailsText = data.issueDetails && data.issueDetails.length > 0
                ? data.issueDetails.map(detail => 
                    `${detail.key}: ${detail.estimatedHours} uur geschat, ${detail.loggedHours} uur gelogd`
                  ).join('<br>')
                : '';

            efficiencyTable += `
                <tr>
                    <td>${data.assignee}</td>
                    <td>${issueKeysText}</td>
                    <td>${data.loggedHours}</td>
                    <td>${data.efficiency}%</td>
                </tr>
                ${issueDetailsText ? `
                <tr>
                    <td colspan="4" style="padding-left: 20px; font-size: 0.9em; color: #666;">
                        ${issueDetailsText}
                    </td>
                </tr>
                ` : ''}
            `;
        });

        // Bereken totalen voor de efficiency tabel
        const totalEstimated = efficiencyData.reduce((sum, data) => sum + data.estimatedHours, 0);
        const totalLogged = efficiencyData.reduce((sum, data) => sum + data.loggedHours, 0);
        const totalEfficiency = totalEstimated > 0 ? (totalLogged / totalEstimated) * 100 : 0;

        // Voeg totaalregel toe
        efficiencyTable += `
            <tr class="table-dark">
                <td><strong>Totaal</strong></td>
                <td><strong>${totalEstimated.toFixed(1)}</strong></td>
                <td><strong>${totalLogged.toFixed(1)}</strong></td>
                <td><strong>${totalEfficiency.toFixed(1)}%</strong></td>
            </tr>
        `;

        efficiencyTable += '</tbody></table></div></div>';

        // Voeg de efficiency tabel toe aan de HTML
        worklogsHtml += efficiencyTable;

        // Genereer de Worklogs totaal tabel op basis van de verzamelde data
        worklogsHtml += generateTotalWorklogsTableFromData(totalHoursByEmployeeAndCategory);

        // Stuur de HTML response
        res.send(worklogsHtml);
    } catch (error) {
        logger.error(`Error bij ophalen van worklogs: ${error}`);
        res.status(500).json({ error: 'Er is een fout opgetreden bij het ophalen van de worklogs' });
    }
});

// Functie om de Worklogs totaal tabel te genereren op basis van de verzamelde data
function generateTotalWorklogsTableFromData(totalHoursByEmployeeAndCategory: Map<string, Map<string, number>>): string {
    // Bepaal de categorieën (kolommen) voor de tabel
    const categories = new Set<string>();
    totalHoursByEmployeeAndCategory.forEach(employeeCategories => {
        employeeCategories.forEach((_, category) => {
            categories.add(category);
        });
    });
    
    // Converteer de Set naar een Array en sorteer deze
    const sortedCategories = Array.from(categories).sort();
    
    let html = `
        <div class="row">
            <div class="col-md-12">
                <h4>Worklogs Totaal</h4>
                <table class="table table-striped">
                    <thead>
                        <tr>
                            <th>Medewerker</th>
                            ${sortedCategories.map(category => `<th>${category}</th>`).join('')}
                            <th>Totaal</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    // Bereken totalen per categorie
    const categoryTotals = new Map<string, number>();
    sortedCategories.forEach(category => {
        categoryTotals.set(category, 0);
    });
    
    // Genereer rijen voor elke medewerker
    totalHoursByEmployeeAndCategory.forEach((employeeCategories, employee) => {
        let employeeTotal = 0;
        html += `<tr><td>${employee}</td>`;
        
        sortedCategories.forEach(category => {
            const hours = employeeCategories.get(category) || 0;
            employeeTotal += hours;
            categoryTotals.set(category, (categoryTotals.get(category) || 0) + hours);
            html += `<td>${hours.toFixed(1)}</td>`;
        });
        
        html += `<td>${employeeTotal.toFixed(1)}</td></tr>`;
    });
    
    // Bereken totaal van alle categorieën
    const grandTotal = Array.from(categoryTotals.values()).reduce((sum, total) => sum + total, 0);
    
    // Voeg totaalregel toe
    html += `
        <tr class="table-dark">
            <td><strong>Totaal</strong></td>
            ${sortedCategories.map(category => `<td><strong>${categoryTotals.get(category)?.toFixed(1) || '0.0'}</strong></td>`).join('')}
            <td><strong>${grandTotal.toFixed(1)}</strong></td>
        </tr>
    `;
    
    html += '</tbody></table></div></div>';
    return html;
}

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(`Server error: ${err}`);
    res.status(500).send(`
        <div class="alert alert-danger">
            Er is een interne serverfout opgetreden: ${err.message || err}
        </div>
    `);
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled Rejection:', reason);
    if (reason instanceof Error) {
        console.error('Stack trace:', reason.stack);
    }
});

// Uncaught exception handler
process.on('uncaughtException', (error: Error) => {
    console.error('Unhandled Exception:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
});

// Start de server in een try-catch block
try {
    app.listen(port, () => {
        console.log(`Server draait op poort ${port}`);
    }).on('error', (error) => {
        console.error(`Error bij starten van server: ${error}`);
        process.exit(1);
    });
} catch (error) {
    console.error(`Error bij starten van server: ${error}`);
    process.exit(1);
}

// Styles voor de pagina
const styles = `
    body { 
        font-family: Arial, sans-serif; 
        margin: 0;
        padding: 0;
        background-color: #f5f5f5;
    }
    .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 20px;
        background-color: white;
        box-shadow: 0 0 10px rgba(0,0,0,0.1);
        border-radius: 5px;
    }
    h1, h2, h3 {
        color: #333;
        margin-top: 20px;
        margin-bottom: 15px;
        border-bottom: 1px solid #ddd;
        padding-bottom: 10px;
    }
    table { 
        border-collapse: collapse; 
        width: 100%; 
        margin-bottom: 30px; 
        background-color: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    th, td { 
        border: 1px solid #ddd; 
        padding: 12px 15px; 
        text-align: left; 
    }
    th { 
        background-color: #f2f2f2; 
        font-weight: bold;
        color: #333;
    }
    tr:nth-child(even) {
        background-color: #f9f9f9;
    }
    tr:hover {
        background-color: #f1f1f1;
    }
    .table-dark {
        background-color: #f2f2f2;
        font-weight: bold;
        color: #333;
    }
    .table-dark th {
        color: #333;
    }
    .table-info {
        background-color: #e6f7ff;
    }
    .card { 
        margin-bottom: 30px; 
        border: 1px solid #ddd;
        border-radius: 5px;
        overflow: hidden;
    }
    .card-header { 
        background-color: #f8f9fa; 
        padding: 15px 20px;
        border-bottom: 1px solid #ddd;
    }
    .card-body { 
        padding: 20px; 
    }
    .row {
        display: flex;
        flex-wrap: wrap;
        margin-right: -15px;
        margin-left: -15px;
    }
    .col-12 {
        flex: 0 0 100%;
        max-width: 100%;
        padding: 0 15px;
    }
    .col-md-6 {
        flex: 0 0 50%;
        max-width: 50%;
        padding: 0 15px;
    }
    .col-md-4 {
        flex: 0 0 33.333333%;
        max-width: 33.333333%;
        padding: 0 15px;
    }
    @media (max-width: 768px) {
        .col-md-6, .col-md-4 {
            flex: 0 0 100%;
            max-width: 100%;
        }
    }
    .mt-4 {
        margin-top: 1.5rem;
    }
    .form-label { 
        margin-bottom: 5px; 
        font-weight: bold;
    }
    .form-control { 
        margin-bottom: 15px; 
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        width: 100%;
    }
    .btn-primary { 
        margin-top: 24px; 
        background-color: #007bff;
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 4px;
        cursor: pointer;
    }
    .btn-primary:hover {
        background-color: #0069d9;
    }
    .alert { 
        margin-bottom: 15px; 
        padding: 15px;
        border-radius: 4px;
    }
    .alert-danger {
        background-color: #f8d7da;
        color: #721c24;
        border: 1px solid #f5c6cb;
    }
    .alert-info {
        background-color: #d1ecf1;
        color: #0c5460;
        border: 1px solid #bee5eb;
    }
    .date-input { 
        width: 100%; 
        padding: 8px 12px; 
        border: 1px solid #ddd; 
        border-radius: 4px; 
    }
    .worklogs-form { 
        margin-bottom: 20px; 
        background-color: #f9f9f9;
        padding: 20px;
        border-radius: 5px;
    }
    .worklogs-form .row {
        display: flex;
        flex-wrap: wrap;
        margin-right: -15px;
        margin-left: -15px;
    }
    .worklogs-form .col-md-4 {
        flex: 0 0 33.333333%;
        max-width: 33.333333%;
        padding: 0 15px;
        margin-bottom: 15px;
    }
    .worklogs-form .form-label { 
        margin-bottom: 5px; 
        font-weight: bold;
        display: block;
    }
    .worklogs-form .form-control { 
        margin-bottom: 15px; 
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        width: 100%;
        box-sizing: border-box;
    }
    .worklogs-form .btn-primary { 
        margin-top: 0; 
        background-color: #007bff;
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 4px;
        cursor: pointer;
        width: 100%;
        height: 38px;
    }
    .worklogs-form .btn-primary:hover {
        background-color: #0069d9;
    }
    a {
        color: #007bff;
        text-decoration: none;
    }
    a:hover {
        text-decoration: underline;
    }
    .nav-tabs {
        display: flex;
        border-bottom: 1px solid #ddd;
        margin-bottom: 20px;
    }
    .nav-tabs .nav-item {
        margin-bottom: -1px;
    }
    .nav-tabs .nav-link {
        display: block;
        padding: 10px 15px;
        border: 1px solid transparent;
        border-top-left-radius: 4px;
        border-top-right-radius: 4px;
        color: #495057;
        background-color: #f8f9fa;
        margin-right: 5px;
    }
    .nav-tabs .nav-link.active {
        color: #495057;
        background-color: #fff;
        border-color: #ddd #ddd #fff;
        font-weight: bold;
    }
    .tab-content {
        padding: 20px 0;
    }
    .tab-pane {
        display: none;
    }
    .tab-pane.active {
        display: block;
    }
    .navbar {
        background-color: #333;
        padding: 15px 20px;
        margin-bottom: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        position: sticky;
        top: 0;
        z-index: 1000;
    }
    .navbar-brand {
        color: white;
        font-size: 1.5rem;
        font-weight: bold;
        text-decoration: none;
        padding: 10px 0;
    }
    .navbar-nav {
        display: flex;
        list-style: none;
        margin: 0;
        padding: 0;
        gap: 20px;
    }
    .nav-item {
        margin: 0;
    }
    .nav-link {
        color: #ddd;
        text-decoration: none;
        padding: 8px 16px;
        border-radius: 4px;
        transition: all 0.3s ease;
    }
    .nav-link:hover {
        color: white;
        background-color: rgba(255,255,255,0.1);
    }
    .nav-link.active {
        color: white;
        background-color: rgba(255,255,255,0.2);
        font-weight: bold;
    }
    .container-fluid {
        padding: 20px;
        margin-top: 20px;
    }
`;

function generatePlanningTable(planning: PlanningResult, sprintNames: Map<string, string>): string {
    const sprintNamesArray = Array.from(sprintNames.values()).sort((a, b) => {
        const numA = parseInt(a.replace('Sprint ', ''));
        const numB = parseInt(b.replace('Sprint ', ''));
        return numA - numB;
    });

    let table = '<table class="table table-bordered table-hover">';
    table += '<thead><tr><th>Sprint</th><th>Capaciteit</th><th>Gebruikte uren</th><th>Beschikbare uren</th><th>Geplande issues</th></tr></thead><tbody>';

    // Groepeer issues per sprint
    const sprintData = new Map<string, {
        capacity: number,
        usedHours: number,
        plannedIssues: PlannedIssue[]
    }>();

    sprintNamesArray.forEach(sprint => {
        sprintData.set(sprint, {
            capacity: 0,
            usedHours: 0,
            plannedIssues: []
        });
    });

    // Verwerk alle issues per sprint
    planning.plannedIssues.forEach(issue => {
        const sprintInfo = sprintData.get(issue.sprint);
        if (sprintInfo) {
            sprintInfo.plannedIssues.push(issue);
            sprintInfo.usedHours += issue.hours;
        }
    });

    // Verwerk capaciteit per sprint
    planning.sprintCapacity.forEach(capacity => {
        const sprintInfo = sprintData.get(capacity.sprint);
        if (sprintInfo) {
            sprintInfo.capacity += capacity.capacity;
        }
    });

    // Genereer rijen voor elke sprint
    sprintNamesArray.forEach(sprint => {
        const sprintInfo = sprintData.get(sprint);
        if (!sprintInfo) return;

        const availableHours = sprintInfo.capacity - sprintInfo.usedHours;
        const plannedIssuesCount = sprintInfo.plannedIssues.length;

        table += `<tr>
            <td>${sprint}</td>
            <td>${sprintInfo.capacity.toFixed(1)}</td>
            <td>${sprintInfo.usedHours.toFixed(1)}</td>
            <td>${availableHours.toFixed(1)}</td>
            <td>${plannedIssuesCount}</td>
        </tr>`;
    });

    table += '</tbody></table>';
    return table;
}

app.get('/planning', async (req, res) => {
    try {
        const projectType = req.query.project as string;
        if (!projectType) {
            return res.status(400).send('Project type is verplicht');
        }

        const projectConfigs = await getProjectConfigsFromSheet();
        const projectConfig = projectConfigs.find(config => config.projectName === projectType);
        if (!projectConfig) {
            return res.status(404).send('Project configuratie niet gevonden');
        }

        // Haal Google Sheets data op
        let googleSheetsData;
        try {
            googleSheetsData = await getGoogleSheetsData('Employees!A1:H');
        } catch (error) {
            console.error('Error bij ophalen van Google Sheets data:', error);
            throw error;
        }

        const issues = await getIssues(projectConfig.jqlFilter);
        const planning = await calculatePlanning(issues, projectType, googleSheetsData);
        const sprintNames = await getSprintNamesFromSheet(googleSheetsData);

        let html = `
            <!DOCTYPE html>
            <html lang="nl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Planning Overzicht - ${projectType}</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
                <style>
                    ${styles}
                    .table { font-size: 0.9rem; }
                    .table th { background-color: #f8f9fa; }
                    .table-success { background-color: #d4edda !important; }
                    .table-warning { background-color: #fff3cd !important; }
                    .table-danger { background-color: #f8d7da !important; }
                    .btn-group { margin-bottom: 20px; }
                    .navbar { margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="navbar-brand">Planning Dashboard</a>
                    <ul class="navbar-nav">
                        <li class="nav-item">
                            <a href="/" class="nav-link">Projecten</a>
                        </li>
                        <li class="nav-item">
                            <a href="/worklogs" class="nav-link">Worklogs & Efficiëntie</a>
                        </li>
                        <li class="nav-item">
                            <a href="/planning?project=${projectType}" class="nav-link active">Planning</a>
                        </li>
                    </ul>
                </nav>
                <div class="container-fluid">
                    ${generatePlanningTable(planning, sprintNames)}
                </div>
                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
            </body>
            </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('Error in /planning route:', error);
        res.status(500).send('Er is een fout opgetreden bij het ophalen van de planning');
    }
});

async function getSprintNamesFromSheet(googleSheetsData: (string | null)[][] | null): Promise<Map<string, string>> {
    const sprintNames = new Map<string, string>();
    
    if (!googleSheetsData) {
        return sprintNames;
    }

    // Zoek de kolom met sprint namen
    const headerRow = googleSheetsData[0];
    const sprintNameColIndex = headerRow.findIndex(header => header === 'Sprint');
    
    if (sprintNameColIndex === -1) {
        return sprintNames;
    }

    // Vul de map met sprint nummers en namen
    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        const sprintNumber = row[0];
        const sprintName = row[sprintNameColIndex];
        
        if (sprintNumber && sprintName) {
            sprintNames.set(sprintNumber.toString(), sprintName.toString());
        }
    }

    return sprintNames;
}

function generateTotalWorklogsTable(worklogs: WorkLog[]): string {
    // Groepeer worklogs per medewerker
    const worklogsByEmployee = new Map<string, WorkLog[]>();
    worklogs.forEach(log => {
        const employeeName = typeof log.author === 'string' ? 
            log.author : 
            (log.author && typeof log.author === 'object' && 'displayName' in log.author ? 
                log.author.displayName : 
                'Onbekend');
        
        if (!worklogsByEmployee.has(employeeName)) {
            worklogsByEmployee.set(employeeName, []);
        }
        worklogsByEmployee.get(employeeName)?.push(log);
    });

    let html = `
        <div class="row">
            <div class="col-md-12">
                <h4>Worklogs Totaal</h4>
                <table class="table table-striped">
                    <thead>
                        <tr>
                            <th>Medewerker</th>
                            <th>Niet gewerkt</th>
                            <th>Overige niet-declarabel</th>
                            <th>Productontwikkeling</th>
                            <th>Totaal</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    let totalNotWorked = 0;
    let totalNonBillable = 0;
    let totalProductDev = 0;

    worklogsByEmployee.forEach((logs, employee) => {
        // Bereken de uren per categorie op basis van de issues
        const notWorked = logs
            .filter(log => {
                // Filter op basis van de issue key of andere eigenschappen
                // Hier moeten we de juiste logica toevoegen om te bepalen welke issues bij "Niet gewerkt" horen
                return false; // Placeholder - vervang dit met de juiste logica
            })
            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
        
        const nonBillable = logs
            .filter(log => {
                // Filter op basis van de issue key of andere eigenschappen
                // Hier moeten we de juiste logica toevoegen om te bepalen welke issues bij "Overige niet-declarabel" horen
                return false; // Placeholder - vervang dit met de juiste logica
            })
            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
        
        const productDev = logs
            .filter(log => {
                // Filter op basis van de issue key of andere eigenschappen
                // Hier moeten we de juiste logica toevoegen om te bepalen welke issues bij "Productontwikkeling" horen
                return false; // Placeholder - vervang dit met de juiste logica
            })
            .reduce((sum, log) => sum + log.timeSpentSeconds / 3600, 0);
        
        const total = notWorked + nonBillable + productDev;

        totalNotWorked += notWorked;
        totalNonBillable += nonBillable;
        totalProductDev += productDev;

        html += `
            <tr>
                <td>${employee}</td>
                <td>${notWorked.toFixed(1)}</td>
                <td>${nonBillable.toFixed(1)}</td>
                <td>${productDev.toFixed(1)}</td>
                <td>${total.toFixed(1)}</td>
            </tr>
        `;
    });

    // Voeg totaalregel toe
    const grandTotal = totalNotWorked + totalNonBillable + totalProductDev;
    html += `
        <tr class="table-dark">
            <td><strong>Totaal</strong></td>
            <td><strong>${totalNotWorked.toFixed(1)}</strong></td>
            <td><strong>${totalNonBillable.toFixed(1)}</strong></td>
            <td><strong>${totalProductDev.toFixed(1)}</strong></td>
            <td><strong>${grandTotal.toFixed(1)}</strong></td>
        </tr>
    `;

    html += '</tbody></table></div></div>';
    return html;
}

interface Project {
  key: string;
  name: string;
}

const projects: Project[] = [
  { key: 'PVD', name: 'Planning PvD' },
  { key: 'PVDDEV', name: 'Planning PvD Development' }
];

async function loadWorklogs() {
  try {
    const employees = await getGoogleSheetsData('Employees!A1:H');
    const projectEmployees = employees.map((row: string[]) => row[0]); // Eerste kolom bevat de medewerkersnamen

    // Haal worklogs op voor alle projecten
    const worklogs = await Promise.all(
      projects.map(async (project: Project) => {
        const projectWorklogs = await getWorkLogsForProject(
          [project.key],
          new Date(),
          new Date(),
          { projectName: project.name, projectCodes: [project.key], jqlFilter: '', worklogName: '', worklogJql: '' }
        );
        return {
          project,
          worklogs: projectWorklogs
        };
      })
    );

    return {
      worklogs,
      projectEmployees
    };
  } catch (error) {
    console.error('Error loading worklogs:', error);
    return {
      worklogs: [],
      projectEmployees: []
    };
  }
}

// Helper functie om de displayName van een assignee te krijgen
function getAssigneeName(assignee: { displayName: string; } | string | undefined): string {
    if (!assignee) return 'Unassigned';
    if (typeof assignee === 'string') return assignee;
    return assignee.displayName;
}