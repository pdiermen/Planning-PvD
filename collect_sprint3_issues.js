import fs from 'fs';

// Lees de planning output
let planningData;
try {
    const planningOutput = fs.readFileSync('planning_output.json', 'utf8');
    planningData = JSON.parse(planningOutput);
} catch (error) {
    console.log('planning_output.json is leeg of niet gevonden');
    try {
        const planningJson = fs.readFileSync('planning.json', 'utf8');
        planningData = JSON.parse(planningJson);
    } catch (error2) {
        console.log('planning.json is ook leeg');
        process.exit(1);
    }
}

// Zoek naar issues in sprint 3
const sprint3Issues = [];

if (planningData.planning && planningData.planning.plannedIssues) {
    planningData.planning.plannedIssues.forEach(plannedIssue => {
        if (plannedIssue.sprint === '3') {
            const hours = plannedIssue.issue.fields?.timeestimate ? plannedIssue.issue.fields.timeestimate / 3600 : 0;
            const assignee = plannedIssue.issue.fields?.assignee?.displayName || 'Unassigned';
            const project = plannedIssue.issue.fields?.project?.key || 'Unknown';
            
            sprint3Issues.push({
                key: plannedIssue.issue.key,
                summary: plannedIssue.issue.fields?.summary || 'No summary',
                assignee: assignee,
                project: project,
                hours: hours,
                sprint: plannedIssue.sprint
            });
        }
    });
}

// Toon resultaten
console.log('=== ISSUES IN SPRINT 3 ===');
console.log(`Totaal aantal issues: ${sprint3Issues.length}`);

let totalHours = 0;
sprint3Issues.forEach(issue => {
    console.log(`- ${issue.key}: ${issue.summary}`);
    console.log(`  Assignee: ${issue.assignee}`);
    console.log(`  Project: ${issue.project}`);
    console.log(`  Hours: ${issue.hours}`);
    console.log('');
    totalHours += issue.hours;
});

console.log(`Totaal geplande uren in sprint 3: ${totalHours.toFixed(2)} uur`);

// Groepeer per assignee
const assigneeGroups = {};
sprint3Issues.forEach(issue => {
    if (!assigneeGroups[issue.assignee]) {
        assigneeGroups[issue.assignee] = [];
    }
    assigneeGroups[issue.assignee].push(issue);
});

console.log('\n=== PER ASSIGNEE ===');
Object.keys(assigneeGroups).forEach(assignee => {
    const issues = assigneeGroups[assignee];
    const assigneeHours = issues.reduce((sum, issue) => sum + issue.hours, 0);
    console.log(`${assignee}: ${assigneeHours.toFixed(2)} uur (${issues.length} issues)`);
    issues.forEach(issue => {
        console.log(`  - ${issue.key}: ${issue.hours} uur`);
    });
    console.log('');
}); 