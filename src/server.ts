import express from 'express';
import type { Request, Response, RequestHandler, NextFunction } from 'express';
import type { Issue as JiraIssue, IssueLink, EfficiencyData, ProjectConfig, WorklogConfig, WorkLog, Sprint } from './types.js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { logger } from './logger.js';
import { getActiveIssues, getWorkLogs, getPlanning, jiraClient, getIssuesForProject, getWorkLogsForProject, getIssues } from './jira.js';
import cors from 'cors';
import type { WorkLogsResponse } from './types.js';
import { JIRA_DOMAIN } from './config.js';
import axios from 'axios';
import { getProjectConfigsFromSheet, getWorklogConfigsFromSheet } from './google-sheets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Laad .env.local bestand
config({ path: join(__dirname, '../.env.local') });

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

async function getGoogleSheetsData(): Promise<string[][] | null> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Employees!A:H'
        });
        return response.data.values as string[][];
    } catch (error) {
        return null;
    }
}

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
            issue.fields?.assignee?.displayName === employeeName
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
                    return log.issueKey === issueKey && 
                           logDate >= startDate && 
                           logDate <= endDate;
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
                                    <input type="date" class="form-control" id="startDate" name="startDate" value="2025-03-03">
                                </div>
                                <div class="col-md-4">
                                    <label for="endDate" class="form-label">Einddatum</label>
                                    <input type="date" class="form-control" id="endDate" name="endDate" value="2025-03-30">
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
                // Laad worklogs automatisch bij het laden van de pagina
                window.onload = function() {
                    loadWorklogs();
                };

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
                const issues = await getIssuesForProject(config.projectCodes, config.jqlFilter);
                projectIssues.set(config.projectName, issues);
            } catch (error) {
                console.error(`Error bij ophalen issues voor project ${config.projectName}:`, error);
                projectIssues.set(config.projectName, []);
            }
        }

        // Haal Google Sheets data op
        let googleSheetsData;
        try {
            googleSheetsData = await getGoogleSheetsData();
        } catch (error) {
            console.error('Error bij ophalen van Google Sheets data:', error);
            throw error;
        }

        // Haal sprint namen op voor alle issues
        const sprintNames = new Map<string, string>();
        for (const issues of projectIssues.values()) {
            for (const issue of issues) {
                if (issue.fields?.customfield_10020 && issue.fields.customfield_10020.length > 0) {
                    try {
                        sprintNames.set(issue.key, await getSprintName(issue.fields.customfield_10020[0]));
                    } catch (error) {
                        console.error(`Error bij ophalen sprint naam voor issue ${issue.key}:`, error);
                    }
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
    const predecessorLinks = issue.fields.issuelinks.filter(link => link.type.name === 'is a predecessor of');
    
    // Als er voorgangers zijn, log deze informatie
    if (predecessorLinks.length > 0) {
        console.log(`Issue ${issue.key} heeft ${predecessorLinks.length} voorganger(s):`);
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
            const isSuccessor = link.type.name === 'Predecessor' && 
                              link.type.inward === 'is a predecessor of';
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
    return [...issues].sort((a, b) => {
        // Eerst sorteren op status
        const statusA = a.fields?.status?.name || '';
        const statusB = b.fields?.status?.name || '';
        
        if (statusA !== statusB) {
            // Status volgorde: Resolved, "In Review", Open, Reopend, Registered, Waiting
            const statusOrder = {
                'Resolved': 0,
                'In Review': 1,
                'Open': 2,
                'Reopend': 3,
                'Reopened': 3,
                'Registered': 4,
                'Waiting': 5
            };
            const orderA = statusOrder[statusA as keyof typeof statusOrder] ?? 999;
            const orderB = statusOrder[statusB as keyof typeof statusOrder] ?? 999;
            return orderA - orderB;
        }
        
        // Als status gelijk is, sorteer op prioriteit
        const priorityA = a.fields?.priority?.name || 'Lowest';
        const priorityB = b.fields?.priority?.name || 'Lowest';
        
        if (priorityA !== priorityB) {
            // Prioriteit volgorde: Highest, High, Medium, Low, Lowest
            const priorityOrder = {
                'Highest': 0,
                'High': 1,
                'Medium': 2,
                'Low': 3,
                'Lowest': 4
            };
            return priorityOrder[priorityA as keyof typeof priorityOrder] - priorityOrder[priorityB as keyof typeof priorityOrder];
        }
        
        // Als status en prioriteit gelijk zijn, sorteer op creatiedatum
        const createdA = new Date(a.fields?.created || 0).getTime();
        const createdB = new Date(b.fields?.created || 0).getTime();
        return createdA - createdB;
    });
}

interface SprintCapacity {
    employee: string;
    sprint: string;
    capacity: number;
    project: string;
}

interface Worklog {
    timeSpentSeconds: number;
    started: string;
    author: {
        displayName: string;
    };
}

interface PlanningResult {
    sprintCapacity: SprintCapacity[];
    employeeSprintUsedHours: {
        employee: string;
        sprintHours: {
            sprint: string;
            hours: number;
            issues: { key: string; hours: number }[];
        }[];
    }[];
    plannedIssues: {
        issue: JiraIssue;
        sprint: string;
        hours: number;
    }[];
}

async function getSprintCapacityFromSheet(googleSheetsData: (string | null)[][]): Promise<SprintCapacity[]> {
    if (!googleSheetsData) {
        console.log('Geen Google Sheets data beschikbaar');
        return [];
    }

    const sprintCapacities: SprintCapacity[] = [];
    const headerRow = googleSheetsData[0];
    const nameIndex = headerRow.indexOf('Naam');
    const effectiveHoursIndex = headerRow.indexOf('Effectieve uren');
    const projectIndex = headerRow.indexOf('Project');

    if (nameIndex === -1 || effectiveHoursIndex === -1 || projectIndex === -1) {
        console.log('Verplichte kolommen niet gevonden in Google Sheets data');
        return [];
    }

    for (let i = 1; i < googleSheetsData.length; i++) {
        const row = googleSheetsData[i];
        const employeeName = row[nameIndex];
        const effectiveHours = parseFloat(row[effectiveHoursIndex] || '0');
        const projects = (row[projectIndex] || '').split(',').map(p => p.trim());

        if (employeeName && !isNaN(effectiveHours)) {
            for (let sprintNumber = 1; sprintNumber <= 5; sprintNumber++) {
                // Als er geen specifieke projecten zijn opgegeven, maak een algemene capaciteit
                if (projects.length === 0 || projects[0] === '') {
                    sprintCapacities.push({
                        employee: employeeName,
                        sprint: sprintNumber.toString(),
                        capacity: effectiveHours * 2, // 2 weken per sprint
                        project: ''
                    });
                } else {
                    // Maak een capaciteit voor elk opgegeven project
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
    }

    console.log('Gevonden sprint capaciteiten:', sprintCapacities);
    return sprintCapacities;
}

async function calculatePlanning(issues: JiraIssue[], projectType: string, googleSheetsData: (string | null)[][] | null): Promise<PlanningResult> {
    const sprintCapacities = await getSprintCapacityFromSheet(googleSheetsData || []);
    const plannedIssues = new Map<string, { sprint: string; hours: number; key: string }[]>();
    const sprintUsedHours = new Map<string, Map<string, number>>();

    // Filter issues op basis van project type en status
    const filteredIssues = issues.filter(issue => {
        const status = issue.fields?.status?.name;
        return status && status !== 'Done';
    });

    // Sorteer issues op basis van status, prioriteit en created date
    const sortedIssues = filteredIssues.sort((a, b) => {
        // Eerst sorteren op status
        const statusA = a.fields?.status?.name || '';
        const statusB = b.fields?.status?.name || '';
        
        if (statusA !== statusB) {
            // Status volgorde: Resolved, "In Review", Open, Reopend, Registered, Waiting
            const statusOrder = {
                'Resolved': 0,
                'In Review': 1,
                'Open': 2,
                'Reopend': 3,
                'Reopened': 3,
                'Registered': 4,
                'Waiting': 5
            };
            const orderA = statusOrder[statusA as keyof typeof statusOrder] ?? 999;
            const orderB = statusOrder[statusB as keyof typeof statusOrder] ?? 999;
            return orderA - orderB;
        }
        
        // Als status gelijk is, sorteer op prioriteit
        const priorityA = a.fields?.priority?.name || 'Lowest';
        const priorityB = b.fields?.priority?.name || 'Lowest';
        
        if (priorityA !== priorityB) {
            // Prioriteit volgorde: Highest, High, Medium, Low, Lowest
            const priorityOrder = {
                'Highest': 0,
                'High': 1,
                'Medium': 2,
                'Low': 3,
                'Lowest': 4
            };
            return priorityOrder[priorityA as keyof typeof priorityOrder] - priorityOrder[priorityB as keyof typeof priorityOrder];
        }
        
        // Als status en prioriteit gelijk zijn, sorteer op creatiedatum
        const createdA = new Date(a.fields?.created || 0).getTime();
        const createdB = new Date(b.fields?.created || 0).getTime();
        return createdA - createdB;
    });

    // Plan eerst alle issues van andere medewerkers
    for (const issue of sortedIssues) {
        const assignee = issue.fields?.assignee?.displayName;
        if (!assignee || assignee === 'Peter van Diermen') continue;

        const issueKey = issue.key;
        const issueHours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
        let issuePlanned = false;

        // Plan het issue in de eerste sprint met voldoende capaciteit
        for (let sprintNumber = 1; sprintNumber <= 5; sprintNumber++) {
            const sprintName = sprintNumber.toString();
            
            // Zoek de capaciteit voor deze medewerker in deze sprint voor dit project
            const sprintCapacity = sprintCapacities.find(
                cap => cap.sprint === sprintName && 
                      cap.employee === assignee && 
                      (cap.project === projectType || cap.project === '')
            );
            
            if (!sprintCapacity) continue;
            
            const employeeCapacity = sprintCapacity.capacity;

            // Bereken de gebruikte uren voor deze sprint
            if (!sprintUsedHours.has(sprintName)) {
                sprintUsedHours.set(sprintName, new Map<string, number>());
            }
            const sprintHours = sprintUsedHours.get(sprintName)!;
            const usedHours = sprintHours.get(assignee) || 0;

            // Check of er genoeg capaciteit is
            if (usedHours + issueHours <= employeeCapacity) {
                // Plan het issue
                if (!plannedIssues.has(assignee)) {
                    plannedIssues.set(assignee, []);
                }
                plannedIssues.get(assignee)!.push({ sprint: sprintName, hours: issueHours, key: issueKey });
                sprintHours.set(assignee, usedHours + issueHours);

                console.log(`Issue ${issueKey} succesvol gepland voor ${assignee} in sprint ${sprintName} met ${issueHours} uur`);
                issuePlanned = true;
                break;
            }
        }

        // Als het issue niet gepland kon worden, plaats het in sprint 10
        if (!issuePlanned) {
            const sprintName = '10';
            if (!sprintUsedHours.has(sprintName)) {
                sprintUsedHours.set(sprintName, new Map<string, number>());
            }
            const sprintHours = sprintUsedHours.get(sprintName)!;
            const usedHours = sprintHours.get(assignee) || 0;

            if (!plannedIssues.has(assignee)) {
                plannedIssues.set(assignee, []);
            }
            plannedIssues.get(assignee)!.push({ sprint: sprintName, hours: issueHours, key: issueKey });
            sprintHours.set(assignee, usedHours + issueHours);

            console.log(`Issue ${issueKey} geplaatst in sprint 10 voor ${assignee} met ${issueHours} uur`);
        }
    }

    // Bereken beschikbare capaciteit per sprint voor Peter van Diermen
    const peterSprintCapacities = new Map<string, number>();
    for (let sprintNumber = 1; sprintNumber <= 5; sprintNumber++) {
        const sprintName = sprintNumber.toString();
        const sprintCapacity = sprintCapacities.find(
            cap => cap.sprint === sprintName && 
                  cap.employee === 'Peter van Diermen' && 
                  (cap.project === projectType || cap.project === '')
        );
        
        if (sprintCapacity) {
            // Bereken totale capaciteit van de sprint
            const totalSprintCapacity = sprintCapacities
                .filter(cap => cap.sprint === sprintName && 
                             (cap.project === projectType || cap.project === ''))
                .reduce((sum, cap) => sum + cap.capacity, 0);

            // Bereken gebruikte capaciteit in de sprint
            const usedCapacity = sprintUsedHours.has(sprintName) 
                ? Array.from(sprintUsedHours.get(sprintName)!.values())
                    .reduce((sum, hours) => sum + hours, 0)
                : 0;

            // Beschikbare capaciteit is het verschil
            const availableCapacity = totalSprintCapacity - usedCapacity;
            peterSprintCapacities.set(sprintName, availableCapacity);
            
            console.log(`Sprint ${sprintName} - Totale capaciteit: ${totalSprintCapacity}, Gebruikt: ${usedCapacity}, Beschikbaar voor Peter: ${availableCapacity}`);
        }
    }

    // Plan nu de issues van Peter van Diermen
    for (const issue of sortedIssues) {
        const assignee = issue.fields?.assignee?.displayName;
        if (!assignee || assignee !== 'Peter van Diermen') continue;

        const issueKey = issue.key;
        const issueHours = issue.fields?.timeestimate ? issue.fields.timeestimate / 3600 : 0;
        let remainingHours = issueHours;
        let issuePlanned = false;

        // Probeer eerst in sprint 1 te plannen
        const sprintName = '1';
        const availableHours = peterSprintCapacities.get(sprintName) || 0;

        if (availableHours >= remainingHours) {
            // Plan het hele issue in sprint 1
            if (!plannedIssues.has(assignee)) {
                plannedIssues.set(assignee, []);
            }
            plannedIssues.get(assignee)!.push({ 
                sprint: sprintName, 
                hours: remainingHours, 
                key: issueKey 
            });
            
            if (!sprintUsedHours.has(sprintName)) {
                sprintUsedHours.set(sprintName, new Map<string, number>());
            }
            const sprintHours = sprintUsedHours.get(sprintName)!;
            const usedHours = sprintHours.get(assignee) || 0;
            sprintHours.set(assignee, usedHours + remainingHours);
            
            // Update beschikbare capaciteit
            peterSprintCapacities.set(sprintName, availableHours - remainingHours);
            
            console.log(`Issue ${issueKey} gepland voor ${assignee} in sprint ${sprintName} met ${remainingHours} uur`);
            issuePlanned = true;
        }

        // Als het issue niet in sprint 1 kon worden gepland, verdeel het over de beschikbare sprints
        if (!issuePlanned) {
            for (let sprintNumber = 1; sprintNumber <= 5 && remainingHours > 0; sprintNumber++) {
                const sprintName = sprintNumber.toString();
                const availableHours = peterSprintCapacities.get(sprintName) || 0;

                if (availableHours > 0) {
                    const hoursToPlan = Math.min(availableHours, remainingHours);

                    // Plan een deel van het issue in deze sprint
                    if (!plannedIssues.has(assignee)) {
                        plannedIssues.set(assignee, []);
                    }
                    plannedIssues.get(assignee)!.push({ 
                        sprint: sprintName, 
                        hours: hoursToPlan, 
                        key: issueKey 
                    });
                    
                    if (!sprintUsedHours.has(sprintName)) {
                        sprintUsedHours.set(sprintName, new Map<string, number>());
                    }
                    const sprintHours = sprintUsedHours.get(sprintName)!;
                    const usedHours = sprintHours.get(assignee) || 0;
                    sprintHours.set(assignee, usedHours + hoursToPlan);
                    
                    // Update beschikbare capaciteit
                    peterSprintCapacities.set(sprintName, availableHours - hoursToPlan);
                    
                    remainingHours -= hoursToPlan;
                    console.log(`Issue ${issueKey} deels gepland voor ${assignee} in sprint ${sprintName} met ${hoursToPlan} uur`);
                }
            }

            // Als er nog uren over zijn, plaats ze in sprint 10
            if (remainingHours > 0) {
                const sprintName = '10';
                if (!sprintUsedHours.has(sprintName)) {
                    sprintUsedHours.set(sprintName, new Map<string, number>());
                }
                const sprintHours = sprintUsedHours.get(sprintName)!;
                const usedHours = sprintHours.get(assignee) || 0;

                if (!plannedIssues.has(assignee)) {
                    plannedIssues.set(assignee, []);
                }
                plannedIssues.get(assignee)!.push({ 
                    sprint: sprintName, 
                    hours: remainingHours, 
                    key: issueKey 
                });
                sprintHours.set(assignee, usedHours + remainingHours);

                console.log(`Restant van issue ${issueKey} geplaatst in sprint 10 voor ${assignee} met ${remainingHours} uur`);
            }
        }
    }

    // Genereer het planning resultaat
    const planningResult: PlanningResult = {
        sprintCapacity: sprintCapacities.filter(cap => cap.project === projectType || cap.project === ''),
        employeeSprintUsedHours: Array.from(sprintUsedHours.entries()).map(([sprint, hours]) => 
            Array.from(hours.entries()).map(([employee, hours]) => ({
                employee,
                sprintHours: [{
                    sprint,
                    hours,
                    issues: plannedIssues.get(employee)?.filter(issue => issue.sprint === sprint).map(issue => ({
                        key: issue.key,
                        hours: issue.hours
                    })) || []
                }]
            }))
        ).flat(),
        plannedIssues: Array.from(plannedIssues.entries()).map(([employee, issues]) => 
            issues.map(issue => ({
                issue: issues.find(i => i.key === issue.key) || issue,
                sprint: issue.sprint,
                hours: issue.hours
            }))
        ).flat()
    };

    return planningResult;
}

function getSprintName(sprint: Sprint): string {
    return sprint.name || sprint.id.toString();
}

function getPersonStats(issues: JiraIssue[]): { name: string; issueCount: number; totalRemainingTime: number }[] {
    const statsMap = new Map<string, { issueCount: number; totalRemainingTime: number }>();
    
    issues.forEach(issue => {
        const assignee = issue.fields?.assignee?.displayName || 'Niet toegewezen';
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
    sprintPlanning.employeeSprintUsedHours.forEach(employeeData => {
        employeeData.sprintHours.forEach(sprintData => {
            const sprintNumber = sprintData.sprint;
            if (!sprintHoursMap.has(sprintNumber)) {
                sprintHoursMap.set(sprintNumber, new Map<string, number>());
            }
            
            const sprintHours = sprintHoursMap.get(sprintNumber)!;
            sprintHours.set(employeeData.employee, sprintData.hours);
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
            <div class="row">
                <div class="col">
                    ${generatePlanningTable(planning, sprintNames)}
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
    let html = '<table class="table table-striped table-bordered">';
    html += '<thead><tr class="table-dark text-dark"><th>Sprint</th><th>Medewerker</th><th>Beschikbare uren</th><th>Geplande uren</th><th>Geplande issues</th><th>Resterende tijd</th></tr></thead><tbody>';

    // Groepeer de gegevens per sprint
    const sprintData = new Map<string, { employee: string; available: number; planned: number; issues: string[] }[]>();

    // Verzamel alle gegevens per sprint
    projectPlanning.employeeSprintUsedHours.forEach(employeeData => {
        employeeData.sprintHours.forEach(sprintHour => {
            if (!sprintData.has(sprintHour.sprint)) {
                sprintData.set(sprintHour.sprint, []);
            }
            const sprintInfo = sprintData.get(sprintHour.sprint)!;
            sprintInfo.push({
                employee: employeeData.employee,
                available: projectPlanning.sprintCapacity.find(cap => cap.sprint === sprintHour.sprint && cap.employee === employeeData.employee)?.capacity || 0,
                planned: sprintHour.hours,
                issues: sprintHour.issues.map(issue => `${issue.key} (${issue.hours.toFixed(1)} uur)`)
            });
        });
    });

    // Genereer rijen voor elke sprint met geplande issues
    sprintData.forEach((employees, sprint) => {
        // Alleen sprints tonen die geplande issues hebben
        const hasPlannedIssues = employees.some(emp => emp.planned > 0);
        if (!hasPlannedIssues) return;

        // Bereken totalen voor deze sprint
        let sprintTotalAvailable = 0;
        let sprintTotalPlanned = 0;
        let sprintTotalRemaining = 0;

        employees.forEach(employee => {
            html += '<tr>';
            html += `<td>Sprint ${sprint}</td>`;
            html += `<td>${employee.employee}</td>`;
            
            // Speciale weergave voor Peter van Diermen
            if (employee.employee === 'Peter van Diermen') {
                html += `<td>0</td>`; // Beschikbare uren altijd 0
                html += `<td>${employee.planned.toFixed(1)}</td>`; // Geplande uren is de som van remaining time
                html += `<td>${employee.issues.join('<br>')}</td>`;
                html += `<td>${(-employee.planned).toFixed(1)}</td>`; // Resterende tijd is negatief van geplande uren
                sprintTotalPlanned += employee.planned;
                sprintTotalRemaining -= employee.planned;
            } else {
                html += `<td>${employee.available.toFixed(1)}</td>`;
                html += `<td>${employee.planned.toFixed(1)}</td>`;
                html += `<td>${employee.issues.join('<br>')}</td>`;
                html += `<td>${(employee.available - employee.planned).toFixed(1)}</td>`;
                sprintTotalAvailable += employee.available;
                sprintTotalPlanned += employee.planned;
                sprintTotalRemaining += (employee.available - employee.planned);
            }
            
            html += '</tr>';
        });

        // Voeg totaalregel toe voor deze sprint
        html += '<tr class="table-dark">';
        html += `<td colspan="2"><strong>Totaal Sprint ${sprint}</strong></td>`;
        html += `<td><strong>${sprintTotalAvailable.toFixed(1)}</strong></td>`;
        html += `<td><strong>${sprintTotalPlanned.toFixed(1)}</strong></td>`;
        html += `<td></td>`;
        html += `<td><strong>${sprintTotalRemaining.toFixed(1)}</strong></td>`;
        html += '</tr>';
    });

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
                        
                        const plannedIssue = planning.plannedIssues.find(pi => pi.issue.key === issue.key);
                        const sprintName = plannedIssue ? sprintNames.get(plannedIssue.sprint) || plannedIssue.sprint : 'Niet gepland';
                        
                        // Markeer issues in sprint 10 als niet ingepland
                        const isPlanned = plannedIssue && plannedIssue.sprint !== '10';
                        
                        return `
                            <tr class="${isPlanned ? 'table-success' : ''}">
                                <td><a href="https://deventit.atlassian.net/browse/${issue.key}" target="_blank" class="text-decoration-none">${issue.key}</a></td>
                                <td>${issue.fields?.summary}</td>
                                <td>${issue.fields?.status?.name}</td>
                                <td>${issue.fields?.priority?.name || 'Lowest'}</td>
                                <td>${issue.fields?.assignee?.displayName || 'Niet toegewezen'}</td>
                                <td>${formatTime(issue.fields?.timeestimate)}</td>
                                <td>${sprintName}</td>
                                <td>${successorsHtml}</td>
                            </tr>
                        `;
                    }).join('')}
                    <tr class="table-dark">
                        <td colspan="5"><strong>Totaal</strong></td>
                        <td><strong>${formatTime(issues.reduce((sum, issue) => sum + (issue.fields?.timeestimate || 0), 0))}</strong></td>
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
                                if (issueKey === 'EET-3559') {
                                    logger.log(`Issue EET-3559 ${isIncluded ? 'wordt' : 'wordt niet'} meegenomen in kolom ${config.columnName}`);
                                }
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
    return `
        <div class="row mb-4">
            <div class="col">
                <div class="d-flex justify-content-between align-items-center">
                    <h2 class="mb-0">Planning</h2>
                    <div class="btn-group">
                        <a href="/worklogs" class="btn btn-outline-primary">Worklogs</a>
                        <a href="/planning" class="btn btn-primary">Planning</a>
                    </div>
                </div>
            </div>
        </div>
        <div class="row">
            <div class="col">
                <div class="table-responsive">
                    <table class="table table-striped table-bordered">
                        <thead>
                            <tr class="table-dark text-dark">
                                <th>Sprint</th>
                                <th>Medewerker</th>
                                <th>Capaciteit</th>
                                <th>Gebruikt</th>
                                <th>Beschikbaar</th>
                                <th>Geplande Issues</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${planning.sprintCapacity.map(capacity => {
                                const sprintName = sprintNames.get(capacity.sprint) || capacity.sprint;
                                const employeePlanning = planning.employeeSprintUsedHours.find(
                                    esp => esp.employee === capacity.employee
                                );
                                const sprintHours = employeePlanning?.sprintHours.find(
                                    sh => sh.sprint === capacity.sprint
                                );
                                const usedHours = sprintHours?.hours || 0;
                                const availableHours = capacity.capacity - usedHours;
                                const plannedIssues = sprintHours?.issues || [];
                                
                                return `
                                    <tr>
                                        <td>${sprintName}</td>
                                        <td>${capacity.employee}</td>
                                        <td>${capacity.capacity}</td>
                                        <td>${usedHours}</td>
                                        <td>${availableHours}</td>
                                        <td>${plannedIssues.map(issue => 
                                            `${issue.key} (${issue.hours} uur)`
                                        ).join('<br>')}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
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
            googleSheetsData = await getGoogleSheetsData();
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