// Test script om te controleren welke sprint vandaag zou moeten zijn
const currentDate = new Date('2025-06-19'); // Vandaag
console.log('Huidige datum:', currentDate.toLocaleDateString('nl-NL'));
console.log('Dag van de week:', currentDate.getDay()); // 0 = zondag, 1 = maandag, etc.

// Test verschillende project start datums
const projectStartDates = [
    '2025-05-11', // Mogelijke start datum
    '2025-01-01', // Begin van het jaar
    '2024-12-01'  // Eind vorig jaar
];

// Helper functie om werkdagen tussen twee datums te berekenen
function getWorkDaysBetween(startDate, endDate) {
    let workDays = 0;
    const currentDate = new Date(startDate);
    
    // Tel de huidige datum altijd mee als werkdag
    workDays++;
    
    // Tel de resterende dagen
    while (currentDate < endDate) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = zondag, 6 = zaterdag
            workDays++;
        }
    }
    
    return workDays;
}

projectStartDates.forEach(startDate => {
    console.log(`\n=== Project start datum: ${startDate} ===`);
    const projectStart = new Date(startDate);
    
    // Bereken sprints
    for (let sprintNum = 1; sprintNum <= 10; sprintNum++) {
        const sprintStart = new Date(projectStart);
        sprintStart.setDate(sprintStart.getDate() + ((sprintNum - 1) * 14));
        const sprintEnd = new Date(sprintStart);
        sprintEnd.setDate(sprintStart.getDate() + 13);
        
        console.log(`Sprint ${sprintNum}: ${sprintStart.toLocaleDateString('nl-NL')} - ${sprintEnd.toLocaleDateString('nl-NL')}`);
        
        // Check of huidige datum in deze sprint valt
        if (currentDate >= sprintStart && currentDate <= sprintEnd) {
            console.log(`  ✅ HUIDIGE SPRINT!`);
            const remainingWorkDays = getWorkDaysBetween(currentDate, sprintEnd);
            const totalWorkDaysInSprint = 10; // 2 weken = 10 werkdagen
            const capacityFactor = remainingWorkDays / totalWorkDaysInSprint;
            console.log(`  Resterende werkdagen: ${remainingWorkDays}`);
            console.log(`  Capaciteitsfactor: ${capacityFactor.toFixed(2)} (${(capacityFactor * 100).toFixed(0)}%)`);
            
            // Test met verschillende effectieve uren
            [0, 8, 16, 24, 32, 40].forEach(effectiveHours => {
                const originalCapacity = effectiveHours * 2;
                const availableCapacity = Math.round(originalCapacity * capacityFactor);
                console.log(`    ${effectiveHours} uur/week -> ${originalCapacity} uur sprint -> ${availableCapacity} uur beschikbaar`);
            });
        }
    }
});

// Test specifiek voor sprint 3 met verschillende project start datums
console.log('\n=== SPECIFIEKE TEST VOOR SPRINT 3 ===');
const testStartDates = ['2025-05-11', '2025-05-12', '2025-05-13', '2025-05-14', '2025-05-15'];

testStartDates.forEach(startDate => {
    const projectStart = new Date(startDate);
    const sprintStart = new Date(projectStart);
    sprintStart.setDate(sprintStart.getDate() + ((3 - 1) * 14)); // Sprint 3
    const sprintEnd = new Date(sprintStart);
    sprintEnd.setDate(sprintStart.getDate() + 13);
    
    console.log(`\nProject start: ${startDate}`);
    console.log(`Sprint 3: ${sprintStart.toLocaleDateString('nl-NL')} - ${sprintEnd.toLocaleDateString('nl-NL')}`);
    
    if (currentDate >= sprintStart && currentDate <= sprintEnd) {
        const remainingWorkDays = getWorkDaysBetween(currentDate, sprintEnd);
        const capacityFactor = remainingWorkDays / 10;
        console.log(`  ✅ Huidige sprint! Resterende werkdagen: ${remainingWorkDays}, Factor: ${capacityFactor.toFixed(2)}`);
    } else if (currentDate > sprintEnd) {
        console.log(`  ❌ Sprint al voorbij`);
    } else {
        console.log(`  ⏳ Sprint nog niet begonnen`);
    }
}); 