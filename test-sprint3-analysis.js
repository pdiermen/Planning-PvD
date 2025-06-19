const { calculatePlanning } = require('./dist/services/planning.js');
const { getGoogleSheetsData } = require('./dist/google-sheets.js');

async function analyzeSprint3() {
    try {
        console.log('=== ANALYSE SPRINT 3 ATLANTIS 7 ===\n');
        
        // Haal Google Sheets data op
        const googleSheetsData = await getGoogleSheetsData('Employees!A1:F');
        
        // Project configuratie voor Atlantis 7
        const projectConfig = {
            project: 'Atlantis 7',
            codes: ['ATL7Q2'],
            sprintStartDate: new Date('2025-06-09'),
            capacityFactor: 0.2 // 20% van de normale capaciteit voor resterende werkdagen
        };
        
        // Haal issues op voor Atlantis 7
        const issues = [
            // Voeg hier test issues toe om de capaciteitscontrole te testen
        ];
        
        console.log('Project configuratie:');
        console.log('- Project:', projectConfig.project);
        console.log('- Codes:', projectConfig.codes);
        console.log('- Sprint start datum:', projectConfig.sprintStartDate.toLocaleDateString('nl-NL'));
        console.log('- Capaciteitsfactor:', projectConfig.capacityFactor);
        console.log('');
        
        // Bereken planning
        const planning = await calculatePlanning(projectConfig, issues, googleSheetsData);
        
        // Analyseer sprint 3
        const sprint3Issues = planning.plannedIssues.filter(pi => pi.sprint === '3');
        const sprint3Capacity = planning.sprintCapacity.filter(sc => sc.sprint === '3' && sc.project === 'Atlantis 7');
        
        console.log('=== SPRINT 3 ANALYSE ===');
        console.log('Geplande issues in sprint 3:');
        sprint3Issues.forEach(pi => {
            console.log(`- ${pi.issue.key}: ${pi.hours} uur voor ${pi.assignee}`);
        });
        
        console.log('\nSprint 3 capaciteiten:');
        sprint3Capacity.forEach(sc => {
            console.log(`- ${sc.employee}: ${sc.capacity} uur (beschikbaar: ${sc.availableCapacity} uur)`);
        });
        
        // Bereken totale geplande uren
        const totalPlannedHours = sprint3Issues.reduce((sum, pi) => sum + pi.hours, 0);
        const totalCapacity = sprint3Capacity.reduce((sum, sc) => sum + sc.capacity, 0);
        
        console.log('\n=== CAPACITEIT CONTROLE ===');
        console.log(`Totale geplande uren: ${totalPlannedHours}`);
        console.log(`Totale sprint capaciteit: ${totalCapacity}`);
        console.log(`Overschrijding: ${totalPlannedHours > totalCapacity ? 'JA' : 'NEE'}`);
        if (totalPlannedHours > totalCapacity) {
            console.log(`Overschrijding met: ${totalPlannedHours - totalCapacity} uur`);
        }
        
    } catch (error) {
        console.error('Error bij analyseren van sprint 3:', error);
    }
}

analyzeSprint3(); 