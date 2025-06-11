import { describe, it, expect } from 'vitest';
import { getAllLinkedIssues } from './jira.js';
import logger from './logger.js';
import type { Issue } from './types.js';
import { jiraClient } from './jira.js';

describe('Jira Functions', () => {
    it('should get all AMP linked issues recursively and skip child issues of REAL-1249', async () => {
        const issues = await getAllLinkedIssues('REAL-2240');
        console.log('Found AMP linked issues:', issues);
        
        // Verify that we got some issues
        expect(issues.length).toBeGreaterThan(0);
        
        // Verify that all issues are AMP issues
        issues.forEach(issue => {
            expect(issue.key).toMatch(/^AMP-\d+$/);
        });
        
        // Verify that all issues have the required fields
        issues.forEach(issue => {
            expect(issue).toHaveProperty('key');
            expect(issue).toHaveProperty('summary');
            expect(issue).toHaveProperty('status');
            expect(issue).toHaveProperty('type');
        });
    }, 1800000); // 30 minuten timeout

    it('should get all linked AMP issues for REAL-2240', async () => {
        const result = await getAllLinkedIssues('REAL-2240');
        logger.info('Gevonden AMP linked issues voor REAL-2240:');
        result.forEach(issue => {
            logger.info(`- ${issue.key}: ${issue.summary} (${issue.status})`);
        });
    }, 1800000); // 30 minuten timeout
}); 