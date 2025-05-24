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