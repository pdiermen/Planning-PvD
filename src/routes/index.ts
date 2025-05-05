import express from 'express';
import type { Request, Response, RequestHandler, NextFunction } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import logger from '../logger.js';
import cors from 'cors';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { getProjectConfigsFromSheet, getWorklogConfigsFromSheet } from '../services/google-sheets.js';
import { calculatePlanning } from '../services/planning.js';
import { calculateEfficiency } from '../services/efficiency.js';
import { getSprintNamesFromSheet } from '../services/sprints.js';
import { loadWorklogs } from '../services/worklogs.js';
import { generateHtml } from '../utils/html-generators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Laad .env.local bestand
dotenv.config({ path: join(__dirname, '../../.env.local') });

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

// Jira configuratie
if (!process.env.JIRA_HOST || !process.env.JIRA_USERNAME || !process.env.JIRA_API_TOKEN) {
    throw new Error('Missing Jira credentials in environment variables');
}

const jiraClient = axios.create({
    baseURL: process.env.JIRA_HOST,
    auth: {
        username: process.env.JIRA_USERNAME,
        password: process.env.JIRA_API_TOKEN
    }
});

app.use(cors());
app.use(express.json());

// Configureer axios interceptors voor error handling
jiraClient.interceptors.response.use(
    (response: any) => response,
    (error: any) => {
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

// Exporteer de app voor gebruik in andere bestanden
export default app; 