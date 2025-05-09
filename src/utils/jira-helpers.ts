import type { Issue } from '../types.js';

export function getSuccessors(issue: Issue): string[] {
    if (!issue.fields?.issuelinks) return [];
    
    return issue.fields.issuelinks
        .filter(link => 
            (link.type.name === 'Blocks' || 
             link.type.name === 'Depends On' || 
             (link.type.name === 'Predecessor' && link.type.inward === 'is a predecessor of')) && 
            link.outwardIssue?.key
        )
        .map(link => link.outwardIssue!.key);
}

export function getPredecessors(issue: Issue): string[] {
    if (!issue.fields?.issuelinks) return [];
    
    return issue.fields.issuelinks
        .filter(link => 
            (link.type.name === 'Blocks' || 
             link.type.name === 'Depends On' || 
             (link.type.name === 'Predecessor' && link.type.inward === 'is a predecessor of')) && 
            link.inwardIssue?.key
        )
        .map(link => link.inwardIssue!.key);
} 