import fs from 'fs';

const logFile = 'planning.log';

const logData = fs.readFileSync(logFile, 'utf8');
const lines = logData.split('\n');

const sprint3Issues = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('✅ ISSUE GEPLAND') && line.includes('in sprint 3')) {
        // Voorbeeld: ✅ ISSUE GEPLAND: EET-6094 (8 uur) voor Milan van Dijk in sprint 3
        const match = line.match(/ISSUE GEPLAND: (\S+) \(([^)]+) uur\) voor (.+?) in sprint 3/);
        if (match) {
            const [_, key, hours, assignee] = match;
            // Zoek projectregel in de volgende 5 regels
            let project = 'Onbekend';
            for (let j = 1; j <= 5 && i + j < lines.length; j++) {
                const nextLine = lines[i + j];
                const projectMatch = nextLine.match(/- Project: (.+)/);
                if (projectMatch) {
                    project = projectMatch[1].trim();
                    break;
                }
            }
            sprint3Issues.push({ key, hours: parseFloat(hours), assignee, project });
        }
    }
}

console.log('=== ISSUES GEPLAND IN SPRINT 3 ===');
console.log(`Totaal: ${sprint3Issues.length}`);
let total = 0;
sprint3Issues.forEach(issue => {
    console.log(`- ${issue.key}: ${issue.hours} uur, ${issue.assignee}, project: ${issue.project}`);
    total += issue.hours;
});
console.log(`Totaal geplande uren: ${total.toFixed(2)} uur`);

// Groepeer per assignee
const perAssignee = {};
sprint3Issues.forEach(issue => {
    if (!perAssignee[issue.assignee]) perAssignee[issue.assignee] = 0;
    perAssignee[issue.assignee] += issue.hours;
});
console.log('\n=== Uren per medewerker ===');
Object.entries(perAssignee).forEach(([assignee, uren]) => {
    console.log(`${assignee}: ${uren.toFixed(2)} uur`);
}); 