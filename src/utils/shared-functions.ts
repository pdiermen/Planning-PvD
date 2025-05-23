import type { Issue as JiraIssue } from '../types.js';

export const styles = `
    .planned {
        background-color: #d4edda;
    }
    .unplanned {
        background-color: #f8d7da;
    }
    .table th {
        background-color: #f8f9fa;
    }
`;

export function getAssigneeName(assignee: { displayName: string; } | string | undefined): string {
    if (!assignee) return 'Unassigned';
    if (typeof assignee === 'string') return assignee;
    return assignee.displayName;
}

export function generateIssuesTable(issues: JiraIssue[]): string {
    return `
        <table class="table table-striped">
            <thead>
                <tr>
                    <th>Key</th>
                    <th>Summary</th>
                    <th>Status</th>
                    <th>Assignee</th>
                    <th>Story Points</th>
                </tr>
            </thead>
            <tbody>
                ${issues.map(issue => `
                    <tr>
                        <td>${issue.key}</td>
                        <td>${issue.fields?.summary || '-'}</td>
                        <td>${issue.fields?.status?.name || '-'}</td>
                        <td>${getAssigneeName(issue.fields?.assignee)}</td>
                        <td>${issue.fields?.customfield_10020 || '-'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
} 