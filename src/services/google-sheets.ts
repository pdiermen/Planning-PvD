import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { ProjectConfig, WorklogConfig } from '../types.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

export async function getProjectConfigsFromSheet(sheets: any, spreadsheetId: string): Promise<ProjectConfig[]> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Project Config!A2:F'
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('Geen project configuraties gevonden');
            return [];
        }

        return rows.map((row: string[]) => ({
            name: row[0],
            projectType: row[1],
            projectCodes: row[2].split(',').map(code => code.trim()),
            excludedParents: row[3].split(',').map(parent => parent.trim()),
            excludedStatuses: row[4].split(',').map(status => status.trim())
        }));
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