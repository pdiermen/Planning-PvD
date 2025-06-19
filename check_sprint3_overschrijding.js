import fs from 'fs';

const logFile = 'planning.log';
const SPRINT = 3;
const CAPACITEIT = 77;

const logData = fs.readFileSync(logFile, 'utf8');
const lines = logData.split('\n');

const sprint3Issues = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('✅ ISSUE GEPLAND') && line.includes(`in sprint ${SPRINT}`)) {
        const match = line.match(/ISSUE GEPLAND: (\S+) \(([^)]+) uur\) voor (.+?) in sprint 3/);
        if (match) {
            const [_, key, hours, assignee] = match;
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

console.log('=== CUMULATIEVE PLANNING SPRINT 3 ===');
let totaal = 0;
let overschreden = false;
sprint3Issues.forEach((issue, idx) => {
    totaal += issue.hours;
    const grens = totaal > CAPACITEIT ? ' <-- OVERSCHRIJDING!' : '';
    console.log(`${idx+1}. ${issue.key}: +${issue.hours} uur, totaal: ${totaal.toFixed(2)}${grens}`);
    if (!overschreden && totaal > CAPACITEIT) {
        console.log(`\n>>> Sprintcapaciteit van ${CAPACITEIT} uur wordt overschreden bij issue ${issue.key} (regel ${idx+1})!\n`);
        overschreden = true;
    }
});
if (!overschreden) {
    console.log(`\nSprintcapaciteit van ${CAPACITEIT} uur wordt niet overschreden.`);
} 