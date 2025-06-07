export function getAssigneeName(assignee: any): string {
    if (!assignee) return 'Unassigned';
    if (typeof assignee === 'string') return assignee;
    return assignee.displayName || 'Unassigned';
} 