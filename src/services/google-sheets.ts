import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { ProjectConfig, WorklogConfig } from '../types.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

export async function getProjectConfigsFromSheet(sheets: any, spreadsheetId: string): Promise<ProjectConfig[]> {
    try {
        // Log de spreadsheet ID en range
        console.log('Ophalen project configuraties uit:', {
            spreadsheetId,
            range: 'Projects!A2:F'
        });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Projects!A2:F'
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('Geen project configuraties gevonden');
            return [];
        }

        // Log de ruwe data
        console.log('Ruwe project data uit Google Sheet:', JSON.stringify(rows, null, 2));

        // Log de headers
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Projects!A1:F1'
        });
        const headers = headerResponse.data.values?.[0] || [];
        console.log('Headers uit sheet:', headers);

        // Log de kolom indices
        const projectIndex = headers.findIndex((header: string | null) => header?.toLowerCase() === 'project');
        const codesIndex = headers.findIndex((header: string | null) => header?.toLowerCase() === 'codes');
        const jqlFilterIndex = headers.findIndex((header: string | null) => header?.toLowerCase() === 'jql filter');
        const worklogIndex = headers.findIndex((header: string | null) => header?.toLowerCase() === 'worklog');
        const worklogJqlIndex = headers.findIndex((header: string | null) => header?.toLowerCase() === 'worklog jql');
        const sprintDateIndex = headers.findIndex((header: string | null) => header?.toLowerCase() === 'sprint datum');

        console.log('Kolom indices:', {
            project: projectIndex,
            codes: codesIndex,
            jqlFilter: jqlFilterIndex,
            worklog: worklogIndex,
            worklogJql: worklogJqlIndex,
            sprintDate: sprintDateIndex
        });

        return rows.map((row: string[]) => {
            let sprintStartDate = null;
            if (row[5]) {
                // Log de ruwe datum string
                console.log(`Project ${row[0]}: Ruwe datum string uit sheet: "${row[5]}"`);
                
                // Splits de datum in jaar, maand en dag
                const [year, month, day] = row[5].split('-').map(Number);
                console.log(`Project ${row[0]}: Gesplitste datum: jaar=${year}, maand=${month}, dag=${day}`);
                
                // Maak een nieuwe datum aan met UTC tijdzone
                sprintStartDate = new Date(Date.UTC(year, month - 1, day));
                console.log(`Project ${row[0]}: Gegenereerde datum: ${sprintStartDate.toISOString()}`);
            } else {
                console.log(`Project ${row[0]}: Geen sprint startdatum gevonden`);
            }
            
            const config = {
                project: row[0],
                codes: row[1] ? row[1].split(',').map(code => code.trim()) : [],
                jqlFilter: row[2] || '',
                worklogName: row[3] || '',
                worklogJql: row[4] || '',
                sprintStartDate
            };
            
            console.log(`Project ${row[0]}: Gegenereerde config:`, JSON.stringify(config, null, 2));
            return config;
        });
    } catch (error) {
        console.error('Error bij het ophalen van project configuraties:', error);
        return [];
    }
}

export async function getWorklogConfigsFromSheet(sheets: any, spreadsheetId: string): Promise<WorklogConfig[]> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Worklog Config!A2:C'
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('Geen worklog configuraties gevonden');
            return [];
        }

        return rows.map((row: string[]) => ({
            worklogName: row[0],
            columnName: row[1],
            issues: row[2].split(',').map(issue => issue.trim())
        }));
    } catch (error) {
        console.error('Error bij het ophalen van worklog configuraties:', error);
        return [];
    }
} 