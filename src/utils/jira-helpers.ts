import type { Issue } from '../types.js';

export function getSuccessors(issue: Issue): string[] {
    if (!issue.fields?.issuelinks) return [];
    
    return issue.fields.issuelinks
        .filter(link => 
            link.type.name === 'Predecessor' && 
            link.type.inward === 'is a predecessor of' &&
            link.inwardIssue?.key &&
            link.inwardIssue.fields?.status?.name !== 'Closed'
        )
        .map(link => link.inwardIssue!.key);
}

export function getPredecessors(issue: Issue): string[] {
    if (!issue.fields?.issuelinks) return [];
    
    return issue.fields.issuelinks
        .filter(link => 
            link.type.name === 'Predecessor' && 
            link.type.outward === 'has as a predecessor' &&
            link.outwardIssue?.key &&
            link.outwardIssue.fields?.status?.name !== 'Closed'
        )
        .map(link => link.outwardIssue!.key);
} 